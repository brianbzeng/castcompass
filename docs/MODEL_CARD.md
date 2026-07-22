# CastingCompass model card

**Status:** multiscale encoder and exactly reproduced official bathymetry,
backscatter, and fused self-supervised pretraining plus common-substrate and
rare-structure transfer probes and a cross-survey shortcut diagnostic
implemented; no encoder passed the frozen
classical baselines, catch heads remain untrained, and no catch performance has
been measured.

**Version:** 0.7.0

## Live regional-ranking boundary

The public live ranker is a separate heuristic configuration, not the untrained
research heads described below. Its catalog covers the Bay Area plus 14 public
Santa Barbara South Coast access locations from Gaviota through Rincon. Santa
Barbara sites use curated casting-zone exposure and habitat priors together with
Santa Barbara tide, weather, buoy, and marine-forecast inputs. They do not use a
Santa Barbara-trained terrain model and have not been validated against local trip
outcomes. Scores remain relative percentiles across the current candidate set, so
adding a region changes the comparison universe rather than creating a catch
probability.

Ordinary trip reports from the new region remain private, reviewable product
observations. They cannot become evidence for the frozen Bay Area validation pilot
or a performance claim without a separately approved, prospective protocol that
defines the new geography before outcomes are known.

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
- a target-agnostic hybrid pretraining head that combines spatial contrastive
  learning with masked reconstruction of declared measured value channels;
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
geomorphic structure sampled twice. For the frozen follow-up experiment,
bathymetry-only, backscatter-only, and fused runs use identical geographic
folds and budgets. Each survey-bound backscatter raster retains a paired binary
availability channel; those channels are never corrupted or reconstructed,
and reconstruction loss is computed only where a real source pixel exists. Hybrid loss remains an
optimization diagnostic rather than habitat or fishing accuracy. The
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

The next seafloor-representation report additionally requires a locked
three-way modality ablation:

| Modality | Model inputs | Reconstruction targets |
| --- | --- | --- |
| `bathymetry` | Ten declared structure channels | Measured depth |
| `backscatter` | Survey-bound backscatter intensities plus their availability masks | Available measured intensities only |
| `fused` | Ten structure channels plus survey-bound intensities and availability | Depth plus available measured intensities |

All three runs must use the same corpus locations, spatial split, seed,
encoder width/depth, optimizer, mask policy, and epoch budget. The required
input and reconstruction layers produce small parameter-count differences
(818,050 bathymetry; 816,645 backscatter; 824,710 fused), all within about one
percent; they are not literally identical-capacity networks. Comparing losses
across different folds or source coverage is prohibited, and even same-fold
hybrid loss does not rank representation quality because reconstruction targets
differ by modality.

The fixed USGS v1 comparison uses validation fold `3`: it is the first seeded
geographic fold with nonzero training coverage from every one of the four
survey-bound intensity channels. This availability-only choice is frozen before
optimization and never consulted a habitat, catch, or probe label.

The three 20-epoch runs and their clean-commit repeats reproduced every loss-
history value, learned tensor, normalization statistic, and corpus binding.
The [minimized receipt](../pipeline/evidence/hybrid-seafloor-v1.receipt.json)
binds the source commit, official corpus, exact model identities, parameters,
best epochs, and local artifact hashes. Its numeric hybrid losses remain
optimization diagnostics only; the independent habitat and rare-structure
probes below are still required.

The official raw video follow-up is a pre-training admissibility audit, not a
model result. Direct scientist-recorded camera classes are a more independent
measurement than the interpreted character map, but adjacent one-minute rows
remain inside one exact cruise/line/tape group. A valid comparison requires at
least 16 examples of every collapsed class in both train and held-out whole
groups. The current four retained groups produce zero eligible partitions, so
the implementation deliberately fits no probe. The target-agnostic
`official_video_endpoint_admissibility_audit` run kind records this negative
result without creating validation or promotion authority.

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

No automatic production promotion is implemented. The strict
[model-governance policy](MODEL-GOVERNANCE.md) freezes the stage order, relational promotion
tests, monitoring cadence, privacy boundary, immediate suppression conditions, rollback order,
180-day maximum evidence age, material-change revalidation triggers, and append-only decision
identity. Its evaluator can only recommend human review or a protected policy update; the current
v1 policy suppresses any trained model because only the reviewed heuristic is authorized.

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
- The frozen hybrid geographic holdout is source-degenerate: measured centers
  come from only the 2004 backscatter footprint. Availability/missingness adds
  reliable apparent skill within that fold, while fused pretraining is reliably
  worse than bathymetry pretraining on both support-eligible unseen surveys.
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
| Live heuristic site × window ranking validation | Unrun; no prospective study activated | As of 2026-07-19: 0 eligible prospective/confirmatory attempts (0 target encounters and 0 target non-encounters), 0 preregistered baseline comparisons, and 0 probability-calibration runs |
| Synthetic smoke workflow | Implemented | Plumbing test only; numeric output intentionally not reported here |
| Official-data classical baselines | Unrun | No result |
| Self-supervised pretraining | [Pilot completed on official USGS 2 m bathymetry](experiments/2026-07-11-usgs-sf-2m-ssl-pilot.md) | Best geographically held-out NT-Xent 2.6161 at epoch 1; optimization/provenance validation only, not catch accuracy |
| Full-survey self-supervised pretraining | [Completed and exactly reproduced on 4,096 USGS 2 m locations](experiments/2026-07-11-usgs-sf-2m-full-ssl-v1.md) | Best geographically held-out NT-Xent 1.4683 at epoch 20; eligible for habitat probing, not live scoring |
| Frozen seafloor-character probe | [Completed and exactly reproduced on a strict unseen region](experiments/2026-07-11-usgs-sf-2m-seafloor-probe-v1.md) | Pretrained macro F1 0.3914; beats depth-only but is reliably worse than classical structure summaries, so it is not promoted |
| Hybrid bathymetry/backscatter pretraining | [Completed and exactly reproduced on one 4,096-location corpus](../pipeline/evidence/hybrid-seafloor-v1.receipt.json) | All three target-agnostic encoders reproduced exactly; differently targeted optimization losses do not rank representation quality |
| Hybrid common-substrate probe | [Completed and exactly reproduced on pretraining holdout 3](experiments/2026-07-22-usgs-sf-hybrid-seafloor-probes-v1.md) | Fused deep macro F1 0.7020 reliably exceeds both single-modality encoders but remains reliably below fused classical summaries at 0.7574 |
| Rare mapped-structure case-control probe | [Completed and exactly reproduced with whole-component holdout](experiments/2026-07-22-usgs-sf-hybrid-seafloor-probes-v1.md) | Fused deep macro F1 0.7259 beats fused random initialization, but does not reliably beat fused classical summaries; balanced sampling cannot estimate prevalence |
| Hybrid source-shortcut diagnostic | [Completed and exactly reproduced with strict per-class survey support](experiments/2026-07-22-usgs-sf-hybrid-shortcut-diagnostic-v1.md) | Fixed fold contains only the 2004 measured source; fused deep is reliably worse than bathymetry deep on both eligible unseen-survey domains; shortcut risk remains unresolved |
| Direct-video endpoint admissibility | [Completed and exactly reproduced with whole-track groups](experiments/2026-07-22-usgs-sf-video-endpoint-admissibility-audit-v1.md) | 166 complete hybrid rows across four groups; zero of seven whole-group partitions meet the per-class floor, so no probe is fit and no model is promoted |
| Santa Barbara South Coast direct-video admissibility | [Completed and exactly reproduced with whole-cruise holdout](experiments/2026-07-22-usgs-south-coast-video-endpoint-admissibility-audit-v1.md) | 1,327 complete hybrid rows across four cruises, but all four official archives have zero raw class-4 observations; zero of seven whole-cruise partitions pass, so no probe is fit and no model is promoted |
| Residual statewide direct-video support screen | [Completed and exactly reproduced before raster acquisition](experiments/2026-07-22-usgs-residual-statewide-video-support-screen-v1.md) | 18,722 official records expose numerical support, but one of two class-4 cruises has 444 out-of-domain class-0 rows and 26 incomplete group identities; among schema-valid archives class 4 occurs in only one cruise, so the endpoint fails closed and no model is fit |
| Direct measured-sediment support screen | [Completed and exactly reproduced before outcome aggregation](experiments/2026-07-22-usgs-ds182-sediment-endpoint-support-v1.md) | The exact 16,485-row `PAC_EXT.txt` member has 14,950 31-field rows under its 32-field header; the protocol forbids padding or switching to dBASE, so no composition support is calculated and no model is fit |
| Exploratory measured-sediment dBASE support screen | [Completed and exactly reproduced under a separately frozen protocol](experiments/2026-07-22-usgs-ds182-sediment-dbf-support-v1.md) | The exact fixed-width schema and Point pairing validate, but only 136 distinct-sample records are inside the exact San Francisco footprint and zero satisfy every frozen endpoint rule; no source-quality review, raster pairing, or model fit is authorized |
| Santa Barbara South Coast direct-sediment support screen | [Completed and exactly reproduced across four metadata-only footprints](experiments/2026-07-22-usgs-south-coast-sediment-support-v1.md) | 26 valid rows/sites span three source groups but contain zero gravel-bearing and only three sand-dominant observations; zero of three whole-source partitions passes, so no pixels are read and no model is fit |
| Independent endpoint source inventory | [Completed with a fail-closed machine policy](experiments/2026-07-22-independent-endpoint-source-inventory-v1.md) | Seven official candidate families reviewed; mapped substrate/cover and the halibut HSM are derived or circular, Digital Coast grabs lack California/hard-bottom support, and DS781/DS182 are already audited support-incomplete families; no candidate receives an evidence role or model authority |
| Prospective direct-video endpoint collection | [Protocol frozen locally but not activated](experiments/2026-07-22-prospective-seafloor-endpoint-collection-protocol-v1.md) | Outcome-blind site frame, blinded dual labels, whole-day groups, 512 m buffers, and fixed three-class support gates are locked; no participants, sites, observations, rasters, or model actions are authorized |
| Two-head fine-tuning | Unrun | No checkpoint |
| Geographic generalization | Unrun | No result |
| Calibration / ablations | Unrun on official data | No result |

Run `python3 -m pipeline.contourcast.cli deep-smoke` after installing PyTorch to
check tensor shapes and finite losses. That command is not training or model
evaluation.
