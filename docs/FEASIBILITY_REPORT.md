# ContourCast v1 feasibility report

Status: **feasible as an explainable relative opportunity ranking; not feasible as a defensible hour-level catch probability with the currently identified public labels.**

## Decision

Proceed with a narrow California halibut planning product for public shore, beach, jetty, and pier access around the Bay Area. Ship a relative ranking with explicit confidence and freshness. Do not market the output as a guaranteed hotspot or probability of catch.

## What the public data can support

### Long-term habitat ranking

The NOAA San Francisco Bay bathymetry product is detailed enough to derive depth, slope, curvature, roughness, bathymetric position, and channel-edge context. Higher-resolution USGS coverage materially improves the structure ceiling: official products include 4 m central-Bay bathymetry/backscatter, 2 m offshore San Francisco bathymetry/backscatter/seafloor character, and a newer 1 m central-Bay surface in a bathymetric-change release. Those signals can be summarized within reachable casting zones rather than arbitrary offshore pixels.

Feature specificity remains source-limited. ContourCast conservatively requires a structure to span at least three native cells and meet published positional-accuracy constraints. A narrow pipe may be unresolved even at 2 m, while its raised corridor, scour, backscatter response, attached-kelp footprint, or associated habitat edge may be detectable. The model records this distinction instead of treating an interpolated pixel as a measurement.

CDFW/CRFS spatial data can support regional California-halibut occurrence and catch-rate evidence, including zero-catch/sample context where released. Its spatial aggregation and minimum-sample rules make it better suited to long-term habitat learning than exact spot claims.

### Seasonality

Monthly RecFIN catch and effort can support a broad seasonal multiplier by area and fishing mode. A reproducible export and query manifest are required before that component becomes a measured production claim.

### Near-term conditions

NOAA CO-OPS, NWS, NDBC, and CoastWatch provide useful public conditions. These do not share the same cadence, spatial support, or forecast horizon, so each must carry its own freshness and exclusion rule. The near-term conditions layer should remain a bounded expert-informed modifier until finer date/time catch labels are legally and reliably available.

## Main limitations

1. **Label resolution:** public recreational catch records are aggregated and cannot establish which accessible shoreline micro-structure produced an observation. Area-level training must use multiple-instance bags, never invented centroids; user-consented precise trip reports are required for eventual micro-structure validation.
2. **Time resolution:** identified public labels do not support a fully learned two-hour catch model.
3. **Sampling bias:** survey effort, mode, access, angler behavior, and reporting vary in space and time.
4. **Positive-label ambiguity:** a catch block can contain water that is unreachable from a public casting zone.
5. **Coastal raster coverage:** a single Bay DEM does not cover the entire Point Reyes–Half Moon Bay product area at identical resolution or datum. Multiple official products must be reconciled and documented.
6. **Datum alignment:** shoreline, bathymetry, and station products may use different horizontal or vertical datums. A valid pipeline must never relabel a raster to make it appear aligned.
7. **Access and regulations:** public access and fishing rules can change faster than model artifacts.

## Promotion criteria

The deep model should not ship because it is interesting. It should ship only when geographically blocked holdouts show reliable improvement over simpler seasonal, generalized-additive/linear, and boosted-tree baselines.

Required evaluation includes:

- occurrence ROC AUC, average precision, Brier score, log loss, and calibration error;
- positive-catch log-CPUA MAE/RMSE;
- Spearman correlation and NDCG for ranking;
- bootstrap confidence intervals;
- buffered geographic folds;
- bathymetry, seasonality, and individual-channel ablations.

If the deep model does not improve ranking reliably, the strongest validated baseline/ensemble becomes production and the negative result remains documented in the model card.

## v1 implementation boundary

Implemented now:

- 47 public access records and casting-zone metadata;
- a 72-hour, two-hour-window interface;
- live tide/weather/buoy snapshot inputs with missing-source exclusion;
- static/offline fallback;
- API/PostGIS contracts;
- reproducible ten-channel structure, multiscale self-supervision, area-bag weak-supervision, baseline, blocked-validation, ablation, and versioning code;
- an official USGS 2 m pilot that produces a geographically held-out self-supervised checkpoint without claiming catch skill;
- dataset/model cards with unrun results clearly marked.

Still required before an accuracy claim:

- assemble the complete BlueTopo/NOAA backbone plus high-resolution USGS bathymetry, backscatter, character, uncertainty, and survey-age mosaics;
- obtain and preserve reproducible CRFS/RecFIN exports;
- audit spatial joins and casting-zone intersections;
- fine-tune on legitimate catch labels and run real-data baselines, holdouts, confidence intervals, and ablations;
- publish measured results and promote one version through the documented gate.

## Product recommendation

Launch the planning interface free while gathering retention and explicit user feedback. Delay subscriptions until the score demonstrates repeat value. If validated, a free current-day plan plus a paid seven-day/alerts/comparison/offline tier is more aligned than display advertising.
