# CastingCompass model card

**Status:** multiscale encoder and exactly reproduced full-survey official-
bathymetry self-supervised pretraining implemented; catch heads remain
untrained; no catch performance measured.

**Version:** 0.3.0

## Model purpose

CastingCompass explores whether bathymetric structure contains useful signal for:

1. recreational catch occurrence for a declared target species; and
2. positive-catch CPUE conditional on an observed catch.

Outputs are experimental research signals. They are not navigation advice,
fishing regulation, a stock assessment, a conservation decision, a safety
warning, or a guarantee of catch. The product must expose uncertainty and data
coverage instead of presenting predictions as live biological truth.

## Implemented comparison models

Three classical baselines use fold-local patch summaries (center, mean,
standard deviation, minimum, and maximum for each selected channel):

- **Naive:** training-fold prevalence and mean positive-catch CPUE;
- **Linear:** standardized class-weighted logistic regression plus Ridge
  regression on `log1p(CPUE)` for positive training catches;
- **Boosted:** histogram gradient-boosted classifier and regressor.

These baselines must be reported alongside any neural model. A deep model is
not considered useful merely because it has more capacity; it must improve the
predeclared metrics under the same geographic folds.

## Deep-learning architecture

`pipeline/contourcast/deep_model.py` defines:

- a configurable ResNet-style encoder for the declared feature stack;
- three residual stages with spatial downsampling and global average pooling;
- a shared-weight multiscale encoder with learned scale attention;
- a SimCLR-style projection head for self-supervised terrain pretraining;
- a two-head fine-tuning model:
  - occurrence logit;
  - conditional `log1p(CPUE)` prediction.
- a multiple-instance two-head model for coarse released fishing blocks. It
  pools several terrain patches to the block label without inventing a point.

Self-supervised views use small translations, Gaussian noise, and semantic
channel dropout. Reflections are disabled by default so shoreline-relative
orientation, bedform direction, and linear alignment remain meaningful. The
contrastive objective is NT-Xent, with nearby overlapping locations excluded
from the negative-pair set so the model is not rewarded for separating the same
geomorphic structure sampled twice. The
fine-tuning objective combines binary cross-entropy and positive-only SmoothL1
log-CPUE loss, with optional batch-normalized sample-count weights for released
CRFS reliability fields. Loss weights, random seeds, architecture width/depth, optimizer,
learning-rate schedule, normalization statistics, and checkpoint selection must
be frozen in run configuration before evaluation.

The epoch functions are intentionally explicit and leave data loaders,
checkpoint storage, early stopping, and model promotion to the experiment
runner. No pretrained weights are downloaded, and no model registry entry is
created merely by importing the code.

## Evaluation protocol

- Build spatially contiguous folds from projected coordinates.
- Hold out every complete region exactly once.
- Exclude training points within the configured metre buffer of each held-out
  set.
- Fit normalization, feature transforms, baselines, and neural fine-tuning only
  on each fold's training data.
- Use self-supervised raster patches from training geography only when comparing
  strict geographic transfer. A separate transductive experiment may use
  unlabeled held-out geography, but it must be labeled as such and never mixed
  with the strict result.
- Do not tune on test folds. Use nested/inner spatial validation or a fixed
  validation region for hyperparameters and checkpoint selection.
- Report each fold, the aggregate mean and spread, sample counts, class balance,
  and rows removed by the buffer.

For a future target-specific occurrence model that explicitly emits
probabilities, primary occurrence metrics are Brier score and log loss;
secondary metrics are ROC AUC, average precision, and 10-bin expected
calibration error. Those probability metrics do **not** apply to the current
heuristic 0–100 percentile, which is an ordinal rank and does not claim
calibration. Positive-catch CPUE is reported with MAE and RMSE. Opportunity
ranking is evaluated with Spearman rank correlation and NDCG@10 only when the
candidate set and sampling support make those metrics identifiable. Folds
containing one occurrence class or no rank variation return null for the
affected metrics rather than inventing values.

The historical v1 first-party site × two-hour-window design is separate from
the point-terrain benchmark above. `docs/VALIDATION-PROTOCOL.md` and
`validation/protocols/california-halibut-site-window-v1.json` preserve its
prospective cohort, holdouts, baseline selection, clustered uncertainty, and
ordinal claim boundary, but v1 must not activate because its external proof and
independent-publication services do not exist.

`docs/VALIDATION-SUCCESSOR.md` instead freezes a prospective collection-
feasibility pilot. It can report completeness, missingness, source/support,
concentration, privacy reconciliation, and unstratified encounter prevalence.
It is prohibited from computing score/outcome association, comparing a
candidate with a baseline, calibrating probability, or promoting a model. Pilot
rows can never enter a future confirmatory test. Site-supported trip rows are
never converted to point labels.

## Required ablations

The evaluation hook currently defines:

| Ablation | Channels |
| --- | --- |
| `full_six` | All six terrain channels |
| `depth_only` | Depth only |
| `geomorphology_without_depth` | Slope, roughness, curvature, local TPI, broad TPI |
| `without_tpi` | Depth, slope, roughness, curvature |

For a neural report, also compare random initialization against self-supervised
pretraining under identical folds and fine-tuning budgets. Additional temporal,
weather, tide, or user-history features belong in separately named experiments;
they must not be slipped into the terrain-only benchmark.

## Version and promotion contract

`contracts/model-run.schema.json` freezes the structural
`castingcompass.model-run/2.0.0` envelope. Content identity is enforced
separately by `verify_run_record_integrity`; schema validation alone is not an
integrity or promotion check. Each actual `run_metadata.json` writes:

- resolved input file paths, byte sizes, and SHA-256 hashes;
- full configuration and dataset kind;
- Git revision and Python/platform runtime;
- the taxon-catalog and, for labeled runs, observation-contract versions;
- either a named `target_scope` and matching `target_taxon_id`, or explicit
  `target-agnostic` / `null` scope for approved unlabeled terrain and seafloor
  pretraining/probe runs;
- content-derived `experiment_version` and `model_version` values with the
  target slug and a full 64-character SHA-256 digest;
- status (`unrun`, `running`, `completed`, or `failed`);
- metrics artifact location and an explicit note describing result scope.

The version seed includes command, dataset kind, contract versions, target
scope, configuration, input digests, and a clean commit or content-derived dirty
source-state identifier. Changing any of that material changes the resulting
identifier. Final model/checkpoint bytes retain separate SHA-256 artifact hashes
that promotion checks rehash. A target-specific run cannot use an
unknown, unresolved, mixed, or generic target. `synthetic-target` is limited to
synthetic tests; labeled production runs are currently limited to
`california-halibut`. Existing terrain-only self-supervised work remains
truthfully target-agnostic rather than being relabeled as halibut work.

Completed checkpoint and metrics artifacts repeat the same target scope and
model version. Loaders fail closed on missing/mismatched target or contract
identity. `legacy_unverified` observations are ineligible for fitting,
evaluation, calibration, and promotion.

`contracts/opportunity.schema.json` freezes compact emitted window identity at
`castingcompass.opportunity/2.0.0`. Every public window carries the target and
all contract versions plus the scoring-system kind, version, and SHA-256. The
current public hybrid score is explicitly `heuristic-configuration`, not a
trained model. Its displayed score remains a relative 0–100 opportunity rank
and `calibrated_probability` is not claimed. A future `trained-model` window
must name a target-specific model-run version and pass the same equality checks
through the static snapshot and API path.

A model is eligible for a future `candidate` stage only after:

1. dataset-card fields and legal/privacy review are complete;
2. all folds and required ablations finish without leakage warnings;
3. calibration is assessed and the model beats the naive baseline on primary
   metrics across meaningful geographic regions;
4. a separate architecture/checkpoint reproduction matches the recorded run;
5. product behavior for low confidence, missing coverage, and source outages is
   tested.

No automatic production promotion is implemented.

No run may claim evidence under historical v1 or the v2 feasibility pilot. V1
is not activatable, and v2 intentionally produces no candidate-performance
result. A future model-validation run needs a separate externally timestamped
confirmatory protocol, fixed candidate and baselines, source-separated
development and locked test inputs, geographic/time holdouts, participant-
clustered uncertainty, minimum support, and promotion/drift/rollback gates.
That protocol and every hashed input must be sealed and deployed before its
first eligible row; locked-test outcomes cannot influence baseline selection,
feature work, or candidate configuration.

## Limitations and risks

- Terrain alone cannot represent fish behavior, seasonality, temperature,
  currents, tides, regulation, angler behavior, or sampling design.
- Labels are fishery-dependent; predictions can learn where people fish rather
  than where fish live.
- Spatial autocorrelation can make random validation look unrealistically good.
- Self-supervised pretraining may encode survey seams or DEM artifacts.
- Conditional CPUE ignores zero catches by design and must always be interpreted
  alongside occurrence probability.
- Calibration can drift across seasons, species, regulations, survey modes, and
  newly contributed locations.
- Fine-grained fishing predictions may expose sensitive habitats or private
  spots. Public displays should aggregate coordinates and apply conservation and
  privacy review.

## Monitoring requirements before deployment

Future serving must record model/data version, coverage checks, confidence,
prediction distribution, latency, and user correction without logging precise
coordinates unnecessarily. Monitor spatial coverage, missing-channel rates,
class/prevalence drift, calibration on delayed labels, error by region/season,
and disagreement with baselines. Roll back or suppress predictions when the CRS,
channel order, source version, or coverage contract fails.

## Current results

| Evaluation | Status | Result |
| --- | --- | --- |
| Synthetic smoke workflow | Implemented | Plumbing test only; numeric output intentionally not reported here |
| Official-data classical baselines | Unrun | No result |
| Self-supervised pretraining | [Pilot completed on official USGS 2 m bathymetry](experiments/2026-07-11-usgs-sf-2m-ssl-pilot.md) | Best geographically held-out NT-Xent 2.6161 at epoch 1; optimization/provenance validation only, not catch accuracy |
| Full-survey self-supervised pretraining | [Completed and exactly reproduced on 4,096 USGS 2 m locations](experiments/2026-07-11-usgs-sf-2m-full-ssl-v1.md) | Best geographically held-out NT-Xent 1.4683 at epoch 20; eligible for habitat probing, not live scoring |
| Frozen seafloor-character probe | [Completed and exactly reproduced on a strict unseen region](experiments/2026-07-11-usgs-sf-2m-seafloor-probe-v1.md) | Pretrained macro F1 0.3914; beats depth-only but is reliably worse than classical structure summaries, so it is not promoted |
| Two-head fine-tuning | Unrun | No checkpoint |
| Geographic generalization | Unrun | No result |
| Calibration / ablations | Unrun on official data | No result |

Run `python3 -m pipeline.contourcast.cli deep-smoke` after installing PyTorch to
check tensor shapes and finite losses. That command is not training or model
evaluation.
