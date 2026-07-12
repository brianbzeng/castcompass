#!/usr/bin/env bash
set -euo pipefail

# Reproduce the first official-data ContourCast representation-learning pilot.
# This downloads public USGS data and writes only to ignored data/artifact paths.

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
OUTPUT_ROOT="${1:-$ROOT_DIR/work/usgs-sf-2m-pilot}"
EPOCHS="${EPOCHS:-10}"
SOURCE_URL="https://pubs.usgs.gov/ds/781/OffshoreSanFrancisco/data/Bathymetry_OffshoreSanFrancisco.zip"
SOURCE_SHA256="79c93fac3ae3d35213b808b3913115744676c03aead72a686651817e86d5be53"

RAW_DIR="$OUTPUT_ROOT/raw"
PROCESSED_DIR="$OUTPUT_ROOT/processed"
ARTIFACT_DIR="$OUTPUT_ROOT/artifacts"
ZIP_PATH="$RAW_DIR/Bathymetry_OffshoreSanFrancisco.zip"
UNPACKED_DIR="$RAW_DIR/usgs-sf-2m"
SOURCE_TIF="$UNPACKED_DIR/Bathymetry_OffshoreSanFrancisco.tif"
PILOT_TIF="$PROCESSED_DIR/usgs-sf-2m-pilot.tif"

mkdir -p "$RAW_DIR" "$PROCESSED_DIR" "$ARTIFACT_DIR"
if [[ ! -f "$ZIP_PATH" ]]; then
  curl -L --fail --retry 3 -o "$ZIP_PATH" "$SOURCE_URL"
fi

actual_sha256="$($PYTHON_BIN - "$ZIP_PATH" <<'PY'
import hashlib
import sys
from pathlib import Path

digest = hashlib.sha256()
with Path(sys.argv[1]).open("rb") as handle:
    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
        digest.update(chunk)
print(digest.hexdigest())
PY
)"
if [[ "$actual_sha256" != "$SOURCE_SHA256" ]]; then
  echo "USGS archive checksum mismatch" >&2
  exit 1
fi

if [[ ! -f "$SOURCE_TIF" ]]; then
  mkdir -p "$UNPACKED_DIR"
  unzip -o "$ZIP_PATH" -d "$UNPACKED_DIR" >/dev/null
fi

# A fully valid 4.096 km square pilot window near the Golden Gate approach.
"$(dirname "$PYTHON_BIN")/rio" clip "$SOURCE_TIF" "$PILOT_TIF" \
  --bounds '534724 4178786 538820 4182882' --overwrite

pilot_sha256="$($PYTHON_BIN - "$PILOT_TIF" <<'PY'
import hashlib
import sys
from pathlib import Path

digest = hashlib.sha256(Path(sys.argv[1]).read_bytes())
print(digest.hexdigest())
PY
)"

cd "$ROOT_DIR"
"$PYTHON_BIN" -m pipeline.contourcast.cli ingest-bathymetry \
  --input "$PILOT_TIF" \
  --output "$PROCESSED_DIR/bathymetry.npz" \
  --source-id usgs_sf_state_waters_2m \
  --vertical-datum NAVD88 \
  --expected-sha256 "$pilot_sha256"

"$PYTHON_BIN" -m pipeline.contourcast.cli derive-structure \
  --bathymetry "$PROCESSED_DIR/bathymetry.npz" \
  --output "$PROCESSED_DIR/structure.npz" \
  --local-radius 4 \
  --broad-radius 24 \
  --relief-radius 8 \
  --horizontal-accuracy-m 2

"$PYTHON_BIN" -m pipeline.contourcast.cli build-pretraining-corpus \
  --feature-stack "$PROCESSED_DIR/structure.npz" \
  --output "$PROCESSED_DIR/pretraining-corpus.npz" \
  --radii-m 32 128 512 \
  --output-size 33 \
  --stride-m 50 \
  --max-centers 512 \
  --min-valid-fraction 1.0 \
  --seed 42

"$PYTHON_BIN" -m pipeline.contourcast.cli pretrain-bathymetry \
  --corpus "$PROCESSED_DIR/pretraining-corpus.npz" \
  --output-dir "$ARTIFACT_DIR/pretraining" \
  --epochs "$EPOCHS" \
  --batch-size 32 \
  --base-width 16 \
  --blocks-per-stage 1 \
  --projection-dim 64 \
  --min-negative-distance-m 512 \
  --split-regions 4 \
  --validation-fold 0 \
  --device auto \
  --seed 42

echo "Pilot artifacts: $ARTIFACT_DIR/pretraining"
