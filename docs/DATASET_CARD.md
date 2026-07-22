# CastingCompass dataset card

**Status:** species-aware contract assets, multiscale structure pipeline, and
exactly reproduced official bathymetry/backscatter/fused self-supervised
pretraining, target-agnostic transfer probes, and source-shortcut diagnostic
implemented. The production
species migration and any supervised catch-training dataset remain unapproved.
Official rasters, probe corpora, and weights are not bundled.

**Version:** 0.6.0

## Intended dataset

CastingCompass is designed to join a bathymetric terrain grid with recreational
fishing observations for Bay and coastal California research. The intended
learning unit is one complete, targeted effort segment. It declares exactly one
primary target, target-specific effort, temporal and spatial support, and
structured observations for every encountered taxon. Aggregated survey
estimates remain separate and must not be treated as effort segments or
exact-point labels.

This dataset is for exploratory habitat and product research. It is not a
nautical chart, navigation aid, regulatory source, biological stock assessment,
or guarantee that fish will be present.

## Official sources and stewardship

The machine-readable manifests are in `pipeline/sources/`.

| Source | Steward | Intended use | Official access |
| --- | --- | --- | --- |
| CUDEM / Coastal Relief bathymetry | NOAA National Centers for Environmental Information | Elevation/bathymetry raster and published metadata | [NOAA Coastal Elevation Models](https://www.ncei.noaa.gov/products/coastal-elevation-models), [NOAA Bathymetry](https://www.ncei.noaa.gov/products/bathymetry) |
| BlueTopo | NOAA Office of Coast Survey | Coverage backbone with elevation, uncertainty, and data-quality layers | [NOAA BlueTopo](https://www.nauticalcharts.noaa.gov/data/bluetopo.html) |
| Offshore San Francisco State Waters | U.S. Geological Survey | 2 m bathymetry/backscatter, seafloor character, habitat, geology, and video ground truth | [USGS DS 781 data catalog](https://pubs.usgs.gov/ds/781/OffshoreSanFrancisco/data_catalog_OffshoreSanFrancisco.html) |
| DS781 residual statewide video observations | U.S. Geological Survey | Raw endpoint-support auditing only; no training, validation, scoring, or raster-acquisition authority | [USGS DS 781 video-observation catalog](https://pubs.usgs.gov/ds/781/video_observations/data_catalog_video_observations.html) |
| Central San Francisco Bay multibeam | U.S. Geological Survey | 4 m bathymetry/backscatter and bedform structure | [USGS DS 55](https://pubs.usgs.gov/dds/dds-55/pacmaps/sf_data.htm) |
| California Recreational Fisheries Survey (CRFS) | California Department of Fish and Wildlife | California marine recreational catch/effort samples or estimates | [CDFW CRFS](https://wildlife.ca.gov/Conservation/Marine/CRFS/Additional-Information) |
| RecFIN Data Warehouse | Pacific States Marine Fisheries Commission | Official distribution/query system for Pacific Coast recreational-fisheries data, including CRFS | [RecFIN](https://www.recfin.org/) |
| CRFS ds3186 | California Department of Fish and Wildlife | All-catch/all-effort BlockBox CPUA context only | [California Open Data ds3186](https://www.lab.data.ca.gov/dataset/california-recreational-fisheries-survey-catch-per-unit-angler-for-all-species-and-all-effort-r) |
| CRFS ds3185 | California Department of Fish and Wildlife | RCGL-catch/Bottomfish-effort BlockBox CPUA context only | [California Open Data ds3185](https://www.lab.data.ca.gov/dataset/california-recreational-fisheries-survey-catch-per-unit-angler-for-rockfish-cabezon-greenling-a) |

CRFS and RecFIN are not NOAA bathymetry products. Their actual stewards are
preserved because survey ownership, design documentation, and citation matter.
CDFW states that CRFS data and estimates from 2004 onward are available through
RecFIN. Raw query exports, query filters, access dates, and checksums must be
retained.

The exact ds3185/ds3186 source revisions, dictionaries, sampling boundaries, permissions, and
canonical snapshot receipts are documented in [OFFICIAL-FISHERIES-DATA.md](OFFICIAL-FISHERIES-DATA.md).
They are aggregate descriptive context only. They cannot enter observation-v2 training,
validation, calibration, production scoring, or exact-point terrain labels.

## Data contracts

### Bathymetry

The canonical NPZ contains:

- `values`: one 2-D, positive-upward elevation raster in metres;
- `metadata.crs`: a projected CRS with metre axes;
- `metadata.transform`: six-coefficient, north-up GDAL affine transform;
- `metadata.vertical_datum`: the datum published with the selected product;
- `metadata.source_id`, nodata value, units, and schema version.

Geographic degrees, rotated grids, unknown vertical datums, empty rasters, and
non-metre horizontal units are rejected. `pyproj`, when installed, performs an
independent CRS semantics check. Without it, the provenance record explicitly
marks CRS semantics as unverified.

Elevation products from different vertical datums must not be stacked or
compared until a documented vertical transformation is performed. Resolution
is not treated as positional or vertical accuracy. NOAA elevation products are
explicitly **not for navigation**.

### Fishing observations

The language-neutral source of truth is:

- `contracts/taxa.json` and `contracts/taxa.schema.json` at
  `castingcompass.taxa/1.0.0`;
- `contracts/observation.schema.json` at
  `castingcompass.observation/2.0.0`;
- `shared/species-contract.ts` and `shared/species_contract.py` for matching
  identity and catalog-eligibility helpers. TypeScript provides the reusable
  semantic record validators; Python enforces the same observation semantics
  at ingestion and again in the model loader.

The JSON schemas are strict structural envelopes, not substitutes for semantic
validation. Cross-field rules such as unique taxon IDs, count reconciliation,
confidence/basis compatibility, temporal ordering, environment eligibility,
and derived outcomes are exercised from one shared adversarial fixture corpus
through both the TypeScript validator and the actual Python ingestion path.

The closed launch catalog contains `california-halibut` as the only production
model target, `unresolved-fish` as an observation-only bucket, and
`synthetic-target` for tests only. `rockfish`, `unknown`, and other generic terms
are not production targets. A future rockfish release must add defensible named
species or an explicitly reviewed complex in a new catalog version.

Every v2 record includes:

- `contract_version`, `taxon_catalog_version`, stable observation and effort
  segment IDs, and `contract_status: valid`;
- one `primary_target_taxon_id` and positive `target_effort` with its unit and
  fishing mode;
- source assertions that the row is a complete attempt and not an expanded
  estimate;
- bounded or exact temporal support and honest point, site, or area spatial
  support;
- one unique `taxon_observations` entry per represented taxon, with encounter,
  retained, released, and disposition-unknown counts that reconcile exactly;
- an identification confidence and basis. Current unreviewed first-party named
  catches are `self_reported` / `angler-report`, not verified. Unidentified fish
  remain `unresolved-fish` / `unresolved`; and
- one derived `outcome_class`: `target_encountered`, `non_target_only`, or
  `no_fish`. Even `no_fish` records contain the primary-target row with zero
  counts and `not_observed` / `not-observed` identity.

The loader fails closed on missing or unknown versions, multiple or mismatched
targets, unknown taxa, generic production targets, duplicate taxon rows,
inconsistent counts or outcomes, catch-only inputs, expanded estimates,
synthetic data in production, or a false confidence/basis pairing. Canonical
site and area records can support descriptive analysis. Launch-v2 point records
must use one of the explicitly approved projected CRSs. Only an exact-time point
record whose CRS also exactly matches the expected model grid can become a
terrain-model row.

The importer never converts an area centroid, port, district, or survey stratum
into a purported catch location. An area-only record may support aggregate
descriptive analysis. A future weakly supervised experiment may represent the
entire released area as a bag of terrain patches and supervise only the bag;
attention on individual patches is not ground-truthed hotspot evidence.

Sample data and expanded survey estimates have different meanings. Expansion
weights, strata, modes, uncertainty fields, and source documentation must be
retained in the raw layer. The v2 flattened modeling table sets `sample_weight`
to `1.0` because each row is one complete effort segment; that value is not a
survey expansion or reliability weight. Expanded estimates are rejected until
a separate survey-weighted estimator is explicitly implemented and validated.

### Legacy migration and eligibility

The additive species migration records the observation/catalog versions,
target taxon, structured taxon observations, outcome class, target/all-fish
counts, and target-identification confidence. Historical trip rows did not
collect the full v2 evidence. They are backfilled as `legacy_unverified`, remain
available for account history and deletion, and are excluded from training,
validation, and calibration. A `rejected` status records failed contract intake;
neither status is a valid v2 observation payload. Production migration and
aggregate post-migration audits must complete before collection is described as
contract-v2 live.

## Derived terrain and structure channels

All six channels are aligned to the bathymetry raster in this fixed order:

1. `depth_m`: positive-down depth, `max(-elevation, 0)`;
2. `slope_deg`: gradient magnitude converted to degrees;
3. `roughness_m`: local depth standard deviation;
4. `curvature`: horizontal Laplacian of elevation;
5. `tpi_local_m`: depth minus local-window mean;
6. `tpi_broad_m`: depth minus broad-window mean.

Defaults use radii of two and six cells. Pixel size, radii, sign convention,
channel names, source datum, and robust summary statistics are saved with each
artifact. Nodata pixels stay invalid after derivation; finite fill is used only
internally to avoid derivative explosions at holes.

The deep-learning structure stack adds:

7. `local_relief_m`: local maximum minus minimum depth;
8. `rugosity_ratio`: local surface-area proxy, equal to one on a flat cell;
9. `aspect_sin`: north/south grid-axis component of the elevation gradient;
10. `aspect_cos`: east/west grid-axis component of the elevation gradient.

Orientation is preserved by default during augmentation because alignment with
shore, current, surf, and other linear structures may be predictive. Optional
backscatter, substrate/seafloor character, survey uncertainty, survey age,
kelp-canopy, or surf-break layers must align exactly to the reference grid.
Every auxiliary value layer receives a paired availability mask before missing
values are filled.

The first frozen hybrid experiment uses the four official 2 m USGS Offshore of
San Francisco backscatter survey rasters (`8101_2004`, `8101_2007`,
`8101_2008`, and `7125_2006`) listed by the source catalog. They are distinct
survey footprints, not interchangeable repeated observations. Acquisition must
retain every source ZIP and metadata file, record byte hashes, mosaic only onto
the matching 2 m bathymetry reference grid, and leave all uncovered cells
explicitly unavailable. The resulting corpus kind is
`official_unlabeled_seafloor_remote_sensing`; it is target-agnostic and cannot
be interpreted as catch or habitat labels.

The source manifest also binds the exact `f208nc` and `f307nc` raw video ZIPs
and every archive member by byte count and SHA-256. Their `CLASS` values are
direct scientist-recorded camera observations, but their tracks were selected
to validate sonar interpretations, observations are adjacent one-minute
samples, and horizontal positional accuracy is highly variable on the order of
10 m. They are therefore eligible only for the explicit endpoint-admissibility
audit unless a separately reviewed split passes. Published habitat polygons
are not treated as independent bathymetry/backscatter targets because official
metadata names those sonar products and hillshade as primary interpretation
sources.

## Physical resolution contract

CastingCompass separates pixel spacing from reliable feature detection:

- fewer than two native cells across: `unresolved`;
- two to fewer than three cells: `marginal`;
- three or more cells, subject to published positional accuracy: `resolvable`.

At 2 m/pixel, the conservative structure threshold is therefore about 6 m. A
narrow pipe may not be directly resolved. A wider raised corridor, scour,
bedform disruption, acoustic-backscatter response, kelp footprint, or habitat
edge can still be represented when it spans enough native cells. Upsampling a
coarse raster never improves this classification.

Each location is represented at multiple physical scales. The initial pilot
uses 64 m, 256 m, and 1,024 m diameter views, corresponding to immediate
structure, surrounding habitat, and broad geomorphic context.

## Spatial alignment and leakage controls

- Raster channels must match CRS, shape, affine transform, and units exactly.
- Observations must use the same projected CRS and lie within raster bounds.
- Terrain patches are extracted only after these checks.
- Evaluation creates spatially contiguous K-means regions and holds out each
  complete region once.
- An optional metre buffer removes training observations close to held-out
  points. Preprocessing and model fitting occur inside each fold.
- Random row splits are not accepted as evidence of spatial generalization.

The K-means regions are an evaluation scaffold, not a claim that they correspond
to ecological management areas. Before a reported experiment, region count and
buffer distance should be chosen from sampling density and the intended product
use, then fixed before inspecting test results.

That scaffold applies to exact-point terrain experiments. First-party
CastingCompass trips deliberately retain curated `site` support and cannot
enter the point loader. Historical v1 preserves a fixed site-catalog SHA-256 in
`validation/catalogs/california-halibut-bay-area-v1.json`, with 46 sites assigned
once to five named panels and four absolute time blocks, but
it is not activatable. The v2 successor uses the same curated site support only
for a collection-feasibility pilot. Neither design invents a site centroid,
weakens point-model eligibility, or treats a whole trip spanning multiple
windows as a point label. Pre-freeze, pre-activation, past, and legacy rows
remain product-observational only regardless of structural validity.

The public site catalog may expand independently of that archive. Its Santa
Barbara South Coast entries are product-planning locations with curated habitat
priors and public forecast sources, not labeled training data and not eligible
pilot geography. Local trip reports remain model-excluded unless a future
prospective protocol freezes the expanded population before enrollment.

Prospective rows additionally retain the frozen recruitment-frame ID, one of
three allowed pre-outcome source IDs, recruitment event time/hash, and—only for
admin-approved community recruitment—the prior approval hash. The validation
analysis is a census of every eligible accepted row in the fixed interval; it
cannot take a post-hoc or arrival-ordered subsample. Recruitment-source and
selection-design mix are preserved for required stratified reporting.

## Known biases and limitations

- CRFS/RecFIN measure fishing activity and observed catches, not complete fish
  presence/absence. Angler choices, access, regulations, gear, skill, season,
  weather, and survey coverage shape the labels.
- A zero catch is not a confirmed biological absence.
- Popular or accessible areas and commonly retained species can be
  overrepresented.
- Bathymetry surveys have heterogeneous age, density, and uncertainty.
- Backscatter availability is strongly source- and geography-dependent. The
  frozen 903-row hybrid holdout contains only the 2004 survey at measured
  centers; 2007 has only one labeled example in two substrate classes and 2006
  has only one class. Those domains cannot support ordinary cross-survey model
  claims and must not be pooled to manufacture class support.
- Public survey geography may be much coarser than a DEM pixel.
- CPUE values can be heavy-tailed and are not automatically comparable across
  modes or survey designs.
- Sensitive user-contributed fishing locations require access controls,
  coordinate minimization, and an explicit retention/deletion policy before
  collection. No private user data is included here.

## Reproducibility and versioning

Every real-data run must preserve:

- immutable raw files and SHA-256 hashes;
- exact source product/query, filters, access date, citation, and manifest ID;
- CRS and vertical-datum transformation history;
- terrain configuration and fixed channel order;
- observation eligibility counts and rejected-row reasons;
- geographic split seed/count/buffer;
- for the v2 feasibility pilot, the externally registered protocol hash,
  activation identity, immutable release/Worker/scoring identity, recruitment
  source/event identity, site-catalog hash, exact interval, started-attempt
  reconciliation, and encrypted snapshot checksum;
- for a later confirmatory study, its separate preregistration, activation,
  outcome-blind split identity, fixed candidate/baselines, and locked input
  hashes required by that future protocol;
- Git revision, Python runtime, input hashes, experiment version, model version,
  target scope, catalog version, and observation contract version from
  `run_metadata.json`.

Run the synthetic plumbing check with:

```bash
python3 -m pipeline.contourcast.cli smoke --output-dir /tmp/contourcast-smoke
```

Synthetic fixture metrics are labeled `synthetic_fixture` and are not real-data
results.

No study export may contain raw email, account ID, resettable reporter hash,
notes, photos, IP address, user agent, or exact coordinates. V2 uses a privacy-
safe deletion-linked participant group, append-only corrections, and daily
encrypted checksummed snapshots. Deletion and withdrawal must be reconciled
before a feasibility report. Candidate performance is not evaluated on v2.

## Current results

The full official USGS 2 m survey has passed windowed ingestion, resolution
audit, ten-channel derivation, three-scale corpus creation, geographic
validation, and exactly reproduced self-supervised checkpoint training across
4,096 sampled locations. This is unlabeled representation learning only. No
class balance, catch metric, habitat conclusion, or Opportunity Score accuracy
improvement is claimed.

The first frozen-embedding probe joins 4,095 corpus locations to the USGS 2 m
seafloor-character map after an explicit EPSG:26910-to-EPSG:32610 coordinate
transformation. Composite depth/slope digits are removed from the target. The
map was itself derived from bathymetry, acoustic backscatter, and
interpreter/video evidence, so the result measures transferable character
signal rather than an independent biological endpoint.

The frozen three-encoder follow-up uses the same official seafloor-character
map and exactly reuses the pretraining holdout. Its common substrate target has
3,183 training rows and 903 test rows. A separate label-guided rare probe
retains 64 smooth anthropogenic, 64 rugged anthropogenic, and 64 nearby natural
control centers. Every rare center must span at least three native cells; whole
connected components remain in one geographic fold; and a 512 m buffer excludes
nearby training rows. Two builds reproduced the rare corpus exactly at SHA-256
`9ea0b540e18760bb3ac9a144dcba4df5d88f05c1491f1bceb341482731072741`.
The balanced case-control design cannot estimate natural prevalence or
population accuracy. Exact results and source identities are recorded in the
[hybrid probe receipt](../pipeline/evidence/hybrid-seafloor-probes-v1.receipt.json).

The follow-up [source-shortcut diagnostic](experiments/2026-07-22-usgs-sf-hybrid-shortcut-diagnostic-v1.md)
shows that the fixed fold is source-degenerate and that availability features
add reliable conditional signal within it. Only the 2004 and 2008 domains meet
the frozen minimum of 32 total rows and 16 rows per class in train and test.
Fused pretraining is reliably worse than bathymetry pretraining on both
eligible unseen-survey tests. These results prohibit a cross-survey
generalization claim and do not authorize model promotion.

The subsequent [direct-video endpoint audit](experiments/2026-07-22-usgs-sf-video-endpoint-admissibility-audit-v1.md)
finds 3,759 classified official rows, 187 valid reference centers, and 166 rows
that retain the complete hybrid patch contract. The retained totals are 94
smooth, 22 mixed/rugose, and 50 mobile-coarse observations across four exact
cruise/line/tape groups. All coarse rows and 21 of 22 mixed/rugose rows occur
in one group. None of the seven unique whole-group partitions leaves 16 rows
of every class on both sides, so a row-level split is prohibited and no model
is fit. This negative support result is exactly reproduced and changes no
serving path.

The follow-up
[Santa Barbara South Coast direct-video audit](experiments/2026-07-22-usgs-south-coast-video-endpoint-admissibility-audit-v1.md)
locks four contiguous official map blocks from Refugio through Carpinteria, 11 survey-specific
backscatter layers, and four video archives. Two archives remained label-unread until the class,
region, patch, whole-cruise, and minimum-support rules were committed. All 4,251 labeled records
have zero raw class-4 observations; the 1,327 complete hybrid rows therefore contain 1,030 smooth,
297 mixed/rugose, and zero mobile-coarse observations. Zero of seven whole-cruise partitions pass.
Two independent-download executions reproduce exact metrics. This narrower evidence footprint
does not establish Gaviota coverage, and no model or serving path changes.

The subsequent
[residual statewide direct-video support screen](experiments/2026-07-22-usgs-residual-statewide-video-support-screen-v1.md)
content-addresses the other six official DS781 video archives. They contain 18,722 records and
15,335 nonblank class values. `s2210mb` has 444 nonblank class-`0` rows outside the frozen class
domain and 26 nonblank rows without complete `LINE`/`TAPE` identity, so the source schema fails
closed. Sixteen of 31 recognized-row whole-cruise partitions pass the numerical support floor,
but that diagnostic is non-authoritative because it depends on the invalid archive. Among the
five schema-valid archives, only `c0212sc` contains class 4. The screen therefore authorizes no
raster acquisition, corpus construction, training, promotion, or serving change.

The next [direct sediment endpoint screen](experiments/2026-07-22-usgs-ds182-sediment-endpoint-support-v1.md)
preregisters continuous bulk-surficial `Gravel`/`Sand`/`Mud` measurements from USGS Data Series
182, with whole-source holdout and no derived dbSEABED class. Its exact `PAC_EXT.txt` member fails
the frozen source schema before any outcome aggregate: 14,950 of 16,485 rows have 31 fields under
the 32-field header. The audit does not pad the omitted field or switch source representations.
Two independent downloads reproduce the same failure; no raster pixel, patch corpus, model, or
serving path is involved.

The separately frozen
[dBASE representation audit](experiments/2026-07-22-usgs-ds182-sediment-dbf-support-v1.md)
preserves that failure and remains exploratory rather than confirmatory. Its exact 16,485-record
fixed-width schema and Point pairing validate, but only 136 distinct-sample records are inside the
exact San Francisco reference footprint and zero satisfy all frozen surface, type, and composition
rules. The endpoint therefore has no valid source group or partition, authorizes no source-quality
or raster-alignment review, and changes no corpus, model, score, or serving path.

The follow-up
[Santa Barbara South Coast sediment screen](experiments/2026-07-22-usgs-south-coast-sediment-support-v1.md)
uses the same frozen endpoint and four exact metadata-only bathymetry footprints. Of 95 distinct
samples inside the footprint, 26 rows/sites across three source groups satisfy every rule, but zero
are gravel-bearing and only three are sand-dominant. Zero of three whole-source partitions passes.
No raster pixel is read and the result cannot authorize alignment, training, promotion, or a local
habitat/fishing claim.

The subsequent
[independent endpoint inventory](experiments/2026-07-22-independent-endpoint-source-inventory-v1.md)
reviews seven official candidate families without admitting them as source manifests. NOAA's
California substrate layer is an unvalidated compiled hard/soft map; its California-halibut HSM is
derived from bathymetry and substrate; Digital Coast grab data lacks a California collection and
cannot sample hard bottom; mapped habitat/cover is not a direct independent endpoint; and the
DS781/DS182 families are the same support-incomplete evidence already audited. The exact machine
policy gives all seven candidates empty evidence roles and denies raster pairing, supervised
training, representation comparison, promotion, and production scoring.

The separate
[prospective direct-video protocol](experiments/2026-07-22-prospective-seafloor-endpoint-collection-protocol-v1.md)
is frozen locally but inactive. It is not a dataset and creates no current source authority. If it
is ever activated after external preregistration and required legal/privacy/safety/data-steward
review, ordinary fishing-trip logs remain in the catch-validation lane and cannot be backfilled as
seafloor labels. Only prospectively assigned purpose-built camera deployments can enter that
endpoint, and a support pass would still require a new raster-alignment and representation
comparison protocol.
