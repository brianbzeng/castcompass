# Performance and execution readiness

This document defines what is locally enforced and what still requires isolated staging
evidence. It is not a claim that production has passed a load, soak, spike, failure-injection,
or penetration test. Never direct intrusive testing at `castingcompass.com`, its aliases, real
accounts, or production data.

## D1 query inventory

The Worker uses prepared, bound D1 statements. `scripts/check_d1_query_plans.py` applies every
migration to an in-memory SQLite database, runs representative `EXPLAIN QUERY PLAN` checks, and
rejects missing leftmost indexes for every foreign-key child path. The checked plans cover the
highest-frequency or growth-sensitive access patterns:

| Workload | Bound / ordering | Required access path |
| --- | --- | --- |
| Session, email-challenge, auth-attempt, and age-proof retention | Scheduled deletion by time; privacy cleanup remains policy-bounded | Dedicated leading time indexes; the two age-proof predicates use SQLite's multi-index OR plan |
| Login and email abuse ceilings | One email pseudonym/address plus a fixed time window | Existing `(email_hash, attempted_at)` and `(email, created_at)` indexes |
| Saved sites and gear profiles | One authenticated user; saved sites and gear are naturally account-bounded | `(user_id, created_at)` and existing `(user_id, updated_at)` ordering indexes |
| Profile trip history | One authenticated user, completed rows only, `LIMIT 100` | Partial expression index over user and effective completion time; no temporary sort |
| Complete account trip export | One authenticated user; intentionally complete rather than silently truncated | `(user_id, created_at)` index. Rare cross-child export ordering may sort; no speculative indexes are added solely for exports |
| Trip submission ceilings | One reporter pseudonym and hour/day windows; active rows have a strict product ceiling | Existing reporter-time index plus a smaller partial active-trip index |
| Advisory AI backlog | Completed and pending/retry rows, `LIMIT 10` | Partial `(status, effective completion time)` index; row claim remains atomic and idempotent |
| Public discussions | One curated site, newest first, `LIMIT 12`, then a primary-key trip join | Existing `(site_id, observed_at)` index and trip primary key |
| Privacy deletion receipts, tombstones, jobs, and tasks | Receipt lookup, subject/owner lookup, bounded worker claims, completed-job retention | Unique receipt, scope/subject, owner/state, state/completion, task retry, and job/object indexes |
| Validation exports and cascades | Activation, trip, or user predicates with append-only sequence order | Existing activation/trip indexes plus user recruitment, activation correction, and forecast/trip foreign-key indexes |

The migration adds indexes only where a current query, ordered result, retention scan, or foreign
key enforcement path justifies their write/storage cost. Cloudflare recommends validating D1
indexes with `EXPLAIN QUERY PLAN` and notes that multi-column indexes require the predicate to use
the leftmost columns: [D1 index guidance](https://developers.cloudflare.com/d1/best-practices/use-indexes/).

After migration `0016_data_resilience_indexes.sql` is reviewed and applied through the guarded
release procedure, run `PRAGMA optimize` as a separate recorded production operation, capture the
before/after plans and D1 rows-read metrics, and confirm migration time against production-shaped
synthetic volume. No migration was applied while preparing this change.

## Connection lifecycle

- The production web path uses the Cloudflare D1 Worker binding. It does **not** create a SQL
  connection pool or call the D1 REST control plane from a request. D1/Workers own that binding
  lifecycle and impose per-invocation connection limits.
- The optional standalone FastAPI/Postgres service uses one bounded `psycopg_pool.ConnectionPool`
  per process: 1 warm connection, 4 maximum connections, at most 8 waiting checkouts, and a
  3-second checkout timeout by default. Values are validated and bounded before use. Each process
  multiplies the provider-wide connection total, so production sizing must be approved against
  the actual database plan.
- The pool opens during FastAPI lifespan and closes during shutdown. A database incident still
  falls back to the published, validated file snapshot. The public accessible-site set has a
  60-second monotonic in-process cache to remove repeated scans and the prior site-detail/list
  N+1; no credential, account, or trip content enters it.
- Pool queue/wait/error statistics must be exported by the observability milestone before the
  optional service is considered production-ready. Psycopg documents bounded pool sizing,
  lifecycle, timeouts, and statistics here: [Psycopg connection pools](https://www.psycopg.org/psycopg3/docs/advanced/pool.html).

## Synchronous and deferred work

“Async” is not a synonym for “safe” or “fast.” The boundary is based on consistency and retry
semantics:

| Operation | Current boundary | Reason / next gate |
| --- | --- | --- |
| Authorization, session validation, rate limits, password decisions | Synchronous | The response cannot be correct before the decision; never move these to background work |
| Trip start/completion/edit and active-data privacy deletion | Synchronous atomic D1 batches | User-visible consistency, ownership checks, immutable evidence, and cascade order must commit before success |
| Email delivery | Awaited when delivery determines whether the flow can proceed; `waitUntil` only where a durable challenge already exists and retry is safe | Provider idempotency key is supplied; centralized delivery status/alerting is still needed |
| AI advisory review | `waitUntil` after the authoritative trip write; scheduled backlog with atomic row claim and bounded provider deadline | Move to a managed queue before high traffic; require idempotency, cost ceiling, retry/backoff, dead-letter state, and operator replay |
| Privacy object purge | Durable D1 job/task ledger processed after active-data removal | Existing leases, retry bounds, attention state, and receipts preserve correctness; dashboard alerting and production-shaped drills remain open |
| Snapshot/model generation, media processing, notification fan-out, large export packaging | Offline pipeline or future managed queue | These must never block authorization or primary writes. A queue design requires a separate reviewed schema and provider configuration |

The Worker currently uses at most six parallel D1 calls in the account-export fan-out, matching
Cloudflare's documented per-invocation simultaneous-connection ceiling. Do not add another query
to that `Promise.all` group without restructuring it. Cloudflare's current D1 limits and batching
guidance are documented in the [D1 FAQ](https://developers.cloudflare.com/d1/reference/faq/).

## Staging-only load harness

`scripts/load-test.mjs` exercises four read-only routes and reports request count, failures,
error rate, p50, p95, and p99. The repository profiles are deliberately capped:

| Profile | Duration | Concurrency | Purpose |
| --- | ---: | ---: | --- |
| `smoke` | 15 seconds | 2 | Connectivity, headers, and gross regression |
| `load` | 120 seconds | 10 | Initial steady-state budget evidence |
| `spike` | 30 seconds | 30 | Short burst and recovery behavior |
| `soak` | 15 minutes | 5 | Leak, pool, cache, and gradual-error evidence |

The initial provisional budgets are p95 ≤ 750 ms, p99 ≤ 1500 ms, and error rate ≤ 1%. They are
engineering tripwires, not a public SLA, and must be revised from staged measurements. The
harness has no target default, permanently rejects every production hostname/alias, rejects URL
credentials and paths, and requires this exact opt-in for a remote staging host:

```sh
export CASTINGCOMPASS_LOAD_AUTHORIZATION=I_HAVE_AUTHORIZATION_FOR_THIS_STAGING_TARGET
npm run load:smoke -- --target https://approved-preview.example.workers.dev/
npm run load:test -- --profile load --target https://approved-preview.example.workers.dev/
```

Run in this order: local smoke, isolated preview smoke, load, spike with recovery observation,
then soak. Use synthetic accounts/data only. Record Worker CPU and wall time, D1 query duration
and rows read/written, error codes, cache hit behavior, pool checkout/wait stats, AI/Resend calls
(disabled or stubbed for read tests), and estimated cost. Stop immediately on data crossover,
authorization failure, uncontrolled writes, sustained 5xx, provider saturation, or cost drift.

Failure injection and penetration testing remain separate authorized exercises. Before either,
freeze the exact commit/config, isolate credentials and data, document source IPs and emergency
contacts, define rollback/kill switches, preserve redacted evidence, and schedule a remediation
retest. The load harness is intentionally not a vulnerability scanner.
