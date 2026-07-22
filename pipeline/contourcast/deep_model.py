"""Optional PyTorch multiscale self-supervised and catch-model architectures.

This module intentionally does not download weights or claim a trained model.
It defines architecture, augmentations, losses, and epoch-level training hooks so
that an experiment can be reproduced once an approved dataset is available.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, Mapping, Tuple

try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as functional
except ImportError:  # pragma: no cover - exercised by dependency guard test
    torch = None  # type: ignore[assignment]
    nn = None  # type: ignore[assignment]
    functional = None  # type: ignore[assignment]


def require_torch() -> None:
    if torch is None:
        raise RuntimeError(
            "PyTorch is required for the deep-model path. Create an isolated environment "
            "with a platform-appropriate torch build. The baseline/smoke path does not require it."
        )


if nn is not None:

    class ResidualBlock(nn.Module):
        expansion = 1

        def __init__(self, in_channels: int, out_channels: int, stride: int = 1) -> None:
            super().__init__()
            self.conv1 = nn.Conv2d(
                in_channels, out_channels, kernel_size=3, stride=stride, padding=1, bias=False
            )
            self.norm1 = nn.BatchNorm2d(out_channels)
            self.conv2 = nn.Conv2d(
                out_channels, out_channels, kernel_size=3, padding=1, bias=False
            )
            self.norm2 = nn.BatchNorm2d(out_channels)
            self.skip = (
                nn.Identity()
                if stride == 1 and in_channels == out_channels
                else nn.Sequential(
                    nn.Conv2d(in_channels, out_channels, kernel_size=1, stride=stride, bias=False),
                    nn.BatchNorm2d(out_channels),
                )
            )

        def forward(self, inputs: Any) -> Any:
            hidden = functional.relu(self.norm1(self.conv1(inputs)), inplace=True)
            hidden = self.norm2(self.conv2(hidden))
            return functional.relu(hidden + self.skip(inputs), inplace=True)


    class TerrainResNetEncoder(nn.Module):
        """Compact ResNet-style encoder for a declared geospatial channel stack."""

        def __init__(
            self,
            input_channels: int = 6,
            base_width: int = 32,
            blocks_per_stage: int = 2,
        ) -> None:
            super().__init__()
            if input_channels < 1 or base_width < 8 or blocks_per_stage < 1:
                raise ValueError(
                    "input_channels >= 1, base_width >= 8, and blocks_per_stage >= 1 are required"
                )
            self.input_channels = input_channels
            self.stem = nn.Sequential(
                nn.Conv2d(input_channels, base_width, kernel_size=5, padding=2, bias=False),
                nn.BatchNorm2d(base_width),
                nn.ReLU(inplace=True),
            )
            stages = []
            in_channels = base_width
            for stage_index, out_channels in enumerate(
                (base_width, base_width * 2, base_width * 4)
            ):
                stage = [
                    ResidualBlock(
                        in_channels,
                        out_channels,
                        stride=1 if stage_index == 0 else 2,
                    )
                ]
                stage.extend(
                    ResidualBlock(out_channels, out_channels)
                    for _ in range(blocks_per_stage - 1)
                )
                stages.append(nn.Sequential(*stage))
                in_channels = out_channels
            self.stages = nn.Sequential(*stages)
            self.pool = nn.AdaptiveAvgPool2d(1)
            self.output_dim = base_width * 4

        def forward_features(self, inputs: Any) -> Any:
            if inputs.ndim != 4 or inputs.shape[1] != self.input_channels:
                raise ValueError(
                    f"encoder expects batches shaped (N, {self.input_channels}, H, W)"
                )
            return self.stages(self.stem(inputs))

        def forward(self, inputs: Any) -> Any:
            return self.pool(self.forward_features(inputs)).flatten(1)


    class SixChannelResNetEncoder(TerrainResNetEncoder):
        """Backward-compatible six-channel baseline encoder."""

        def __init__(self, base_width: int = 32, blocks_per_stage: int = 2) -> None:
            super().__init__(6, base_width, blocks_per_stage)


    class MultiScaleTerrainEncoder(nn.Module):
        """Shared-weight terrain encoder with learned attention across physical scales."""

        def __init__(self, encoder: TerrainResNetEncoder, scales: int = 3) -> None:
            super().__init__()
            if scales < 1:
                raise ValueError("scales must be positive")
            self.encoder = encoder
            self.scales = scales
            self.scale_embeddings = nn.Parameter(torch.zeros(scales, encoder.output_dim))
            self.attention = nn.Sequential(
                nn.Linear(encoder.output_dim, max(8, encoder.output_dim // 2)),
                nn.Tanh(),
                nn.Linear(max(8, encoder.output_dim // 2), 1),
            )
            self.output_dim = encoder.output_dim

        @property
        def input_channels(self) -> int:
            return self.encoder.input_channels

        def forward_with_spatial(self, inputs: Any) -> Tuple[Any, Any]:
            if inputs.ndim != 5:
                raise ValueError("multiscale encoder expects (N, scales, channels, H, W)")
            batch, scales, channels, height, width = inputs.shape
            if scales != self.scales or channels != self.input_channels:
                raise ValueError(
                    f"expected {self.scales} scales and {self.input_channels} channels"
                )
            spatial = self.encoder.forward_features(
                inputs.reshape(batch * scales, channels, height, width)
            )
            encoded = self.encoder.pool(spatial).flatten(1)
            encoded = encoded.reshape(batch, scales, -1) + self.scale_embeddings[None, :, :]
            weights = torch.softmax(self.attention(encoded).squeeze(-1), dim=1)
            embedding = torch.sum(encoded * weights[:, :, None], dim=1)
            spatial = spatial.reshape(batch, scales, *spatial.shape[1:])
            return embedding, spatial

        def forward(self, inputs: Any) -> Any:
            embedding, _ = self.forward_with_spatial(inputs)
            return embedding


    class TerrainContrastiveModel(nn.Module):
        """SimCLR-style projection head for unlabeled bathymetry patches."""

        def __init__(self, encoder: Any, projection_dim: int = 128) -> None:
            super().__init__()
            self.encoder = encoder
            self.projector = nn.Sequential(
                nn.Linear(encoder.output_dim, encoder.output_dim),
                nn.ReLU(inplace=True),
                nn.Linear(encoder.output_dim, projection_dim),
            )

        def forward(self, inputs: Any) -> Any:
            return functional.normalize(self.projector(self.encoder(inputs)), dim=1)


    class TerrainMaskedContrastiveModel(nn.Module):
        """Multiscale encoder with contrastive and masked-reconstruction heads.

        Reconstruction is intentionally limited to caller-declared measured value
        channels. Availability masks remain model inputs but must never be treated
        as reconstruction targets.
        """

        def __init__(
            self,
            encoder: MultiScaleTerrainEncoder,
            *,
            projection_dim: int = 128,
            reconstruction_channels: int = 2,
        ) -> None:
            super().__init__()
            if reconstruction_channels < 1:
                raise ValueError("reconstruction_channels must be positive")
            self.encoder = encoder
            self.reconstruction_channels = reconstruction_channels
            self.projector = nn.Sequential(
                nn.Linear(encoder.output_dim, encoder.output_dim),
                nn.ReLU(inplace=True),
                nn.Linear(encoder.output_dim, projection_dim),
            )
            decoder_width = max(8, encoder.output_dim // 2)
            self.reconstructor = nn.Sequential(
                nn.Conv2d(encoder.output_dim, decoder_width, kernel_size=3, padding=1),
                nn.ReLU(inplace=True),
                nn.Conv2d(decoder_width, reconstruction_channels, kernel_size=1),
            )

        def forward(self, inputs: Any) -> Dict[str, Any]:
            if inputs.ndim != 5:
                raise ValueError(
                    "masked-contrastive model expects (N, scales, channels, H, W)"
                )
            batch, scales, _, height, width = inputs.shape
            embedding, spatial = self.encoder.forward_with_spatial(inputs)
            feature_height, feature_width = spatial.shape[-2:]
            decoded = self.reconstructor(
                spatial.reshape(batch * scales, self.encoder.output_dim, feature_height, feature_width)
            )
            reconstruction = functional.interpolate(
                decoded,
                size=(height, width),
                mode="bilinear",
                align_corners=False,
            ).reshape(batch, scales, self.reconstruction_channels, height, width)
            return {
                "projection": functional.normalize(self.projector(embedding), dim=1),
                "reconstruction": reconstruction,
                "embedding": embedding,
            }


    class CatchMultiTaskModel(nn.Module):
        """Fine-tuning model with occurrence and positive-catch CPUE heads."""

        def __init__(self, encoder: Any, dropout: float = 0.2) -> None:
            super().__init__()
            self.encoder = encoder
            self.dropout = nn.Dropout(dropout)
            self.occurrence_head = nn.Linear(encoder.output_dim, 1)
            self.log_cpue_head = nn.Linear(encoder.output_dim, 1)

        def forward(self, inputs: Any) -> Dict[str, Any]:
            embedding = self.dropout(self.encoder(inputs))
            return {
                "occurrence_logit": self.occurrence_head(embedding).squeeze(1),
                "log_cpue": self.log_cpue_head(embedding).squeeze(1),
                "embedding": embedding,
            }


    class AreaBagCatchModel(nn.Module):
        """Multiple-instance model for legitimately coarse fishing-area labels.

        A CRFS/RecFIN block is represented by several terrain locations. The
        label supervises the bag, not any invented centroid or individual patch.
        Patch attention is inspectable but is not itself a ground-truthed hotspot.
        """

        def __init__(self, encoder: Any, dropout: float = 0.2) -> None:
            super().__init__()
            self.encoder = encoder
            self.attention = nn.Sequential(
                nn.Linear(encoder.output_dim, max(8, encoder.output_dim // 2)),
                nn.Tanh(),
                nn.Linear(max(8, encoder.output_dim // 2), 1),
            )
            self.dropout = nn.Dropout(dropout)
            self.occurrence_head = nn.Linear(encoder.output_dim, 1)
            self.log_cpue_head = nn.Linear(encoder.output_dim, 1)

        def forward(self, inputs: Any, patch_mask: Any | None = None) -> Dict[str, Any]:
            if inputs.ndim not in {5, 6}:
                raise ValueError(
                    "area bags must be (N,patches,C,H,W) or (N,patches,scales,C,H,W)"
                )
            batch, patches_per_bag = inputs.shape[:2]
            flattened = inputs.reshape(batch * patches_per_bag, *inputs.shape[2:])
            embeddings = self.encoder(flattened).reshape(batch, patches_per_bag, -1)
            logits = self.attention(embeddings).squeeze(-1)
            if patch_mask is not None:
                if patch_mask.shape != logits.shape:
                    raise ValueError("patch_mask must be shaped (N, patches_per_bag)")
                logits = logits.masked_fill(~patch_mask.bool(), -1e9)
            weights = torch.softmax(logits, dim=1)
            pooled = self.dropout(torch.sum(embeddings * weights[:, :, None], dim=1))
            return {
                "occurrence_logit": self.occurrence_head(pooled).squeeze(1),
                "log_cpue": self.log_cpue_head(pooled).squeeze(1),
                "embedding": pooled,
                "patch_attention": weights,
            }

else:

    class ResidualBlock:  # type: ignore[no-redef]
        def __init__(self, *_: Any, **__: Any) -> None:
            require_torch()

    class SixChannelResNetEncoder:  # type: ignore[no-redef]
        def __init__(self, *_: Any, **__: Any) -> None:
            require_torch()

    class TerrainResNetEncoder:  # type: ignore[no-redef]
        def __init__(self, *_: Any, **__: Any) -> None:
            require_torch()

    class MultiScaleTerrainEncoder:  # type: ignore[no-redef]
        def __init__(self, *_: Any, **__: Any) -> None:
            require_torch()

    class TerrainContrastiveModel:  # type: ignore[no-redef]
        def __init__(self, *_: Any, **__: Any) -> None:
            require_torch()

    class TerrainMaskedContrastiveModel:  # type: ignore[no-redef]
        def __init__(self, *_: Any, **__: Any) -> None:
            require_torch()

    class CatchMultiTaskModel:  # type: ignore[no-redef]
        def __init__(self, *_: Any, **__: Any) -> None:
            require_torch()

    class AreaBagCatchModel:  # type: ignore[no-redef]
        def __init__(self, *_: Any, **__: Any) -> None:
            require_torch()


def augment_terrain_batch(
    inputs: Any,
    noise_std: float = 0.01,
    channel_drop: float = 0.05,
    max_shift: int = 2,
    allow_reflection: bool = False,
    protected_channel_indices: Iterable[int] = (),
) -> Any:
    """Orientation-preserving noise, translation, and channel dropout.

    Reflections are disabled by default because shoreline-relative orientation,
    bedform direction, and linear-feature alignment can be ecologically useful.
    Inputs are expected to be robust-normalized before augmentation.
    """

    require_torch()
    protected = tuple(int(index) for index in protected_channel_indices)
    if len(set(protected)) != len(protected):
        raise ValueError("protected_channel_indices must be unique")
    channel_axis = 1 if inputs.ndim == 4 else 2 if inputs.ndim == 5 else None
    if channel_axis is None:
        raise ValueError("terrain batches must be (N,C,H,W) or (N,S,C,H,W)")
    if protected and (min(protected) < 0 or max(protected) >= inputs.shape[channel_axis]):
        raise ValueError("protected_channel_indices contains an out-of-range channel")
    augmented = inputs.clone()
    if allow_reflection and bool(torch.rand(()) < 0.5):
        augmented = torch.flip(augmented, dims=(-1,))
    if allow_reflection and bool(torch.rand(()) < 0.5):
        augmented = torch.flip(augmented, dims=(-2,))
    if max_shift > 0:
        row_shift = int(torch.randint(-max_shift, max_shift + 1, ()).item())
        col_shift = int(torch.randint(-max_shift, max_shift + 1, ()).item())
        height, width = augmented.shape[-2:]
        original_shape = augmented.shape
        flattened = augmented.reshape(-1, 1, height, width)
        padded = functional.pad(
            flattened, (max_shift, max_shift, max_shift, max_shift), mode="replicate"
        )
        row_start = max_shift + row_shift
        col_start = max_shift + col_shift
        augmented = padded[
            ..., row_start : row_start + height, col_start : col_start + width
        ].reshape(original_shape)
    noise = noise_std * torch.randn_like(augmented)
    if protected:
        if inputs.ndim == 4:
            noise[:, list(protected)] = 0.0
        else:
            noise[:, :, list(protected)] = 0.0
    augmented = augmented + noise
    if channel_drop > 0:
        if inputs.ndim == 4:
            keep_shape = (len(inputs), inputs.shape[1], 1, 1)
        elif inputs.ndim == 5:
            # Keep/drop a semantic channel consistently across physical scales.
            keep_shape = (len(inputs), 1, inputs.shape[2], 1, 1)
        else:
            raise ValueError("terrain batches must be (N,C,H,W) or (N,S,C,H,W)")
        keep = torch.rand(keep_shape, device=inputs.device) > channel_drop
        if protected:
            if inputs.ndim == 4:
                keep[:, list(protected)] = True
            else:
                keep[:, :, list(protected)] = True
        augmented = augmented * keep
    return augmented


def mask_terrain_blocks(
    inputs: Any,
    target_channel_indices: Iterable[int],
    *,
    mask_fraction: float = 0.25,
    block_size: int = 4,
) -> Tuple[Any, Any]:
    """Mask spatial blocks only in declared value channels.

    The returned boolean mask has the same shape as ``inputs`` so reconstruction
    eligibility can be intersected with source-availability masks. This function
    never infers which channels are measurements versus metadata.
    """

    require_torch()
    if inputs.ndim != 5:
        raise ValueError("masked pretraining inputs must be (N,S,C,H,W)")
    if not 0 < mask_fraction < 1:
        raise ValueError("mask_fraction must be between zero and one")
    if block_size < 1:
        raise ValueError("block_size must be positive")
    channel_indices = tuple(int(index) for index in target_channel_indices)
    if not channel_indices or len(set(channel_indices)) != len(channel_indices):
        raise ValueError("target_channel_indices must be unique and nonempty")
    if min(channel_indices) < 0 or max(channel_indices) >= inputs.shape[2]:
        raise ValueError("target_channel_indices contains an out-of-range channel")
    batch, scales, channels, height, width = inputs.shape
    coarse_height = (height + block_size - 1) // block_size
    coarse_width = (width + block_size - 1) // block_size
    coarse = (
        torch.rand(
            (batch, scales, 1, coarse_height, coarse_width),
            device=inputs.device,
        )
        < mask_fraction
    )
    spatial = functional.interpolate(
        coarse.reshape(batch * scales, 1, coarse_height, coarse_width).float(),
        size=(height, width),
        mode="nearest",
    ).bool().reshape(batch, scales, 1, height, width)
    channel_mask = torch.zeros(
        (1, 1, channels, 1, 1), device=inputs.device, dtype=torch.bool
    )
    channel_mask[:, :, list(channel_indices)] = True
    mask = spatial & channel_mask
    if not bool(torch.any(mask)):
        # Very small synthetic batches can randomly miss every coarse cell. Keep
        # training defined without changing which semantic channels are eligible.
        mask[0, 0, channel_indices[0], : min(block_size, height), : min(block_size, width)] = True
    return inputs.masked_fill(mask, 0.0), mask


def masked_reconstruction_loss(
    predictions: Any,
    targets: Any,
    masked_pixels: Any,
    *,
    available_pixels: Any | None = None,
) -> Any:
    """Smooth-L1 reconstruction over masked, genuinely measured pixels only."""

    require_torch()
    if predictions.shape != targets.shape or predictions.ndim != 5:
        raise ValueError("reconstruction predictions and targets must be equal (N,S,C,H,W)")
    if masked_pixels.shape != predictions.shape:
        raise ValueError("masked_pixels must match reconstruction targets")
    eligible = masked_pixels.bool()
    if available_pixels is not None:
        if available_pixels.shape != predictions.shape:
            raise ValueError("available_pixels must match reconstruction targets")
        eligible = eligible & available_pixels.bool()
    if not bool(torch.any(eligible)):
        raise ValueError("masked reconstruction has no measured eligible pixels")
    return functional.smooth_l1_loss(predictions[eligible], targets[eligible])


def nt_xent_loss(first: Any, second: Any, temperature: float = 0.2) -> Any:
    require_torch()
    if first.shape != second.shape or first.ndim != 2:
        raise ValueError("contrastive embeddings must be two equal (N, D) tensors")
    if len(first) < 2:
        raise ValueError("contrastive loss requires at least two examples")
    representations = functional.normalize(torch.cat([first, second], dim=0), dim=1)
    logits = representations @ representations.T / temperature
    diagonal = torch.eye(len(logits), device=logits.device, dtype=torch.bool)
    logits = logits.masked_fill(diagonal, -1e9)
    batch_size = len(first)
    targets = (torch.arange(2 * batch_size, device=logits.device) + batch_size) % (2 * batch_size)
    return functional.cross_entropy(logits, targets)


def spatial_nt_xent_loss(
    first: Any,
    second: Any,
    coordinates: Any,
    *,
    temperature: float = 0.2,
    min_negative_distance_m: float = 0.0,
) -> Any:
    """NT-Xent that does not treat nearby overlapping terrain as negatives."""

    require_torch()
    if min_negative_distance_m <= 0:
        return nt_xent_loss(first, second, temperature)
    if first.shape != second.shape or first.ndim != 2:
        raise ValueError("contrastive embeddings must be two equal (N, D) tensors")
    if coordinates.shape != (len(first), 2):
        raise ValueError("coordinates must be shaped (N, 2)")
    if len(first) < 2:
        raise ValueError("contrastive loss requires at least two examples")
    representations = functional.normalize(torch.cat([first, second], dim=0), dim=1)
    logits = representations @ representations.T / temperature
    batch_size = len(first)
    targets = (torch.arange(2 * batch_size, device=logits.device) + batch_size) % (
        2 * batch_size
    )
    doubled_coordinates = torch.cat([coordinates, coordinates], dim=0).float()
    distances = torch.cdist(doubled_coordinates, doubled_coordinates)
    row_indices = torch.arange(2 * batch_size, device=logits.device)
    excluded = distances < float(min_negative_distance_m)
    excluded[row_indices, targets] = False
    excluded[row_indices, row_indices] = True
    logits = logits.masked_fill(excluded, -1e9)
    valid_negatives = torch.sum(~excluded, dim=1) - 1  # remove the positive target
    valid_rows = valid_negatives >= 1
    if not bool(torch.any(valid_rows)):
        raise ValueError(
            "spatial contrastive batch has no sufficiently distant negative pairs"
        )
    return functional.cross_entropy(logits[valid_rows], targets[valid_rows])


def multitask_loss(
    outputs: Dict[str, Any],
    occurrence: Any,
    cpue: Any,
    *,
    cpue_weight: float = 0.5,
    sample_weight: Any | None = None,
) -> Tuple[Any, Dict[str, float]]:
    """Weighted BCE plus positive-only SmoothL1 log-CPUE loss.

    ``sample_weight`` is intended for released CRFS sample-count/reliability
    weights. It is normalized within each batch so absolute survey counts do
    not change the optimizer step scale.
    """

    require_torch()
    occurrence = occurrence.float()
    if sample_weight is None:
        weights = torch.ones_like(occurrence)
    else:
        weights = torch.clamp(sample_weight.float(), min=0.0)
        if weights.shape != occurrence.shape:
            raise ValueError("sample_weight must have the same shape as occurrence")
    weights = weights / torch.clamp(weights.mean(), min=1e-8)
    classification_rows = functional.binary_cross_entropy_with_logits(
        outputs["occurrence_logit"], occurrence, reduction="none"
    )
    classification = torch.sum(classification_rows * weights) / torch.clamp(
        weights.sum(), min=1e-8
    )
    positive = occurrence > 0.5
    if bool(torch.any(positive)):
        regression_rows = functional.smooth_l1_loss(
            outputs["log_cpue"][positive],
            torch.log1p(cpue.float()[positive]),
            reduction="none",
        )
        regression = torch.sum(regression_rows * weights[positive]) / torch.clamp(
            weights[positive].sum(), min=1e-8
        )
    else:
        regression = outputs["log_cpue"].sum() * 0.0
    total = classification + cpue_weight * regression
    return total, {
        "loss": float(total.detach().cpu()),
        "occurrence_loss": float(classification.detach().cpu()),
        "cpue_loss": float(regression.detach().cpu()),
    }


def train_ssl_epoch(
    model: Any,
    loader: Iterable[Any],
    optimizer: Any,
    *,
    device: str = "cpu",
    temperature: float = 0.2,
    min_negative_distance_m: float = 0.0,
) -> float:
    """One explicit self-supervised epoch; checkpointing belongs to the caller."""

    require_torch()
    model.train()
    losses = []
    for batch in loader:
        patches = batch[0] if isinstance(batch, (tuple, list)) else batch
        coordinates = (
            batch[1].to(device)
            if isinstance(batch, (tuple, list)) and len(batch) > 1
            else None
        )
        patches = patches.to(device)
        first = model(augment_terrain_batch(patches))
        second = model(augment_terrain_batch(patches))
        loss = (
            spatial_nt_xent_loss(
                first,
                second,
                coordinates,
                temperature=temperature,
                min_negative_distance_m=min_negative_distance_m,
            )
            if coordinates is not None
            else nt_xent_loss(first, second, temperature)
        )
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        optimizer.step()
        losses.append(float(loss.detach().cpu()))
    if not losses:
        raise ValueError("self-supervised loader produced no batches")
    return sum(losses) / len(losses)


def fine_tune_epoch(
    model: Any,
    loader: Iterable[Any],
    optimizer: Any,
    *,
    device: str = "cpu",
    cpue_weight: float = 0.5,
) -> Mapping[str, float]:
    """One two-head epoch with optional sample weight as the fourth batch item."""

    require_torch()
    model.train()
    totals = []
    occurrence_losses = []
    cpue_losses = []
    for batch in loader:
        if len(batch) == 3:
            patches, occurrence, cpue = batch
            sample_weight = None
        elif len(batch) == 4:
            patches, occurrence, cpue, sample_weight = batch
        else:
            raise ValueError(
                "fine-tuning batches must contain patch, occurrence, cpue, and optional sample_weight"
            )
        outputs = model(patches.to(device))
        loss, parts = multitask_loss(
            outputs,
            occurrence.to(device),
            cpue.to(device),
            cpue_weight=cpue_weight,
            sample_weight=sample_weight.to(device) if sample_weight is not None else None,
        )
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        optimizer.step()
        totals.append(parts["loss"])
        occurrence_losses.append(parts["occurrence_loss"])
        cpue_losses.append(parts["cpue_loss"])
    if not totals:
        raise ValueError("fine-tuning loader produced no batches")
    return {
        "loss": sum(totals) / len(totals),
        "occurrence_loss": sum(occurrence_losses) / len(occurrence_losses),
        "cpue_loss": sum(cpue_losses) / len(cpue_losses),
    }


def architecture_smoke_test(
    batch_size: int = 4,
    patch_size: int = 17,
    *,
    input_channels: int = 6,
    scales: int = 1,
) -> Mapping[str, Any]:
    """Run a shape/loss check only. This is not training or model evaluation."""

    require_torch()
    base_encoder = TerrainResNetEncoder(
        input_channels=input_channels, base_width=16, blocks_per_stage=1
    )
    encoder = MultiScaleTerrainEncoder(base_encoder, scales=scales) if scales > 1 else base_encoder
    ssl_model = TerrainContrastiveModel(encoder, projection_dim=32)
    shape = (
        (batch_size, scales, input_channels, patch_size, patch_size)
        if scales > 1
        else (batch_size, input_channels, patch_size, patch_size)
    )
    inputs = torch.randn(*shape)
    first = ssl_model(augment_terrain_batch(inputs))
    second = ssl_model(augment_terrain_batch(inputs))
    ssl_loss = nt_xent_loss(first, second)
    downstream = CatchMultiTaskModel(encoder)
    outputs = downstream(inputs)
    bag_model = AreaBagCatchModel(encoder)
    bag_inputs = torch.stack([inputs, inputs], dim=1)
    bag_outputs = bag_model(bag_inputs)
    labels = torch.tensor([0, 1] * ((batch_size + 1) // 2))[:batch_size]
    cpue = torch.linspace(0.0, 2.0, batch_size)
    loss, _ = multitask_loss(outputs, labels, cpue)
    return {
        "status": "architecture_smoke_only",
        "input_shape": list(inputs.shape),
        "embedding_shape": list(first.shape),
        "occurrence_shape": list(outputs["occurrence_logit"].shape),
        "cpue_shape": list(outputs["log_cpue"].shape),
        "area_bag_attention_shape": list(bag_outputs["patch_attention"].shape),
        "finite_losses": bool(
            torch.isfinite(ssl_loss)
            and torch.isfinite(loss)
            and torch.all(torch.isfinite(bag_outputs["occurrence_logit"]))
        ),
    }
