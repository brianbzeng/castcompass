# USGS Santa Barbara South Coast sediment support v1

**Run date:** 2026-07-22 UTC

**Frozen source commit:** `44cb3189cf22756c0ebe32485f5e7bf09da84d5a`

**Experiment class:** exploratory, preexposed same-release geographic support

## Question and frozen boundary

Can the exact fixed-width USGS Data Series 182 sediment table provide enough direct,
source-separable bulk-surficial `Gravel`/`Sand`/`Mud` support inside four contiguous official USGS
Santa Barbara South Coast bathymetry footprints to justify a later source-quality and exact
raster-alignment review?

The [protocol](2026-07-22-usgs-south-coast-sediment-support-protocol-v1.md) was committed before
South Coast membership or region-specific support was computed. It disclosed the failed text
representation, the prior global dBASE parsing and San Francisco aggregate, and the already frozen
endpoint rules. The four raster transforms and bounds had been inspected, but no pixel value or
South Coast sediment distribution had been read.

This remains exploratory. The same DS182 record values already entered the San Francisco audit,
and this footprint is narrower than the Gaviota-to-Rincon product catalog. A pass could not be
independent confirmation or model-promotion evidence.

## Exact official inputs

Two independent DS182 download sets matched exactly:

- `pac_ext.zip`: 1,087,605 bytes at SHA-256
  `0643827168d4a91e8f2ed6df7962dee16ff39bdf203a263a833e7f3d7faa51ff`;
- `pac_ext.dbf`: 4,369,583 bytes at SHA-256
  `0617c5e83a0bd4de5b423bc1cf8774bd753ffdb5ed87f9bc32699fb6292c8afa`;
- `pac_src.txt`: 19,495 bytes at SHA-256
  `89bc35fd455f623cae5c3c7ab3942e9bd933bac7a56f447f7ec236f000af4a1e`.

The exact four USGS Data Series 781 bathymetry GeoTIFF hashes are:

| Frozen priority | Region | GeoTIFF SHA-256 |
| ---: | --- | --- |
| 1 | Offshore Refugio Beach | `fba0b0fa9f3dd2c29890a8b1260b4a3d53a74fc3d909e7b98e2656439319259a` |
| 2 | Offshore Coal Oil Point | `c63ab37fbc9f64b838fabd8d3fcee4b4c9a4de21ecd3410109d9fd12d01c595f` |
| 3 | Offshore Santa Barbara | `877a7ab310b60a5dbb263c47de640234a2254b3b44b4291960254c1a2d5eb408` |
| 4 | Offshore Carpinteria | `eb687e6a5fefeedc094f51f1d23a08d92b2b2c81e7bba3c26d62446558c9abea` |

Every dBASE/Point structural and coordinate-pairing check passes. Every raster SHA-256, CRS,
affine transform, shape, and bound matches the frozen metadata. The screen reads zero raster
pixels. Three overlapping points are assigned once using the preregistered west-to-east priority.

## Endpoint support result

The 16,485 records reduce to 15,577 distinct samples after 908 exact duplicates. Ninety-five
distinct samples fall inside one of the four footprints. Twenty-six records at 26 sites across
three source groups satisfy every frozen surface, exact-type, composition, identity, and geometry
rule.

Support is sparse and one-sided:

| Assigned region | Valid rows/sites | Gravel-bearing | Mud-bearing | Sand-dominant |
| --- | ---: | ---: | ---: | ---: |
| Offshore Refugio Beach | 1 | 0 | 1 | 0 |
| Offshore Coal Oil Point | 9 | 0 | 8 | 1 |
| Offshore Santa Barbara | 11 | 0 | 10 | 1 |
| Offshore Carpinteria | 5 | 0 | 4 | 1 |
| **Total** | **26** | **0** | **23** | **3** |

The three source groups contribute 17, 6, and 3 rows. There are three unique whole-source
bipartitions, but zero can meet the 64-row/site floor, the 16-row/site floor for every anchor, or
the minimum three train groups. In particular, the entire valid endpoint contains zero
`gravel_bearing` observations.

The global exclusion counts remain nonexclusive: 15,482 distinct samples are outside the South
Coast footprints, 8,418 have an unsupported exact type, 2,698 have unreported composition, 1,296
fail the surface-top rule, 418 have nonblank phase, and 75 fail the composition-sum tolerance.

## Reproduction and decision

Two independent DS182 download-set executions produced byte-identical metrics at SHA-256
`6b5ad746fc419bfdd93ced43a73051c59285af42595d0bb1294faef4127a4f41`. After removing only
`run_id` and `created_at` and replacing absolute input paths with basenames, run metadata was also
byte-identical at SHA-256
`6ae878a34f30e697bd09c1dce9625e529d72591e37efb474c6cf4dffa180c902`.

The target-agnostic provenance identities are:

- experiment: `exp-target-agnostic-551e1543969cc3e56b04831ac30a3f0b5bd4267377de583243eea1abc653686a`;
- model placeholder: `model-target-agnostic-ae6ebfa964ca09db66cbaf0922ee2180957eeaff501432b250ec0b6d995cbbb7`.

No model was fit; the placeholder is run identity only. Raw endpoint support is not admissible, so
source-method review, exact hybrid alignment, leakage buffering, patch construction, and training
are not authorized. The audit does not lower minimums, drop the absent anchor, pool adjacent rows,
or substitute mapped classes after seeing the result.

This closes the DS182 route for both the San Francisco and South Coast admitted imagery. The next
model comparison needs a genuinely support-complete independent endpoint or prospectively
designed trip/survey collection. No browser, API, Worker, D1/R2/Queue, encoder, score, serving,
provider, production, or deployment state changed.
