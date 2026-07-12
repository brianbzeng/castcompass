# ContourCast dataset card

**Status:** data contract, multiscale structure pipeline, and one reproducible
official-data self-supervised pilot implemented. Official rasters and weights
are not bundled. No supervised catch-training dataset has been approved.

**Version:** 0.2.0

## Intended dataset

ContourCast is designed to join a bathymetric terrain grid with recreational
fishing observations for Bay and coastal California research. The intended
learning unit is a point-resolution fishing event with effort, a target species,
an occurrence label, and catch per unit effort (CPUE). Aggregated survey
estimates remain separate and must not be treated as exact-point labels.

This dataset is for exploratory habitat and product research. It is not a
nautical chart, navigation aid, regulatory source, biological stock assessment,
or guarantee that fish will be present.

## Official sources and stewardship

The machine-readable manifests are in `pipeline/sources/`.

| Source | Steward | Intended use | Official access |
| --- | --- | --- | --- |
| CUDEM / Coastal Relief bathymetry | NOAA National Centers for Environmental Information | Elevation/bathymetry raster and published metadata | [NOAA Coastal Elevation Models](https://www.ncei.noaa.gov/products/coastal-elevation-models), [NOAA Bathymetry](https://www.ncei.noaa.gov/products/bathymetry) |
| BlueTopo | NOAA Office of Coast Survey | Coverage backbone with elevation, uncertainty, and data-quality layers | [NOAA BlueTopo](https://www.nauticalcharts.noaa.gov/data/bluetopo.html) |
| Offshore San Francisco State Waters | U.S. Geological Survey | 2 m bathymetry/backscatter, seafloor character, habitat, geology, and video ground truth | [USGS DS 781 data catalog](https://pubs.usgs.gov/ds/781/OffshoreSanFrancisco/data_catalog_OffshoreSanFrancisco.html) |
| Central San Francisco Bay multibeam | U.S. Geological Survey | 4 m bathymetry/backscatter and bedform structure | [USGS DS 55](https://pubs.usgs.gov/dds/dds-55/pacmaps/sf_data.htm) |
| California Recreational Fisheries Survey (CRFS) | California Department of Fish and Wildlife | California marine recreational catch/effort samples or estimates | [CDFW CRFS](https://wildlife.ca.gov/Conservation/Marine/CRFS/Additional-Information) |
| RecFIN Data Warehouse | Pacific States Marine Fisheries Commission | Official distribution/query system for Pacific Coast recreational-fisheries data, including CRFS | [RecFIN](https://www.recfin.org/) |

CRFS and RecFIN are not NOAA bathymetry products. Their actual stewards are
preserved because survey ownership, design documentation, and citation matter.
CDFW states that CRFS data and estimates from 2004 onward are available through
RecFIN. Raw query exports, query filters, access dates, and checksums must be
retained.

## Data contracts

### Bathymetry

The canonical NPZ contains:

- `values`: one 2-D, positive-upward elevation raster in metres;
- `metadata.crs`: a projected CRS with metre axes;
- `metadata.transform`: six-coefficient, north-up GDAL affine transform;
- `metadata.vertical_datum`: the datum published with the selected product;
- `metadata.source_id`, nodata value, units, and schema version.

Geographic degrees, rotated grids, unknown vertical datums, empty rasters, and
non-metre horizontal units are rejected. `pyproj`, when installed, performs an
independent CRS semantics check. Without it, the provenance record explicitly
marks CRS semantics as unverified.

Elevation products from different vertical datums must not be stacked or
compared until a documented vertical transformation is performed. Resolution
is not treated as positional or vertical accuracy. NOAA elevation products are
explicitly **not for navigation**.

### Fishing observations

Canonical fields are:

| Field | Meaning |
| --- | --- |
| `event_id` | Stable source event/sample identifier |
| `observed_at` | Observation time when released |
| `species` | Target taxon/name from the source export |
| `catch_count` | Nonnegative observed or documented count field |
| `effort_hours` | Positive effort denominator |
| `sample_weight` | Positive released sample-count/reliability weight; defaults to 1 when unavailable |
| `occurrence` | `1` when canonical catch count is positive, otherwise `0` |
| `cpue` | `catch_count / effort_hours` |
| `x`, `y`, `crs` | Legitimately released projected point coordinates and CRS |
| `area_id` | Source geography when only an aggregate area is released |
| `spatial_resolution` | `point`, `area`, or source-specific resolution |
| `source_id` | Manifest identifier |
| `terrain_model_eligible` | True only for point/GPS/exact rows with both coordinates |

The importer never converts an area centroid, port, district, or survey stratum
into a purported catch location. An area-only record may support aggregate
descriptive analysis. A future weakly supervised experiment may represent the
entire released area as a bag of terrain patches and supervise only the bag;
attention on individual patches is not ground-truthed hotspot evidence.

Sample data and expanded survey estimates have different meanings. Expansion
weights, strata, modes, uncertainty fields, and source documentation must be
retained in the raw layer. The current canonical point pipeline is not a
survey-weighted estimator; expanded estimates should not be mixed with raw
events until that estimator is explicitly implemented and validated.

## Derived terrain and structure channels

All six channels are aligned to the bathymetry raster in this fixed order:

1. `depth_m`: positive-down depth, `max(-elevation, 0)`;
2. `slope_deg`: gradient magnitude converted to degrees;
3. `roughness_m`: local depth standard deviation;
4. `curvature`: horizontal Laplacian of elevation;
5. `tpi_local_m`: depth minus local-window mean;
6. `tpi_broad_m`: depth minus broad-window mean.

Defaults use radii of two and six cells. Pixel size, radii, sign convention,
channel names, source datum, and robust summary statistics are saved with each
artifact. Nodata pixels stay invalid after derivation; finite fill is used only
internally to avoid derivative explosions at holes.

The deep-learning structure stack adds:

7. `local_relief_m`: local maximum minus minimum depth;
8. `rugosity_ratio`: local surface-area proxy, equal to one on a flat cell;
9. `aspect_sin`: north/south grid-axis component of the elevation gradient;
10. `aspect_cos`: east/west grid-axis component of the elevation gradient.

Orientation is preserved by default during augmentation because alignment with
shore, current, surf, and other linear structures may be predictive. Optional
backscatter, substrate/seafloor character, survey uncertainty, survey age,
kelp-canopy, or surf-break layers must align exactly to the reference grid.
Every auxiliary value layer receives a paired availability mask before missing
values are filled.

## Physical resolution contract

ContourCast separates pixel spacing from reliable feature detection:

- fewer than two native cells across: `unresolved`;
- two to fewer than three cells: `marginal`;
- three or more cells, subject to published positional accuracy: `resolvable`.

At 2 m/pixel, the conservative structure threshold is therefore about 6 m. A
narrow pipe may not be directly resolved. A wider raised corridor, scour,
bedform disruption, acoustic-backscatter response, kelp footprint, or habitat
edge can still be represented when it spans enough native cells. Upsampling a
coarse raster never improves this classification.

Each location is represented at multiple physical scales. The initial pilot
uses 64 m, 256 m, and 1,024 m diameter views, corresponding to immediate
structure, surrounding habitat, and broad geomorphic context.

## Spatial alignment and leakage controls

- Raster channels must match CRS, shape, affine transform, and units exactly.
- Observations must use the same projected CRS and lie within raster bounds.
- Terrain patches are extracted only after these checks.
- Evaluation creates spatially contiguous K-means regions and holds out each
  complete region once.
- An optional metre buffer removes training observations close to held-out
  points. Preprocessing and model fitting occur inside each fold.
- Random row splits are not accepted as evidence of spatial generalization.

The K-means regions are an evaluation scaffold, not a claim that they correspond
to ecological management areas. Before a reported experiment, region count and
buffer distance should be chosen from sampling density and the intended product
use, then fixed before inspecting test results.

## Known biases and limitations

- CRFS/RecFIN measure fishing activity and observed catches, not complete fish
  presence/absence. Angler choices, access, regulations, gear, skill, season,
  weather, and survey coverage shape the labels.
- A zero catch is not a confirmed biological absence.
- Popular or accessible areas and commonly retained species can be
  overrepresented.
- Bathymetry surveys have heterogeneous age, density, and uncertainty.
- Public survey geography may be much coarser than a DEM pixel.
- CPUE values can be heavy-tailed and are not automatically comparable across
  modes or survey designs.
- Sensitive user-contributed fishing locations require access controls,
  coordinate minimization, and an explicit retention/deletion policy before
  collection. No private user data is included here.

## Reproducibility and versioning

Every real-data run must preserve:

- immutable raw files and SHA-256 hashes;
- exact source product/query, filters, access date, citation, and manifest ID;
- CRS and vertical-datum transformation history;
- terrain configuration and fixed channel order;
- observation eligibility counts and rejected-row reasons;
- geographic split seed/count/buffer;
- Git revision, Python runtime, input hashes, experiment version, and model
  version from `run_metadata.json`.

Run the synthetic plumbing check with:

```bash
python3 -m pipeline.contourcast.cli smoke --output-dir /tmp/contourcast-smoke
```

Synthetic fixture metrics are labeled `synthetic_fixture` and are not real-data
results.

## Current results

An official USGS 2 m bathymetry crop has passed the ingestion, resolution audit,
ten-channel derivation, three-scale corpus, and self-supervised checkpoint
workflow. This is unlabeled representation learning only. No class balance,
catch metric, habitat conclusion, or Opportunity Score accuracy improvement is
claimed.
