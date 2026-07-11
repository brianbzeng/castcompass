# ContourCast architecture

## Runtime topology

```mermaid
flowchart TB
    subgraph Client["Cloudflare-hosted PWA"]
      UI["Next.js / TypeScript UI"]
      MAP["MapLibre + ArcGIS World Ocean map"]
      SW["Service worker cache"]
      CACHE["Last verified snapshot"]
      UI --> MAP
      UI --> SW
      SW --> CACHE
    end

    subgraph Serving["Render"]
      API["FastAPI v1"]
      FILES["Versioned file snapshot fallback"]
      API --> FILES
    end

    subgraph Storage["Supabase"]
      PG["PostgreSQL + PostGIS"]
      SITE["sites / casting zones"]
      WIN["opportunity windows"]
      FRESH["source freshness"]
      RUNS["ingestion + model runs"]
      PG --> SITE
      PG --> WIN
      PG --> FRESH
      PG --> RUNS
    end

    subgraph Inputs["Public official inputs"]
      NOAA["NOAA bathymetry / tides / currents / buoy / CoastWatch"]
      NWS["NWS hourly forecasts"]
      MARINE["Open-Meteo Marine modeled SST"]
      FISH["CDFW CRFS + RecFIN"]
    end

    subgraph ML["Versioned geospatial ML workflow"]
      INGEST["Ingest + validate CRS/datum"]
      TERRAIN["Six terrain channels"]
      SPLIT["Buffered geographic folds"]
      BASE["Seasonal / linear / boosted baselines"]
      DEEP["ResNet encoder + SSL + two heads"]
      GATE["Promotion gate"]
      INGEST --> TERRAIN --> SPLIT
      SPLIT --> BASE --> GATE
      SPLIT --> DEEP --> GATE
    end

    UI -->|"HTTPS /v1"| API
    API -->|"primary when populated"| PG
    NOAA --> INGEST
    NWS --> INGEST
    MARINE --> INGEST
    FISH --> INGEST
    GATE -->|"versioned artifact + metrics"| API
```

## Score flow

1. `HabitatScore` comes from the promoted spatial model. In the current demo it is a labeled curated proxy, not a trained-model output.
2. `SeasonalityMultiplier` comes from monthly public catch and effort. The current demo uses a labeled provisional fixture pending a reproducible RecFIN export.
3. `DynamicModifier` uses fresh tide, wind, swell, current, and daylight inputs. It is bounded so conditions cannot erase the habitat signal. Modeled SST is currently displayed as unscored context while forecast-versus-station error is measured.
4. The combined values are ranked across the current candidate site/window set.
5. The user receives the percentile as `OpportunityScore`, plus components, confidence, explanation factors, model version, and source freshness.

## Freshness contract

Each external value records:

- source name;
- observation/check time;
- maximum age;
- `fresh`, `stale`, `missing`, or `excluded` status;
- whether it was used in the score;
- an exclusion reason when applicable.

Stale or missing values are not silently imputed as live observations. The API can return a partial result with the affected source removed, or a 503 when no verified snapshot exists.

## Resilience

- API reads prefer Postgres when configured and fall back to the packaged verified snapshot on database failure.
- The PWA uses the API when `NEXT_PUBLIC_API_URL` is set and the static snapshot otherwise.
- The service worker uses network-first caching for forecast JSON and navigation, retaining the last successful response for offline use.
- ArcGIS World Ocean base/reference tiles are external and may not be available offline; rankings and site details remain available. Basemap bathymetry is explanatory context, not navigation data and not the live habitat model.

## Security and privacy

- v1 is anonymous and read-only.
- Secrets live in Render/Supabase/hosting environment variables, not the repository.
- CORS is explicit.
- No private catch locations or user accounts exist in v1.
- Authentication, Stripe, alerts, and personal logs are deferred until product value and model quality are demonstrated.
