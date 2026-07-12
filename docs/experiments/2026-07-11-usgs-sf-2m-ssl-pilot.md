# USGS Offshore San Francisco 2 m SSL pilot

**Run date:** 2026-07-11 PDT  
**Experiment:** `exp-9a201c482478`  
**Model artifact:** `model-cc8415076199`  
**Code revision:** `59ace39dcf6794d98f2ead95aa7fa9cb40fc8839`

## Purpose

Verify that ContourCast can train a multiscale deep encoder on real public
bathymetry while preserving source provenance, physical resolution, geographic
separation, and an explicit boundary between representation learning and catch
accuracy.

This is not a habitat-validation or catch-prediction result.

## Source

- Product: [USGS California State Waters Map Series — Offshore of San Francisco](https://pubs.usgs.gov/ds/781/OffshoreSanFrancisco/data_catalog_OffshoreSanFrancisco.html)
- Source archive SHA-256: `79c93fac3ae3d35213b808b3913115744676c03aead72a686651817e86d5be53`
- Native grid: 2 m, EPSG:26910, NAVD88
- Published survey period: 2004–2008
- Pilot bounds: `534724, 4178786, 538820, 4182882`
- Pilot footprint: 4.096 km × 4.096 km
- Conservative minimum resolvable feature width: approximately 6 m

## Feature and patch contract

Ten channels were derived: depth, slope, roughness, curvature, local TPI,
broad TPI, local relief, rugosity ratio, and two aspect components.

The corpus contains 512 underwater locations. Each location has three physical
views:

| Diameter | Native cells across | Intended context |
| --- | ---: | --- |
| 64 m | 32 | immediate structure |
| 256 m | 128 | surrounding habitat |
| 1,024 m | 512 | broad geomorphology |

The corpus SHA-256 is
`00aaf445989ff6ed7676e3e880644a6f4d4fa12feb86b77ea3e91ba3514eba02`.

## Training design

- Shared-weight ResNet encoder with learned scale attention
- SimCLR projection dimension: 64
- Spatially blocked split: 383 training / 129 validation patches
- Robust median/IQR normalization fit only on training geography
- Nearby locations within 512 m excluded from the negative-pair set
- Orientation-preserving augmentation; no default flips or rotations
- Three CPU epochs, batch size 32, AdamW learning rate `3e-4`

## Optimization result

| Epoch | Training NT-Xent | Validation NT-Xent |
| ---: | ---: | ---: |
| 1 | 2.9825 | **2.6161** |
| 2 | 2.0739 | 2.9288 |
| 3 | 1.6451 | 2.6748 |

The best checkpoint is epoch 1. Its SHA-256 is
`fc329577aaebafa4e51155d028f938bb5df72b84d43a1f4e0f5a3135e5737828`.
An independent repeat on the same CPU, code revision, input corpus, and seed
produced identical metrics and the identical checkpoint hash.
The widening train/validation gap after epoch 1 is an early overfitting warning,
not evidence of habitat skill. The checkpoint exists to validate the training
and provenance path; it is not promoted into the live Opportunity Score.

## Next experiment

1. Stream the full USGS/BlueTopo coverage instead of training on one crop.
2. Add co-registered backscatter, seafloor character, uncertainty, and survey
   age with explicit coverage masks.
3. Measure frozen-embedding utility on independently released habitat classes
   before using any fishing labels.
4. Fine-tune on coarse catch blocks using area bags, then separately evaluate
   on consented precise trip reports.
5. Compare random initialization, bathymetry-only pretraining, and
   bathymetry-plus-backscatter pretraining under identical geographic folds.
