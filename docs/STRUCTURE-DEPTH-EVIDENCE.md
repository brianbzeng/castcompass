# California reviewed-location structure and depth evidence

**Status:** source-bound repository slice; independent site and visual review still required

## Frozen meaning

`castingcompass.structure-depth-evidence/1.5.0` is planning context for 61
reviewed catalog locations: all 14 Santa Barbara South Coast locations, ten San
Francisco coast and waterfront locations, ten San Mateo Coast/Half Moon Bay
locations, seven Point Reyes/Marin Coast locations, and ten North/East Bay
locations, plus the final ten Oakland-through-South-Bay launch-catalog
locations. It shows broad NOAA chart depth bands intersecting a configured
offshore sector and selected chart-feature classes within one kilometer. It is not:

- an exact depth at the map marker;
- a promise that a depth is shore-reachable or castable;
- a navigational, wading, access, or habitat-safety product;
- proof that uncharted structure is absent; or
- an opportunity-score, habitat-prior, or catch-probability input.

Every site has `scoreDelta: null`, `navigationUseAllowed: false`, and catalog
mutation disabled. The checked-in site catalog, provisional target-depth fields,
habitat priors, opportunity snapshot, and validation geography are unchanged.

## Why NOAA ENC Direct is the initial baseline

The Santa Barbara source review compared three official datasets on 2026-07-21:

1. [NOAA BlueTopo](https://nauticalcharts.noaa.gov/data/bluetopo_specs.html)
   has explicit elevation, uncertainty, and contributor layers, but the current
   `BlueTopo_Tile_Scheme_20260626_132625.gpkg` exposes a published tile at only
   Gaviota, Refugio, and El Capitán. The remaining 11 site tiles have no current
   download link, so BlueTopo cannot support a consistent regional claim.
2. [USGS Data Series 702](https://pubs.usgs.gov/ds/702/data.html) provides a
   stable 2012 Santa Barbara Channel 10 m NAVD88 grid. Only six configured site
   sectors contained valid grid cells, and the nearshore coverage is too
   incomplete to use as the sole 14-site baseline.
3. [NOAA ENC Direct to GIS](https://nauticalcharts.noaa.gov/learn/encdirect/)
   returned a depth-area intersection for every configured Santa Barbara site sector. The
   collector uses only the `Approach` usage band because NOAA recommends one
   scale band per extraction to avoid mixed-resolution duplicates.

The BlueTopo tile-scheme SHA-256 is
`dc854cc98608eaae19e5cc8e4ccf92f9f61af998cc135c61c649d2052c3fc319`.
The downloaded USGS archive SHA-256 is
`5ae764fe1d154b43deb2dcd1c1a1de253c737abb5b2221529783ccbead79453b`.
These receipts explain source selection; neither rejected source is silently
substituted for a missing ENC value.

The San Francisco extension reuses that exact fixed `Approach` service and
layer inventory. Nine of ten configured San Francisco sectors intersect one or
more depth-area records. Crane Cove Park does not; it remains explicitly
`partial`, even though point soundings and selected chart features exist within
one kilometer. No other source or catalog prior is substituted to make that
sector appear complete.

The San Mateo Coast/Half Moon Bay extension uses the same fixed source and layer
inventory. All ten configured sectors intersect one or more depth-area records
and have at least one deduplicated sounding within one kilometer. This chart
coverage does not override access: Pacifica Municipal Pier remains closed,
excluded from recommendations, and absent from forecast/detail/trip-start flows;
the main interface retains its official closure-status link.

The Point Reyes/Marin Coast extension also uses the fixed `Approach` service and
layer inventory. Five of seven configured sectors intersect one or more depth-
area records. Bolinas Beach and Muir Beach do not; each remains explicitly
`partial`, even though nearby point soundings and a charted seabed-description
record exist. Neither catalog clues nor soundings are substituted for the
missing area-band evidence.

The North/East Bay extension uses the same fixed service and layer inventory.
Eight of ten configured sectors intersect one or more depth-area records.
McNears Beach Pier and Ferry Point Fishing Pier do not; each remains explicitly
`partial`, even though nearby point soundings and charted shoreline-construction
records exist. Neither catalog clues nor soundings are substituted for the
missing area-band evidence.

The Oakland-through-South-Bay extension completes source-bound coverage of the
61-site launch catalog with the same fixed service and layer inventory. All ten
new configured sectors intersect one or more depth-area records and have nearby
deduplicated soundings. The chart records still do not establish shore-reachable
depth, castability, access, wading safety, or navigation suitability.

## Geometry and interpretation

For each site, the collector constructs a WGS84 sector from the public catalog
coordinate, the existing bearing, the existing radius, and a fixed ±45-degree
half-width. Depth areas, contours, and soundings are intersected with that
sector. A separate 1,000 m circle provides nearby point-sounding and selected
structure-class context.

The sector is a reproducible query footprint, not a measured cast envelope. A
band such as `0–9.1 m` means one or more ENC depth-area features with that range
intersect the sector. Overlapping bands can come from adjacent or overlapping
ENC cells and are preserved rather than blended into invented precision.
Negative-to-zero bands describe drying/shoreline transitions and are retained in
the artifact but omitted from the compact public water-band list.

Depth units are meters. NOAA tidal-chart depths use Mean Lower Low Water (MLLW),
while the selected feature records do not consistently populate `VERDAT`.
ENC Direct is vector chart data, not a raster with a fixed grid resolution. The
selected layers also do not publish numeric positional accuracy or vertical
uncertainty. Those fields therefore remain explicit `not-exposed` states rather
than zeros.

## Captured 61-site inventory

The normalized source snapshot was captured at `2026-07-21T12:10:36Z` from the
fixed NOAA `enc_approach` ArcGIS service. Point-sounding counts are deduplicated
across overlapping ENC cells. “No selected feature record” never means “no
structure.”

| Location | Submerged ENC bands intersecting sector | Deduplicated soundings within 1 km | Selected chart-feature classes within 1 km |
| --- | --- | ---: | --- |
| Gaviota State Park Beach | 0–9.1 m | 6 | Shoreline construction |
| Refugio State Beach | 0–9.1 m | 4 | No selected feature record |
| El Capitán State Beach | 0–9.1 m | 2 | No selected feature record |
| Haskell's Beach | 0–9.1 m | 1 | Shoreline construction |
| Goleta Beach | 0–9.1 m | 3 | Shoreline construction |
| Arroyo Burro Beach | 0–9.1 m; 9.1–18.2 m | 6 | No selected feature record |
| Mesa Lane Steps Beach | 0–9.1 m | 9 | No selected feature record |
| Leadbetter Beach | 0–3.6 m; 1.8–3.6 m; 3.6–5.4 m; 5.4–10.9 m | 12 | Pile/piling; seabed description; shoreline construction |
| Santa Barbara Harbor Breakwater | 0–3.6 m; 3.6–5.4 m; 5.4–10.9 m | 16 | Obstruction; pile/piling; seabed description; shoreline construction |
| Stearns Wharf | 3.6–5.4 m; 5.4–10.9 m | 19 | Obstruction; pile/piling; shoreline construction; wreck |
| East Beach | 5.4–10.9 m; 10.9–18.2 m | 22 | Seabed description; wreck |
| Summerland Beach from Lookout Park | 1.8–3.6 m; 3.6–5.4 m; 5.4–10.9 m | 7 | No selected feature record |
| Carpinteria State Beach | 0–1.8 m; 3.6–5.4 m; 5.4–10.9 m | 9 | Shoreline construction |
| Rincon Beach Park | 1.8–3.6 m; 3.6–5.4 m; 5.4–10.9 m; 10.9–14.6 m | 14 | Obstruction; shoreline construction |

| San Francisco location | Evidence status | ENC bands intersecting sector | Deduplicated soundings within 1 km | Selected chart-feature classes within 1 km |
| --- | --- | --- | ---: | --- |
| Torpedo Wharf | Charted context | 0–1.8 m; 0–3.6 m; 1.8–3.6 m; 3.6–5.4 m; 5.4–9.1 m; 9.1–18.2 m; 18.2–27.4 m | 16 | Seabed description; shoreline construction |
| Crissy Field East Beach | Charted context | 0–1.8 m; 0–3.6 m; 1.8–3.6 m; 1.8–5.4 m; 5.4–9.1 m; 9.1–18.2 m | 6 | Obstruction; seabed description; shoreline construction |
| Baker Beach | Charted context | -1.8–0 m; 0–3.6 m; 1.8–3.6 m; 3.6–5.4 m; 5.4–9.1 m; 9.1–10.9 m; 10.9–18.2 m | 20 | Seabed description |
| China Beach | Charted context | -1.8–0 m; 0–3.6 m; 3.6–5.4 m; 5.4–9.1 m | 10 | Seabed description |
| Ocean Beach North | Charted context | -1.8–0 m; 0–1.8 m; 0–3.6 m; 1.8–3.6 m; 3.6–5.4 m; 5.4–9.1 m | 17 | No selected feature record |
| Ocean Beach South | Charted context | -1.8–0 m; 0–1.8 m; 1.8–3.6 m; 3.6–5.4 m; 5.4–9.1 m | 7 | Seabed description |
| Pier 7 | Charted context | 5.4–9.1 m; 9.1–18.2 m | 14 | Obstruction; shoreline construction |
| Pier 14 | Charted context | 0–3.6 m; 3.6–5.4 m; 5.4–9.1 m; 9.1–18.2 m | 13 | Obstruction; shoreline construction; wreck |
| Crane Cove Park | Partial | No intersecting depth-area band | 7 | Obstruction; pile/piling; seabed description; shoreline construction; wreck |
| Heron's Head Park Pier | Charted context | 0–3.6 m | 16 | Obstruction; seabed description; shoreline construction; wreck |

| San Mateo Coast / Half Moon Bay location | ENC bands intersecting sector | Deduplicated soundings within 1 km | Selected chart-feature classes within 1 km |
| --- | --- | ---: | --- |
| Pacifica Municipal Pier | -1.8–0 m; 0–3.6 m | 2 | Shoreline construction |
| Sharp Park Beach | -1.8–0 m; 0–3.6 m; 3.6–10.9 m | 3 | Shoreline construction |
| Rockaway Beach | -1.8–0 m; 0–3.6 m; 3.6–10.9 m | 3 | Seabed description |
| Pacifica State Beach (Linda Mar) | -1.8–0 m; 0–3.6 m; 3.6–10.9 m | 1 | Seabed description |
| Montara State Beach | -1.8–0 m; 0–3.6 m; 3.6–10.9 m; 10.9–18.2 m | 2 | No selected feature record |
| Pillar Point Harbor West Jetty | 0–1.8 m; 1.8–3.6 m; 3.6–5.4 m | 18 | Seabed description; shoreline construction |
| Pillar Point Harbor East Jetty | 3.6–5.4 m; 5.4–9.1 m | 19 | Seabed description; shoreline construction |
| Surfer's Beach | 5.4–9.1 m; 9.1–18.2 m | 11 | Pile/piling; seabed description; shoreline construction |
| Francis State Beach | -1.5–0 m; 1.8–3.6 m; 3.6–5.4 m; 5.4–9.1 m | 9 | Obstruction; seabed description |
| Poplar Beach | -1.5–0 m; 1.8–3.6 m; 3.6–5.4 m; 5.4–9.1 m | 11 | Seabed description |

| Point Reyes / Marin Coast location | Evidence status | ENC bands intersecting sector | Deduplicated soundings within 1 km | Selected chart-feature classes within 1 km |
| --- | --- | --- | ---: | --- |
| Limantour Beach | Charted context | -1.6–0 m; -1.5–0 m; 0–3.6 m; 3.6–5.4 m; 3.6–10.9 m; 5.4–9.1 m; 9.1–18.2 m | 12 | Seabed description |
| Drakes Beach | Charted context | -1.6–0 m; -1.5–0 m; 0–3.6 m; 1.8–3.6 m; 3.6–5.4 m; 3.6–10.9 m; 5.4–9.1 m | 14 | Seabed description |
| Point Reyes South Beach | Charted context | -1.6–0 m; 0–3.6 m; 3.6–5.4 m; 3.6–10.9 m; 5.4–9.1 m; 9.1–18.2 m; 10.9–18.2 m | 10 | No selected feature record |
| Bolinas Beach | Partial | No intersecting depth-area band | 6 | Seabed description |
| Stinson Beach | Charted context | -1.8–0 m; -1.5–0 m; 0–1.8 m; 0–3.6 m; 1.8–3.6 m; 3.6–5.4 m; 3.6–10.9 m; 5.4–9.1 m; 9.1–10.9 m; 10.9–18.2 m | 11 | Seabed description |
| Muir Beach | Partial | No intersecting depth-area band | 9 | Seabed description |
| Rodeo Beach | Charted context | -1.8–0 m; -1.5–0 m; 0–9.1 m; 3.6–10.9 m; 9.1–10.9 m | 13 | No selected feature record |

| North / East Bay location | Evidence status | ENC bands intersecting sector | Deduplicated soundings within 1 km | Selected chart-feature classes within 1 km |
| --- | --- | --- | ---: | --- |
| McNears Beach Pier | Partial | No intersecting depth-area band | 6 | Shoreline construction |
| Paradise Beach Pier | Charted context | 0–1.8 m | 13 | Obstruction; pile/piling; seabed description; shoreline construction |
| Fort Baker Fishing Pier | Charted context | 0–3.6 m; 0–5.4 m; 5.4–9.1 m | 12 | Obstruction; pile/piling; shoreline construction |
| Ferry Point Fishing Pier | Partial | No intersecting depth-area band | 6 | Shoreline construction |
| Keller Beach | Charted context | -1.7–0 m; 0–1.8 m | 6 | Shoreline construction |
| Point Isabel Shoreline | Charted context | 0–1.8 m | 10 | Obstruction; seabed description; shoreline construction |
| Albany Bulb Shoreline | Charted context | -1.7–0 m; 0–1.8 m | 9 | Shoreline construction |
| Berkeley Marina North Basin Shore | Charted context | 0–1.8 m | 8 | Obstruction; seabed description; shoreline construction |
| Cesar Chavez Park Shoreline | Charted context | 0–1.8 m | 13 | Obstruction; seabed description; shoreline construction |
| Emeryville Marina Fishing Pier | Charted context | 0–1.8 m | 16 | Obstruction; pile/piling; seabed description; shoreline construction |

| Oakland through South Bay location | ENC bands intersecting sector | Deduplicated soundings within 1 km | Selected chart-feature classes within 1 km |
| --- | --- | ---: | --- |
| Port View Park Fishing Pier | 1.8–3.6 m; 3.6–5.4 m; 5.4–9.1 m | 12 | Dredged area; obstruction; seabed description; shoreline construction |
| Middle Harbor Shoreline Park | -1.7–0 m; 0–5.4 m | 4 | Dredged area; obstruction; pile/piling; shoreline construction |
| Alameda South Shore Rock Wall | 0–1.8 m | 12 | Obstruction; seabed description; shoreline construction |
| Crown Memorial State Beach | -2.4–0 m; 0–1.8 m; 1.8–3.6 m | 8 | Obstruction; shoreline construction; wreck |
| Oyster Bay Regional Shoreline | -2.4–0 m; 0–1.8 m | 13 | Obstruction; shoreline construction; wreck |
| San Leandro Marina Shore | -2.4–0 m; 0–1.8 m | 15 | Obstruction; shoreline construction; wreck |
| Dumbarton Fishing Pier | 9.1–18.2 m | 13 | Obstruction; shoreline construction |
| Coyote Point Jetty | -2.4–0 m; 0–1.8 m | 12 | Pile/piling; shoreline construction |
| Seal Point Park Shoreline | 0–1.8 m | 22 | Obstruction; shoreline construction |
| Oyster Point Fishing Pier | 0–1.8 m | 22 | Pile/piling; shoreline construction |

The exact full-date depth records range from 1999 through 2025. The source also
publishes valid month-precision values such as `2013-06` and a year-only `2005`
for the charted wreck near Stearns Wharf. Contract version 1.5 preserves those
values separately in `partialSourceDates`; it never invents a day. A record with
no `SORDAT` sets `hasUndatedRecords`. Source age and precision are displayed
because a current service response does not make an old underlying survey new.

## Integrity and failure behavior

`scripts/refresh_structure_depth.py`:

- allows only the fixed HTTPS NOAA Approach service and rejects redirects;
- verifies every reviewed layer ID and name against service metadata before
  querying;
- caps responses and feature counts, rejects transfer-limit truncation,
  unexpected fields, malformed geometry, invalid depths, invalid source cells,
  and unreviewed dates, while preserving validated year/month precision;
- stores normalized feature attributes plus point geometry or a geometry hash,
  avoiding public exact structure coordinates;
- deduplicates overlapping-cell soundings and geometry-identical structure
  records without treating a missing class as absence;
- binds the public artifact to SHA-256 digests of the policy, collector, exact
  site catalog, and normalized source snapshot; and
- can regenerate deterministically from the checked-in snapshot for offline and
  adversarial tests.

Any required depth-query failure makes that site's depth unavailable. Any
selected structure-query failure makes the structure section unavailable while
retaining catalog clues as explicitly unvalidated. Service metadata drift makes
all 61 sites unavailable. Errors are fixed categories and never expose local
paths or exception text.

## Remaining acceptance work

This completes source-bound chart-context coverage of all 61 launch-catalog
locations, not the parent map goal. Before a location can be called fully
reviewed:

1. a local reviewer must confirm the sector orientation, public access context,
   and whether the displayed chart classes are useful rather than misleading;
2. dynamic sand bars, troughs, reef edges, vegetation, and other catalog clues
   need separate reproducible sources or must remain generic field clues;
3. BlueTopo or another qualified source with explicit uncertainty should be
   added where complete coverage becomes available;
4. mobile visual acceptance must confirm that bands, datum, age, uncertainty,
   and non-navigation language remain legible; and
5. any scoring use needs a separately frozen policy, independent habitat review,
   and prospective validation against the unchanged baseline.

The blank
[Santa Barbara structure/depth review packet](SANTA-BARBARA-STRUCTURE-DEPTH-REVIEW.md)
now provides the first executable review path for items 1 and 2 across the 14
South Coast sites. It requires disjoint local-angler and chart/GIS roles, current
source-identity evidence, private raw answers, and an aggregate-only receipt.
The blank
[San Francisco structure/depth review packet](SAN-FRANCISCO-STRUCTURE-DEPTH-REVIEW.md)
extends the same executable boundary to the next ten coast and waterfront sites
while preserving Crane Cove Park's partial chart status. The shared evaluator
keeps each region's schemas, geography, site inventory, policy digest, and
private response files isolated. The blank
[San Mateo structure/depth review packet](SAN-MATEO-STRUCTURE-DEPTH-REVIEW.md)
adds the next ten Coast and Half Moon Bay sites while keeping Pacifica Municipal
Pier's independent closure and recommendation exclusion intact. The blank
[Point Reyes and Marin Coast structure/depth review packet](MARIN-STRUCTURE-DEPTH-REVIEW.md)
adds the next seven sites while preserving Bolinas Beach and Muir Beach as
`partial`; no response can invent either missing sector band or promote those
records to charted context. The blank
[North and East Bay structure/depth review packet](NORTH-EAST-BAY-STRUCTURE-DEPTH-REVIEW.md)
adds the next ten sites while preserving McNears Beach Pier and Ferry Point
Fishing Pier as `partial`; nearby soundings, shoreline-construction records,
catalog clues, or human responses cannot substitute for either missing
depth-area band. Preparing any packet is not the review itself and does not
close any item above.

No production, Cloudflare, database, provider, or deployment change is part of
this repository slice.
