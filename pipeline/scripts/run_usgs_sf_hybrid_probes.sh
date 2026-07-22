#!/usr/bin/env bash
set -euo pipefail

# Reproduce the common substrate and component-held-out rare-structure probes.
# Run run_usgs_sf_hybrid_pretraining.sh first, or point HYBRID_ROOT at its output.

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
DEVICE="${DEVICE:-mps}"
HYBRID_ROOT="${HYBRID_ROOT:-$ROOT_DIR/work/usgs-sf-hybrid-v1}"
OUTPUT_ROOT="${1:-$ROOT_DIR/work/usgs-sf-hybrid-probes-v1}"
RAW_DIR="$OUTPUT_ROOT/raw"
RESULT_DIR="$OUTPUT_ROOT/results"
PROBE_CORPUS="$OUTPUT_ROOT/processed/usgs-sf-rare-structure-corpus-v1.npz"
LABEL_ARCHIVE="$RAW_DIR/SeafloorCharacter_OffshoreSanFrancisco.zip"
LABEL_TIF="$RAW_DIR/seafloor-character/SeafloorCharacter_OffshoreSanFrancisco.tif"

CORPUS_PATH="${CORPUS_PATH:-$HYBRID_ROOT/processed/usgs-sf-hybrid-corpus-v1.npz}"
BATHYMETRY_CHECKPOINT="${BATHYMETRY_CHECKPOINT:-$HYBRID_ROOT/artifacts/bathymetry/bathymetry_hybrid_encoder.pt}"
BACKSCATTER_CHECKPOINT="${BACKSCATTER_CHECKPOINT:-$HYBRID_ROOT/artifacts/backscatter/backscatter_hybrid_encoder.pt}"
FUSED_CHECKPOINT="${FUSED_CHECKPOINT:-$HYBRID_ROOT/artifacts/fused/fused_hybrid_encoder.pt}"
EXTRACTED_DIR="${EXTRACTED_DIR:-$HYBRID_ROOT/raw/extracted}"

LABEL_URL="https://pubs.usgs.gov/ds/781/OffshoreSanFrancisco/data/SeafloorCharacter_OffshoreSanFrancisco.zip"
LABEL_ARCHIVE_SHA256="a826cca8611ff4b5445ae398f1ad419813435876db2aa5810e76a73c83225c3b"
LABEL_SHA256="224ea4ed70c02769e08b3b971b9adae6c5853f2af7130587604e8f49ba6d035e"
CORPUS_SHA256="dd88342209522d12726208259640fe7ac9379a61fa79cd9e606475945dd9af4a"
BATHYMETRY_CHECKPOINT_SHA256="3261b5328290d5e9992c6ae19d3670eff5ad4d0b47027442bcd04bfaa36edbce"
BACKSCATTER_CHECKPOINT_SHA256="edb8e6579bac3f76b74b11b3ba91d7bb363605172fa6d5abc52edf4bc0b8d5e2"
FUSED_CHECKPOINT_SHA256="7ccff84da4ea0799cc4f87b0d63b39ccb6e943d95ca082da6b38e6aa8a6f7156"

GEOTIFFS=(
  "Bathymetry_OffshoreSanFrancisco.tif"
  "BackscatterA_8101_2004_OffshoreSanFrancisco.tif"
  "BackscatterB_8101_2007_OffshoreSanFrancisco.tif"
  "BackscatterC_8101_2008_OffshoreSanFrancisco.tif"
  "BackscatterD_7125_2006_OffshoreSanFrancisco.tif"
)
GEOTIFF_SHA256=(
  "75629f6a8bc7e3ea78fb6b3b22c737ec75a8cba1621f2c0066a2343ab61a242a"
  "6fd2b9d9b9109d7a2b8f7cf3eaee2dbda9102c09295e8760a663015b92162bf0"
  "9910dc1a1b5726f4866eee8d4a07702fa85048a78c993dc522d0213ae141be34"
  "8885f1414fd4638981f8a0ede253b825b9d331c73ca3d4c7004665127ed3d8d2"
  "f44b5ebbabe5f979fbc49ce65704cf3b4f354a826cf7cab61f22f0dc64bdd972"
)
LAYER_NAMES=(
  ""
  "backscatter_intensity_8101_2004"
  "backscatter_intensity_8101_2007"
  "backscatter_intensity_8101_2008"
  "backscatter_intensity_7125_2006"
)

hash_file() {
  "$PYTHON_BIN" - "$1" <<'PY'
import hashlib
import sys
from pathlib import Path

digest = hashlib.sha256()
with Path(sys.argv[1]).open("rb") as handle:
    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
        digest.update(chunk)
print(digest.hexdigest())
PY
}

require_hash() {
  local path="$1"
  local expected="$2"
  if [[ ! -f "$path" ]]; then
    echo "Required artifact is absent: $path" >&2
    echo "Run pipeline/scripts/run_usgs_sf_hybrid_pretraining.sh first." >&2
    exit 1
  fi
  if [[ "$(hash_file "$path")" != "$expected" ]]; then
    echo "Artifact checksum mismatch: $path" >&2
    exit 1
  fi
}

mkdir -p "$RAW_DIR" "$RESULT_DIR/common" "$RESULT_DIR/rare" "$(dirname "$PROBE_CORPUS")"
if [[ ! -f "$LABEL_ARCHIVE" ]]; then
  curl -L --fail --retry 3 -o "$LABEL_ARCHIVE" "$LABEL_URL"
fi
require_hash "$LABEL_ARCHIVE" "$LABEL_ARCHIVE_SHA256"
if [[ ! -f "$LABEL_TIF" ]]; then
  mkdir -p "$(dirname "$LABEL_TIF")"
  unzip -o "$LABEL_ARCHIVE" -d "$(dirname "$LABEL_TIF")" >/dev/null
fi
require_hash "$LABEL_TIF" "$LABEL_SHA256"
require_hash "$CORPUS_PATH" "$CORPUS_SHA256"
require_hash "$BATHYMETRY_CHECKPOINT" "$BATHYMETRY_CHECKPOINT_SHA256"
require_hash "$BACKSCATTER_CHECKPOINT" "$BACKSCATTER_CHECKPOINT_SHA256"
require_hash "$FUSED_CHECKPOINT" "$FUSED_CHECKPOINT_SHA256"
for index in "${!GEOTIFFS[@]}"; do
  require_hash "$EXTRACTED_DIR/${GEOTIFFS[$index]}" "${GEOTIFF_SHA256[$index]}"
done

ALIGNED_ARGS=()
for index in 1 2 3 4; do
  ALIGNED_ARGS+=(
    --aligned-layer "${LAYER_NAMES[$index]}=$EXTRACTED_DIR/${GEOTIFFS[$index]}"
    --aligned-layer-sha256 "${LAYER_NAMES[$index]}=${GEOTIFF_SHA256[$index]}"
  )
done

cd "$ROOT_DIR"
"$PYTHON_BIN" -m pipeline.contourcast.cli probe-hybrid-seafloor-character \
  --corpus "$CORPUS_PATH" \
  --bathymetry-checkpoint "$BATHYMETRY_CHECKPOINT" \
  --backscatter-checkpoint "$BACKSCATTER_CHECKPOINT" \
  --fused-checkpoint "$FUSED_CHECKPOINT" \
  --labels "$LABEL_TIF" \
  --output-dir "$RESULT_DIR/common" \
  --label-sha256 "$LABEL_SHA256" \
  --validation-fold 3 \
  --split-regions 5 \
  --batch-size 64 \
  --device "$DEVICE" \
  --bootstrap-samples 1000 \
  --seed 42

"$PYTHON_BIN" -m pipeline.contourcast.cli build-rare-structure-corpus \
  --input "$EXTRACTED_DIR/${GEOTIFFS[0]}" \
  --labels "$LABEL_TIF" \
  --output "$PROBE_CORPUS" \
  --source-id usgs_sf_state_waters_2m \
  --vertical-datum NAVD88 \
  --expected-sha256 "${GEOTIFF_SHA256[0]}" \
  --label-sha256 "$LABEL_SHA256" \
  --samples-per-class 64 \
  --candidate-multiplier 1.75 \
  --spacing-m 8 \
  --minimum-resolvable-cells 3 \
  --control-min-distance-m 16 \
  --control-max-distance-m 128 \
  --radii-m 32 128 512 \
  --output-size 33 \
  --min-valid-fraction 0.8 \
  --min-aligned-valid-fraction 0.5 \
  --local-radius 4 \
  --broad-radius 24 \
  --relief-radius 8 \
  --horizontal-accuracy-m 2 \
  --tile-size 1024 \
  --split-regions 3 \
  --seed 42 \
  "${ALIGNED_ARGS[@]}"

"$PYTHON_BIN" -m pipeline.contourcast.cli probe-rare-seafloor-structure \
  --probe-corpus "$PROBE_CORPUS" \
  --pretraining-corpus "$CORPUS_PATH" \
  --bathymetry-checkpoint "$BATHYMETRY_CHECKPOINT" \
  --backscatter-checkpoint "$BACKSCATTER_CHECKPOINT" \
  --fused-checkpoint "$FUSED_CHECKPOINT" \
  --labels "$LABEL_TIF" \
  --output-dir "$RESULT_DIR/rare" \
  --buffer-m 512 \
  --batch-size 64 \
  --device "$DEVICE" \
  --bootstrap-samples 1000 \
  --seed 42

echo "Common probe metrics: $RESULT_DIR/common/hybrid_seafloor_probe_metrics.json"
echo "Rare probe metrics: $RESULT_DIR/rare/rare_structure_probe_metrics.json"
