# CastingCompass product roadmap

This list is ordered by user harm and launch risk first, followed by measurement,
validation, expansion, business readiness, and visual polish. An item is complete only
after its acceptance checks pass in the intended environment.

## P0 — Immediate safety and launch integrity

- [x] Complete the cross-functional baseline audit and establish model-truthfulness rules.
- [ ] Prevent AI-generated trip summaries from publishing without explicit human approval.
  Done when the production endpoint defaults off, AI can write only a private draft,
  legacy rows are quarantined, human approval is auditable, copy is truthful, and live
  smoke tests pass.
  - [x] Implement and verify the patched isolated safety-floor commit plus the additive
    approval release.
  - [ ] Publish the safety commit first, record its deployment as the rollback floor, apply
    the migration, publish the approval release, audit all legacy rows, and run live smoke tests.
- [ ] Release production hardening from a clean worktree at the reviewed immutable commit:
  Worker and static-asset security
  headers, health/security endpoints, edge abuse controls, sanitized logs, staged migration
  tests, monitoring, alerts, backup verification, and a restore drill.
  - [x] Implement and locally verify request/body guards, non-cacheable API and security
    headers, a D1-backed health check and security.txt endpoints, provider-log redaction,
    secret scanning, immutable CI actions, dependency-update automation, and fail-closed
    release tooling.
  - [x] Implement and locally verify AES-256-GCM sealing for full-D1 operational exports,
    fixed 89-day retention, private checksum manifests, a role-labeled hash-chained audit log,
    isolated restore, current deletion-ledger replay, validation-ledger integrity checks, and
    aggregate-only evidence. No production backup or restore drill has been performed.
  - [x] Implement and locally verify default-off Turnstile protection for all seven public
    account-abuse flows, including exact action/hostname binding, staged-toggle recovery,
    privacy-minimized provider requests, mobile/accessibility coverage, and provider-independent
    privacy-rights routes.
  - [ ] Deploy the reviewed release, configure and test edge rate limits, create the production
    Turnstile widget and activate it through a separate reviewed change, deliver test alerts,
    create an encrypted backup, complete a non-production restore drill, and attach the
    production evidence required by `docs/PRODUCTION-OPERATIONS.md`.
- [ ] Make account privacy promises durable: deletion queue/tombstones for photos and public
  copies, truthful completion semantics, and an age-only first step before email/password.
  - [x] Implement and locally verify single-use age proofs, consent-safe reacceptance,
    authenticated export, atomic active-data removal, durable object cleanup, aggregate
    receipts, retry/lease safety, restore suppression, and operator recovery guidance.
  - [ ] Apply and audit the production migration, verify the exact private R2 binding and
    zero-photo invariant, exercise deletion/export/retry fixtures, deploy the age-proof edge
    ceiling and alerts, complete the restore replay drill, and obtain provider/counsel review.

## P1 — Evidence, data contracts, discoverability, and scalable foundations

- [ ] Freeze the species-aware observation and model-run contract before new ingestion or
  recruitment: canonical/versioned taxa or explicit complexes; one primary target per
  evaluable effort segment; structured per-taxon encounters, retained/released counts, and
  identification confidence; distinct target-no-encounter versus no-fish outcomes; and a
  loader that rejects mixed/unexpected taxa and records the target in every artifact.
  - [x] Implement and locally verify the closed catalog, cross-runtime schemas/validators,
    complete-attempt loader, trip persistence, target-stamped run/artifact identity, and
    compact static/API opportunity identity.
  - [ ] Apply and audit the production migration, confirm all historical rows are
    `legacy_unverified` and model-excluded, deploy the versioned snapshot/API, and preserve
    the frozen contract in the first approved ingestion manifest.
- [ ] Freeze the validation protocol before collecting more outcomes: complete targeted
  trips including skunks, effort and mode, immutable source-separated splits, geographic and
  temporal holdouts, preregistered baselines, outcome-independent incentives, preserved
  model version and `scoreInfluencedChoice`, and independent or safely randomized trip
  selection where possible. Curated site IDs support site × time-window claims only; precise
  casting-zone research requires separate consent, minimization, access, retention/deletion,
  and sensitive-location controls.
  - [x] Freeze and locally verify the strict human/machine preregistration, exact 46-site
    geography, absolute time blocks, fixed-interval census, frozen recruitment provenance,
    baseline/metric/sample/promotion gates, private-manifest contract, adversarial semantic
    tests, and narrow ordinal claim boundary. The audit concluded that v1 must not activate
    because its bespoke external transparency-log and independent-publication services do not exist.
  - [x] Freeze and locally verify the v2 successor schemas and operational-pilot contract:
    externally timestamped read-only preregistration, immutable release/Worker identity,
    complete starts and outcomes including skunks, source labeling, privacy-minimized fields,
    append-only corrections, encrypted snapshots/restores, fixed feasibility gates, no
    candidate-performance analysis, and permanent exclusion of pilot rows from confirmation.
  - [x] Locally implement and verify the default-off v2 start/completion/safe-cancellation
    ledger, activation- and account-bound HMAC participant grouping, private account export,
    exact retained/deleted-start reconciliation, append-only/identity guards, and transactional
    runtime fixtures. This records no email, raw account ID, coordinates, notes, photos, IP, or
    user agent in the pilot ledger and computes no candidate-performance result.
  - [x] Locally implement and verify append-only correction handling plus outcome-independent
    direct/community recruitment-source capture. Direct/community invitations must match an
    immutable campaign sealed by D1 server time before activation; an HMAC invitation alone is
    not treated as proof of issue time. First-source-wins, account export/deletion, correction
    chaining, source-separated reconciliation, and adversarial mutation/timing cases are covered.
  - [ ] Approve and implement the separate 730-day validation-only snapshot and deletion-
    suppression policy. The verified 89-day full-D1 operational restore path cannot satisfy
    this gate without contradicting the current 90-day deletion-tombstone boundary. Then
    configure production storage/operator evidence; complete legal/privacy/data-steward review;
    externally preregister the exact artifact; and seal/deploy a valid activation manifest
    before the first pilot-eligible row.
  - [ ] If the pilot passes, freeze and preregister a separate confirmatory protocol with a fixed
    candidate and baselines, source-separated development and locked test data, geographic/time
    holdouts, clustered uncertainty, minimum support, and promotion/drift/rollback gates. Never
    backdate activation or treat pilot/product rows as confirmatory evidence.
- [ ] Acquire reproducible official CDFW/CRFS/RecFIN data—starting with CDFW ds3186
  all-species/all-effort and ds3185 rockfish/cabezon blocks—and start a prospective first-party
  cohort. Every snapshot needs its query/export manifest, retrieval date, checksum, license,
  attribution, dictionary, source version, sampling design, denominator, and spatial/time
  support. Keep samples separate from expanded estimates, never invent point labels from
  blocks, and declare training/validation/context permissions per source.
- [ ] Treat Fishbrain as an optional written-license partnership and Facebook groups as
  admin-approved prospective recruitment—not scraped retrospective evidence. Licensed social
  data without complete attempts, no-catch, effort, coverage, and sampling propensity is for
  discovery, weak supervision, or external trend corroboration only; the independent benchmark
  remains a source-separated prospective cohort.
- [ ] Validate the California halibut relative ranking against frozen baselines before broader
  claims; publish uncertainty, limitations, negative results, and the current all-zero sample
  constraint. Attempt probability calibration only after a trained occurrence model has a
  sufficiently representative held-out set of positive and negative outcomes.
- [ ] Define model promotion, drift, and rollback gates: beat preregistered geographic/time
  holdout baselines before promotion; monitor by site, season, mode, and taxon; version every
  release; and require rollback/revalidation when performance or data support drifts.
- [ ] Establish truthful technical SEO and measurement without promoting unvalidated accuracy:
  Google Search Console and Bing Webmaster Tools verification, sitemap submission, crawl/index
  coverage, canonical URLs, metadata, social previews, appropriate structured data, Core Web
  Vitals, mobile/accessibility checks, and privacy-conscious conversion analytics.
  - [x] Implement and locally verify the four-page crawl set, self-canonicals, route-specific
    social metadata, `/profile` noindex, robots/sitemap files, narrow `WebSite` JSON-LD, and
    a dashboard/runbook that keeps heuristic ranking claims truthful.
  - [x] Remove the 1MB header/offline icon fetch and third-party font requests from the staged
    Vinext build while preserving the existing branded social card and install icons.
  - [ ] Deploy the reviewed crawl foundation after P0 and verify every canonical/redirect host.
  - [ ] Verify the Google domain property through DNS, import or verify Bing, submit the sitemap,
    inspect the four public URLs, confirm `/profile` noindex, and record initial coverage.
  - [ ] Establish real-user Core Web Vitals and privacy-reviewed funnel baselines without
    collecting precise location, trip content, account identifiers, or free text.
- [ ] Make infrastructure mobile-ready and scalable with versioned APIs/shared schemas,
  appropriate mobile authentication, queue-based AI work, staging, bounded retries/costs,
  and WebKit/offline/safe-area coverage.

## P2 — Species and business expansion

- [ ] Add striped bass as the first new beta using a distinct estuary/migration model.
- [ ] Define and evaluate explicit shore-relevant rockfish species/complexes next; then model
  cabezon as its own taxon; then split surfperch into defensible habitat/taxon groups. Each beta
  needs its own source inventory, model card, validation gate, and current regulation treatment.
- [ ] Complete business/legal readiness before substantial promotion or revenue: entity/DBA,
  tax and local-license review, trademark clearance, startup counsel/CPA review, DMCA/UGC
  posture, and broker quotes for cyber/privacy, technology E&O, general, and media liability.

## P3 — Experience and brand

- [ ] Improve accessibility and interaction quality after core risks are controlled, including
  keyboard/screen-reader review, zoom/reflow, contrast, reduced motion, and a non-map path.
- [ ] Refresh visual design, graphics, species art, empty states, social cards, and brand
  illustration. Artist collaboration is intentionally deferred and can focus on expressive
  assets while product interaction remains usability-led.
