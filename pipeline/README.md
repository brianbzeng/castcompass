# ContourCast geospatial ML pipeline

This directory contains a reproducible, leakage-aware foundation for learning
seafloor representations and, once suitable labels exist, modeling
recreational-fishing occurrence and positive-catch CPUE. Downloaded government
rasters and model checkpoints are intentionally ignored by Git. No catch-skill
claim is made from self-supervised bathymetry training.

## Lightweight smoke test

The smoke path uses only NumPy, pandas, and scikit-learn. It creates a fictional
UTM raster and fictional catch records, then exercises terrain derivation,
patch extraction, spatially blocked folds, three baselines, four ablations, and
versioned run metadata.

```bash
python3 -m pipeline.contourcast.cli smoke \
  --output-dir /tmp/contourcast-smoke \
  --seed 42

python3 -m unittest discover -s pipeline/tests -v
```

Any numbers under the smoke output are synthetic plumbing-test results, not
habitat, fishing, or model-quality claims.

## Official-source workflow

List source stewards and official access pages:

```bash
python3 -m pipeline.contourcast.cli sources
```

Download the selected NOAA CUDEM/Coastal Relief product and its metadata from
the official viewer. Record the exact product/version, access date, published
CRS, vertical datum, and SHA-256. Reproject externally to a north-up,
metre-based local CRS if needed; do not relabel the CRS.

```bash
python3 -m pipeline.contourcast.cli ingest-bathymetry \
  --input data/raw/noaa_tile.tif \
  --output data/processed/bathymetry.npz \
  --source-id noaa_ncei_cudem \
  --vertical-datum 'PUBLISHED DATUM' \
  --expected-sha256 'REPLACE_WITH_REAL_SHA256'

python3 -m pipeline.contourcast.cli derive-terrain \
  --bathymetry data/processed/bathymetry.npz \
  --output data/processed/terrain.npz
```

For deep representation learning, derive the ten-channel structure contract.
It retains the six baseline channels and adds local relief, rugosity, and two
orientation channels. The resolution audit records which physical feature
widths are actually supportable by the native grid.

```bash
python3 -m pipeline.contourcast.cli derive-structure \
  --bathymetry data/processed/bathymetry.npz \
  --output data/processed/structure.npz \
  --local-radius 4 \
  --broad-radius 24 \
  --relief-radius 8 \
  --horizontal-accuracy-m 2

python3 -m pipeline.contourcast.cli audit-resolution \
  --bathymetry data/processed/bathymetry.npz \
  --horizontal-accuracy-m 2 \
  --feature-widths-m 1 2 5 10 20 50 100
```

Aligned acoustic backscatter, seafloor-character, uncertainty, survey-age, or
optical kelp/surf layers can be appended with an explicit availability mask.
Missing coverage is therefore observable to the model rather than silently
median-filled.

Export CRFS sample data or estimates from the official RecFIN warehouse. Keep
the raw file and query parameters. A column map is a JSON object from canonical
name to export column, for example:

```json
{
  "event_id": "SOURCE_SAMPLE_ID",
  "species": "COMMON_NAME",
  "catch_count": "OBSERVED_CATCH",
  "effort_hours": "ANGLER_HOURS",
  "sample_weight": "SAMPLES"
}
```

```bash
python3 -m pipeline.contourcast.cli ingest-observations \
  --input data/raw/recfin_export.csv \
  --output data/processed/observations.csv \
  --source-id cdfw_crfs \
  --column-map data/raw/column_map.json \
  --expected-sha256 'REPLACE_WITH_REAL_SHA256'
```

Area-level rows are retained for aggregate analysis but receive
`terrain_model_eligible=false`. Only legitimately released point coordinates in
the raster's exact projected CRS may enter patch models.

```bash
python3 -m pipeline.contourcast.cli validate \
  --bathymetry data/processed/bathymetry.npz \
  --observations data/processed/observations.csv

python3 -m pipeline.contourcast.cli evaluate-baselines \
  --terrain data/processed/terrain.npz \
  --observations data/processed/observations.csv \
  --output-dir artifacts/real-baseline-v1 \
  --dataset-kind real_observations \
  --splits 5 \
  --buffer-m 250
```

## Optional dependencies

- `rasterio`: read official GeoTIFFs during bathymetry ingestion.
- `pyproj`: independently verify that CRS axes are projected metres.
- `torch`: run the six-channel ResNet self-supervised/fine-tuning scaffold.

Install optional packages in an isolated environment using the platform- and
accelerator-appropriate versions. No Python environment is silently modified by
this repository.

When PyTorch is installed, this checks architecture shapes and finite losses;
it does not train or evaluate a model:

```bash
python3 -m pipeline.contourcast.cli deep-smoke
```

Build three physical views around every training center and pretrain a shared
encoder with learned scale attention. Resampling makes tensor sizes consistent
but never upgrades source resolution.

```bash
python3 -m pipeline.contourcast.cli build-pretraining-corpus \
  --feature-stack data/processed/structure.npz \
  --output data/processed/pretraining-corpus.npz \
  --radii-m 32 128 512 \
  --output-size 33 \
  --stride-m 50 \
  --max-centers 2000

python3 -m pipeline.contourcast.cli pretrain-bathymetry \
  --corpus data/processed/pretraining-corpus.npz \
  --output-dir artifacts/bathymetry-ssl-v1 \
  --epochs 25 \
  --batch-size 32
```

`pretrain-bathymetry` holds out a complete geographic region, fits robust
normalization on training geography only, trains orientation-preserving
SimCLR views, excludes nearby overlapping terrain from the negative-pair set,
and saves the best checkpoint plus hashes, configuration, and loss history.
NT-Xent is an optimization diagnostic, not catch accuracy.

## Reproducible USGS 2 m pilot

The first official-data pilot uses the USGS Offshore of San Francisco 2 m
multibeam bathymetry product. It verifies the public-data download, checksum,
crop, ten-channel feature, three-scale corpus, geographic holdout, training,
and checkpoint path:

```bash
python3 -m venv --system-site-packages .venv-geo-deep
.venv-geo-deep/bin/pip install -r pipeline/requirements-geo-deep.txt
PYTHON_BIN=.venv-geo-deep/bin/python \
  pipeline/scripts/run_usgs_sf_2m_ssl_pilot.sh
```

The pilot crop is 4.096 km square and uses 512 locations with 64 m, 256 m,
and 1,024 m diameter views. Full-area training should stream tiled GeoTIFF/COG
windows instead of materializing every derived channel in one NPZ.

## Outputs

- Canonical bathymetry: compressed NPZ plus provenance JSON.
- Terrain stack: six-channel NPZ plus derivation statistics/provenance JSON.
- Structure stack: ten or more declared channels, resolution audit, and optional
  auxiliary-layer availability masks.
- Pretraining corpus: multiscale `(location, scale, channel, row, column)` NPZ
  with physical footprints and source-resolution warnings.
- Encoder checkpoint: weights, fold-local normalization, channel/scale contract,
  source hash, and a representation-only claim boundary.
- Observations: canonical CSV plus provenance JSON.
- Evaluation: per-fold and aggregate JSON for each baseline/ablation.
- Run metadata: input hashes, full configuration, runtime, Git revision,
  experiment version, and model version.

See [the dataset card](../docs/DATASET_CARD.md) and
[the model card](../docs/MODEL_CARD.md) before using real data.
