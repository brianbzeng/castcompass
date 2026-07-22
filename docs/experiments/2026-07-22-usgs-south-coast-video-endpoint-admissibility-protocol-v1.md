# USGS Santa Barbara South Coast video-endpoint admissibility protocol v1

Status: **frozen before the `sw109sc` and `z107sc` label values are read**.

This is an endpoint-support and leakage audit, not a model-training protocol. Passing it can
justify designing a separately reviewed representation experiment. It cannot authorize model
training, encoder promotion, score changes, serving changes, or deployment.

## Question

Do direct USGS camera-video observations provide enough independent support for a whole-cruise
train/test comparison of the frozen multiscale bathymetry and survey-specific backscatter inputs
in the contiguous official Santa Barbara South Coast evidence footprint?

## Label-visibility boundary

Source discovery exposed the label distributions of two archives before this protocol was frozen:

- `s1c08sc`: 1,722 records; raw labeled counts 1=`1,010`, 2=`162`, 3=`56`, blank=`494`.
- `z206sc`: 603 records; raw labeled counts 1=`353`, 2=`30`, 3=`75`, blank=`145`.

Those two archives are exploratory evidence. Their values cannot establish an unadapted support
claim. Only the unchanged rules applied to the held-unread `sw109sc` and `z107sc` archives can add
confirmatory evidence. Before this freeze, only their schemas and record counts were inspected:

- `sw109sc`: 2,380 records; `CLASS`, `LINE`, and `TAPE` are character fields.
- `z107sc`: 667 records; `CLASS` is numeric and `LINE`/`TAPE` are character fields.

After the freeze, the audit must record whether any class collapse, support threshold, grouping
rule, region order, or decision rule changed. Any such change invalidates the confirmatory claim
and requires a new version that discloses the exposed values.

## Exact source and geography contract

The content-addressed source inventory is
`pipeline/sources/usgs_santa_barbara_south_coast.json`. Every archive and every extracted GeoTIFF
must match its recorded SHA-256 digest. The evidence footprint is the following west-to-east
priority, which is frozen independently of labels:

1. `offshore_refugio_beach`
2. `offshore_coal_oil_point`
3. `offshore_santa_barbara`
4. `offshore_carpinteria`

This footprint is narrower than CastingCompass's Gaviota-to-Rincon product catalog. In particular,
it does not establish official visual/bathymetric endpoint support for Gaviota. Product coverage
and model-evidence coverage must remain separate claims.

All four locked video archives are evaluated against all four map blocks. If a video observation
has a complete hybrid patch in more than one block, it is assigned to the first block in the
frozen west-to-east order. The observation key is exact `(cruise_id, source record index)`. Class
values cannot affect overlap assignment.

## Frozen endpoint and input contract

The endpoint is the scientist-recorded USGS camera-video `CLASS` field. Blank labels are excluded.
The class collapse is unchanged from the San Francisco audit:

- raw 1 → `smooth_fine_medium_sediment`
- raw 2 or 3 → `mixed_or_rugose_rock`
- raw 4 → `mobile_coarse_sediment`

Character and integral numeric DBF representations are canonicalized to the same strings. A
non-finite, malformed, fractional, deleted, unknown, or unverified value fails closed.

The input-support check uses the existing hybrid patch derivation without fitting a model:

- map-block-specific 2 m bathymetry;
- each survey-specific backscatter GeoTIFF as its own channel, with its own availability mask;
- radii 32 m, 128 m, and 512 m;
- output size 33×33;
- minimum bathymetry-valid fraction 0.8;
- minimum union backscatter-valid fraction 0.5 at every scale;
- local, broad, and relief radii 4, 24, and 8 cells;
- horizontal accuracy input 2 m;
- tile size 1,024 cells.

The source includes historical and targeted validation tracks. It is not uniform, current, or a
fish/catch endpoint.

## Frozen independence and support gate

The only permitted grouping unit is the exact cruise ID. `LINE`, `TAPE`, adjacent observations,
and individual rows may not cross the train/test boundary. With four cruises, all seven unique
nonempty whole-cruise bipartitions are enumerated once by fixing the lexicographically first cruise
in train.

A partition is eligible only when **every collapsed class has at least 16 retained rows in both
train and test**. The endpoint is admissible only if at least one partition is eligible. No random
row split, threshold search, class remapping, cruise subdivision, or post-label region change is
allowed.

Video measurements are visually direct, but track selection was designed to support sonar-map
interpretation. Therefore even a passing result measures limited representation support under
targeted sampling; it is not an independent population-accuracy estimate.

## Required output and decision boundary

The deterministic audit must record:

- exact input and manifest hashes;
- raw and labeled counts per cruise;
- overlap, valid-center, full-patch, and deduplication row flow per region;
- collapsed class counts per retained cruise and overall;
- every candidate whole-cruise partition and its per-class support;
- whether the held-unread boundary remained unchanged;
- explicit booleans for training, promotion, scoring, serving, and deployment (all false).

If no partition passes, record a negative result and stop. If a partition passes, stop anyway and
write a separate training/evaluation protocol before any model sees the labels. Neither outcome
changes the current curated Habitat score or the public site's model disclosure.
