# CastingCompass goal status

Last reconciled: **2026-07-18 UTC**

This is the owner-facing dashboard for the complete goal list. The detailed acceptance
criteria and immutable receipts remain in [PRODUCT_ROADMAP.md](PRODUCT_ROADMAP.md); provider
steps remain in [PRODUCTION-OPERATIONS.md](PRODUCTION-OPERATIONS.md). A checked item here means
its complete acceptance boundary passed. “Local complete” means the repository control passed
but the parent stays open until its production, provider, legal, or independent-review gate is
also satisfied.

## Current seven-step work cycle — API image exception deadline

- [x] Reconcile the required handoff, exact `main`, open PRs/issues, Dependabot alerts, and
      post-merge workflows. Evidence: `main` is `e58a7f50359fc3e41f37e5ad168b9ecf089b50b8`,
      PRs and Dependabot alerts are empty, issue `#86` is the sole open issue, and CI,
      release-provenance, and CodeQL all passed that exact commit.
- [x] Re-check official Python and CPython sources. Python 3.13.14 remains the latest stable
      3.13 release; the three security fixes have upstream/backport PRs but no containing stable
      3.13 release; PEP 719 schedules Python 3.13.15 for 2026-08-04.
- [x] Re-check the Docker Official Image source and public registry. The selected tag still maps
      to source revision `f79aea5b8f6b2d65b31ba2bb3f69c0c2083345c8`, index digest
      `sha256:399babc8b49529dabfd9c922f2b5eea81d611e4512e3ed250d75bd2e7683f4b0`,
      AMD64 manifest `sha256:c25cd44f45df1279a2cba589e67dfcd9db04647ea483b117a7de8b1a99bdfb23`,
      and ARM64 manifest `sha256:0515d7a37d0febc8bd7d88b4879b8598f4e1a1aae16307c733fd34f36be18f15`.
- [x] Implement the bounded fallback without weakening mitigations: named security owner,
      mandatory 2026-08-04 re-review, 2026-08-08 hard expiry, primary-source binding, at most
      seven days of post-release grace, immediate stable-series-fix rejection, and preserved
      `tarfile`/`html.parser` removal plus import guards. Focused contract tests pass 16/16.
- [x] Pass the complete local repository, API, pipeline, security, SBOM, build, and mobile gates.
      Evidence: 325/325 repository tests, 29/29 API tests plus all 13 critical query plans,
      69/69 pipeline tests with one documented optional raster skip, 102/102 mobile-browser
      tests, lint, typecheck, secrets, exact Python locks, zero-execution npm policy, both SBOM
      checks, and both npm audits with zero vulnerabilities.
- [x] Publish the protected draft PR and accept fresh native AMD64/ARM64 image evidence plus all
      required checks on the exact head. PR `#90` head
      `f20c210bb8014baee62c9bf09010a3d5a99c5d97` passed CI `29652969717`, image-security
      `29652969712`, release-provenance `29652969706`, and CodeQL `29652968953`. AMD64 artifact
      `8432023776` (`sha256:a972eeb814fcdb28a56ca20b676645b0ba5c58d50a9fd3f19a9b34075cf77320`)
      and ARM64 artifact `8432025040`
      (`sha256:cfdd3f5a3d8ccea37ce051a1ded26474c96010434814da4e02759161423621de`)
      retain the raw and normalized evidence.
- [x] Merge only after every required check passes, then reconcile the exact `main` commit,
      post-merge workflows, artifacts, and alert state. PR `#90` merged as
      `f1a6579ca97fa509b0b1ac1367c6fa7e4c644104`; main CI `29653146497`, image-security
      `29653146520`, release-provenance `29653146479`, and CodeQL `29653146307` passed. AMD64
      artifact `8432074834`
      (`sha256:a82c248231ddf83164aad84563b3c5703951f6c39c409b2b71885daa7757b060`)
      and ARM64 artifact `8432075433`
      (`sha256:c9eaa3426e90188c0db8015a06018c0fffd20d072b71b4f77a7590ca0b0b2591`)
      preserve matching source-bound reports through 2026-08-17. Open Dependabot,
      code-scanning, and secret-scanning alerts are all zero; issue `#86` stays open for the
      mandatory 2026-08-04 re-review. Cloudflare and production remain paused.

## Completed prior seven-step cycle — official fisheries data

- [x] Reconcile PR `#87`, its exact post-merge checks, and the zero-open-alert repository state.
- [x] Inventory the existing CDFW, CRFS, and RecFIN contracts without ingesting private or
      social data.
- [x] Verify the current ds3185/ds3186 official service identities, revisions, dictionaries,
      sampling boundaries, license labels, and export drift.
- [x] Acquire and twice reproduce canonical owner-only snapshots with byte-binding receipts and
      a fail-closed acquisition command.
- [x] Verify support and allowed-use boundaries. Local evidence: 69/69 pipeline tests passed
      (one documented optional raster test skipped), 324/324 repository tests passed, Ruff,
      lint, typecheck, offline dependency audits, secrets, locks, and both SBOM checks passed.
- [x] Publish PR `#88` and obtain hosted network-audit and 102/102 mobile-browser evidence.
      API, dependency review, both pinned Python stacks, CodeQL for Actions/JavaScript/Python,
      pipeline, web, and release-provenance checks all passed on the exact PR commit.
- [x] Merge only after every required hosted check passes and reconcile the exact main commit.
      PR `#88` merged as `5b221f59c39f69d939f144f99a3ea81226e8908d`; post-merge CI
      `29645959440`, release provenance `29645959456`, optional Python `29645959451`, and CodeQL
      `29645959414` all passed. Dependabot remained at zero open alerts. Cloudflare and
      production remain paused.

## Completed earlier seven-step cycle

- [x] Triage PRs `#17`–`#32`; close unsafe, broken, duplicated, or superseded updates.
- [x] Upgrade and lock maintained runtimes and direct dependency families.
- [x] Produce and independently verify deterministic signed release provenance.
- [x] Produce the combined npm/Python/API-image/Worker/D1/assets release inventory and SBOM.
- [x] Accept the native AMD64/ARM64 API-image package, license, and vulnerability gate.
- [x] Run the clean-commit synthetic non-production restore/deletion-replay drill and preserve
      only private aggregate evidence. Production data, provider access, key custody, real-backup
      recovery, and second-person approval remain explicitly false.
- [x] Create this status dashboard, re-run the safe offline observability/performance/SEO and
      mobile checks, and preserve UI/brand work as the final priority. Verification: 319/319
      repository tests, 17/17 focused observability/scale/SEO tests, and 102/102 mobile tests.

## P0 — Immediate safety and launch integrity

- [x] Establish the cross-functional baseline audit and truthful model-claim rules.
- [ ] Prevent AI-generated trip summaries from publishing without explicit human approval.
      **Local complete;** guarded production migration/deployment, legacy-row audit, and live
      smoke evidence remain.
- [ ] Release production hardening: headers, health/security endpoints, abuse controls,
      sanitized logs, migrations, alerts, backup verification, and restore readiness.
      **Local implementation and synthetic restore drill complete;** Cloudflare deployment,
      rate-limit/WAF/Turnstile activation, alert delivery, key custody, and independent review
      remain.
- [ ] Make account privacy promises durable across active rows, public copies, objects,
      deletion queues, exports, receipts, retries, and restored data. **Local complete;**
      production migration/provider/counsel evidence remains.
- [ ] Complete defense-in-depth security and authorization review: session cookies, access
      matrix and ownership predicates, schema/input/output/upload/prompt boundaries, endpoint
      abuse ceilings, password safety, encryption/custody, version locks, SBOMs, provenance,
      vulnerability response, restore testing, and authorized staging penetration testing.
      **Most repository controls complete; the 13-layer owner reference mapping and zero-execution
      npm install-script boundary are locally complete;** production/provider/staging gates remain,
      including isolated DAST, active edge filtering, live detection/alerting, key custody, and
      independent review.
- [ ] Complete the privacy lifecycle: data inventory, cascade map, deletion semantics,
      retention decision, rights workflows, processor handling, and counsel approval. **Local
      inventory/cascade/deletion checks complete;** the optional 30-day recovery decision and
      external legal/provider drills remain.
- [ ] Provide and drill safe maintenance mode on every production hostname. **Local complete;**
      production activation, stale-client recovery, and captured evidence remain.

## P1 — Evidence, data contracts, discoverability, and scale

- [ ] Establish privacy-preserving production observability and an operator console, including
      structured logs, request IDs, redaction, searchable failures, alerts, backup/privacy-job
      views, immutable changes, and a separately authorized future financial domain. **Local
      logging schema/runbook complete;** provider dashboard, access, retention, cost, uptime,
      and delivered-alert evidence remain. PostHog remains deferred pending privacy review.
- [ ] Make data and execution paths measurably scalable: query plans/indexes, bounded access,
      cache matrix, justified asynchronous work, D1-managed connections, optional API pooling,
      and isolated load/soak/spike/failure tests. **Local query/index/cache/connection contracts
      and production-refusing harness complete;** migrations, staging measurements, queues,
      failure injection, and authorized penetration testing remain.
- [ ] Freeze and deploy the species-aware observation/model-run contract. **Local contract
      complete;** production migration, legacy-row audit, and first approved ingestion manifest
      remain.
- [ ] Freeze and govern the validation protocol. **v1 correctly inactive; v2 and the 730-day
      technical candidate are locally complete;** policy/key/schedule/legal review, external
      preregistration, witnessed restore, and activation remain.
- [ ] Acquire reproducible official CDFW/CRFS/RecFIN data with manifests, checksums, licenses,
      dictionaries, sampling support, and allowed-use declarations; begin a prospective cohort.
      **Exact aggregate ds3186/ds3185 snapshots and receipts complete;** both are context-only,
      while a complete-effort RecFIN export and the prospective cohort remain open.
- [ ] Treat Fishbrain only as an optional written-license partnership and Facebook groups only
      as admin-approved prospective recruitment—never scraped retrospective evidence.
- [ ] Validate California halibut relative ranking against frozen baselines and publish
      uncertainty, limitations, negative results, and the current all-zero sample constraint.
- [ ] Define model promotion, drift, rollback, monitoring, and revalidation gates.
- [ ] Establish truthful technical SEO and measurement. **Local crawl set, canonicals,
      metadata, social previews, JSON-LD, robots, sitemap, noindex, asset/font cleanup, and
      runbook complete;** deployment, Google/Bing verification/submission, coverage, Core Web
      Vitals, and privacy-reviewed funnel baselines remain.
- [ ] Make infrastructure mobile-ready with shared schemas, appropriate authentication,
      queue-based work, staging, bounded retries/costs, and WebKit/offline/safe-area coverage.

## P2 — Species and business expansion

- [ ] Add striped bass as the first distinct estuary/migration beta.
- [ ] Add defensible rockfish complexes, cabezon, and surfperch groups, each with its own source
      inventory, model card, validation gate, and regulation treatment.
- [ ] Complete business/legal readiness before promotion or revenue: entity/DBA, tax/local
      license, trademark, counsel/CPA, DMCA/UGC, and insurance review.
- [ ] Preserve authorship and business evidence: dated decisions, source/asset provenance,
      licenses/assignments, contributor agreements, release hashes, archived public artifacts,
      and counsel-guided copyright/trademark/patent/trade-secret decisions.

## P3 — Experience and brand (intentionally last)

- [ ] Complete accessibility and interaction review: keyboard/screen reader, zoom/reflow,
      contrast, reduced motion, and a non-map path.
- [x] Add the branded accessible, noindex, non-cacheable `404` page and home action.
- [ ] Finish truthful operation-specific loading/progress/retry/cancel/reconnection states.
      **Route, profile, trip, deletion, edit, gear, sign-out, and saved-location safety states are
      locally complete;** only APIs that can report real progress may receive detailed progress.
- [ ] Add per-file photo upload states: visible glow plus copy shift, thumbnail, type, size,
      validation, independent progress/retry/cancel, and honest indeterminate state. Photos stay
      disabled until storage/privacy/security gates pass.
- [ ] Refresh visual design, graphics, species art, empty states, social cards, and brand
      illustration. Artist collaboration remains deferred until higher-risk work is complete.

## Product-owner work that is safe while Cloudflare stays paused

- [ ] Audit MFA/passkeys and recovery methods for GitHub, Cloudflare, the domain registrar,
      primary email, Google Search Console, and Bing Webmaster Tools. Store recovery codes
      offline; never paste them into Codex, GitHub, or a dashboard note.
- [ ] Choose the independent technical reviewer for restore/key-custody evidence. They should
      review aggregate receipts and the runbook, never receive production data or secret bytes.
- [ ] Choose an alert destination and escalation owner: monitored email/phone, acknowledgement
      expectation, backup contact, and quiet-hours policy.
- [ ] Make a private business-record folder for formation/tax/license questions, counsel/CPA
      notes, trademark research, insurance quotes, contracts, invoices, and renewal dates.
      Treat these as questions for qualified professionals, not completed legal conclusions.
- [ ] Start an authorship/provenance register: asset or feature, creator, creation date, source,
      license/assignment, AI assistance if any, release/commit, and storage location.
- [ ] Before using your artist friend’s work, agree in writing on scope, credit, payment,
      ownership/license, modification rights, source-file delivery, and whether portfolio use is
      allowed. Actual visual commissioning can wait until P3.
- [ ] Prepare an SEO language sheet: audience questions, honest page purpose, candidate search
      phrases, prohibited accuracy claims, and desired snippets for the four public pages. Do
      not change DNS or submit URLs until the reviewed crawl foundation is deployed.
- [ ] Record current Google/Bing dashboard ownership and verification status with screenshots
      that contain no secrets. Leave sitemap submission and live URL inspection for deployment.
- [x] Build the official-data source register for CDFW/CRFS/RecFIN: dataset name, official URL,
      owner, retrieval method, license/terms, dictionary, update cadence, and intended use. Do
      not ingest private/social data. The register and exact ds3185/ds3186 receipts are in
      `docs/OFFICIAL-FISHERIES-DATA.md` and `pipeline/sources/receipts/`; neither aggregate is
      approved for training, validation, scoring, or point labels.
- [ ] Draft five short user-interview scripts focused on whether people understand the
      heuristic ranking, freshness labels, limitations, and trip-report privacy. Avoid collecting
      precise locations, credentials, or private trip notes while the service is paused.
- [ ] Track operating costs and receipts by provider in a simple accounting ledger. Keep this
      separate from application logs and analytics; a financial dashboard comes later.

## Do not do yet

- Do not resume Cloudflare, reconnect Git deployments, change production DNS, deploy,
      migrate D1, provision production secrets, enable Turnstile, or submit the sitemap until the
      guarded release checklist reaches those steps.
- Do not enable photos, public discussions, AI auto-publication, the validation pilot, or
      PostHog/session replay.
- Do not run load, stress, vulnerability scanning, or penetration testing against
      `castingcompass.com` or any production data. Use only an explicitly authorized isolated
      staging target later.
- Do not paste passwords, tokens, cookies, key material, recovery codes, private exports,
      user data, or unredacted provider screenshots into Codex, GitHub, logs, or PRs.
