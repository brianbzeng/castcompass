# Water-quality advisory overlay

## Frozen meaning

The `castingcompass.water-quality-advisory/2.0.0` artifact is a human-health
water-contact advisory overlay. It is not a California-halibut predictor, a
pollution severity model, a catch-probability input, or evidence that fish,
water contact, or seafood consumption is safe.

The policy remains deliberately narrow:

- only a reviewed site-to-station mapping or an explicit countywide action may
  receive an agency status;
- a current official closure, posting, advisory, or rain action suppresses that
  site from CastingCompass recommendations without rewriting its attested
  fishing score;
- a current no-active-posting result is neutral only when its source publishes
  complete, fresh sample evidence;
- an action-only source can never turn an absent record into a no-posting claim;
- stale, incomplete, unmonitored, unavailable, and unmapped status stays
  explicitly unknown; and
- the official agency page and posted signs remain authoritative.

This preserves the frozen opportunity-score and validation contracts while
adding an independent recommendation guardrail. Water quality remains excluded
from the numeric score until a separately reviewed policy defines a defensible
contribution and frozen-baseline validation accepts it.

## San Francisco sample-status source

Source `sfpuc` uses the San Francisco Public Utilities Commission (SFPUC) Ocean
and Beach Monitoring Program:

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

SFPUC describes routine weekly sampling. For a neutral no-posting result, every
mapped station must be present, sampled, and no more than ten Pacific-calendar
days old. The small allowance beyond seven days accommodates publication timing
without turning an old sample into indefinite current evidence. Any active
official status takes precedence. If a multi-station mapping has any active
status, the strictest status wins. If a station is missing, stale, or
unmonitored and none is active, the site is unknown.

## Santa Barbara County action source

Source `california-beachwatch-santa-barbara` uses the California State Water
Resources Control Board's public BeachWatch action table. The State Board
explains that local health agencies issue advisories and closures and submit
beach action information; CastingCompass does not substitute its own bacteria
thresholds.

- State program and survey context:
  <https://www.waterboards.ca.gov/water_issues/programs/beaches/beach_surveys/index.html>
- fixed public action table:
  <https://beachwatch.waterboards.ca.gov/public/advisory.php>

The collector submits only the fixed Santa Barbara County identifier `14` to
that public table. It recognizes only the published `Closure`, `Posting`, and
`Rain` action types. A start date must not be in the future, and a reported end
date must not precede the refresh date. `Closure` takes precedence over
`Posting`, which takes precedence over `Rain`.

All 14 South Coast locations inherit the table's explicit
`All_Santa_Barbara_County_Beaches` action. Eleven also have direct station
mappings:

| CastingCompass site | BeachWatch station support |
| --- | --- |
| Gaviota State Park Beach | WP0000079 |
| Refugio State Beach | WP0000183 |
| El Capitán State Beach | WP0000013 |
| Haskell's Beach | WP0000186 |
| Goleta Beach | WP0000037 |
| Arroyo Burro Beach | WP0000147 |
| Mesa Lane Steps Beach | Countywide actions only |
| Leadbetter Beach | WP0000007 |
| Santa Barbara Harbor Breakwater | Countywide actions only |
| Stearns Wharf | Countywide actions only |
| East Beach | WP0000083, WP0000085 |
| Summerland Beach from Lookout Park | WP0000188 |
| Carpinteria State Beach | WP0000180 |
| Rincon Beach Park | WP0000123 |

An active exact-station or countywide action suppresses the mapped catalog site.
An ended or future action does not. Crucially, the action table does not publish
complete fresh sample evidence for every mapped site, so no matching active row
means **unknown**, never neutral, open, clean, or safe. The collector tolerates
only a date-order anomaly that has already been wholly historical for more than
90 days; recent or future malformed dates fail this source closed. This bounded
exception covers a documented old row without letting an old data defect disable
current actions or become a no-posting inference.

The checked-in review snapshot was refreshed from both official endpoints at
`2026-07-21T07:20:00Z`. At that instant the State Board table returned
open-ended postings for Gaviota (`2026-06-15`) and Refugio (`2026-06-08`), so
those two recommendations are suppressed in this repository artifact. That is a
time-stamped review snapshot, not a live guarantee; users must check the linked
agency source and posted signs.

## Integrity and failure behavior

`scripts/refresh_water_quality.py`:

- permits only the two fixed HTTPS machine endpoints and rejects redirects;
- caps every response at 2 MiB and rejects malformed source structure;
- binds the artifact to SHA-256 digests of the policy, collector, and exact site
  catalog;
- isolates source failures so one unavailable program cannot erase a valid
  active action from the other;
- rejects duplicate SFPUC station records, unreviewed SFPUC status codes,
  unreviewed BeachWatch action types, unexpected counties, invalid station IDs,
  and recent malformed action dates;
- keeps missing BeachWatch actions unknown instead of inferring a neutral state;
- sanitizes source failures into fixed categories without publishing exception
  text or local paths; and
- supports separate local XML and HTML fixtures plus `--as-of` for deterministic
  adversarial tests.

The browser independently expires neutral SFPUC sample evidence on the same
Pacific-calendar freshness rule. The scheduled snapshot workflow refreshes and
validates `public/data/water-quality.json` before opening its ordinary review PR.

## Local implementation receipt

The exact follow-up tree passed the Cloudflare build and 475 Node tests, the
complete 144-case Chromium/WebKit phone matrix, ESLint, TypeScript, the full
security/SBOM/source-integrity chain, both zero-vulnerability npm audits, 29 API
tests, Ruff, 83 pipeline tests with one documented optional-`rasterio` skip, the
deterministic synthetic smoke, and all 19 critical D1 query-plan checks. This is
repository evidence only. Exact-head hosted checks, independent mapping review,
guarded deployment, and post-deployment source verification remain open.

## Unfinished acceptance work

The broader roadmap item stays open. Before water quality can become a numeric
score component, CastingCompass still needs:

1. reviewed official-source adapters and exact mappings for the remaining
   launch catalog;
2. independent local review of the Santa Barbara station/countywide mappings,
   source latency, rainfall semantics, geographic support, and outage behavior;
3. frozen retrospective and prospective baselines that test whether any fishing-
   quality contribution improves ranking without creating misleading health
   claims;
4. independent review of suppression, accessibility, mobile behavior, and
   operational refresh evidence; and
5. guarded deployment and post-deployment source-freshness receipts.

Until those gates pass, agency status is an exclusion-only safety guardrail and
every numeric scoreDelta remains null.
