# Scheduled Worker invocation budget

Status: locally enforced; isolated staging and production evidence remain open

Cloudflare applies D1 and subrequest limits to the whole Worker invocation. A separate
`ctx.waitUntil()` promise is not a separate quota boundary. CastingCompass therefore runs one
sequential background lane per `*/5 * * * *` cron tick instead of launching every background
pipeline concurrently.

## Rotation and local ceilings

The lane is selected from the scheduled timestamp's five-minute bucket. The four fixed lanes
repeat every 20 minutes, including across isolate restarts; no mutable cursor or browser input
selects work.

| Lane | Per-pass work cap | Conservative D1 query budget | Maximum external operations |
| --- | ---: | ---: | ---: |
| Queue dispatch | 1 advisory review, then 5 privacy exports | 32 | 6 Queue sends, or 1 direct provider request plus 5 sends when independently enabled |
| Trip-photo reservations | 7 reservations | 44 | 7 idempotent R2 deletes |
| Privacy-export expiry | 7 export objects | 36 | 7 idempotent R2 deletes |
| Auth retention and deletion | 1 bounded candidate read, up to 9 retention statements, then 3 deletion tasks | 44 | 3 idempotent R2 deletes |

Every D1 budget is below the 50-query Free-plan ceiling. The bounds include a cold schema probe,
each statement inside `batch()`, exact lease/terminal read-backs, and the repair write for an
ambiguous or failed terminal response. Runtime work is sequential, which also stays below D1's
simultaneous-connection limit. Durable ledgers, leases, retry timestamps, and attention states
preserve excess work for later rotations rather than silently dropping it.

Completed privacy tombstones are pruned child-first. One oldest eligible job contributes at most
100 already-completed, locator-free tasks per pass; a parent is eligible for its separate
100-job delete only after no child row remains. The foreign-key cascade therefore has zero child
rows to write during scheduled retention instead of hiding an arbitrary fan-out behind a
nominally bounded parent delete. A pre-read candidate can prune only after an exact primary-key,
completion-time, aggregate-count, and opaque per-batch claim compare-and-set; child deletion and
claim clearing occur in that same transaction. Drift makes the prune a no-op, and a lost
post-commit response leaves neither an exposed claim nor a partial ledger. Incomplete,
locator-bearing, or attention-state work is retained.

`tests/scheduled-runtime.test.mjs` applies the complete migration chain, saturates every lane,
counts executed D1 statements (including batch members), verifies the work cap, and rejects a
lane that exceeds its declared budget. The trip store separately fails closed on an incomplete
migration-owned schema and performs no runtime DDL.

## What this does not prove

Local statement counting does not prove the deployed Cloudflare plan, cron delivery, rows
read/written, CPU time, wall time, Queue or R2 latency, provider rate limits, cost, backlog drain,
or alerts. Before activation or traffic growth, run the exact release commit in isolated staging
with synthetic data and record those aggregate measurements. Keep production maintenance,
schema migration, provider binding, Queue/R2 activation, and alert changes behind their separate
reviewed release gates.

Primary platform references: [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
and [D1 batch semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/).
