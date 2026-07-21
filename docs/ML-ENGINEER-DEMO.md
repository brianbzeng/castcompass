# ML-engineer demo checkpoint

**Status:** verified local candidate; not a production-release receipt

This demo combines the reviewed Santa Barbara South Coast planning expansion with
the fail-closed San Francisco and Santa Barbara water-contact advisory slices. It
is suitable for a local technical walkthrough. It is not authorization to merge,
deploy, activate a provider, collect validation evidence, or claim model
performance.

## Start the local candidate

Use the reviewed Node `22.23.1` and npm `10.9.8` toolchain. From the candidate
checkout:

```bash
npm ci --ignore-scripts
npm run build:cloudflare
npm run start -- --host 127.0.0.1 --port 4173
```

Open <http://127.0.0.1:4173>. Docker, Cloudflare access, production credentials,
remote databases, and provider mutations are not needed for this walkthrough.
Keep the demo on localhost. Do not use account, deployment, or production-admin
flows as part of the presentation.

## Ten-minute walkthrough

1. Select **Goleta** or **Santa Barbara** and switch between list and map views.
   Explain that the catalog now spans 14 conservative public-access locations
   from Gaviota through Rincon, with protected or ambiguous water omitted.
2. Open a location report. Show the relative Opportunity Score, its transparent
   habitat/seasonality/conditions/fishability components, access caveats, casting
   zone, and structure guidance. The score ranks the currently evaluated windows;
   it is not a catch probability.
3. Open **Forecast check** and show source identity and freshness. Missing or stale
   inputs remain missing or stale instead of receiving invented replacements.
4. Open `/?site=gaviota-state-park-beach` to demonstrate the stable site-link and
   the time-stamped State Board posting in the checked-in review snapshot. The
   official action hides the site from recommendations but does not rewrite its
   fishing score. Then open `/?site=leadbetter-beach`: its ended action does not
   become a clean-water claim, so the site remains unknown.
5. Open `/?site=crissy-field-east-beach` to contrast SFPUC's complete, fresh
   sample-supported neutral state. Explain that neutral means only no active
   posting was reported under that source's frozen rules; it never improves the
   score or claims that contact or seafood is safe. Unmapped, stale, unavailable,
   unmonitored, and action-absent states remain explicitly unknown.
6. Show the trip-log language only as a product workflow. Friend and community
   reports remain private ordinary observations; none automatically trains,
   validates, or changes the model.

## Accurate technical framing

- The shipped ranking is an explainable heuristic configuration over curated
  habitat priors, provisional seasonality, public forecast conditions,
  fishability, and a small access-pressure modifier.
- The repository contains a research pipeline with geographically blocked
  evaluation, baselines, ablations, a six-channel encoder, and synthetic smoke
  coverage. No trained deep model contributes to the public ranking today.
- The original 47-site Bay Area validation population remains frozen. Adding
  Santa Barbara product coverage cannot rewrite earlier validation semantics.
- Current public performance evidence is all-zero/inconclusive. Do not describe
  the product as validated, accurate, calibrated, predictive, or safer than an
  alternative.

## Base integration receipt

Implementation commit `ec2d5bc26429eca1a7e45bbef62bfc5c0775d198` passed the Cloudflare build, 472 Node tests, 144 mobile
Chromium/WebKit cases, ESLint, TypeScript, the complete security and source-
integrity chain, zero-vulnerability full and production npm audits, 29 API tests,
83 pipeline tests (one documented optional-`rasterio` skip), Ruff, the synthetic
pipeline smoke, and all 19 critical D1 query-plan checks. Documentation-only
review head `378079d1613e3ef8c73505d44c1a496bff56f7ca` then passed both independent
hosted 144-case web/mobile jobs, API, pipeline, dependency review, all three
CodeQL languages, release provenance, both native API-image architectures, and
both optional research-stack platforms. PR `#131` remains draft-only.

The separate Santa Barbara BeachWatch follow-up has also completed its local
implementation receipt: the Cloudflare build and 475 Node tests, 144 mobile
Chromium/WebKit cases, ESLint, TypeScript, the full security/SBOM/source-integrity
chain, both zero-vulnerability npm audits, 29 API tests, 83 pipeline tests (one
documented optional-`rasterio` skip), Ruff, the synthetic pipeline smoke, and all
19 D1 query-plan checks passed. This local receipt does not replace the pending
exact-head hosted receipt and does not authorize a merge or deployment.

## Deliberately unfinished

- Local-anglers' access review for all 14 regional sites, including two reviews
  for each limited-access site.
- Independent local review of the Santa Barbara station/countywide mappings and
  source latency; official water-quality coverage for the rest of the launch
  catalog; any numeric pollution or fishing-quality contribution.
- Location-by-location official/licensed structure and depth inventories.
- Prospective regional model validation, independent product/safety review,
  provider evidence, guarded deployment, and post-deployment verification.

If asked whether it is ready for production, the accurate answer is: **the local
demo candidate is verified, but production release remains intentionally closed.**
