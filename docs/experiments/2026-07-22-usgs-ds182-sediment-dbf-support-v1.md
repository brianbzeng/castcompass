# USGS Data Series 182 dBASE sediment support v1

**Run date:** 2026-07-22 UTC  
**Frozen source commit:** `b6bb2df351eac12eabad8eb50d29b970c95e52b6`  
**Experiment class:** exploratory same-release representation; not independent confirmation

## Question and prior exposure

Can the exact fixed-width `pac_ext.dbf` representation of USGS Data Series 182 provide enough
source-separable, direct bulk-surficial `Gravel`/`Sand`/`Mud` support inside the exact San
Francisco hybrid-raster footprint to justify a later source-quality and alignment review?

The [protocol](2026-07-22-usgs-ds182-sediment-dbf-support-protocol-v1.md) was committed before any
official dBASE record value or aggregate was read. It disclosed that the companion
`PAC_EXT.txt` representation had already failed its frozen schema, that the archive and dBASE
header/descriptors had been inspected, and that synthetic code already embodied the endpoint
rules. The endpoint, surface-depth rule, operational anchors, whole-source grouping, support
minimums, and stop conditions were retained unchanged. This is not a repair of the text result
and the two representations are not independent evidence.

## Exact inputs and structural result

Two independent official download sets matched exactly:

- `pac_ext.zip`: 1,087,605 bytes, SHA-256
  `0643827168d4a91e8f2ed6df7962dee16ff39bdf203a263a833e7f3d7faa51ff`;
- `pac_ext.dbf`: 4,369,583 bytes, SHA-256
  `0617c5e83a0bd4de5b423bc1cf8774bd753ffdb5ed87f9bc32699fb6292c8afa`;
- `pac_src.txt`: 19,495 bytes, SHA-256
  `89bc35fd455f623cae5c3c7ab3942e9bd933bac7a56f447f7ec236f000af4a1e`;
- reference GeoTIFF: SHA-256
  `75629f6a8bc7e3ea78fb6b3b22c737ec75a8cba1621f2c0066a2343ab61a242a`.

The dBASE III version, 1,057-byte header, 265-byte record width, ordered 32-field schema, exact
terminators, 16,485 active records, and all fixed-width values pass the preregistered parser. Every
dBASE longitude/latitude agrees with the same-position Point geometry within `0.00001` degree.
The exact source table contains 114 unique source rows. The reference EPSG:26910 transform, shape,
and bounds match the prior admitted source; the audit reads no raster pixels.

The published metadata still says 16,486 records while the exact dBASE and Point members agree on
16,485. That preserved source erratum is not repaired.

## Frozen endpoint result

The 16,485 source records reduce to 15,577 distinct `SampleKey` values after 908 byte-equivalent
decoded duplicates are counted once. No conflicting sample or site identity was admitted.

The declared exclusion counts are nonexclusive because one row can fail more than one rule:

| Frozen exclusion | Rows |
| --- | ---: |
| Outside exact reference-raster footprint | 15,441 |
| Unsupported exact `DataTypes` value | 8,418 |
| Composition unreported | 2,698 |
| `SampleTop` outside 0.0–0.1 m or unreported sentinel | 1,296 |
| Nonblank `SamplePhase` | 418 |
| Composition sum outside 98–102% | 75 |

Only 136 distinct-sample records are inside the exact footprint, and **zero records satisfy every
frozen endpoint rule simultaneously**. Therefore the endpoint has zero valid rows, sites, and
source groups; there is no whole-source candidate partition and no support-eligible partition.
The result is a valid negative support finding, not a dBASE parser failure.

## Decision and reproduction

The raw endpoint is not admissible for this footprint. Source-accuracy review, raster alignment,
512 m leakage buffering, patch construction, and model training are not authorized. The audit does
not widen the geography, accept additional `DataTypes` strings, relax the surface rule, fill
composition, or select a different source subset after seeing the result.

Two independent-download executions produced byte-identical metrics at SHA-256
`2e36a23e6fa5261eaaddd588b9e3c7ae5df01bde1d2e70f893ccb56b7b0888a7`. After removing only
`run_id` and `created_at` and replacing absolute input paths with basenames, run metadata was also
byte-identical at SHA-256
`516deb6a17cd3aac2c432de7d2ccbfaf9b1a5d790d39e75233c89eb71310ba0a`.

The recorded target-agnostic identities are:

- experiment: `exp-target-agnostic-0e1fb4c5665964c1b44a8ce92803a1cb8039e2da2e5b5fd169ec94c105995687`;
- model placeholder: `model-target-agnostic-eadffec1d717a077dd99fe052dcd60e7cc8394b0cb266f6acd75115b24b29a55`.

No model was fit; the placeholder is provenance identity only. This result establishes neither
current sediment or habitat, fish presence, California-halibut skill, score calibration, nor
product readiness. No encoder, browser, API, Worker, D1/R2/Queue, score, provider, production, or
deployment state changed. The next representation comparison still requires a genuinely
support-complete independent endpoint or a separately preregistered scientific question.
