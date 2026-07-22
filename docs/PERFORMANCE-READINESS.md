# Performance and execution readiness

This document defines what is locally enforced and what still requires isolated staging
evidence. It is not a claim that production has passed a load, soak, spike, failure-injection,
or penetration test. Never direct intrusive testing at `castingcompass.com`, its aliases, real
accounts, or production data.

## D1 query inventory

`scripts/generate-d1-query-inventory.mjs` parses every Worker TypeScript source file and records
all 254 direct `.prepare()` sites: 240 literal statements and 14 separately reviewed nonliteral
expressions across eight source files. The committed policy and generated inventory are
source-hash and call-site bound. CI rejects source-file/count drift, computed or aliased
`prepare` access, a nonliteral expression without its exact static-authority review, an unscoped
literal `UPDATE` or `DELETE`, and a literal multi-row `SELECT` without a reviewed ownership and
cardinality contract. No database or provider is queried while generating the inventory.

The inventory exposes rather than conceals the remaining scale boundaries. All nine unbounded
multi-row reads are intentional complete authenticated privacy exports; no owner-lifecycle
cleanup depends on an unbounded application-side read. Account deletion instead materializes
its complete private-object inventory inside D1 with four source-bound
`INSERT INTO ... SELECT` statements, then removes active rows in one fixed 18-statement
transaction. Account-facing saved-location and gear-preset reads fetch at most 101 rows, expose
at most the exact 100-item account ceiling, and fail closed on a legacy
overflow instead of silently truncating it. Their creates enforce the same ceiling inside the
single `INSERT ... SELECT` statement so concurrent requests cannot both pass a separate count
check. An existing saved location remains idempotently successful at the ceiling. Complete
privacy exports stay intentionally unbounded so a data-rights response cannot omit records; the
default-off async adapter packages them away from the request path when activated, while staging
measurements and provider activation remain open. An inventory proves source coverage and
review identity; it does not prove query latency, production index selection, or safe load
capacity.

Cold authentication, trip-store initialization, and enabled public discussions each perform one
read-only schema-readiness query and fail closed if their migration-owned tables, columns,
indexes, triggers, foreign keys, or `trips.photo_key_hash` column are absent. Default-off public
discussions return an empty public projection without touching D1. None of these paths runs
request-time or scheduled-work DDL; the trip store no longer issues its prior 35
table/index/trigger statements, and discussions no longer issue table/index DDL on a cold
isolate.
Scheduled authentication
retention selects at most 100 eligible primary keys per table and
invocation before deleting sessions, challenges, attempts, age proofs, and completed deletion
jobs. Backlogs drain on later scheduled runs, and regression coverage proves the first invocation
leaves exactly one row from a 101-row eligible fixture while preserving ineligible rows. Privacy
object cleanup claims at most five tasks per invocation, and deletion-job reconciliation updates
at most 100 jobs with one set-based statement rather than one statement per job. Completed
tombstones are removed child-first: one oldest eligible job contributes at most 100 completed,
locator-free task rows per invocation, and up to 100 parent jobs are removed only after they have
zero remaining children. Scheduled parent retention therefore cannot trigger a hidden,
unbounded child cascade. Production-shaped timing, rows-read/written, and backlog-drain evidence
still remains an isolated-staging gate.

The current Cloudflare limits are 50 D1 queries per Worker invocation on Free, 1,000 on Paid,
and 100 bound parameters per query. D1 `batch()` runs its statements sequentially and
transactionally, but every statement still counts toward the applicable limits. Local direct-D1
tests therefore hold the stricter Free ceiling: a cold 75-photo account deletion uses one fixed
batch of no more than 20 statements, executes no more than 50 D1 queries, and never exceeds 100
parameters. The same ceiling covers the lost-committed-response recovery path by reducing its
inline cleanup to one object. These are deterministic local bounds, not deployed-plan or
production-latency evidence. See [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
and [D1 batch semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/).

The five-minute cron also uses the Free ceiling as one aggregate invocation boundary. It no
longer starts four independent `waitUntil` pipelines concurrently. Instead, one deterministic
lane runs sequentially per tick and the four lanes repeat every 20 minutes: queue dispatch,
trip-photo reservation cleanup, expired-export cleanup, and auth retention plus privacy
deletion. Saturated local D1 adapters execute every lane below its conservative 50-query budget:
32, 44, 36, and 44 respectively. The corresponding work caps are one advisory-review dispatch,
five privacy-export dispatches, seven photo reservations, seven expired exports, and three
privacy-deletion tasks. Backlogs remain durable and drain on later rotations. This source and
fixture proof is not evidence of the deployed plan, cron delivery, provider subrequest behavior,
latency, or alerting; those remain isolated-staging gates. The complete contract is in
[SCHEDULED-WORKER-BUDGET.md](SCHEDULED-WORKER-BUDGET.md).

`scripts/check_d1_query_plans.py` separately applies every migration to an in-memory SQLite
database, runs 54 representative `EXPLAIN QUERY PLAN` checks, and rejects missing leftmost
indexes for every foreign-key child path. The checked plans cover the highest-frequency or
growth-sensitive access patterns:

| Workload | Bound / ordering | Required access path |
| --- | --- | --- |
| Session, email-challenge, auth-attempt, and age-proof retention | Scheduled deletion by time; each table selects at most 100 eligible primary keys per invocation | Dedicated leading time indexes; the two age-proof predicates use SQLite's multi-index OR plan |
| Session issuance receipt | One random token hash, authenticated owner, exact timestamps, live user, and absent account-deletion fence, `LIMIT 1` | Session, user, and deletion-fence primary keys; exact state decides whether the plaintext token may be disclosed |
| Sign-out revocation receipt | One exact primary-key absence read for each distinct presented host or legacy session token after the transactional delete batch | Session primary key; only readable zero cardinality permits browser-cookie clearing and the exact sign-out response |
| Legal-acceptance compare-and-set and receipt | Complete authenticated account/legal version plus the exact still-live session before write; exact accepted/prior/account/session cardinality after write | User email/ID and session primary-key indexes; only the request's complete stored account version with continuing session authority can produce the compliance response |
| Age-proof lifecycle receipts | Exact random proof snapshot after creation; exact consumed/prior/cardinality state after one-use transition | Age-proof primary key; plaintext proof disclosure and downstream challenge creation recover committed response loss without accepting rollback or changed state |
| Email-challenge issuance and resend receipts | Complete challenge snapshot plus rolling email ceiling after creation; complete next/prior snapshot and ID cardinality after resend compare-and-set | Challenge primary key and `(email, created_at)` index; only exact state can authorize code delivery while password recovery preserves its generic response |
| Email-code attempt receipt | Claimed and prior counts for one complete challenge snapshot, plus current ID/kind cardinality | Challenge primary key; exact claimed state decides whether code verification may authorize a credential transition |
| Sign-in attempt receipts | Exact pending claim plus rolling failed-attempt count before password work; exact successful classification and absence of the prior pending state before session issuance | Attempt primary key and `(email_hash, attempted_at)` index; stored state recovers lost mutation responses without weakening the ten-attempt ceiling |
| Account-creation receipt | One exact user/legal row plus scalar counts for ID/email cardinality, prior sessions, the one-use challenge, and deletion fence | User ID/email, challenge, and fence unique indexes plus the `(user_id, expires_at)` session index; complete post-state gates welcome and first-session side effects |
| Password-reset receipt | One exact credential row plus scalar counts for prior sessions, the one-use challenge, and deletion fence | User/challenge/fence primary keys and the `(user_id, expires_at)` session index; complete post-state decides whether replacement-session creation may begin |
| Login and email abuse ceilings | One email pseudonym/address plus a fixed time window | Existing `(email_hash, attempted_at)` and `(email, created_at)` indexes |
| Saved sites and gear profiles | One authenticated user; exact 100-item ceilings, `LIMIT 101` overflow detection, fail-closed legacy overflow, and atomic count-guarded creates | `(user_id, created_at)` and `(user_id, updated_at)` ordering indexes |
| Gear update/delete receipts | One server-generated timestamp and authenticated owner after PATCH; exact owner/global cardinality after DELETE | Gear-profile primary key; normalized update state or global absence decides success |
| Manual advisory-review retry receipt | At most ten exact prior owner/trip/AI versions; exact queued/prior/owner/global cardinality after one transactional batch; one immediate dispatch and nine durable backlog rows | Trip primary key; committed response loss can schedule only exact queued state, while rollback, ownership/version drift, and unreadable state cannot manufacture a receipt. Queue-enabled and direct synthetic tests each use 27 local D1 statements and one external operation; actual rows-read/written and latency remain staging evidence |
| Profile trip history | One authenticated user, completed rows only, `LIMIT 100` | Partial expression index over user and effective completion time; no temporary sort |
| Profile trip edit receipt | One server-generated evidence ID, owner/trip identity, and optional correction ID, `LIMIT 1` | Trip and evidence primary keys plus the unique correction-ID index; success separately requires exact normalized post-state |
| Pending trip deletion receipt | One high-entropy receipt plus exact owner/trip/task state, `LIMIT 1`; scalar absence checks are exact-cardinality | Unique receipt, task job/object, trip primary-key, and discussion trip indexes; success requires the expected ledger and zero residual trip/discussion rows |
| Account deletion receipt | One high-entropy receipt plus exact set-based task and active-row counts, `LIMIT 1`; no object-by-object D1 query | Unique receipt/task, account/trip/fence/reservation/attempt/export indexes; success requires a canonical ledger and zero active owner rows |
| Complete account trip export | One authenticated user; intentionally complete rather than silently truncated | `(user_id, created_at)` index. Rare cross-child export ordering may sort; no speculative indexes are added solely for exports |
| Trip submission ceilings | One reporter pseudonym and hour/day windows; active rows have a strict product ceiling | Existing reporter-time index plus a smaller partial active-trip index |
| Advisory AI backlog | Completed new/queued/retry rows plus well-formed expired processing claims, oldest-first with `LIMIT 10` | Reviewed index hint over the completed-trip effective-time partial index; each provider dispatch requires an exact high-entropy read-back claim and stale terminal writes lose |
| Advisory AI queue outbox | Due pending/retry/queued jobs and expired leases, bounded oldest-first | `(state, available_at, lease_expires_at)` dispatch index plus a unique trip index; D1 remains authoritative under at-least-once delivery |
| Public discussions | One curated site, newest first, `LIMIT 12`, then a primary-key trip join | Existing `(site_id, observed_at)` index and trip primary key |
| Privacy deletion receipts, tombstones, jobs, and tasks | Receipt lookup, subject/owner lookup, five-task worker claims, one set-based 100-job reconciliation, one oldest-job/100-task retention prune, and a 100-job childless-parent retention delete | Unique receipt, scope/subject, owner/state, state/completion, task retry, job/object, and parent primary-key indexes; exact claim state makes an overlapping or stale pruner a no-op |
| Account deletion fence and private-object inventory | Exact fence-lease receipt; four source-bound set inventories for prior deletion tasks, photo reservations, privacy exports, and attached trip photos; bounded due-reservation reconciliation | Unique owner fence identity, object-hash uniqueness, `(owner_subject_hash, created_at)`, export-owner/state, trip-owner, and retry indexes |
| Validation exports and cascades | Activation, trip, or user predicates with append-only sequence order | Existing activation/trip indexes plus user recruitment, activation correction, and forecast/trip foreign-key indexes |

The inventory policy and generated artifact are inputs to the combined release SBOM and are
included in the deterministic release bundle, so a release candidate cannot silently substitute
a narrower query ledger. The migration adds indexes only where a current query, ordered result,
retention scan, or foreign key enforcement path justifies their write/storage cost. Cloudflare
recommends validating D1 indexes with `EXPLAIN QUERY PLAN` and notes that multi-column indexes
require the predicate to use the leftmost columns:
[D1 index guidance](https://developers.cloudflare.com/d1/best-practices/use-indexes/).

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
| Trip start/completion/edit and active-data privacy deletion | Synchronous atomic D1 batches | User-visible consistency, ownership checks, immutable evidence, and cascade order must commit before success. Start, completion, and past-report retries use client-held high-entropy request material, server-side one-way hashes, principal binding, and exact receipts; automatic replay remains prohibited |
| Email delivery | Awaited when delivery determines whether the flow can proceed; `waitUntil` only where a durable challenge already exists and retry is safe | Provider idempotency key is supplied; centralized delivery status/alerting is still needed |
| AI advisory review | Production default remains `waitUntil` after the authoritative trip write plus scheduled backlog. A default-off managed Queue adapter, opaque message contract, D1 outbox/lease/attention ledger, bounded retry/backoff, cost ceiling, deletion/maintenance recovery, and state-guarded replay planner are locally implemented | Apply `0018`, provision the producer/consumer/DLQ, prove isolated synthetic failure and rollback cases, activate alerts/IAM, then enable only through a separate reviewed release using `docs/AI-REVIEW-QUEUE.md` |
| Privacy object purge | Durable D1 job/task ledger processed after active-data removal | Existing leases, retry bounds, attention state, and receipts preserve correctness; dashboard alerting and production-shaped drills remain open |
| Complete privacy export packaging | Direct authenticated response while the production flag is off; default-off managed Queue adapter when activated | The local Queue/D1/private-object path is complete and preserves all rows, but `0019`, provider bindings, staging metrics, IAM, DLQ, alerts, and the separate activation release remain open; see `docs/ASYNC-PRIVACY-EXPORTS.md` |
| Snapshot/model generation, media processing, notification fan-out | Offline pipeline or future managed queue | These must never block authorization or primary writes. Each queue design requires a separate reviewed schema and provider configuration |

The direct fallback currently uses at most six parallel D1 calls in each account-export fan-out,
matching Cloudflare's documented per-invocation simultaneous-connection ceiling. Do not add
another query to that `Promise.all` group without restructuring it. The active query, parameter,
and connection ceilings are recorded in [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

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
credentials and paths, and accepts only a canonical named HTTPS host for remote staging. Before
the first timed request, remote mode also requires all of the following:

1. the exact source commit is a clean checkout reachable from the locally reviewed official
   `origin/main`;
2. the operator supplies the expected immutable Worker version and an opaque
   `sec_` exercise marker from the written staging authorization/deployment receipt;
3. a non-redirecting, non-cacheable `/api/health` response matches the exact current six-field
   Worker contract, API compatibility version, Worker version, exercise marker, healthy D1, and
   non-maintenance state.

The target hostname, Worker version, and exercise marker are deliberately omitted from stdout.
Only the public source commit and aggregate measurements are printed. The remote opt-in and
identity arguments are mandatory:

```sh
export CASTINGCOMPASS_LOAD_AUTHORIZATION=I_HAVE_AUTHORIZATION_FOR_THIS_STAGING_TARGET
COMMIT="0123456789abcdef0123456789abcdef01234567"
WORKER_VERSION="version-from-the-staging-deployment-receipt"
EXERCISE_ID="sec_0123456789abcdef0123456789abcdef"

npm run load:smoke -- \
  --target https://approved-preview.example.workers.dev/ \
  --expected-commit "$COMMIT" \
  --expected-worker-version "$WORKER_VERSION" \
  --exercise-id "$EXERCISE_ID"
npm run load:test -- \
  --profile load \
  --target https://approved-preview.example.workers.dev/ \
  --expected-commit "$COMMIT" \
  --expected-worker-version "$WORKER_VERSION" \
  --exercise-id "$EXERCISE_ID"
```

Do not copy those example identities into a real run. Generate a new opaque marker for the
authorized window, bind it only to the isolated synthetic Worker, and remove it after the
exercise. Remote execution from an unreviewed feature branch, a dirty checkout, a stale API or
Worker, an absent marker, a redirect, an IP literal, cleartext HTTP, or maintenance state fails
before load workers start. Loopback mode does not accept or claim remote identity arguments.

Run in this order: local smoke, isolated preview smoke, load, spike with recovery observation,
then soak. Use synthetic accounts/data only. Record Worker CPU and wall time, D1 query duration
and rows read/written, error codes, cache hit behavior, pool checkout/wait stats, AI/Resend calls
(disabled or stubbed for read tests), and estimated cost. Stop immediately on data crossover,
authorization failure, uncontrolled writes, sustained 5xx, provider saturation, or cost drift.

Failure injection and penetration testing remain separate authorized exercises. Before either,
freeze the exact commit/config, isolate credentials and data, document source IPs and emergency
contacts, define rollback/kill switches, preserve redacted evidence, and schedule a remediation
retest. The load harness is intentionally not a vulnerability scanner.
