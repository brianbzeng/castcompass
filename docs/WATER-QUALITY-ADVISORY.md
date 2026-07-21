# Water-quality advisory overlay

## Frozen meaning

The castingcompass.water-quality-advisory/1.0.0 artifact is a human-health
water-contact advisory overlay. It is not a California-halibut predictor, a
pollution severity model, a catch-probability input, or evidence that fish,
water contact, or seafood consumption is safe.

The first policy slice is deliberately narrow:

- only an exact, reviewed site-to-station mapping may receive an agency status;
- a current official closure, posting, or advisory suppresses that site from
  CastingCompass recommendations without rewriting its attested fishing score;
- a current no-active-posting result is neutral and cannot improve a score;
- stale, incomplete, unmonitored, unavailable, and unmapped status stays
  explicitly unknown; and
- the official agency page remains authoritative.

This preserves the frozen opportunity-score and validation contracts while
adding an independent recommendation guardrail. Water quality remains excluded
from the numeric score until a separately reviewed policy defines a defensible
contribution and frozen-baseline validation accepts it.

## Initial official source and support

Version castingcompass.water-quality-advisory/sfpuc-0.1.0 uses the San
Francisco Public Utilities Commission (SFPUC) Ocean and Beach Monitoring
Program:

- program: <https://www.sfpuc.gov/programs/ocean-and-beach-monitoring>
- public current-status map:
  <https://webapps.sfpuc.org/sapps/beachesandbay.html>
- fixed machine endpoint:
  <https://infrastructure.sfwater.org/lims.asmx/getBeaches>

SFPUC's public map distinguishes current open/no-posting locations, posted
locations, unavailable data, locations that are not routinely sampled, and
recent combined-sewer discharges. CastingCompass uses only the fail-closed
subset described above and does not independently reinterpret numeric bacteria
measurements as safe.

The policy maps six catalog sites to exact SFPUC station identifiers:

| CastingCompass site | SFPUC station IDs |
| --- | --- |
| Baker Beach | 4608, 4609, 4610 |
| China Beach | 4607 |
| Crane Cove Park | 4620 |
| Crissy Field East Beach | 4612 |
| Ocean Beach North | 4604, 4605 |
| Ocean Beach South | 4602 |

All other catalog sites remain not-covered. Nearby stations are not silently
substituted for an exact mapping.

## Freshness and precedence

SFPUC describes routine weekly sampling. For a neutral no-posting result, every
mapped station must be present, sampled, and no more than ten calendar days old.
The small allowance beyond seven days accommodates publication timing without
turning an old sample into indefinite current evidence.

An active official closure, posting, advisory, or combined-sewer-discharge
signal takes precedence over the sample-age check and suppresses the
recommendation. This is because the current agency map—not CastingCompass's own
measurement interpretation—is the controlling status. If a multi-station
mapping has any active status, the strictest status wins. If any station is
missing or unmonitored and none is active, the site is unknown.

## Integrity and failure behavior

scripts/refresh_water_quality.py:

- permits only the fixed HTTPS SFPUC machine endpoint and rejects redirects;
- caps the response at 2 MiB and rejects malformed or duplicate station data;
- binds the published artifact to SHA-256 digests of the policy, collector, and
  exact site catalog;
- rejects unreviewed agency status codes, while the browser independently
  expires a neutral sample on the same Pacific-calendar freshness rule;
- sanitizes source failures into fixed categories;
- writes an explicit source-unavailable assessment instead of inventing an
  agency status; and
- supports a local XML fixture and --as-of timestamp for deterministic
  adversarial tests.

The scheduled snapshot workflow refreshes and validates
public/data/water-quality.json before opening its ordinary review PR.

## Unfinished acceptance work

The broader roadmap item stays open. Before water quality can become a numeric
score component, CastingCompass still needs:

1. reviewed official-source adapters and exact mappings for the remaining
   launch catalog and the Santa Barbara/Goleta catalog;
2. source-specific current-status semantics, rainfall cautions, sampling
   cadence, geographic support, licensing, and outage behavior;
3. frozen retrospective and prospective baselines that test whether any
   fishing-quality contribution improves ranking without creating misleading
   health claims;
4. independent review of suppression, accessibility, mobile behavior, and
   operational refresh evidence; and
5. guarded deployment and post-deployment source-freshness receipts.

Until those gates pass, agency status is an exclusion-only safety guardrail and
every numeric scoreDelta remains null.
