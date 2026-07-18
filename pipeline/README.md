# CastingCompass geospatial ML pipeline

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

## Historical v1 site-window validation — do not activate

The commands in this section are retained to reproduce and test the frozen v1
design. They are **not** the production activation path. V1 depends on an
external per-event transparency-log verifier and independent publication
service that do not exist, so its activation is permanently closed. The current
successor is the non-performance collection pilot in
`docs/VALIDATION-SUCCESSOR.md`. Verify its local contracts with:

```bash
npm run verify:validation-successor
```

V2 still requires runtime capture, privacy/legal/data-steward approval, an OSF
registration, storage/restore evidence, and a sealed activation manifest before
the first eligible row. No command below satisfies those gates.

The first-party validation path is separate from terrain-point ingestion. It
can evaluate only the frozen California-halibut curated-site by authoritative
two-hour-window claim. It cannot substantiate probability, biological absence,
precise casting-zone, causal, safety, access, regulatory, or other-species
claims. All inputs and outputs below are private local artifacts and are not
production evidence by themselves.

Production first needs an externally allowlisted Ed25519 exporter/publication
key, a tamper-evident pre-enrollment activation commitment, a trusted server
clock, and append-only proof that the signer issued each full immutable
score/site/window/snapshot/recruitment/consent payload at impression time. A
public key merely declared inside its own unsigned activation manifest proves
internal consistency, not server provenance; neither an arbitrary digest nor a
terminal after-outcome census proves prospective issuance. Seal the empty
activation with the deployed scoring identity; seal times come only from the
trusted clock and cannot be supplied by the caller:

```bash
python3 -m pipeline.contourcast.cli seal-validation-activation \
  --protocol validation/protocols/california-halibut-site-window-v1.json \
  --release-commit FULL_CONTAINING_COMMIT \
  --scoring-system-kind heuristic-configuration \
  --scoring-system-version heuristic-california-halibut-SHA256 \
  --scoring-system-sha256 SHA256 \
  --opportunity-contract-version castingcompass.opportunity/2.0.0 \
  --validation-export-signing-key-id EXTERNALLY_ALLOWLISTED_KEY_ID \
  --validation-export-public-key-ed25519 BASE64_ED25519_PUBLIC_KEY \
  --external-log-anchor-provider-id EXTERNALLY_ALLOWLISTED_ANCHOR_PROVIDER \
  --external-log-anchor-signing-key-id DISTINCT_EXTERNAL_ANCHOR_KEY_ID \
  --external-log-anchor-public-key-ed25519 DISTINCT_BASE64_ED25519_PUBLIC_KEY \
  --output PRIVATE_ACTIVATION.json
```

Assignment sealing accepts an exact, deidentified, label-free JSON/JSONL
envelope. Outcome fields, unknown fields, direct identifiers, reporter hashes,
notes, photos, and coordinates are rejected. Every prospective row must carry
the canonical `castingcompass.validation-impression-attestation/1.0.0`
Ed25519 envelope signed by the activation-pinned key. The evaluator reconstructs
and exactly matches its ordinal score, site/window, model snapshot, recruitment,
consent/intent, cohort, selection-audit, and activation identities, then checks
its pre-outcome time and signature. Python and Worker share
`contracts/fixtures/impression-attestation-vector.json`. The strict companion
opportunity ledger and candidate-prediction JSON files must exactly cover every
prospective assignment. Each manifest assignment freezes the full label-free
row hash, exact candidate-prediction hash, and ordinal score. Supply every prior
manifest in sequence; each batch is cumulative, preserves all earlier
assignment objects byte-semantically, and creates a new chain link.

Primary score exposure is a separate signed event. The assignment attestation
first proves that the score was not yet exposed; if the product later displays
it, a linked first-exposure envelope records the actual time. Only exposure
strictly before effort starts can appear in a sealed prospective row. Exposure
at or after effort start is retained only in terminal reconciliation and is
never backfilled into the row. Safe cancellation remains an issued, unsealed
terminal disposition rather than a negative outcome.

```bash
python3 -m pipeline.contourcast.cli seal-validation-splits \
  --label-free-evidence PRIVATE_LABEL_FREE_EVIDENCE.jsonl \
  --opportunity-ledger PRIVATE_OPPORTUNITY_LEDGER.json \
  --predictions PRIVATE_CANDIDATE_PREDICTIONS.json \
  --manifest-chain PRIVATE_ACTIVATION.json PRIVATE_BATCH_1.json \
  --output PRIVATE_BATCH_2.json
```

After the fixed interval, an activation-key-signed trusted census must bind
every accepted row to one consecutive `export_ordinal` and its completion event
and reconcile every issued assignment, every signed primary exposure event, and every terminal
disposition through one exact millisecond-aligned watermark. Missing issuance
and unmatched exposure counts must be zero, including for an honest zero-row
interval. The local artifact is still only a signed exporter assertion, not
independent append-only-log proof. Seal finalization only after that census;
the finalization freezes the clean source tree, exact Python 3.12 direct and
transitive dependency lock (including `cffi` and `pycparser`), immutable
runtime-image digest, census, and final assignment batch.

```bash
python3 -m pipeline.contourcast.cli seal-validation-finalization \
  --label-free-evidence PRIVATE_LABEL_FREE_EVIDENCE.jsonl \
  --opportunity-ledger PRIVATE_OPPORTUNITY_LEDGER.json \
  --predictions PRIVATE_CANDIDATE_PREDICTIONS.json \
  --census-export SIGNED_TERMINAL_CENSUS.json \
  --manifest-chain PRIVATE_ACTIVATION.json PRIVATE_BATCH_1.json PRIVATE_BATCH_2.json \
  --output PRIVATE_FINALIZATION.json
```

The trusted service then supplies a cumulative signed exclusion, withdrawal,
and deletion ledger together with the complete manifest chain. Every later
ledger strictly advances its timestamps, preserves the prior assignment/event
prefix exactly, and appends events after the predecessor reconciliation
watermark. Exclusion may advance to withdrawal or deletion, withdrawal may
advance only to deletion, and deletion is terminal. Reports preserve both the
first analytical removal and the latest privacy state.
Before labels can be requested, revalidate the frozen evaluator and seal the
exact next label-lock link:

```bash
python3 -m pipeline.contourcast.cli seal-validation-label-lock \
  --manifest-chain PRIVATE_ACTIVATION.json PRIVATE_BATCH_1.json PRIVATE_BATCH_2.json PRIVATE_FINALIZATION.json \
  --output PRIVATE_LABEL_LOCK.json
```

Only after receiving that lock may the trusted exporter issue a signed labeled
export bound to the exact lock and final deletion ledger. The evaluator opens
those held bytes once, writes a receipt before parsing, selects the baseline on
blocks 1–2, predicts every held geography in blocks 3–4, and runs the fixed
2,000-replicate global participant-cluster bootstrap. Each participant's rows
stay together across every panel and block. Unique-group, Kish effective-group,
outcome-class concentration, geography, and temporal-block gates fail to
inconclusive without dropping rows. Secondary source/design results are
descriptive only; there are no secondary hypothesis tests or Holm adjustment.

Because the current census carries no independently verified append-only-log
proof, this invocation emits only a nonpublishable unpublished draft. It
returns `withheld-pending-independent-append-only-log-proof` and creates no
publication request or receipt:

```bash
python3 -m pipeline.contourcast.cli evaluate-site-window \
  --label-free-evidence PRIVATE_LABEL_FREE_EVIDENCE.jsonl \
  --labeled-evidence PRIVATE_LABELED_EVIDENCE.jsonl \
  --opportunity-ledger PRIVATE_OPPORTUNITY_LEDGER.json \
  --predictions PRIVATE_CANDIDATE_PREDICTIONS.json \
  --census-export SIGNED_TERMINAL_CENSUS.json \
  --deletion-reconciliation SIGNED_DELETION_0.json SIGNED_DELETION_1.json \
  --manifest-chain PRIVATE_ACTIVATION.json PRIVATE_BATCH_1.json PRIVATE_BATCH_2.json PRIVATE_FINALIZATION.json \
  --label-lock PRIVATE_LABEL_LOCK.json \
  --label-access-receipt PRIVATE_LABEL_ACCESS_RECEIPT.json \
  --output PRIVATE_VALIDATION_ARCHIVE.json
```

Production first needs the currently unimplemented external proof verifier. It
must consume actual inclusion/consistency proof arrays, checkpoint roots and
tree sizes—not caller-asserted digests—cover every issuance and signed exposure
gaplessly through a terminal checkpoint. Each event must be externally anchored
within 300 seconds; an exposure admitted into a sealed label-free row must also
be anchored before effort starts, while terminal-only post-effort exposure keeps
the 300-second deadline. The terminal checkpoint must cover every issuance and
exposure through `reconciled_through_at`, be anchored at or after that watermark,
and be anchored no more than 300 seconds later. Exact server-authoritative
effort-start/completion events must also be proven. A zero-event stream still
needs that independently signed and anchored zero-size checkpoint with verified
genesis consistency. The anchor provider/key is pinned in activation, distinct
from the exporter, externally allowlisted, and independently custodied.

Only after that proof succeeds may an independent pinned-runtime production
service recompute the analysis, reconcile the final removal high-water mark,
issue and atomically consume a server nonce, and publish in that same operation.
It returns a signed receipt. Supplying that receipt with `--publication-audit`
only verifies and archives it locally; the local output remains
`publishable: false` and can never authorize production publication.

All evidence, manifests, receipts, and archives must live in encrypted private
storage with 0700 directories and 0600 files. The production primary exporter
also requires a deletion-linked, server-authoritative participant token stable
across sessions and devices; the resettable reporter/device token used by the
current public secondary flow is not eligible for primary concentration gates.
The externally anchored at-impression signer/exporter and tamper-evident
issuance log are not live today, so prospective primary activation remains
blocked.

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

Export complete-effort CRFS sample records from the official source and keep
the raw file and query parameters. Before pipeline ingestion, transform each
complete effort segment into one canonical observation v2 JSON object. Flat
catch-only CSVs and expanded estimates are rejected because they cannot supply
truthful zero-catch effort or one-row-per-attempt labels. A JSONL row has this
shape (abbreviated only by having one zero-count target row):

```json
{"contract_version":"castingcompass.observation/2.0.0","taxon_catalog_version":"castingcompass.taxa/1.0.0","contract_status":"valid","observation_id":"crfs:sample-123","effort_segment_id":"crfs:effort-123","primary_target_taxon_id":"california-halibut","source":{"source_id":"cdfw_crfs","source_record_id":"sample-123","data_kind":"complete-effort-segment","complete_attempt":true,"expanded_estimate":false},"target_effort":{"value":2.5,"unit":"angler-hours","mode":"shore"},"temporal_support":{"start_at":"2026-06-01T15:00:00Z","end_at":"2026-06-01T17:30:00Z","precision":"exact"},"spatial_support":{"kind":"site","support_id":"crfs-site-123"},"taxon_observations":[{"taxon_id":"california-halibut","encounter_count":0,"retained_count":0,"released_count":0,"disposition_unknown_count":0,"identification_confidence":"not_observed","identification_basis":"not-observed"}],"outcome_class":"no_fish"}
```

```bash
python3 -m pipeline.contourcast.cli ingest-observations \
  --input data/canonical/crfs_observations.jsonl \
  --output data/processed/observations.csv \
  --source-id cdfw_crfs \
  --primary-target-taxon-id california-halibut \
  --expected-sha256 'REPLACE_WITH_REAL_SHA256'
```

Every record must declare the same primary target. Per-taxon rows distinguish
`target_encountered`, `non_target_only`, and `no_fish`; unresolved non-target
fish remain `unresolved-fish` rather than being promoted to a named species.
Area/site rows and bounded-time rows are retained for descriptive analysis but
receive `terrain_model_eligible=false`. Only exact-time, legitimately released
point coordinates in the raster's exact projected CRS may enter patch models.
The flattened `sample_weight` is always `1.0` per complete effort segment; it
is never a survey expansion weight.

```bash
python3 -m pipeline.contourcast.cli validate \
  --bathymetry data/processed/bathymetry.npz \
  --observations data/processed/observations.csv \
  --target-taxon-id california-halibut

python3 -m pipeline.contourcast.cli evaluate-baselines \
  --terrain data/processed/terrain.npz \
  --observations data/processed/observations.csv \
  --output-dir artifacts/real-baseline-v1 \
  --dataset-kind real_observations \
  --target-taxon-id california-halibut \
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
python3.12 -m venv .venv-geo-deep
.venv-geo-deep/bin/python -m pip install --only-binary=:all: --require-hashes \
  --index-url https://pypi.org/simple \
  -r pipeline/requirements-geo-deep-macos-arm64.lock
CC_OPTIONAL_STACK=macos-arm64 CC_REQUIRE_MPS=1 \
  .venv-geo-deep/bin/python pipeline/scripts/check_geo_deep_environment.py
PYTHON_BIN=.venv-geo-deep/bin/python \
  pipeline/scripts/run_usgs_sf_2m_ssl_pilot.sh
```

That command is specifically for CPython 3.12 on macOS 15+ ARM64. Linux x86-64 CPU
uses `requirements-geo-deep-linux-cpu.lock` with PyPI plus the official PyTorch CPU
index, as exercised by `.github/workflows/optional-python.yml`. CUDA, ROCm, Windows,
and other platforms require separate reviewed locks and platform tests before use.

The pilot crop is 4.096 km square and uses 512 locations with 64 m, 256 m,
and 1,024 m diameter views. The full-area path below streams tiled GeoTIFF/COG
windows instead of materializing every derived channel in one feature stack.

The production-scale corpus path streams the complete source survey in
overlapping tiles and reproduces the recorded 4,096-location SSL v1 run:

```bash
PYTHON_BIN=.venv-geo-deep/bin/python \
  pipeline/scripts/run_usgs_sf_2m_full_pretraining.sh
```

The complete run uses five spatial regions, 20 epochs, nearby-negative
exclusion, and a wider encoder. Its checkpoint remains research-only until it
passes an independently labeled seafloor-character or habitat probe.

Run the strict substrate-component probe with:

```bash
PYTHON_BIN=.venv-geo-deep/bin/python \
  pipeline/scripts/run_usgs_sf_2m_seafloor_probe.sh
```

The probe compares the frozen pretrained encoder with an identical random
encoder, classical ten-channel summaries, and depth-only summaries. It removes
the source raster's composite depth/slope digits and uses the same region that
was held out during self-supervised pretraining.

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
