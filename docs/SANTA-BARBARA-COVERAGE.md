# Santa Barbara South Coast coverage

**Status:** repository implementation; not a production-release receipt

CastingCompass extends its explainable California-halibut relative ranker across
14 public South Coast access locations from Gaviota through Goleta and Santa
Barbara to Rincon. This is geographic product coverage, not a trained Santa
Barbara catch model and not evidence of improved accuracy.

## Included planning areas

- **Gaviota Coast:** Gaviota State Park beach, Refugio State Beach, and El
  Capitán State Beach.
- **Goleta:** Haskell's Beach and the ocean side of Goleta Beach.
- **Santa Barbara:** Arroyo Burro, Mesa Lane Steps, Leadbetter, Santa Barbara
  Harbor Breakwater, Stearns Wharf, and East Beach.
- **Summerland:** Summerland Beach from Lookout Park, kept limited until local
  reviewers confirm the pedestrian route, posted hours, and tide constraints.
- **Carpinteria:** Carpinteria State Beach and Rincon Beach Park.

Each catalog entry names its public-access source, applicable CDFW regulation
map, access caveat, casting-zone direction and exposure, and an explicit date for
the access review. Access, regulations, surf, construction, and wildlife closures
can change; the user must recheck official sources and posted signs before travel.

## Exclusions and boundary safeguards

- Campus Point, Sands, and Devereux are not fishing catalog locations because
  CDFW places that shoreline inside the Campus Point no-take conservation area.
  Ellwood Beach also remains unranked until a public access point can be tied to
  a clearly legal casting zone outside the protected boundary and locally
  reviewed without inviting boundary confusion.
- Goleta Slough is no-take. The Goleta listing covers the ocean beach only and
  does not assert that every portion of its pier is open.
- The El Capitán casting zone is kept outside the Naples no-take boundary.
- Gaviota's public beach is listed, while the storm-damaged Gaviota Pier remains
  explicitly closed and is not a ranked site.
- Private, uncertain, or poorly sourced access is omitted rather than inferred.

The 2026-07-20 gap audit used the [City of Goleta coastal-access
inventory](https://www.cityofgoleta.org/home/showpublisheddocument/32405/638962261763570000),
[CDFW's Campus Point boundary](https://wildlife.ca.gov/Conservation/Marine/MPAs/Campus-Point),
the [City of Santa Barbara beach
inventory](https://sbparksandrec.santabarbaraca.gov/parks-recreation-spaces?combine=&field_space_target_id=525),
and [Santa Barbara County's official Lookout Park
listing](https://www.countyofsb.org/lookout-park). It added the previously
uncovered Summerland segment through that public access. The
Summerland map point is based on [CDFW OSPR site summary
`4-675-C`](https://filelib.wildlife.ca.gov/Public/OSPR/WebMapping/ACP/dfg_ospr_acp4/pdfs/sensitive_sites/Archive/Archive_2019/4-675-C.pdf);
that response-planning document does not establish fishing quality, safe access,
or current water quality.

These product boundaries are conservative aids, not legal geofences. Official
CDFW maps, current regulations, and posted closures control.

## Forecast and scoring inputs

Regional tide predictions use NOAA CO-OPS station `9411399` at Gaviota State
Park for the Gaviota Coast, `9411340` at Santa Barbara for Goleta, Santa
Barbara, and Summerland, and `9411270` at Rincon Island for Carpinteria and
Rincon. Five NWS/Open-Meteo anchors cover Gaviota, Goleta, Santa Barbara,
Summerland, and Carpinteria.
NOAA NDBC station `46054` supplies West Santa Barbara Channel observations for
the Gaviota anchor, while `46053` supplies East Channel observations for the
other three anchors. Missing or stale values remain missing or stale; the
generator does not invent replacements.

The live configuration combines a curated habitat prior, provisional monthly
seasonality, public conditions, practical fishability, and a small transparent
access-pressure modifier. Habitat priors were not fit to Santa Barbara trip logs.
The final 0–100 value is a relative percentile across every active site/window in
the current catalog, not a calibrated chance of catching a fish.

## Queued data improvements

Two owner-requested goals remain incomplete:

1. Continue the separately versioned official water-quality overlay across the
   rest of the launch catalog. The second local source slice now covers all 14
   South Coast locations for explicit countywide BeachWatch actions, with 11
   direct station mappings and three countywide-only mappings. Active official
   actions can suppress a recommendation, while an absent, ended, malformed, or
   unavailable action remains unknown and never changes the numeric fishing
   score. Independent local mapping/source-latency review, broader Bay Area
   coverage, complete rainfall semantics, guarded deployment, and any validated
   fishing-quality contribution remain open. No value may imply that water is
   clean, safe, or predictive of catch without the required official and
   prospective evidence.
2. Complete independent location-by-location structure/depth acceptance. The
   first regional source-bound slice now gives all 14 locations reproducible
   NOAA ENC Approach depth-area intersections and selected chart-feature
   context, bound to policy, collector, site-catalog, and normalized-source
   hashes. It explicitly records meters, MLLW, source dates, missing fixed-grid
   resolution, missing numeric positional accuracy/uncertainty, display-only
   permission, and `scoreDelta: null`. Local sector review, dynamic habitat
   sources, per-location visual acceptance, and any separately validated model
   use remain open. See [STRUCTURE-DEPTH-EVIDENCE.md](STRUCTURE-DEPTH-EVIDENCE.md)
   and the unexecuted
   [Santa Barbara structure/depth review packet](SANTA-BARBARA-STRUCTURE-DEPTH-REVIEW.md).

The broader goals remain unchecked in the product roadmap. The implemented
advisory slices can exclude an exactly mapped San Francisco site or a supported
Santa Barbara action from local recommendations without changing the
opportunity-score bytes. The structure/depth slice adds display-only chart
context without altering Santa Barbara ranking inputs, catalog annotations, or
validation boundaries.

## Trip and validation boundary

Friends and other anglers may submit complete trips and skunks through the normal
private review workflow. Those reports do not automatically alter scores or
publish. They are ordinary product observations and are ineligible for the frozen
Bay Area feasibility pilot.

The original 47-site catalog is archived byte-for-byte at
`validation/catalogs/california-halibut-bay-area-v1.json`. A future Santa Barbara
performance study would require a new prospective protocol, frozen population,
recruitment plan, privacy review, and activation before any eligible outcome is
known.

## Local access review

The blank [local access review packet](SANTA-BARBARA-LOCAL-ACCESS-REVIEW.md)
provides a machine-checked way for area anglers to flag generalized catalog
corrections without supplying identity, exact trip time, coordinates, photos,
catches, or trip notes. It has not been executed. Every site remains pending,
and completing it cannot authorize deployment or create model-validation
evidence.

## Release checkpoint

This branch makes no Cloudflare, database, provider, indexing, or production
change. Review and protected CI can proceed independently, but deployment remains
blocked by the existing security and guarded-release checklist.
