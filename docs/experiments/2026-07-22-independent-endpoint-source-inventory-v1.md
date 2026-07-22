# Independent seafloor endpoint source inventory v1

**Review date:** 2026-07-22 UTC

**Machine policy:**
[`castingcompass-independent-seafloor-endpoint-candidates-v1`](../../pipeline/independent-endpoint-candidate-policy.json)

**Policy SHA-256:** `5127ef90fe425d9dd1b0469a631a13cbd556a798208b7fb514190794dcc540e1`

**Receipt:**
[`independent-endpoint-source-inventory-v1`](../../pipeline/evidence/independent-endpoint-source-inventory-v1.receipt.json)

**Decision:** no reviewed candidate is admissible for raster pairing, supervised training,
representation comparison, encoder promotion, or production scoring

## Question and prior evidence

Is there an official California dataset that can provide a genuinely new, direct, source-separable
endpoint for the next comparison of the frozen bathymetry/backscatter representations?

The search excludes a candidate when it is outside the admitted San Francisco or Santa Barbara
imagery, is a map or model derived from the candidate inputs, reuses the already audited DS781 or
DS182 source families without new independent support, cannot observe every frozen class, or has
not demonstrated whole-source-group support. Discovering a public download is not model
authorization.

The existing negative audits remain binding: the San Francisco and Santa Barbara video sources,
the residual statewide DS781 catalog, and the San Francisco and Santa Barbara DS182 sediment
screens do not provide a valid whole-group partition with adequate support for every frozen
endpoint class. No row-randomized split, post-outcome class deletion, or derived map can repair
that result.

## Official-source review

| Candidate | Observation and lineage | Verdict |
| --- | --- | --- |
| [NOAA Digital Coast Benthic Grab Samples](https://www.coast.noaa.gov/digitalcoast/data/benthicgrab.html) | Direct soft-sediment grabs, but the catalog has five East Coast collections and no California collection. NOAA also notes that grabs are limited to soft substrate. | Exclude: no target geography, no hard-substrate endpoint, and no local class support. |
| [NOAA Digital Coast Benthic Cover](https://coast.noaa.gov/digitalcoast/data/benthiccover.html) | The catalog includes a 2011 San Francisco Bay benthic habitat map, but the product class is mapped cover derived primarily from imagery or acoustic surveys rather than a new direct endpoint. Exact overlap with the admitted offshore state-waters raster is not established. | Exclude: derived map, uncertain input independence, and offshore support unproven. |
| [NOAA NCCOS Benthic substrate type off California](https://www.fisheries.noaa.gov/inport/item/39578) | A compiled hard/soft polygon map based on Moss Landing material plus digitized hard-bottom maps from UCSB and the Minerals Management Service. NOAA reports variable resolution and says it has not been field validated. | Exclude: mapped rather than direct, only hard/soft, variable resolution, and unvalidated. |
| [NOAA NCCOS California halibut habitat suitability model](https://www.fisheries.noaa.gov/inport/item/39324) | A deterministic suitability product built by combining literature associations with bathymetry and benthic-substrate GIS layers. NOAA says its suitability values have not been validated. | Exclude: model output, wrong endpoint, and circular use of candidate input families. |
| [USGS Data Series 781 video observations](https://pubs.usgs.gov/ds/781/video_observations/data_catalog_video_observations.html) | Direct camera observations, but this is the source family already audited. The local and statewide support screens do not distribute all frozen classes across valid separable groups; tracks were also targeted to support sonar interpretation. | No new independent evidence: preserve the completed negative audits. |
| [USGS Data Series 182 Pacific Coast sediment database](https://pubs.usgs.gov/publication/ds182) | Direct bulk-surficial sediment measurements, but this is the source family already audited. San Francisco has zero endpoint-valid rows; the South Coast has 26 valid sites, zero gravel-bearing sites, and no eligible whole-source partition. | No new independent evidence: preserve the completed negative audits. |
| [USGS Data Series 781 habitat interpretations](https://cmgds.marine.usgs.gov/catalog/pcmsc/SeriesReports/DS_DDS/DS_781/SantaBarbara/Habitat_OffshoreSantaBarbara_metadata.faq.html) | Mapped interpretations whose metadata names bathymetry, backscatter, and hillshade as primary sources and video and sediment as support. | Exclude: direct candidate-input and endpoint-source reuse. |

The NOAA substrate layer is useful descriptive cartography, and the halibut HSM is useful prior
scientific context. Neither may be relabeled as an independent outcome for a model trained on or
evaluated against bathymetry/backscatter structure. The absence of an admissible public candidate
is a negative source-discovery result, not proof that no suitable data exists anywhere.

## Fail-closed implementation

The machine policy fixes seven candidate identities, official URLs, observation forms, lineage
statements, exclusion reasons, and empty evidence roles. Its validator rejects:

- any current raster-pairing, training, comparison, promotion, or production authority;
- an admissible candidate verdict or an unreviewed inventory entry;
- non-official or cleartext source URLs;
- derived maps or models without an explicit circularity exclusion; and
- any candidate-level evidence role or model authorization.

The next path is the separately frozen
[prospective direct-video collection protocol](2026-07-22-prospective-seafloor-endpoint-collection-protocol-v1.md).
That protocol remains local and inactive. It does not authorize contacting participants, assigning
sites, collecting data, pairing rasters, reading candidate outputs, or fitting a model.

## Claim boundary

This result establishes only that none of the seven reviewed official candidates is a new,
support-complete, independent three-class endpoint under the current question. It does not
establish current habitat, substrate prevalence, fish presence, catch probability, model skill,
product quality, or deployment readiness. No raster pixels were acquired or paired, no model was
trained or promoted, and no serving, score, browser, provider, production, or deployment state
changed.
