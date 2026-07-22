# USGS Santa Barbara South Coast sediment support protocol v1

**Frozen before South Coast endpoint membership or support aggregation:** 2026-07-22 UTC  
**Status:** exploratory geographic support protocol only; no independent confirmation, raster-pixel
read, patch construction, model fit, promotion, score, serving, provider, production, or deployment
authority

## Question and evidence footprint

Can the exact USGS Data Series 182 fixed-width dBASE representation provide enough direct,
source-separable bulk-surficial `Gravel`/`Sand`/`Mud` support inside the four contiguous official
USGS Santa Barbara South Coast bathymetry footprints to justify a later source-quality and exact
raster-alignment review?

The evidence footprint is Offshore Refugio Beach, Offshore Coal Oil Point, Offshore Santa
Barbara, and Offshore Carpinteria. It includes Goleta within those official map blocks but does not
cover the product catalog from Gaviota through Rincon in full. No result may be described as
Gaviota or Rincon model evidence.

This question remains materially separate from fishing skill and from the failed three-class video
endpoint. It uses continuous direct sediment percentages, not derived usSEABED classes or mapped
habitat. It cannot establish current substrate, California-halibut presence, catch probability, or
live score quality.

## Prior-exposure disclosure

This is an exploratory geographic transfer, not a fresh confirmatory endpoint:

- `PAC_EXT.txt` already failed its frozen 32-field schema; no values from that representation were
  aggregated or used for repair.
- The exact companion `pac_ext.dbf` was then parsed under a separately committed protocol. Its
  full structural schema and Point pairing passed, and global processing exposed 15,577 distinct
  samples, 908 duplicate records, and nonexclusive exclusion aggregates for the San Francisco
  footprint. Zero records satisfied every San Francisco endpoint rule.
- No South Coast footprint membership, region-specific sediment distribution, valid-row count,
  source-group support, anchor support, or partition result has been computed before this protocol.
- The four South Coast bathymetry transforms and bounds have been inspected, but no pixel values
  are read by this support screen.
- The exact endpoint fields, surface rule, anchors, whole-source grouping, support minimums, and
  computational bound remain unchanged from the prior dBASE protocol.

Because the same DS182 record values have already entered an exploratory audit, a South Coast pass
cannot be independent confirmation and cannot authorize promotion.

## Exact content-addressed sources

### Sediment representation

The sole outcome representation is `pac_ext.dbf` inside U.S. Geological Survey Data Series 182:

- publication: `https://pubs.usgs.gov/publication/ds182`;
- exact archive: `https://pubs.usgs.gov/ds/2006/182/data/pac_ext.zip`;
- source table: `https://pubs.usgs.gov/ds/2006/182/data/pac_src.txt`.

The archive is 1,087,605 bytes at SHA-256
`0643827168d4a91e8f2ed6df7962dee16ff39bdf203a263a833e7f3d7faa51ff`. The exact dBASE member
is 4,369,583 bytes at SHA-256
`0617c5e83a0bd4de5b423bc1cf8774bd753ffdb5ed87f9bc32699fb6292c8afa`. The exact source table is
19,495 bytes at SHA-256
`89bc35fd455f623cae5c3c7ab3942e9bd933bac7a56f447f7ec236f000af4a1e`. Two independent official
download sets must continue to match byte-for-byte. Raw bytes are not committed.

The dBASE III parser, exact ordered 32-field descriptors, 16,485 active-record count, ASCII and
ordinary-decimal rules, deletion handling, Point pairing, identifier rules, and duplicate handling
are exactly those frozen in the
[prior dBASE protocol](2026-07-22-usgs-ds182-sediment-dbf-support-protocol-v1.md). No fallback to
the malformed text member, fuzzy field mapping, value repair, or alternate sentinel is allowed.

### South Coast metadata-only footprints

The four bathymetry assets come from U.S. Geological Survey Data Series 781 and are used only for
their content-addressed CRS, affine transform, shape, and bounds:

| Priority | Region | GeoTIFF SHA-256 | CRS | Shape | Bounds |
| ---: | --- | --- | --- | --- | --- |
| 1 | Offshore Refugio Beach | `fba0b0fa9f3dd2c29890a8b1260b4a3d53a74fc3d909e7b98e2656439319259a` | EPSG:32610 | 8,960 × 8,960 | 758070, 3808160, 775990, 3826080 |
| 2 | Offshore Coal Oil Point | `c63ab37fbc9f64b838fabd8d3fcee4b4c9a4de21ecd3410109d9fd12d01c595f` | EPSG:32611 | 8,963 × 8,960 | 223875, 3803500, 241801, 3821420 |
| 3 | Offshore Santa Barbara | `877a7ab310b60a5dbb263c47de640234a2254b3b44b4291960254c1a2d5eb408` | EPSG:32611 | 8,960 × 8,960 | 241390, 3801510, 259310.00000000003, 3819430 |
| 4 | Offshore Carpinteria | `eb687e6a5fefeedc094f51f1d23a08d92b2b2c81e7bba3c26d62446558c9abea` | EPSG:32611 | 8,960 × 8,960 | 258760, 3797180, 276680, 3815100 |

Every transform must be north-up at the exact published two-metre grid. The small binary floating
representation in the Santa Barbara east bound and x scale is locked as read from the exact
GeoTIFF and compared with an absolute tolerance of `1e-9`; it is not rounded into a new grid.

Each sediment point is transformed independently into every regional CRS. A point inside more
than one inclusive raster bound is assigned exactly once using the west-to-east priority above,
which was frozen for the earlier video audit without reference to sediment values. A point outside
all four footprints is excluded. No backscatter or bathymetry pixel is read, and footprint
membership cannot establish complete 32/128/512 m patch coverage.

The South Coast source policy admits only a new `endpoint-support-footprint` operation for these
exact metadata checks. It does not authorize supervised labels, raster pairing, or validation.

## Frozen endpoint, identity, and leakage rules

The endpoint remains `(Gravel, Sand, Mud)` in source-reported percent. A record is valid only when:

1. its finite dBASE longitude/latitude agrees with its same-position Point within `0.00001` degree
   and is assigned to one exact South Coast footprint;
2. `DataSetKey`, `SiteKey`, and `SampleKey` are positive identifiers and the source key occurs
   exactly once in the locked source table;
3. decoded `DataTypes` is exactly `GRZ` or `TXR`;
4. decoded `SamplePhase` is blank;
5. `SampleTop` is reported, is not `-99`, and lies from 0.0 through 0.1 m;
6. `Gravel`, `Sand`, and `Mud` are reported, are not `-99`, are finite, and each lies from 0 through
   100; and
7. the unmodified composition sum lies from 98 through 102 percent.

The declared `-99` sentinel in the explicitly filterable measurement fields is a row exclusion.
A missing or sentinel identity/coordinate, malformed fixed-width value, unknown source key,
conflicting sample, cross-source site, site-coordinate conflict, schema drift, or geometry mismatch
fails the audit. No imputation, normalization, class derivation, source deletion, or threshold
change is allowed.

`SampleKey` is the measurement identity, `SiteKey` the indivisible location, and `DataSetKey` the
indivisible source domain. Repeated identical records are counted once. Every future candidate
split holds out whole `DataSetKey` groups; row-, coordinate-, site-, and region-random splits are
prohibited. A later raster protocol must keep every site and all centers within at least 512 m of a
held boundary out of training.

## Frozen support gate and decisions

The unchanged overlapping anchors are:

- `gravel_bearing`: `Gravel >= 5` percent;
- `mud_bearing`: `Mud >= 20` percent;
- `sand_dominant`: `Sand >= 80` percent.

Each unique nonempty whole-source bipartition is enumerated once by fixing the numerically smallest
source on the train side. Train and test must each contain at least 64 valid rows, 64 sites, and 16
rows and sites for every anchor; train must contain at least three source groups and test at least
one. At most 14 valid source groups may enter exhaustive reporting, for no more than 8,191
candidates. More groups fail closed without sampling or greedy selection. All eligible partitions
are reported and none is selected from outcome balance.

- Schema, provenance, identity, geometry, or computational-bound failure: stop and preserve it.
- Zero valid rows or no eligible whole-source partition: stop; do not acquire or read new raster
  pixels and do not train.
- One or more eligible partitions: authorize only a separate source-method, horizontal-accuracy,
  exact hybrid-coverage, 512 m buffer, and post-coverage support protocol.
- Every result remains exploratory and requires a genuinely independent endpoint or prospective
  survey before any representation claim.
- Under every result, no corpus is built, no model is trained or promoted, and no browser, API,
  Worker, D1/R2/Queue, live score, provider, production, or deployment state changes.
