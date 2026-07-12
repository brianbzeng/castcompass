# ContourCast

ContourCast is an installable, mobile-first California halibut opportunity planner for public shore, beach, jetty, and pier access from Point Reyes through San Francisco Bay to Half Moon Bay.

It compares reachable casting zones and two-hour windows using three separately visible components:

- **Habitat** — long-term seafloor structure and public recreational catch evidence.
- **Seasonality** — monthly California halibut catch and effort patterns.
- **Conditions** — a bounded modifier from tide, wind, swell, current, and daylight. Modeled water temperature is shown as context but is not scored until it is validated against local observations.

The final 0–100 **Opportunity Score is a relative percentile**, not a catch probability. A score of 80 means a site/window ranks above 80% of the candidates in the current evaluation set.

## Current demo status

The checked-in demo includes:

- 47 curated public access locations, with temporary closures retained in the catalog but excluded from ranking.
- 1,656 two-hour windows over a 72-hour horizon when one catalog location is closed.
- Live public NOAA CO-OPS tide predictions, NWS hourly forecasts, NDBC observations, and Open-Meteo Marine modeled SST at snapshot generation time.
- Visible freshness states and exclusion of missing/stale inputs.
- A MapLibre map using ArcGIS World Ocean base and reference layers, clustered map-native site points, a ranked access list, preset/custom distance-radius filtering, score explanations, official CDFW links, responsive detail sheets, geolocation sorting, PWA installation, and offline access to the latest loaded forecast.
- A first-party validation beta with start/end trip logging, complete catch and no-catch outcomes, anonymous effort tracking, pending-review submissions, aggregate ledger totals, and optional metadata-stripped verification photos.
- FastAPI endpoints, PostgreSQL/PostGIS schema, Docker/Render configuration, and file-snapshot fallback.
- A reproducible geospatial/ML pipeline with terrain derivation, blocked validation, baselines, ablations, a six-channel ResNet-style encoder, SimCLR-style pretraining, and two-task fine-tuning scaffolding.

The live snapshot's habitat score and monthly seasonality are explicitly labeled **demo/provisional proxies**. No trained deep model contributes to the live score and no real-world performance claim is shipped yet. The repository contains the six-channel ResNet/SimCLR research pipeline and two prediction heads; that model can replace the habitat proxy only after official-data training and geographically blocked validation. See the [model card](docs/MODEL_CARD.md), [dataset card](docs/DATASET_CARD.md), [feasibility report](docs/FEASIBILITY_REPORT.md), and [community-integration policy](docs/COMMUNITY_INTEGRATIONS.md).

## Architecture

```mermaid
flowchart LR
    U["Mobile / desktop PWA"] -->|"live JSON"| A["FastAPI on Render"]
    U -->|"offline fallback"| S["Versioned 72-hour snapshot"]
    U --> M["MapLibre + ArcGIS World Ocean"]
    U -->|"trip reports"| D1["Cloudflare D1"]
    U -->|"processed photos"| R2["Cloudflare R2"]
    A --> P["Supabase PostgreSQL / PostGIS"]
    A --> S
    R["NOAA CO-OPS · NWS · NDBC · Open-Meteo Marine"] --> J["Snapshot refresh"]
    J --> S
    B["NOAA bathymetry · CRFS · RecFIN"] --> G["Geospatial / ML pipeline"]
    G --> V["Versioned model artifacts"]
    V --> A
```

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Local development

Requirements:

- Node.js 22.13+
- Python 3.12+
- Docker, only if you want the local PostGIS stack

### PWA

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

The PWA uses `public/data/opportunities.json` when `NEXT_PUBLIC_API_URL` is unset. To use a running API, copy `.env.example` to `.env.local` and keep:

```bash
NEXT_PUBLIC_API_URL=http://localhost:8000
```

Trip-report APIs are served by the PWA Worker itself. Local and hosted builds use the logical `DB` D1 binding for structured reports and `TRIP_PHOTOS` R2 binding for processed WebP verification images. The checked-in migration is applied through the Sites deployment workflow.

### Refresh the 72-hour public-data snapshot

```bash
npm run data:refresh
```

The generator never substitutes invented ocean/weather values. Missing sources remain null and are marked excluded. Open-Meteo's public endpoint is non-commercial and requires attribution; switch to a commercial plan or another licensed provider before enabling subscriptions or ads.

### FastAPI

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r services/api/requirements.txt
uvicorn services.api.app.main:app --reload --port 8000
```

Swagger is available at `http://localhost:8000/docs`.

Endpoints:

- `GET /health`
- `GET /v1/sites`
- `GET /v1/sites/{id}`
- `GET /v1/opportunities?species=california-halibut&from=&hours=72`

Run the API and local PostGIS together:

```bash
docker compose up --build
```

### Geospatial/ML smoke workflow

```bash
python3 -m venv .pipeline-venv
source .pipeline-venv/bin/activate
pip install -r pipeline/requirements-smoke.txt
python3 -m unittest discover -s pipeline/tests -v
python3 -m pipeline.contourcast.cli smoke --output-dir /tmp/contourcast-smoke --seed 42
```

The smoke dataset is synthetic and only checks pipeline plumbing. It is never presented as fishing evidence. Full GeoTIFF/PyTorch execution uses the optional dependencies in `pipeline/requirements-geo-deep.txt`.

## Verification

```bash
npm test
npm run lint
python3 -m pytest services/api/tests -q
python3 -m unittest discover -s pipeline/tests -v
```

## Deployment

- **PWA:** Cloudflare or Sites-compatible vinext deployment.
- **API:** Render using `render.yaml`.
- **Database:** Supabase PostgreSQL with PostGIS; apply `infra/schema.sql`.
- **Static resilience:** the PWA retains the most recently loaded forecast and can fall back to the versioned snapshot.

Set the production PWA's `NEXT_PUBLIC_API_URL` to the Render service URL and the API's `ALLOWED_ORIGINS` to the final PWA origin. Never commit `DATABASE_URL` or service tokens.

## Safety and interpretation

- ContourCast is a planning aid, not a guarantee of catch.
- Bathymetry is explanatory context, not navigational data.
- Regulation links are informational; always check official CDFW rules and posted access closures.
- Current CDFW guidance lists a 22-inch total-length minimum for retained California halibut; the app repeats this as a reminder while linking back to the live regulation page.
- Only public access locations are ranked. Exact user catch locations are not collected in this version.
- Trip reports remain pending review and do not alter the Opportunity Score automatically. Public ledger values are aggregate submission totals, not verified catch claims.

## Official source entry points

- [NOAA San Francisco Bay bathymetry](https://www.ncei.noaa.gov/access/metadata/landing-page/bin/iso?id=gov.noaa.ngdc.mgg.dem%3Asan_francisco_bay_P090_2018)
- [CDFW CRFS spatial catch and effort](https://test.lab.data.ca.gov/dataset?name=california-recreational-fisheries-survey-catch-per-unit-angler-for-all-species-and-all-effort-r)
- [RecFIN](https://reports.psmfc.org/recfin/)
- [NOAA CO-OPS API](https://api.tidesandcurrents.noaa.gov/api/dev)
- [NWS API](https://www.weather.gov/documentation/services-web-api)
- [NOAA CoastWatch ERDDAP](https://coastwatch.noaa.gov/erddap/index.html)
- [Open-Meteo Marine API](https://open-meteo.com/en/docs/marine-weather-api)
- [ArcGIS World Ocean basemap](https://developers.arcgis.com/rest/basemap-styles/arcgis-oceans-base-webmap-get/)
- [CDFW San Francisco Bay regulations](https://wildlife.ca.gov/Fishing/Ocean/Regulations/Fishing-Map/sf-bay)
- [CDFW San Francisco coast regulations](https://wildlife.ca.gov/Fishing/Ocean/Regulations/Fishing-Map/San-Francisco)

## License

Application source is provided for portfolio and development use. Upstream datasets remain governed by their source agencies' terms, metadata, attribution, and redistribution requirements.
