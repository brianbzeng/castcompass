# USGS Data Series 182 sediment endpoint support protocol v1

**Frozen before measurement-table inspection:** 2026-07-22 UTC  
**Status:** protocol only; no outcome result, raster acquisition, model fit, promotion, score,
serving, or deployment authority

## Question

Can direct, laboratory-extracted measurements of bulk surficial sediment provide a
source-separable continuous endpoint inside the exact San Francisco hybrid-raster footprint for a
future representation comparison?

This is a materially different scientific question from the rejected three-class camera endpoint.
It asks whether bathymetry and survey-bound backscatter representations could later be evaluated
against measured sediment composition. It does not attempt to recover hard-rock habitat from grab
samples, reuse the USGS interpreted seafloor-character map as truth, or validate California-halibut
presence, catch probability, or the live score.

The measurement values in `pac_ext.txt` may not be downloaded or inspected until the commit that
contains this protocol exists. Public metadata, schemas, source descriptions, record counts, and
geographic extents may be used to freeze the design.

## Fixed official sources

The sole outcome table is the extracted-data output from U.S. Geological Survey Data Series 182,
*usSEABED: Pacific Coast (California, Oregon, Washington) Offshore Surficial-Sediment Data Release*:

- publication: `https://pubs.usgs.gov/publication/ds182`;
- data catalog: `https://pubs.usgs.gov/ds/2006/182/data_cata.html`;
- exact archive: `https://pubs.usgs.gov/ds/2006/182/data/pac_ext.zip`;
- extracted-data metadata: `https://pubs.usgs.gov/ds/2006/182/data/metadata_pac_ext.html`;
- source table: `https://pubs.usgs.gov/ds/2006/182/data/pac_src.txt`;
- source descriptions: `https://pubs.usgs.gov/ds/2006/182/PAC_SRC.html`;
- usSEABED methodology: `https://pubs.usgs.gov/ds/2006/182/usseabed.html`.

The first official download must record the SHA-256 and byte count of the ZIP and every archive
member. A second independent official download must match exactly before any result is accepted.
The source table is content-addressed separately. Raw source bytes are not committed.

### Pre-result field-name erratum

The first exact archive inspection produced no aggregate, partition, or admission result and found
a source-documentation name difference. The published attribute metadata calls the field
`DataType`, while both the exact `PAC_EXT.txt` header and dBASE schema call it `DataTypes`. The
parser must require `DataTypes` in the source bytes and canonicalize that one exact name to the
protocol term `DataType`. No other alias, substring, token expansion, or case repair is admitted.
The outcome values, accepted exact values (`GRZ` and `TXR`), source selection, surface rule,
composition checks, grouping, support thresholds, and decisions are unchanged. The exact archive
member is uppercase `PAC_EXT.txt`; member-name matching remains case-sensitive.

The same pre-result structural inspection found a published-count discrepancy. The metadata says
16,486 point features, while `PAC_EXT.txt` contains exactly 16,485 data rows and the dBASE header
and Point shapefile record sequence independently contain 16,485 records. The locked manifest must
preserve both counts and enforce 16,485 as the exact, internally consistent archive count. Any
future disagreement among those three exact archive representations still fails closed. No
composition aggregate or partition result was computed before this erratum was recorded.

Only the laboratory-oriented extracted output (`EXT`) is admissible. Parsed (`PRS`) or calculated
(`CLC`) outputs, later mapped products, and unlisted mirrors are out of scope. Published metadata
reports 16,486 extracted point features assembled from more than 300 heterogeneous sources whose
original collection spans 1840 through 2003.

## Measurement lineage and claim boundary

The table is an integrated historical compilation, not a contemporaneous probability sample.
Original sampling, laboratory methods, navigation, datum assumptions, precision, and reporting
vary by source. Published horizontal uncertainty ranges from roughly 5 m differential GPS to more
than 2 km for older navigation. The release also warns that duplicate sites may remain across
source reports. These limits must remain visible in every receipt.

Data Series 781 later used sediment samples to help interpret sonar-derived seafloor maps. Direct
laboratory percentages avoid treating those interpreted maps as an independent target, but they do
not prove that every sample campaign was independent of every sonar survey. Whole-source transfer
and a separate source-accuracy review are therefore mandatory before raster pairing or training.

This endpoint can at most support a historical sediment-composition representation experiment. It
cannot establish current habitat, hard substrate prevalence, fish presence, California-halibut
skill, score calibration, navigation safety, temporal generalization, or product readiness.

## Frozen endpoint

The future endpoint is the continuous bulk-sediment composition vector:

`(Gravel, Sand, Mud)` in source-reported percent.

No class label is predicted in this support screen. `SeabedCls`, `FolkCode`, `ShepardCode`,
`RockMshp`, or any other dbSEABED-derived description or classification may be used as an outcome,
filter, repair, or tie-breaker. `Clay`, `Grainsize`, and `Sorting` may be reported only as unused
field-presence metadata and may not affect admission.

A row is endpoint-valid only when all of the following predeclared conditions hold:

1. `Latitude` and `Longitude` are finite and fall inside the exact existing hybrid reference-raster
   footprint; a broad California bounding box is not a substitute for the raster transform.
2. `DataSetKey`, `SiteKey`, and `SampleKey` are nonempty, non-sentinel identifiers.
3. `DataType` is exactly `GRZ` or `TXR`; no token expansion or inferred alias is allowed after
   values are inspected.
4. `SamplePhase` is blank, as required by the release metadata for bulk-sediment mapping.
5. `SampleTop` is reported, is not the `-99` no-data sentinel, and is in the closed interval
   0.0 through 0.1 m. Rows with an unknown top are reported but not admitted as surficial evidence.
6. `Gravel`, `Sand`, and `Mud` are all reported, are not `-99`, are finite, and each lies in the
   closed interval 0 through 100.
7. Their sum lies in the closed interval 98 through 102 percent, allowing only the published
   one-percent field resolution and ordinary source rounding.

Any missing required column, duplicate column after ASCII-case canonicalization, unsafe archive
member, unsupported delimiter or encoding, malformed row, non-finite number, sentinel in a
required identity or coordinate, or archive/member checksum mismatch fails the audit closed. The
published `-99` no-data sentinel in the explicitly filterable `SampleTop`, `Gravel`, `Sand`, or
`Mud` fields is instead a declared well-formed row-level exclusion, as specified in criteria 5
through 7. Rows that are well-formed but fail one of the declared endpoint criteria are counted
under every applicable reason and excluded; no value is imputed, normalized to 100, rounded into
compliance, or replaced from another field.

## Identity, duplication, and leakage

`SampleKey` is the measurement identity, `SiteKey` is the indivisible location identity, and
`DataSetKey` is the indivisible source-domain identity.

- Repeated identical rows for one `SampleKey` are reported and admitted at most once.
- Conflicting endpoint values or identifiers for one `SampleKey` fail the audit closed.
- A `SiteKey` appearing under multiple `DataSetKey` values, or with reported longitude or latitude
  differing by more than `0.00001` degree across its rows, fails closed rather than being guessed
  or split. That fixed tolerance is approximately the source table's five-decimal coordinate
  resolution and is not changed after composition values are read.
- Multiple valid samples at one `SiteKey` remain in the same side of every split. A later modeling
  protocol must declare a label-blind aggregation rule or retain repeated measurements with
  site-clustered evaluation; this screen does neither.
- Every future train/test candidate holds out whole `DataSetKey` groups. Row-random, coordinate-
  random, and `SiteKey`-random splits are prohibited.

The support screen enumerates each unique nonempty whole-`DataSetKey` bipartition once by fixing
the lexicographically first source group on the train side. It reads no raster pixels beyond the
reference transform needed for exact footprint membership.

## Predeclared continuous-support gate

Because the endpoint is continuous and compositional, no outcome-adaptive bins, quantiles, class
merges, or post-result threshold changes are allowed. The following operational anchors measure
whether both sides span practically distinct observed compositions; they are support diagnostics,
not asserted universal geological classes, and they may overlap:

- `gravel_bearing`: `Gravel >= 5` percent;
- `mud_bearing`: `Mud >= 20` percent;
- `sand_dominant`: `Sand >= 80` percent.

A raw whole-source partition is support-eligible only when:

- train and test each contain at least 64 endpoint-valid rows and 64 distinct `SiteKey` values;
- train contains at least three `DataSetKey` groups and test contains at least one;
- train and test each contain at least 16 rows and 16 distinct sites for every anchor above; and
- no schema, identity, or cross-source site conflict has invalidated the audit.

This raw gate is necessary but not sufficient. A passing result authorizes only a separate,
precommitted source-quality and raster-alignment protocol. Before any representation comparison,
that protocol must verify source-level methods and horizontal uncertainty, require documented
horizontal uncertainty no worse than 50 m, preserve survey-bound intensity and availability,
apply the existing 32/128/512 m patch contract, remove all cross-boundary sites within at least
512 m, and re-run the same support floor after coverage filtering. Unknown or worse source
accuracy is excluded rather than converted into a confidence weight after outcomes are known.

## Fixed decisions

- No raw eligible whole-source partition: stop. Do not acquire new rasters, build a patch corpus,
  or train. Preserve the negative result and pursue a prospective independent survey or another
  question preregistered before its outcomes are read.
- One or more raw eligible partitions: report all eligible partitions without selecting one from
  outcome balance. Proceed only to the separate source-quality and raster-alignment protocol.
- Schema, identity, or provenance failure: stop and preserve the failure. Do not silently delete a
  source, reinterpret an identifier, weaken the surface rule, or repair measurements.
- Under every result: no encoder is promoted; no artifact enters the live score; no browser, API,
  Worker, D1/R2/Queue, provider, production state, public model claim, or deployment authority
  changes.
