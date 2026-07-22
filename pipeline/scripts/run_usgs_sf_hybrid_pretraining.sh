#!/usr/bin/env bash
set -euo pipefail

# Reproduce the frozen three-way USGS bathymetry/backscatter experiment.

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
DEVICE="${DEVICE:-mps}"
OUTPUT_ROOT="${1:-$ROOT_DIR/work/usgs-sf-hybrid-v1}"
RAW_DIR="$OUTPUT_ROOT/raw"
EXTRACTED_DIR="$RAW_DIR/extracted"
PROCESSED_DIR="$OUTPUT_ROOT/processed"
ARTIFACT_DIR="$OUTPUT_ROOT/artifacts"
CORPUS_PATH="$PROCESSED_DIR/usgs-sf-hybrid-corpus-v1.npz"

FILENAMES=(
  "Bathymetry_OffshoreSanFrancisco.zip"
  "BackscatterA_8101_2004_OffshoreSanFrancisco.zip"
  "BackscatterB_8101_2007_OffshoreSanFrancisco.zip"
  "BackscatterC_8101_2008_OffshoreSanFrancisco.zip"
  "BackscatterD_7125_2006_OffshoreSanFrancisco.zip"
)
ARCHIVE_SHA256=(
  "79c93fac3ae3d35213b808b3913115744676c03aead72a686651817e86d5be53"
  "b4d60827335870c896f8f655dfc33d37e0eb7c86f814124e16546d2fb8c7fc2b"
  "20d4b6eea5c8610ade7efe01ff5d2056add40963d9e302e89d1afd1411904e84"
  "7222d45f50c08380da44eeda8039112f1e47417fb17168e9810ff1b897a1c881"
  "c78b31386069ea01d1414aa991d225d413dd778d14bb2acfcd1556b9e767156b"
)
GEOTIFF_FILENAMES=(
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

mkdir -p "$RAW_DIR" "$EXTRACTED_DIR" "$PROCESSED_DIR" "$ARTIFACT_DIR"
for index in "${!FILENAMES[@]}"; do
  archive="$RAW_DIR/${FILENAMES[$index]}"
  if [[ ! -f "$archive" ]]; then
    curl -L --fail --retry 3 \
      -o "$archive" \
      "https://pubs.usgs.gov/ds/781/OffshoreSanFrancisco/data/${FILENAMES[$index]}"
  fi
  if [[ "$(hash_file "$archive")" != "${ARCHIVE_SHA256[$index]}" ]]; then
    echo "USGS archive checksum mismatch: ${FILENAMES[$index]}" >&2
    exit 1
  fi
  geotiff="$EXTRACTED_DIR/${GEOTIFF_FILENAMES[$index]}"
  if [[ ! -f "$geotiff" ]]; then
    unzip -o "$archive" -d "$EXTRACTED_DIR" >/dev/null
  fi
  if [[ "$(hash_file "$geotiff")" != "${GEOTIFF_SHA256[$index]}" ]]; then
    echo "USGS GeoTIFF checksum mismatch: ${GEOTIFF_FILENAMES[$index]}" >&2
    exit 1
  fi
done

ALIGNED_ARGS=()
for index in 1 2 3 4; do
  ALIGNED_ARGS+=(
    --aligned-layer "${LAYER_NAMES[$index]}=$EXTRACTED_DIR/${GEOTIFF_FILENAMES[$index]}"
    --aligned-layer-sha256 "${LAYER_NAMES[$index]}=${GEOTIFF_SHA256[$index]}"
  )
done

cd "$ROOT_DIR"
"$PYTHON_BIN" -m pipeline.contourcast.cli build-geotiff-pretraining-corpus \
  --input "$EXTRACTED_DIR/${GEOTIFF_FILENAMES[0]}" \
  --output "$CORPUS_PATH" \
  --source-id usgs_sf_state_waters_2m \
  --vertical-datum NAVD88 \
  --expected-sha256 "${GEOTIFF_SHA256[0]}" \
  --radii-m 32 128 512 \
  --output-size 33 \
  --stride-m 64 \
  --max-centers 4096 \
  --min-valid-fraction 0.8 \
  --min-aligned-valid-fraction 0.5 \
  --local-radius 4 \
  --broad-radius 24 \
  --relief-radius 8 \
  --horizontal-accuracy-m 2 \
  --tile-size 1024 \
  --seed 42 \
  "${ALIGNED_ARGS[@]}"

for modality in bathymetry backscatter fused; do
  "$PYTHON_BIN" -m pipeline.contourcast.cli pretrain-hybrid-seafloor \
    --corpus "$CORPUS_PATH" \
    --output-dir "$ARTIFACT_DIR/$modality" \
    --modality "$modality" \
    --epochs 20 \
    --batch-size 64 \
    --learning-rate 0.0003 \
    --weight-decay 0.0001 \
    --base-width 32 \
    --blocks-per-stage 2 \
    --projection-dim 128 \
    --temperature 0.2 \
    --min-negative-distance-m 512 \
    --reconstruction-weight 1 \
    --mask-fraction 0.25 \
    --mask-block-size 4 \
    --split-regions 5 \
    --validation-fold 3 \
    --device "$DEVICE" \
    --seed 42
done

echo "Hybrid corpus: $CORPUS_PATH"
echo "Hybrid artifacts: $ARTIFACT_DIR"
