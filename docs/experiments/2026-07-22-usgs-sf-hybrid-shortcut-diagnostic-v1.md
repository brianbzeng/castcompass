# USGS Offshore San Francisco hybrid shortcut diagnostic v1

**Run date:** 2026-07-22 UTC

**Source commit:** `3b4307189e63d625ea0de048ab3f515da9e38144`

**Receipt:** [`hybrid-seafloor-shortcut-diagnostic-v1`](../../pipeline/evidence/hybrid-seafloor-shortcut-diagnostic-v1.receipt.json)

## Question and frozen boundary

Did the frozen hybrid experiment learn transferable seafloor representation, or
can survey footprint, source availability, and missingness explain part of the
reported transfer result?

This is a post-hoc diagnostic, not a new target-selection or promotion run. It
reuses the exact official corpus, three checkpoints, historical USGS
seafloor-character labels, validation fold `3`, and seed `42`. It cannot turn a
source-derived substrate map into independent biological validation.

Before rerunning the official inputs, the protocol fixed these controls:

- source domain means exactly one smallest-scale backscatter availability
  channel is present at the patch center;
- overlap and no-source rows are reported but never pooled into a source domain;
- a leave-one-source result needs at least 32 rows and at least 16 rows in every
  class on both sides of the split;
- seam slices below that per-class floor are descriptive only; and
- 1,000 paired bootstrap draws resample held-out rows within class.

## Fixed pretraining holdout audit

The nominal 903-row geographic holdout is source-degenerate. Of its rows, 901
have only the `8101_2004` source at center and two have no source; the 2006,
2007, and 2008 surveys contribute no measured center pixels. This fold can test
geographic transfer within one survey footprint, not cross-survey transfer.

| Feature set | Macro F1 |
| --- | ---: |
| Availability summaries only | 0.2611 |
| Coordinate polynomial | 0.4474 |
| Bathymetry classical summaries | 0.5865 |
| Bathymetry plus availability summaries | 0.6833 |
| Bathymetry pretrained encoder | 0.6462 |
| Backscatter pretrained encoder | 0.6348 |
| Fused pretrained encoder | 0.7020 |
| Fused classical summaries | **0.7574** |

Adding availability summaries to bathymetry classical summaries increases
macro F1 by median `+0.0968` with a 95% interval of `+0.0584` to `+0.1409`.
That does not mean availability alone is a useful model; it is evidence that
the missingness footprint contributes reliable conditional signal in this
source-degenerate split. Fused deep features still trail fused classical
summaries by `-0.0553` (`-0.1035` to `-0.0084`).

The 229 interior rows contain only one mobile-coarse example, and the 672 seam
rows contain only nine mixed/rugose examples. Both strata therefore remain
`descriptive_low_support`; the two unavailable-center rows are not evaluable.
No seam-versus-interior comparison is accepted from these slices.

## Leave-one-source-domain-out result

Only two surveys meet the predeclared per-class support floor.

| Held-out survey | Test rows | Bathymetry pretrained macro F1 | Fused pretrained macro F1 | Fused − bathymetry median delta (95% interval) |
| --- | ---: | ---: | ---: | ---: |
| `8101_2004` | 3,069 | **0.6171** | 0.4534 | `-0.1634` (`-0.1883`, `-0.1367`) |
| `8101_2008` | 600 | **0.3548** | 0.2987 | `-0.0572` (`-0.1027`, `-0.0144`) |

The `8101_2007` domain has 262 rows but only one mixed/rugose and one
mobile-coarse example. The `7125_2006` domain has 30 smooth-sediment rows and no
other class. They are recorded as `not_evaluable`; neither is silently merged
with another source.

The fused encoder is reliably worse than bathymetry pretraining on both
admissible unseen-survey tests. The fixed-fold benefit from fused or availability
features therefore does not establish cross-survey representation quality.

## Reproduction and decision

Two executions from the clean source commit produced byte-identical metrics at
SHA-256 `3eb59f04711061aab13aa3528e2a0d56f0f46f40bbbbb140f3461bd5433b5bb5`
and byte-identical predictions at
`dd47e6bc964ba12cc96d2b094b4e94ec46c5ebba6a8940a4e02876100fc06893`.
Run metadata differs only in execution-specific run ID, timestamp, and absolute
output paths.

The shortcut risk remains unresolved, no encoder is promoted, and no serving or
Opportunity Score path changes. Before fishing-label work, the next meaningful
model gate is an independently released habitat/video endpoint with source- and
geography-separated support, or a redesigned survey-invariant objective tested
against that independent endpoint.
