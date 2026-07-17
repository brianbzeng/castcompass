# Observability and operator diagnostics

This is the repository-controlled observability contract. It does not prove that a production
dashboard, alert destination, identity policy, retention setting, or log export exists. Those
items require captured Cloudflare account evidence before launch.

## Decision and trust boundary

Cloudflare Workers Observability is the primary Worker log and diagnostic surface. Workers Logs
is already enabled in `wrangler.jsonc`; the repository emits bounded structured objects that the
Cloudflare dashboard can search, filter, visualize, save, share, and export. Cloudflare documents
those capabilities in [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
and the [Query Builder](https://developers.cloudflare.com/workers/observability/query-builder/).

The optional FastAPI service emits the same schema family as one JSON object per host log line,
returns its own `X-Request-ID`, normalizes its public routes, and records only exception type/code.
It has no account/session routes and therefore no actor key. If that service is deployed outside
Cloudflare, its hosting-provider log stream is not automatically present in the Workers dashboard;
an approved log drain/OTLP destination and retention policy remains an external activation gate.

Raw invocation logs are disabled. Their default fetch message contains the full request URL,
which can expose a trip identifier or hostile unknown path. The application instead records a
normalized route template such as `/api/profile/trips/:trip_id` or `/api/:unknown`. One custom
completion event is retained for meaningful requests at the current beta sampling rate of 100%;
hashed build assets are debug-only and therefore suppressed at the production `info` level.
Revisit sampling and cost before a traffic campaign. Cloudflare currently documents plan-based
retention of only a few days, so this is not an audit ledger or long-term business record.

PostHog is deferred. Its current product includes analytics and error tracking, but adding the
browser SDK would create a new processor, consent and deletion surface, identifier model, network
egress path, and potential autocapture/session-replay risk. Do not add it until the processor
inventory, privacy notice, consent rule, residency, retention, IP policy, autocapture allowlist,
deletion test, DPA, and cost owner are approved. If later enabled, begin with explicit anonymous
events only; keep autocapture and session replay off and never send account, trip, photo, prompt,
precise-location, or free-text fields. PostHog's own privacy guidance emphasizes collection
controls and consent: [data collection controls](https://posthog.com/docs/privacy/data-collection)
and [GDPR guidance](https://posthog.com/docs/privacy/gdpr-compliance).

Financial reporting must never be built from logs or PostHog event counts. A future financial
dashboard is a separately authorized domain backed by payment-processor and accounting source
records, an immutable import/reconciliation trail, least-privilege roles, and explicit retention.

## Event schema

Every application event uses `castingcompass.log/1.0.0` and has:

| Field | Meaning |
| --- | --- |
| `timestamp` | UTC ISO-8601 emission time |
| `level` | `debug`, `info`, `warn`, or `error` |
| `event` | Stable dotted event name, not prose |
| `service` | `castingcompass-web` for the Worker or `castingcompass-api` for the optional FastAPI service |
| `environment` | `development`, `preview`, `production`, `unknown`, or `scheduled` |
| `worker_version_id` | Validated Cloudflare version metadata when available |
| `request_id` | Server-generated UUID returned as `X-Request-ID`; inbound values are ignored |
| `trace_id` | Validated Cloudflare Ray ID when available |
| `actor_session_key` | HMAC-SHA-256 of a valid session token using the dedicated observability pseudonym secret and a versioned domain separator; absent when either input is unavailable |
| `method`, `route`, `status`, `outcome`, `duration_ms` | Bounded request summary; route is a server allowlisted template and never includes query text |
| `operation_id`, `task` | Correlation for scheduled work |

The actor key is deliberately not a raw user ID. It cannot authorize anything, changes when the
session or HMAC key changes, and is omitted if `OBSERVABILITY_PSEUDONYM_SECRET` is unavailable. The raw
token and HMAC material never enter the event. Rotation therefore limits correlation duration.

The logging API accepts only flat bounded scalar values or short identifier arrays. It rejects
field names associated with emails, IDs, credentials, cookies, request bodies, prompts, notes,
coordinates, object locators, and photos. String values must be short code-like identifiers;
exception messages and stacks are never submitted. The only direct `console.*` calls live in
`worker/observability.ts`, where severity is preserved for Cloudflare indexing.

Development debug logging is explicit: use `LOG_LEVEL=debug` only in a local or isolated preview
environment. Production defaults to `info`; an absent or unrecognized level cannot enable debug.

## Operator dashboard recipe

In Cloudflare, go to **Workers & Pages → contourcast-halibut → Observability**. Create and save
these Query Builder views. Names are part of the runbook so screenshots and incident notes can
refer to them consistently:

| Saved view | Filter | Visualization |
| --- | --- | --- |
| `CC — current failures` | `event = "http.request.completed" AND status >= 500` | Count over time, grouped by `route` and `worker_version_id` |
| `CC — latency by route` | `event = "http.request.completed" AND status < 500` | p50/p95/p99 of `duration_ms`, grouped by `route` |
| `CC — rate-limit controls` | `startsWith(event, "rate_limit.")` | Count over time, grouped by `event` |
| `CC — privacy jobs` | `startsWith(event, "privacy.") OR task = "auth_data_cleanup"` | Event table with `level`, `event`, `operation_id`, and version |
| `CC — AI review` | `startsWith(event, "ai_review.") OR task = "trip_review_backlog"` | Count and latest failures by event/version |
| `CC — email delivery` | `startsWith(event, "email.") OR startsWith(event, "password_recovery.")` | Count by event and provider status; no recipient fields |
| `CC — one request` | `request_id = "<support-provided UUID>"` | Event table ordered by timestamp |
| `CC — one session window` | `actor_session_key = "<copied pseudonym>"` | Event table; use only for a bounded incident and never as an identity lookup |
| `CC — scheduled failures` | `event = "scheduled.task.failed"` | Latest table with task, operation, version, and duration |

Also pin the provider-native Worker request, exception, CPU-time, and wall-time charts. A saved
query is not an alert. Configure notification rules separately for sustained 5xx, uncaught
exceptions, CPU/wall-time regression, scheduled failures, D1 errors, and request-volume anomaly.
Every alert needs an owner, threshold/window, cooldown, runbook link, acknowledgement path, and
tested destination.

## Incident workflow

1. Record UTC start time, affected hostname, current Worker version, and a non-sensitive request
   ID. Never ask a user for a cookie, token, password, exact location, trip notes, or screenshot
   containing private data.
2. Open `CC — one request`, then compare `CC — current failures` and native Worker metrics before
   and after the deployment version. Use the normalized route, status, event code, and timing;
   do not query D1 private rows merely because they exist.
3. If privacy deletion, rate limiting, email, or AI review is involved, use only its focused view
   and follow that subsystem's runbook. Provider request IDs are opaque correlation values, not
   proof of delivery or user identity.
4. Activate a documented kill switch or maintenance release only through the immutable release
   procedure. Do not mutate production from an ad hoc dashboard session.
5. Export only the minimum redacted event set needed for the incident. Store it under the
   incident retention rule, record access, and delete it on schedule.
6. Close only after a synthetic non-sensitive reproduction proves both recovery and log
   redaction. Link the exact commit, deployment, alert, and follow-up owner.

## External activation evidence still required

- [ ] Confirm Workers Logs receives only the structured schema and raw invocation logs are absent
      on the exact preview and production versions.
- [ ] Save the views above under an MFA-protected least-privilege operator role and capture their
      stable links or screenshots without event payloads.
- [ ] Record account plan, retention, sampling, daily/monthly volume, cost ceiling, and an owner
      who reviews them.
- [ ] Deliver synthetic 5xx, latency, scheduled-failure, D1, and volume alerts to the real
      escalation destination; acknowledge and close them through the runbook.
- [ ] Prove a request-ID reconstruction with fixtures and verify that email, raw account/trip
      identifiers, cookies, tokens, IPs, prompts, notes, coordinates, and provider bodies are absent.
- [ ] Decide whether short native retention is sufficient. If not, approve an OTLP/Logpush
      destination with encryption, region, access control, deletion, cost, and processor review
      before enabling export.
- [ ] If the optional FastAPI service is deployed, connect and test its provider log drain so its
      request IDs can be searched from the same least-privilege incident surface.
