# Production operations gate

This runbook separates repository controls from Cloudflare/account controls. Repository
tests cannot prove that a dashboard rule, alert, backup, or deployed version exists. Do not
mark production hardening complete until the evidence checklist at the end is filled from
the production environment.

## Abuse controls

The Worker enforces request-body limits, per-email authentication ceilings, failed-login
ceilings, and per-reporter trip ceilings. Those durable limits do not replace an edge rule:
an attacker can still create high-cardinality identifiers and make the Worker spend CPU and
D1 operations.

Configure Cloudflare rate-limiting rules ahead of the Worker, beginning in log-only mode when
the plan supports it. Review legitimate beta traffic before selecting final thresholds.
At minimum, cover:

- email-producing mutations: `/api/auth/signup/request`,
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

## Monitoring and alerting

Cloudflare Worker observability is enabled in `wrangler.jsonc`, but that setting alone is not
an alerting system. Configure and exercise:

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

Run the export only from a verified release checkout after `npm ci`; do not let a package
runner download an unreviewed Wrangler version for a production-data operation.

A restore drill must use an isolated local database or a disposable non-production D1
database. Never overwrite production for a drill. Validate schema objects, migration state,
`PRAGMA integrity_check`, `PRAGMA foreign_key_check`, representative aggregate row counts,
authentication/session revocation behavior, and application reads. Record only aggregate
evidence, then destroy the drill copy. R2/photo backup is out of scope while uploads remain
disabled; add a separate private-object restore drill before enabling photos.

## Production evidence checklist

- [ ] Release came from a clean worktree at the reviewed immutable commit.
- [ ] Deployment ID and Worker version ID were recorded; exactly one version has `100%` traffic.
- [ ] Production migration preflight, Time Travel bookmark, migration, and postflight passed.
- [ ] Canonical, redirect-alias, and `workers.dev` smoke checks passed.
- [ ] Health and security endpoints return the expected content and hardening headers.
- [ ] GitHub dependency/Dependabot review has no untriaged high or critical production
      advisory; development-only findings have an owner and deadline.
- [ ] A named operator exercised the reviewed snapshot PR and guarded publication cadence;
      a deliberately aged fixture displayed `Cached`/`stale` instead of `Live data`/`fresh`.
- [ ] Edge rate limits are deployed and tested without blocking normal beta use.
- [ ] Turnstile is enforced and tested on the agreed high-abuse forms, or an explicit
      time-bounded risk acceptance identifies the owner and deadline.
- [ ] Exception, 5xx, CPU, D1, uptime, and volume alerts delivered a test notification.
- [ ] A recent encrypted D1 export exists with a tested retention/deletion procedure.
- [ ] A non-production restore drill passed and its aggregate evidence is recorded.
- [ ] The public-discussion kill switch and safe Worker rollback were exercised.
