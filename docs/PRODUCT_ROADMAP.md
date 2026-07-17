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
  - [x] Audit the live D1 ledger/schema without reading user rows and locally verify the
    integrated release path: exact `0007` drift reconciliation, one-file migration staging,
    a default-off API/scheduled-work maintenance bridge, aggregate pre/postflight checks,
    immutable checkout binding, and rollback boundaries. Production remains unchanged.
  - [ ] Publish the safety commit first, record its deployment as the rollback floor, apply
    the approved integrated migration sequence, publish the approval release, audit all legacy
    rows, and run live smoke tests using `docs/INTEGRATED-RELEASE.md`.
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
    aggregate-only evidence.
  - [x] Create an initial encrypted pre-release production D1 artifact with fixed 89-day
    retention, owner-only file modes, a verified audit-chain head, separately stored key
    material, and confirmed plaintext destruction. This is real backup evidence, but it is not
    an accepted restore drill or an approved key-custody policy.
  - [x] Implement and locally verify default-off Turnstile protection for all seven public
    account-abuse flows, including exact action/hostname binding, staged-toggle recovery,
    privacy-minimized provider requests, mobile/accessibility coverage, and provider-independent
    privacy-rights routes.
  - [x] Implement and locally verify the schema-release maintenance bridge, exact staged D1
    wrapper, primary-ledger pre/post checks, live maintenance verifier, and post-`0011`
    fix-forward boundary required to release the accumulated migrations safely.
  - [ ] Deploy the reviewed release, configure and test edge rate limits, create the production
    Turnstile widget and activate it through a separate reviewed change, deliver test alerts,
    approve key custody, complete a non-production restore/deletion-replay drill, and attach
    the remaining production evidence required by `docs/PRODUCTION-OPERATIONS.md`.
- [ ] Make account privacy promises durable: deletion queue/tombstones for photos and public
  copies, truthful completion semantics, and an age-only first step before email/password.
  - [x] Implement and locally verify single-use age proofs, consent-safe reacceptance,
    authenticated export, atomic active-data removal, durable object cleanup, aggregate
    receipts, retry/lease safety, restore suppression, and operator recovery guidance.
  - [ ] Apply and audit the production migration, verify the exact private R2 binding and
    zero-photo invariant, exercise deletion/export/retry fixtures, deploy the age-proof edge
    ceiling and alerts, complete the restore replay drill, and obtain provider/counsel review.
- [ ] Complete a defense-in-depth security and authorization review before growth, validation
  activation, or broader AI use. Treat every browser, API, uploaded file, model input, model
  output, webhook, and provider response as untrusted; a checklist or nominal layer count is
  not completion without attack-specific tests and production evidence.
  - [ ] Map the owner's security-layer reference images into the threat model when the original
    attachments are available, reconcile them with the existing controls, and record each
    control's owner, evidence, alert, recovery path, and residual risk.
  - [ ] Keep session credentials out of `localStorage`: verify `HttpOnly`, `Secure`, appropriately
    scoped `SameSite` cookies, rotation, expiry, revocation, fixation resistance, CSRF defenses,
    and enumeration-safe login/recovery behavior. Client-side session or admin checks may guide
    the interface but must never grant access.
    - [x] Locally implement and verify HTTPS `__Host-` session cookies, hashed 256-bit opaque
      tokens, migration of the prior cookie, atomic rotation after authentication, stale-cookie
      clearing, fixed expiry, logout/password-reset/account-deletion revocation, same-origin
      mutation checks, equal-work invalid login, and generic deferred recovery behavior across
      request, resend, and invalid-code paths. Live cookie, email-delivery, expiry, and revocation
      evidence remains required after the guarded production deployment.
  - [ ] Define and approve a deny-by-default access-control matrix for anonymous users, account
    owners, moderators, support, operators, and administrators. Enforce it server-side on every
    route and object lookup, with privilege-escalation, insecure direct-object reference, and
    cross-account tests. Because D1/SQLite has no native PostgreSQL-style row-level security,
    require an equivalent per-record ownership/role predicate in the data-access layer and test
    that omitted or mismatched identity fails closed.
    - [x] Document the current matrix and locally verify that a second authenticated account
      cannot read an owner's photo/export data or delete the owner's trip/gear. Approval of
      future moderator, support, and operator roles remains open.
  - [ ] Verify strict schema/size/type validation, contextual output encoding, safe database
    binding, upload signature and metadata checks, and AI prompt-injection boundaries. Model
    instructions and user content remain data, never authority; models receive no ambient
    secrets or unrestricted tools, outputs must match narrow schemas, and no model output can
    publish or mutate privileged state without a separately authorized server action.
    - [x] Locally enforce and attack-test endpoint field allowlists, duplicate multipart-field
      rejection, existing body/type/length bounds, parameter-bound D1 writes, default-off
      image uploads with signature verification and metadata-stripping WebP re-encoding, React
      output encoding, and the escaped JSON-LD script context. The advisory AI boundary now
      minimizes stored input, separates untrusted data from system instructions, has no tools
      or ambient authority, applies a hard deadline and 64 KiB response cap, requires an exact
      bounded output schema without type coercion or prose wrapping, redacts failure logs, and
      still cannot create a public post. Production edge evidence and authorized staging
      penetration testing remain open.
  - [ ] Verify endpoint-specific rate limits and abuse ceilings for login, recovery, signup,
    uploads, exports, deletion, reports, and AI routes. Adopt length-based password rules that
    allow password managers/passphrases, block breached/common passwords using a privacy-safe
    lookup, reject account-derived patterns, and avoid arbitrary composition rules that reduce
    usability without improving security.
    - [x] Locally implement and verify new-password length rules, account/service-derived
      pattern rejection, padded five-character HIBP range lookup, fail-closed provider handling,
      privacy disclosure/versioning, and compatibility for existing ten-character passwords.
    - [x] Locally implement and attack-test default-off Worker ceilings for public auth and
      email flows, authenticated writes, reads, exports/deletion/manual AI retry, and aggregate
      AI-provider dispatch. Request counters receive only a secret-keyed IP pseudonym; they run
      before body parsing, return generic non-cacheable responses, and fail closed when enabled
      configuration is missing or unavailable. Existing D1 login/email/trip ceilings remain the
      durable exact controls. Production secret provisioning, activation, outer WAF rules,
      threshold tuning, monitoring, and live endpoint evidence remain open.
  - [ ] Verify encryption in transit and at rest, key separation/rotation/recovery, least
    privilege, secret scanning, dependency/runtime/action version locks, reproducible builds,
    an SBOM, vulnerability-response ownership, and restore-tested backups. Pinning must include
    a scheduled reviewed update path so security fixes are not frozen out.
    - [x] Locally pin direct npm packages, Node/Python CI runtimes, runner labels, and immutable
      action commits; remediate the known npm advisory tree to zero; add high/production-
      moderate audit gates, pull-request dependency review, a deterministic CycloneDX
      production SBOM bound to the package-lock hash, and an owner/deadline/update runbook.
      Optional Geo/PyTorch platform locks, cross-platform npm install-script allowlisting,
      combined/signed SBOM and build attestations, repository required-check settings,
      production evidence, key custody, and restore drills remain open.
    - [x] Lock the exercised FastAPI and pipeline CI Python graphs to exact transitive versions
      and committed SHA-256 distribution hashes, bind lock metadata to its source inputs, keep
      test-only packages out of the API image, enforce pip
      all-or-nothing hash checking and binary-only installs in CI/API containers, pin the API
      Python base image by patch and multi-platform digest, and schedule Docker updates. The
      optional Geo/PyTorch stack and signed deployment provenance remain open.
    - [x] Locally inventory all seven Worker runtime secrets, extend named-secret scanning and
      ignored local Wrangler secret files, define environment/purpose/backup-key separation,
      document D1 managed-encryption and application-controlled AES-256-GCM boundaries, and
      record feature-specific rotation and recovery hazards. Production IAM/MFA evidence,
      actual binding/key IDs, approved custody, rotation exercises, and restore drills remain
      open, so the parent gate is not complete.
  - [ ] Exercise the attack surface in an isolated staging environment with authorized load,
    stress, and penetration tests; remediate critical/high findings and retest before production
    promotion. Never aim stress or intrusive security testing at production user data.
- [ ] Complete the privacy lifecycle and deletion policy before broader account recruitment.
  Maintain a data inventory and cascade map covering primary rows, public copies, objects,
  queues, logs, analytics, exports, derived artifacts, and backups; make deletion retries and
  restore suppression observable and auditable without retaining raw deleted content.
  - [x] Document and locally machine-check the complete D1/object/provider/browser/backup
    inventory, foreign-key and trigger cascade map, atomic active-data deletion order,
    non-recoverable current behavior, and a privacy-minimized EU/UK/California-aware request
    workflow. Production-shaped drills, processor execution, dashboard case controls, and
    privacy/counsel approval remain open.
  - [ ] Decide with privacy/counsel review whether an ordinary account closure may offer a
    clearly disclosed 30-day recovery window. If adopted, revoke access immediately, isolate
    recovery data from active/public use, automatically hard-delete it at day 30, and let a
    verified erasure request bypass recovery. Do not silently weaken the existing immediate
    active-data removal and durable public/object cleanup promises.
  - [ ] Publish and drill GDPR/UK GDPR/CCPA-style access, correction, portability, deletion,
    objection, and appeal workflows; verify identity proportionately, meet applicable response
    clocks, inventory processors and transfers, minimize logs, and document lawful retention
    exceptions rather than claiming universal compliance without review.
- [ ] Provide a safe maintenance experience on every production hostname: a branded,
  accessible maintenance page for browsers; non-cacheable `503` API responses with bounded
  `Retry-After`; operator-only health diagnostics; no write paths that bypass maintenance; and
  tested activation, recovery, and stale-service-worker behavior.
  - [x] Locally implement the self-contained browser `503`, preserve crawler-control files,
    fail closed for current and future mutation routes, mark responses for the PWA, rotate the
    offline cache, and extend the immutable-version live verifier across browser/API behavior.
  - [ ] Activate and recover the exact reviewed release on every production hostname, verify
    the public minimized health check and private diagnostics, and record stale-client evidence.

## P1 — Evidence, data contracts, discoverability, and scalable foundations

- [ ] Establish privacy-preserving production observability and an operator console before
  scaling traffic. Evaluate Cloudflare-native logs/analytics and focused vendors such as
  PostHog by data fit, searchability, alerting, cost, retention, residency, deletion support,
  access controls, and lock-in; analytics is not a substitute for error logging or an audit
  ledger.
  - [ ] Emit structured, schema-versioned events with UTC timestamp, severity, release, route,
    request/trace ID, outcome, latency, and a rotating pseudonymous account reference only when
    necessary. Never log passwords, tokens, cookies, precise location, trip notes, photo data,
    raw prompt content, or other high-risk fields. Development debug logs must be gated and
    production logs redacted, sampled, access-controlled, retained briefly, and deletion-aware.
  - [ ] Centralize searchable errors and aggregate operational summaries; correlate browser,
    Worker, queue, D1, R2, AI-provider, deployment, and scheduled-job failures; add actionable
    alerts, runbook links, acknowledgement/escalation, and synthetic checks. Prove alert delivery
    and incident reconstruction using non-sensitive fixtures.
  - [ ] Build a least-privilege, MFA-protected operator dashboard for health, deployments,
    request/error trends, queues, backup/restore evidence, privacy jobs, security events, and
    immutable change history. Keep future financial reporting as a separately authorized data
    domain with accounting-grade source records and reconciliation, not values inferred from
    application logs.
  - [x] Locally centralize Worker logging behind a schema-enforcing module, add server-generated
    request IDs and secret-keyed session pseudonyms, normalize dynamic/unknown routes, replace
    ad hoc console output, correlate scheduled work, disable raw URL invocation logs, and publish
    the Cloudflare dashboard/query/incident recipe plus the PostHog privacy decision. Production
    dashboard creation, IAM/retention/cost evidence, external uptime checks, and delivered alert
    drills remain open.
- [ ] Make the data and execution paths measurably scalable before a traffic campaign.
  - [ ] Inventory every production query, capture representative `EXPLAIN QUERY PLAN` evidence,
    add only workload-justified indexes, bound scans/pagination, eliminate N+1 patterns, verify
    cross-account predicates, and regression-test query latency and migration cost.
  - [ ] Publish a cache matrix by asset/data class with owner, privacy classification, cache key,
    TTL, invalidation trigger, stale policy, and failure behavior. Never share-cache personalized
    or authenticated responses; test purge, version skew, offline/service-worker upgrades, and
    correctness during snapshot rollover.
  - [ ] Queue only slow or retryable side effects such as AI generation, media processing,
    notifications, cleanup, and aggregation. Keep authorization and consistency-critical writes
    synchronous; require idempotency keys, deduplication, bounded retry/backoff, dead-letter
    handling, cost ceilings, progress state, cancellation where safe, and operator replay tools.
  - [ ] Use Cloudflare's managed D1 binding lifecycle instead of inventing a traditional SQL
    connection pool. If a future database/provider supports pooling, size and monitor it against
    concurrency limits and failure modes before adoption.
  - [ ] Define performance budgets and run isolated load, soak, spike, and failure-injection
    tests with production-shaped synthetic data. Record saturation points, tail latency, error
    rates, queue depth, database contention, cache effectiveness, cost, and a safe rollback plan.
  - [x] Locally add workload-backed D1 indexes, machine-check 13 critical `EXPLAIN QUERY PLAN`
    paths plus every foreign-key child index, remove the public-site N+1 behind a bounded cache,
    publish the cache/async/connection contracts, add a bounded Postgres process pool only for
    the optional API, and provide a read-only load harness that permanently refuses production.
    Migration application, `PRAGMA optimize`, production-shaped staging measurements, queue
    provider implementation, failure injection, and authorized penetration testing remain open.

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
  - [x] Locally implement and verify the separate 730-day validation-only technical candidate:
    privacy-minimized encrypted projections, immutable opaque suppression capture on deletion,
    cumulative suppression/aggregate-removal artifacts, strict retention-class separation,
    frozen-hash verification, deletion replay, and aggregate-only evidence. The drill computes
    no candidate performance and deliberately records governance approval and the overall
    activation storage gate as false.
  - [ ] Approve the 730-day validation-only snapshot and deletion-suppression policy; configure
    production key custody, least-privilege storage, daily schedules/alerts, retention deletion,
    and operator evidence; complete a witnessed production-shaped restore/deletion-replay drill;
    complete legal/privacy/data-steward review; externally preregister the exact artifact; and
    seal/deploy a valid activation manifest before the first pilot-eligible row. The 89-day
    full-D1 operational restore remains a separate artifact class and cannot satisfy this gate.
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
- [ ] Preserve authorship and business records: maintain dated design/decision notes, source and
  asset provenance, license/assignment records, contributor agreements, release hashes, and
  archived public artifacts. Have counsel distinguish automatic copyright protection,
  registration strategy, trademark/brand protection, patent/trade-secret questions, and third-
  party or AI-assisted material. Surface the evidence in the operator console without exposing
  private keys, personal data, or privileged legal material.

## P3 — Experience and brand

- [ ] Improve accessibility and interaction quality after core risks are controlled, including
  keyboard/screen-reader review, zoom/reflow, contrast, reduced motion, and a non-map path.
- [x] Add a branded, accessible `404` page with a clear return-to-home action, useful navigation,
  correct `404` status, noindex behavior, and service-worker-safe non-caching.
- [ ] Add honest loading and recovery states after the underlying operations are bounded:
  route-appropriate skeletons, immediate acknowledgement, progressive status for slow work,
  inline retry/cancel where safe, and carefully scoped optimistic updates that roll back on
  failure. Do not display fake precision or let optimistic UI imply a privileged write succeeded.
  - [x] Add and locally verify an accessible route-level indeterminate loading shell plus a
    render-error boundary with generic copy, explicit retry/home actions, reduced-motion
    behavior, no raw diagnostics, and no claim that an in-flight account write completed.
  - [x] Keep profile request failures distinct from verified empty accounts: preserve the last
    successful copy, validate response shape, show unknown counts and accessible skeletons
    before first load, and provide a generic inline retry without exposing diagnostics.
  - [x] Give trip writes truthful connection and slow-request states: pause new submissions when
    the browser reports offline, keep drafts, show indeterminate progress without invented
    percentages, and never automatically replay an ambiguous write after reconnection.
  - [x] Fail account deletion safely in the client: block offline submission, keep slow requests
    visibly unconfirmed, and treat a dropped response as potentially committed so the user is
    directed to the durable deletion receipt instead of retrying a destructive write.
  - [ ] Add operation-specific progress, timeout, retry, cancellation, and reconnection states
    only where the underlying API can report them truthfully; retain authoritative confirmation
    for account, trip, privacy, and other privileged writes.
- [ ] Improve trip-photo upload states with accessible visual emphasis (including the requested
  glow plus a copy/state change, not color alone), thumbnail, file type, size, validation result,
  and per-file progress/retry/cancel. Multiple files receive independent state and progress;
  indeterminate progress is used when byte progress is unavailable, and completed uploads remain
  distinguishable from files that are merely selected or locally previewed.
- [ ] Refresh visual design, graphics, species art, empty states, social cards, and brand
  illustration. Artist collaboration is intentionally deferred and can focus on expressive
  assets while product interaction remains usability-led.
