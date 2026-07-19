# Production operations gate

This runbook separates repository controls from Cloudflare/account controls. Repository
tests cannot prove that a dashboard rule, alert, backup, or deployed version exists. Do not
mark production hardening complete until the evidence checklist at the end is filled from
the production environment.

## Abuse controls

The Worker enforces request-body limits, per-email authentication ceilings, failed-login
ceilings, and per-reporter trip ceilings. Those durable D1 controls remain the authoritative
ceilings for the identities they cover. The repository also declares six Cloudflare Workers
Rate Limiting bindings, but enforcement remains deliberately off through
`RATE_LIMITING_ENABLED=false` until the production secret, bindings, outer rules, monitoring,
and synthetic checks below are ready.

| Binding | Reviewed local ceiling | Covered work |
| --- | --- | --- |
| `AUTH_RATE_LIMITER` | 20 per 60 seconds per pseudonymous network address | Signup eligibility/request/verification, resend, password request/reset, and login |
| `EMAIL_RATE_LIMITER` | 5 per 60 seconds per pseudonymous network address | Signup request/verification, resend, and password request in addition to the auth ceiling |
| `WRITE_RATE_LIMITER` | 30 per 60 seconds per pseudonymous network address | API mutations outside the explicit auth-flow set, including trip/report/profile/gear/photo paths |
| `SENSITIVE_RATE_LIMITER` | 6 per 60 seconds per pseudonymous network address | Account/trip deletion, data/photo export, and manual AI retry in addition to read/write ceilings |
| `READ_RATE_LIMITER` | 120 per 60 seconds per pseudonymous network address | API `GET`/`HEAD` requests except the health check |
| `AI_PROVIDER_RATE_LIMITER` | 20 per 60 seconds on one application-wide key | Scheduled or request-triggered AI-provider dispatch |

When enabled, the request limiter HMACs the trusted `CF-Connecting-IP` value with the
separately stored `RATE_LIMIT_KEY_SECRET`. Only the 64-character pseudonym reaches the
binding; the Worker does not persist or log the raw address. Missing/malformed configuration,
missing edge identity, or binding errors return a generic non-cacheable `503`; a reached
ceiling returns a generic non-cacheable `429`. Both carry a bounded `Retry-After`. The health
route remains available for diagnosis, and the AI ceiling denies work before a trip is
claimed or provider content is assembled.

Cloudflare documents the Workers binding as local to a Cloudflare location and eventually
consistent, so it is an abuse brake rather than precise accounting or a global business
quota. It also is not a replacement for a WAF rule because the request has already reached
the Worker. Keep the exact D1 ceilings, provider quotas, cost budgets, and outer controls.
See Cloudflare's [Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
and [WAF rate-limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/)
documentation.

Activate these bindings only as a separate reviewed production operation:

1. Deploy the reviewed Worker and bindings with `RATE_LIMITING_ENABLED=false`; confirm the
   health route, normal API traffic, and existing D1 ceilings still behave normally.
2. Generate a dedicated high-entropy secret of at least 32 characters and store it only as
   the Cloudflare Worker secret `RATE_LIMIT_KEY_SECRET`. Record its custodian and rotation
   procedure, never its value. Do not reuse a session, validation, deletion, or backup key.
3. Confirm the exact six binding names, unique namespace IDs, and reviewed limits on the
   deployed version. Exercise 429, invalid-config 503, header redaction, normal signup/login,
   export/deletion, report, retry, and scheduled AI fixtures in an isolated environment.
4. Configure outer Cloudflare WAF rate-limiting rules for coarse attack rejection. Begin in
   observation/log-only mode where the account plan supports it; otherwise use conservative
   thresholds and a synthetic hostname before routing normal beta traffic.
5. In a separately reviewed immutable config change, set exactly
   `RATE_LIMITING_ENABLED=true`. Any other non-empty value is intentionally treated as an
   invalid enabled configuration. Monitor 429/503 classes, legitimate multi-user NAT traffic,
   D1 growth, Worker CPU, and provider usage before promotion.
6. If thresholds harm legitimate use, return the switch to `false` through the guarded
   release path while retaining the durable D1 ceilings. If the controls are under attack,
   use maintenance mode or tighten the outer rule rather than exposing identifiers in logs.

Configure Cloudflare rate-limiting rules ahead of the Worker, beginning in log-only mode when
the plan supports it. Review legitimate beta traffic before selecting final thresholds.
At minimum, cover:

- age-proof and email-producing mutations: `/api/auth/signup/eligibility`,
  `/api/auth/signup/request`,
  `/api/auth/challenge/resend`, and `/api/auth/password/request`;
- credential and code checks: `/api/auth/login`, `/api/auth/signup/verify`, and
  `/api/auth/password/reset`;
- trip mutations under `/api/trips/`; and
- a broad emergency ceiling for all non-GET `/api/` traffic.

Use Turnstile on email-producing and credential-entry forms before public promotion. Verify
tokens server-side, bind them to the expected hostname and action, reject missing/expired or
wrong-action tokens, and keep a kill switch. Test the browser, installed PWA, accessibility,
and future mobile clients before enforcing it. Never implement a global D1 limiter keyed by
raw IP/user-agent values; that turns abusive traffic into high-cardinality database writes.
The age-proof endpoint also needs a tested edge ceiling before launch: otherwise eligible
requests can create unbounded short-lived D1 rows without sending email. Exercise the rule
against normal multi-step signup and measure both blocked requests and proof-table growth.

## Authentication and session smoke tests

Run these checks only with a dedicated synthetic account and keep every token, email address,
and verification code out of screenshots, logs, and release records:

- confirm successful HTTPS authentication sets only an opaque `__Host-cc_session` value with
  `Path=/`, `Secure`, `HttpOnly`, `SameSite=Lax`, and no `Domain` attribute;
- confirm a pre-migration `cc_session` cookie is replaced on session refresh and its server row
  is no longer accepted, without recording either token;
- confirm logout rejects a wrong origin, then revokes the correct presented session and clears
  both current and migration cookie names;
- create two synthetic sessions, complete a password reset, and confirm both old sessions fail
  while exactly one newly issued session works;
- confirm an expired session and a session whose account was deleted both fail closed; and
- compare absent-account and wrong-password login/recovery probes only through aggregate timing
  and response-class evidence. Do not retain identifiers or raw latency traces tied to an email.

Repository tests prove the code paths and privacy boundaries, not the deployed cookie behavior,
Worker background-email lifecycle, provider delivery, D1 state, or edge rate limits. Keep this
gate open until those live synthetic checks pass on the exact deployed version.

## Key custody and encryption

Use [Key custody and encryption](KEY-CUSTODY-AND-ENCRYPTION.md) as the source of truth for the
seven runtime secret names, separation rules, managed D1 encryption boundary, local backup
encryption, semantic rotation hazards, incident path, and account-level acceptance evidence.
Never include a secret value in this runbook, a release record, monitoring, or the future
operator dashboard. A local scanner pass does not prove production custody, least-privilege
roles, MFA, correct environment bindings, revocation, recovery, or rotation.

Treat every runtime secret change as a deployment. Cloudflare documents that ordinary
`wrangler secret put` immediately deploys a new Worker version, so use a reviewed versioned
secret/release workflow and record the exact Worker version. Do not rotate validation HMACs
mid-activation, do not rotate a backup key before all retained artifacts remain recoverable,
and account for the temporary edge-counter reset caused by rate-limit pseudonym-key rotation.

## Release and emergency maintenance

`RELEASE_MAINTENANCE_MODE` is a deployment-bound kill switch, not a browser or local-storage
flag. When active, the Worker stops scheduled work, rejects every `/api/` request other than the
minimized health probe before body parsing or database access, and rejects any future non-API
mutation method fail closed. Document navigations receive self-contained static HTML with
`503`, numeric `Retry-After`, and browser/CDN `no-store`. The page contains no script, remote
resource, account state, or `noindex`; `/robots.txt` and `/sitemap.xml` remain available.

For a reviewed release bridge or a short urgent incident:

1. Disable Cloudflare Git-connected automatic deployments and pause scheduled snapshot
   publication. Record the current deployment/version and the immutable 40-character commit.
2. Use a clean detached checkout at that exact commit, run `npm ci --ignore-scripts`, export the
   exact `RELEASE_COMMIT` and action-specific private `RELEASE_AUTHORIZATION_FILE` described in
   [Production change authorization](PRODUCTION-CHANGE-AUTHORIZATION.md), and execute
   `npm run release:cloudflare:maintenance`. Do not edit the checked-in default or use an ad hoc
   dashboard variable that cannot be tied to reviewed source.
3. Confirm one maintenance version has `100%` traffic. Run `npm run verify:release-maintenance`
   with the canonical and direct Worker hosts plus the exact version ID. Separately prove all
   aliases redirect to the canonical host.
4. Confirm the live verifier saw the marked HTML `503`, available `robots.txt`, blocked read and
   write APIs, active health flag, no cacheability, and the exact version. Inspect redacted logs
   for bypasses without querying user rows.
5. Fix forward from a newly reviewed immutable commit when code changes are required. Recover
   by deploying that same approved commit with maintenance off, then prove normal health,
   canonical pages, API authorization, scheduled work, and service-worker cache replacement.

Whole-site `503` is appropriate only for a short outage. If an incident will last longer than a
few days, obtain a product/search decision instead of leaving an indefinite maintenance release.
Never use `403`, `404`, a robots-wide disallow, Search Console removal, or `noindex` as an outage
switch. Production activation and recovery evidence remain external gates; local tests do not
prove the switch is live.

## Monitoring and alerting

Cloudflare Worker observability is enabled in `wrangler.jsonc`; raw invocation URL logs are
disabled and the application emits the privacy-bounded schema in `docs/OBSERVABILITY.md`. That
repository setting alone is not a deployed dashboard or alerting system. Create the documented
saved views, configure, and exercise:

- Worker exceptions, 5xx rate, CPU time, and request-volume anomaly alerts;
- D1 error/latency and storage growth review;
- an external GET/HEAD check of `https://castingcompass.com/api/health` that expects `200`,
  JSON `status: "ok"`, and `Cache-Control: no-store`;
- a canonical-page check and exact redirect checks for all aliases; and
- notification delivery to an account the operator checks, with a documented escalation
  path and discussion kill-switch procedure.

Do not put emails, request bodies, raw notes, session cookies, verification codes, precise
locations, or provider response bodies in logs or alert payloads. Run a synthetic failure and
confirm both delivery and redaction before launch.

## Backup and restore drill

D1 Time Travel is the first migration/incident recovery point, not an independent backup.
Its bookmark and retention window belong in each release record. Separately export D1 on a
documented schedule and retain copies according to the privacy policy.

`wrangler d1 export` writes **plaintext SQL containing user data**. Never describe that file
as encrypted. Export only into an access-restricted directory on an encrypted volume, keep it
out of the repository and cloud-sync folders, encrypt it immediately with an approved key,
then remove the plaintext copy according to the storage platform's secure-deletion limits.
Record the encrypted artifact's checksum, creation time, schema/migration state, retention
date, and key custodian without recording user data.

Example export shape (replace the private path deliberately):

```sh
umask 077
./node_modules/.bin/wrangler d1 export contourcast-trips --remote --config wrangler.jsonc \
  --output /PRIVATE/ENCRYPTED-VOLUME/castingcompass-UTC.sql
```

Run the export only from a verified release checkout after `npm ci --ignore-scripts`; do not let a package
runner download an unreviewed Wrangler version for a production-data operation.

A restore drill must use an isolated local database or a disposable non-production D1
database. Never overwrite production for a drill. Validate schema objects, migration state,
`PRAGMA integrity_check`, `PRAGMA foreign_key_check`, representative aggregate row counts,
authentication/session revocation behavior, and application reads. Record only aggregate
evidence, then destroy the drill copy. R2/photo backup is out of scope while uploads remain
disabled; add a separate private-object restore drill before enabling photos.

The repository's local sealing and deletion-replay tool is documented in
`docs/VALIDATION-STORAGE.md`. It fixes full-D1 operational retention at 89 days, verifies
AES-256-GCM artifacts and a private audit chain, restores only in a private temporary child,
replays the preserved current deletion ledger, and writes aggregate-only evidence. Passing its
tests is not evidence that a production artifact, key-custody policy, or reviewed drill exists.
Its 89-day operational copy also does not satisfy the v2 pilot's separate 730-day validation-
snapshot requirement.

### Privacy deletion ledger and restore suppression

The `privacy_deletion_jobs` and `privacy_deletion_tasks` tables are operational privacy
controls, not ordinary application history. A point-in-time restore can resurrect account
rows while also rolling these controls back. Never restore D1 and immediately return it to
service.

Before any production restore:

1. Stop application writes, scheduled AI review, and deletion workers.
2. Preserve an encrypted, access-restricted copy of the current deletion-job/task ledger.
   Record only its checksum and aggregate counts in the incident record.
3. Restore into an isolated database first. Reapply every current account/trip tombstone,
   preserve every unresolved object task, and remove any linked public discussion rows.
4. Prove that no restored user or trip matches a current tombstone, unresolved R2 cleanup
   remains queued, foreign-key and integrity checks pass, and aggregate deletion counts agree.
5. Obtain a second-person review of the privacy audit before routing any traffic to the
   restored database.

Completed tombstones are retained for 90 days. The maximum production backup and Time Travel
window must therefore be documented and kept shorter than 90 days. If any recoverable copy can
outlive the tombstone window, lengthen tombstone retention before taking that copy. A restore
drill is not complete until this replay procedure has been exercised with a deleted account,
a linked public discussion row, and both completed and pending photo tasks.

Photo uploads remain disabled in the reviewed production build. Before enabling them, bind and
verify the intended private R2 bucket, inventory D1 photo locators against that bucket without
logging keys, exercise export and deletion through the Worker binding, alert on aged
`processing` jobs using `requested_at` (not the reconciliation-heartbeat `updated_at`) and on
every `needs_attention` job, and test an R2 object restore/deletion replay. A binding to
an empty or wrong bucket can make a delete call succeed against the wrong storage location, so
bucket identity is release evidence—not a configuration assumption.

Enabling the browser control or adding an R2 binding is not sufficient authorization. The
Worker must retain an explicit server-side upload gate that defaults off. Before switching it
on, implement and test a D1-serialized account-deletion fence: block new trip/photo writes,
then take the complete photo inventory, durably queue every locator, and only then remove active
rows. Include an interleaving test where an upload reaches the attach step during deletion and
prove that the object is either attached to a live trip or durably queued for cleanup.

## Production evidence checklist

- [ ] A fresh redacted provider-state audit confirms exactly one version has `100%` traffic,
      maintenance/config parity is understood, and no provider mutation occurred. Exact
      deployment, version, and reviewed-commit binding is recorded privately; provider metadata
      alone is not accepted as source provenance.
- [ ] Release came from a clean worktree at the reviewed immutable commit.
- [ ] Deployment ID and Worker version ID were recorded; exactly one version has `100%` traffic.
- [ ] Production migration preflight, Time Travel bookmark, migration, and postflight passed.
- [ ] Migration `0016_data_resilience_indexes.sql` completed within its reviewed window;
      `PRAGMA optimize`, representative production `EXPLAIN QUERY PLAN` output, foreign-key
      checks, and before/after D1 rows-read evidence were recorded without query parameters.
- [ ] Migration `0017_trip_idempotency.sql` completed before normal traffic resumed; postflight
      verified its exact nullable text column and synthetic start, completion, and past-report
      retries returned the original operation/trip receipt after a simulated lost response.
- [ ] Migration `0018_ai_review_queue.sql` completed before any Queue binding or feature
      activation; postflight verified its exact table, unique-trip and dispatch indexes, zero
      initial jobs, and foreign-key cascade. The production flag and bindings remain off until
      every provider/staging/rollback/alert gate in `docs/AI-REVIEW-QUEUE.md` passes.
- [ ] Privacy pre/postflight counts match; the missing-age and legal-reacceptance cohorts have
      an explicit support decision, while export and account deletion remain available.
- [ ] Canonical, redirect-alias, and `workers.dev` smoke checks passed.
- [ ] Health and security endpoints return the expected content and hardening headers.
- [ ] The release used the reviewed Node/Python versions and pinned API container digest;
      `npm ci --ignore-scripts`, secret scanning, exact-input Python lock verification, binary-only hash-checked
      Python installs, both npm audit thresholds, dependency review, and deterministic SBOM
      verification passed at the exact commit. The recorded SBOM/lock hashes match that commit.
- [ ] GitHub dependency/Dependabot review has no untriaged high or critical advisory; accepted
      development findings have reachability evidence, an owner, and a deadline. Live `main`
      protection still requires the exact API, pipeline, web, dependency-review, and
      app-bound Advanced Security `CodeQL` checks; secret-scanning push protection and private
      reporting remain enabled; and the CodeQL analyses plus alert list were reviewed at the
      immutable release commit.
- [ ] The seven runtime secret bindings, distinct opaque key IDs, named custodians/reviewers,
      least-privilege account roles, MFA, recovery, revocation, and environment separation were
      verified without placing values in evidence.
- [ ] D1 managed transport/at-rest controls and the absence of application field-level
      encryption are recorded accurately; enabled features passed missing-key, rotation,
      rollback, redacted-log, and provider-revocation checks on the exact Worker version.
- [ ] A named operator exercised the reviewed snapshot PR and guarded publication cadence;
      a deliberately aged fixture displayed `Cached`/`stale` instead of `Live data`/`fresh`.
- [ ] Browser/edge/PWA cache headers match `docs/CACHING-STRATEGY.md`; explicit purge,
      snapshot rollover, old-service-worker removal, offline fallback, and profile/API
      non-caching passed on every production hostname.
- [ ] The exact release passed smoke, load, spike/recovery, and soak profiles against isolated
      production-shaped staging data; p95/p99, errors, D1 rows, cache behavior, pool waits,
      saturation, and cost evidence meet the approved budgets. Production was not load-tested.
- [ ] The six Worker rate-limit bindings have the reviewed production limits; their secret,
      exact-true activation, 429/503 behavior, privacy-safe keys, and emergency-disable path
      were tested without blocking normal beta use.
- [ ] Outer Cloudflare rate-limiting rules are deployed and tested without blocking normal
      beta use; dashboard/plan limitations and final thresholds are recorded.
- [ ] Turnstile is enforced and tested on the agreed high-abuse forms, or an explicit
      time-bounded risk acceptance identifies the owner and deadline.
- [ ] The exact maintenance release served marked, self-contained HTML `503` responses on
      browser navigations, kept crawler-control files available, blocked every API/mutation and
      scheduled job, replaced stale PWA caches, and recovered through the reviewed normal release.
- [ ] Exception, 5xx, CPU, D1, uptime, and volume alerts delivered a test notification.
- [ ] The `docs/OBSERVABILITY.md` saved views exist under an MFA-protected operator role;
      raw invocation URLs are absent, request-ID reconstruction passed, the dedicated
      observability pseudonym key is separate, and redaction fixtures exposed no private fields.
- [ ] A recent encrypted D1 export exists with a tested retention/deletion procedure.
- [x] A production-shaped synthetic non-production restore/deletion-replay drill passed from
      clean commit `0542074ce681c2fbecbe6ea93ffc443c276b6a7a`. Its private aggregate
      acceptance packet was created at `2026-07-18T06:24:47.211Z`; restore-evidence SHA-256 is
      `585a156ecbec933c6cdb485340bd04f802be4781d8a0e2bd6a54668c59c309d8` and the
      verified audit head is
      `ff60f51a34be01d73dfc2a8182d174d4386e6bf03ede2ad71fdf0365d7f5b96c`.
      The packet explicitly records no production data/provider use, no production backup
      restore, no approved key custody, no independent review, and no production-gate pass.
- [ ] The backup/Time Travel window is shorter than the 90-day deletion-tombstone window.
- [ ] A restore drill preserved the current deletion ledger and proved that deleted account,
      trip, public-discussion, and pending-photo records could not reappear in service.
- [ ] The production photo-locator audit is zero while uploads are disabled, or the intended
      R2 bucket binding, deletion retries, aged-job alert, and authenticated export were tested.
- [ ] Deletion receipts, retry exhaustion, operator requeue, aged-job alerting, and restore
      suppression were exercised without placing identifiers or object locators in evidence.
- [ ] The public-discussion kill switch and safe Worker rollback were exercised.
