# USGS Offshore San Francisco hybrid seafloor probes v1

**Run date:** 2026-07-22 UTC

**Source commit:** `a0720cd565bde9382695b6c4af8e6c380828edf7`

**Receipt:** [`hybrid-seafloor-probes-v1`](../../pipeline/evidence/hybrid-seafloor-probes-v1.receipt.json)

## Question and frozen decision rule

Do the bathymetry-only, backscatter-only, or fused frozen encoders transfer to
historical mapped seafloor character better than architecture-matched random
encoders and input-matched classical summaries?

The answer is allowed to select a better *research representation*. It cannot
promote a model, validate California-halibut skill, alter the Opportunity Score,
or choose a production configuration. The USGS character target was interpreted
from bathymetry, backscatter, and video, so this is not an independent biological
endpoint or evidence that inputs predict information absent from their source.

## Common substrate probe

The common probe samples the USGS map at the same 4,096 corpus locations and
removes the composite depth-zone and slope digits. Codes 1, 2/3, and 4 become
smooth sediment, mixed/rugose rock, and mobile coarse sediment. Anthropogenic
codes 5/6 are excluded and evaluated separately.

- The exact pretraining validation fold `3` is reused without inspecting labels.
- Fitting uses 3,183 labeled rows and evaluation uses 903 held-out rows.
- Held-out class counts are 804 smooth, 67 mixed/rugose, and 32 mobile coarse.
- Every encoder remains frozen. Only a scaled balanced logistic probe is fit.
- Classical summaries and each random encoder see exactly the channels available
  to their corresponding modality.
- The 1,000 paired bootstrap draws resample held-out rows within class.

| Representation | Macro F1 | Balanced accuracy | Log loss |
| --- | ---: | ---: | ---: |
| Bathymetry pretrained | 0.6462 | 0.6699 | 0.2978 |
| Bathymetry random | 0.3845 | 0.3742 | 0.5857 |
| Bathymetry classical summaries | 0.5865 | 0.7142 | 0.4263 |
| Backscatter pretrained | 0.6348 | 0.6673 | 0.3738 |
| Backscatter random | 0.6389 | 0.6614 | 0.3240 |
| Backscatter classical summaries | 0.4541 | 0.6036 | 0.6744 |
| Fused pretrained | 0.7020 | 0.7939 | **0.2474** |
| Fused random | 0.5325 | 0.4647 | 0.4969 |
| Fused classical summaries | **0.7574** | **0.8767** | 0.3336 |
| Depth-only summaries | 0.3140 | 0.3333 | 0.6093 |

The fused encoder exceeded bathymetry pretraining by median macro-F1 `+0.0533`
(95% interval `+0.0048` to `+0.1112`) and backscatter pretraining by `+0.0646`
(`+0.0133` to `+0.1134`). It nevertheless remained below fused classical
summaries by `-0.0555` (`-0.1088` to `-0.0087`). Backscatter pretraining did not
reliably exceed its random encoder.

## Rare mapped-structure probe

The uniform pretraining sample contained zero anthropogenic centers even though
the complete character map contains 50,799 code-5 pixels and 3,610 code-6
pixels. The separate rare probe corrects that sampling failure without mixing
its class balance into the common-area result.

- Smooth and rugged anthropogenic centers must be at least three native cells,
  approximately 6 m, across in their own mapped class.
- Sixty-four centers per rare class are retained with 64 nearby natural controls
  sampled 16–128 m away.
- The balanced 192-row case-control corpus retains 82 connected components. It
  cannot estimate natural prevalence or population accuracy.
- Whole connected components are assigned to one of three geographic regions.
  Fold `0` was chosen using label/coordinate support only.
- Training centers within 512 m of any held-out center are excluded. The final
  split contains 72 training rows, 92 test rows, 28 buffer exclusions, 34
  training components, 37 test components, and zero component overlap.
- The 1,000 paired bootstrap draws resample held-out connected components within
  rare class, never individual pixels.

| Representation | Macro F1 | Balanced accuracy | Log loss |
| --- | ---: | ---: | ---: |
| Bathymetry pretrained | 0.6651 | 0.6651 | 1.0440 |
| Bathymetry random | 0.6380 | 0.6385 | **0.9691** |
| Bathymetry classical summaries | **0.7795** | **0.7806** | 1.1474 |
| Backscatter pretrained | 0.4532 | 0.4885 | 3.2269 |
| Backscatter random | 0.4240 | 0.4561 | 3.2764 |
| Backscatter classical summaries | 0.5060 | 0.5313 | 1.6076 |
| Fused pretrained | 0.7259 | 0.7256 | 1.3354 |
| Fused random | 0.5792 | 0.6067 | 1.0787 |
| Fused classical summaries | 0.7535 | 0.7534 | 1.4208 |
| Depth-only summaries | 0.6048 | 0.6074 | 1.0182 |

The fused encoder exceeded its random initialization by median macro-F1
`+0.1514` (component-bootstrap 95% interval `+0.0467` to `+0.2647`) and
backscatter pretraining by `+0.2774` (`+0.1515` to `+0.4021`). Its advantage over
bathymetry pretraining was inconclusive, as was its difference from fused
classical summaries. Bathymetry classical summaries produced the highest point
macro F1.

## Reproduction and decision

Two builds of the rare corpus were byte-identical at SHA-256
`9ea0b540e18760bb3ac9a144dcba4df5d88f05c1491f1bceb341482731072741`.
Two common-probe runs produced identical metrics and predictions bytes; two
rare-probe runs did the same. The minimized receipt preserves exact corpus,
checkpoint, source, metrics, prediction, and clean-source identities.

The fused encoder is the best deep representation in this frozen experiment,
but no encoder is promoted. Classical summaries remain the stronger common
substrate baseline and are not reliably beaten on the rare case-control probe.
The next model work should diagnose why learned backscatter features trail simple
summaries, test source-seam shortcuts and missingness dependence, and evaluate an
independently released habitat/video target before any fishing-label work.
