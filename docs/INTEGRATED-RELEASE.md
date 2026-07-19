# Integrated production release

This runbook is the authoritative path for the first release containing migrations
`0009` through `0018`. It exists because production has a known, narrowly bounded drift:
the eight nullable `0007_legal_acceptance.sql` columns are already present, while the D1
migration ledger records only `0000` through `0006`. Running Wrangler against the normal
`drizzle` directory would try `0007` again and then every later migration. Do not run raw
`wrangler d1 migrations apply` against production.

The release remains pending until a human explicitly authorizes the external operations.
All command output and identifiers belong in a private evidence directory outside the
repository. Never store user rows, email addresses, notes, session values, secrets, raw
object keys, or the Time Travel bookmark in source control.

Every production mutation also requires a separate action-specific, two-role, six-hour private
packet accepted by [Production change authorization](PRODUCTION-CHANGE-AUTHORIZATION.md).
Checkout verification, static confirmation flags, or a previous phase's packet cannot replace it.

## Fixed release boundaries

- Production database: `contourcast-trips` (`DB` in `wrangler.jsonc`).
- Checked-in feature switches, including `RELEASE_MAINTENANCE_MODE`, default to `false`.
- The guarded migration wrapper accepts only the exact checked-in migration allowlist,
  verifies a clean checkout at operator-supplied `RELEASE_COMMIT`, queries the primary D1
  ledger before and after, and creates a private temporary Wrangler config whose
  `migrations_pattern` exposes one exact file.
- `0007` is never rerun. A guarded SQL statement records it only if the ledger is exactly
  `0000`–`0006`, all eight columns have the expected nullable `TEXT` shape, no later schema
  exists, and the foreign-key check is empty.
- Remote D1 does not authorize SQLite `PRAGMA integrity_check`. The release therefore uses
  D1's supported foreign-key check and exact schema/data predicates; the complete migration
  chain still runs `integrity_check` in local automated tests.
- The maintenance Worker keeps crawler-control files, static assets, and `/api/health`
  available; returns a self-contained non-cacheable HTML `503` for browser documents and a
  non-cacheable `503 release_maintenance` for every API or mutation before body parsing or
  database handlers; and suppresses scheduled review and cleanup work.

## Compatibility sequence

| Phase | Worker serving traffic | Permitted schema state | Safe recovery |
| --- | --- | --- | --- |
| A | pinned discussion safety floor | through `0010` | route back to the recorded safety version |
| B | reviewed full release with maintenance on | `0010` through `0018` | remain on the recorded maintenance version and fix forward |
| C | reviewed full release with maintenance off | exactly through `0018` | re-enable the same release's maintenance version while investigating |

The safety-floor Worker is not a valid normal-traffic rollback after `0011`: the species
contract adds completion guards that older trip writes do not satisfy. A Time Travel restore
overwrites current data and is not an ordinary rollback. It requires a continuing write
freeze, impact review, and separate explicit authorization.

## 1. Freeze automation and prove source identity

Disable Cloudflare Git-connected automatic deployments and pause the GitHub
`Refresh public forecast snapshot` schedule. Confirm no build or refresh is running. In the
reviewed full-release worktree:

```sh
export RELEASE_COMMIT=FULL_40_CHARACTER_RELEASE_COMMIT
npm ci --ignore-scripts
npm run verify:release-checkout
npm test
npm run lint
npm run typecheck
npm run security
npm run verify:discussion-safety
npm run verify:validation-successor
```

Record the exact commit and check output. Do not derive `RELEASE_COMMIT` from the checkout in
the release command; it is an operator-supplied review boundary.

## 2. Establish the safety floor

Follow step 1 of [Discussion moderation](DISCUSSION-MODERATION.md) from a separate clean
worktree pinned to `e2c612246fadfdb231e481c405fa72e502458ed1`. Deploy it Worker-only, record
the deployment and version IDs, confirm exactly one version receives `100%` of traffic, and
run the all-host discussion verifier. The public discussion switch remains off.

If the currently active Worker is claimed to be equivalent, still bind that claim to its
source commit, deployment ID, version ID, `100%` traffic observation, and successful live
checks. An unverified dashboard label is not a rollback floor.

## 3. Record recovery evidence and run the read-only preflight

From the unchanged full-release worktree, record D1 backend information and a fresh Time
Travel bookmark in the private release record, then run the guarded read-only preflight:

```sh
./node_modules/.bin/wrangler d1 info contourcast-trips --config wrangler.jsonc --json
./node_modules/.bin/wrangler d1 time-travel info contourcast-trips --config wrangler.jsonc --json
npm run preflight:cloudflare:remote
```

Stop unless the preflight succeeds. It must observe the exact `0000`–`0006` ledger; all eight
`0007` columns; no `0009`–`0018` release schema or indexes; no photo locators; no
foreign-key violations; and
only aggregate user, trip, and discussion counts. Preserve its aggregate evidence hash and
output. The confirmation flags in later commands assert that the bookmark was already stored;
they do not create or preserve it for the operator.

## 4. Reconcile `0007`, then apply the safety-compatible migrations

These are production mutations. Run them only after explicit release approval:

```sh
export RELEASE_AUTHORIZATION_FILE=/PRIVATE/ENCRYPTED/PATH/migrate-reconcile-0007.json
npm run reconcile:cloudflare:0007 -- \
  --confirm-primary contourcast-trips --confirm-bookmark-recorded

export RELEASE_MIGRATION=0009_human_discussion_approval.sql
export RELEASE_AUTHORIZATION_FILE=/PRIVATE/ENCRYPTED/PATH/migrate-0009.json
npm run migrate:cloudflare:remote -- \
  --confirm-primary contourcast-trips --confirm-bookmark-recorded

export RELEASE_MIGRATION=0010_privacy_durability.sql
export RELEASE_AUTHORIZATION_FILE=/PRIVATE/ENCRYPTED/PATH/migrate-0010.json
npm run migrate:cloudflare:remote -- \
  --confirm-primary contourcast-trips --confirm-bookmark-recorded
```

Each invocation re-verifies the immutable checkout and exact ordered remote ledger. Wrangler
also verifies that none of the target migration's tables, columns, or boundary triggers exists;
it can then see only the named file and creates its normal per-migration backup. Stop on any
mismatch, prompt rejection, command error, or post-apply ledger failure. Do not skip ahead,
rename a migration, or use the normal `wrangler.jsonc` migration directory directly.

## 5. Deploy and prove the maintenance bridge

Deploy the full reviewed release with every public feature switch off and maintenance on:

```sh
export RELEASE_AUTHORIZATION_FILE=/PRIVATE/ENCRYPTED/PATH/deploy-maintenance.json
npm run release:cloudflare:maintenance
./node_modules/.bin/wrangler deployments status --config wrangler.jsonc --json
```

Record the maintenance deployment ID and version ID and confirm exactly one version receives
`100%` of traffic. Then prove both the canonical and direct `workers.dev` hosts identify that
version, report maintenance active, serve the marked browser `503`, keep `robots.txt` available,
and block both read and mutation APIs:

```sh
npm run verify:release-maintenance -- \
  --base-url https://castingcompass.com \
  --base-url https://WORKER_SUBDOMAIN.workers.dev \
  --expected-worker-version-id MAINTENANCE_VERSION_ID
```

Do not apply `0011` unless this check passes. If maintenance deployment or verification fails,
stop in phase A and retain or restore the recorded safety-floor version.

## 6. Apply the schema-bound migrations one at a time

While the verified maintenance version is at `100%`, apply the remaining exact sequence:

```sh
export RELEASE_MIGRATION=0011_species_aware_observations.sql
export RELEASE_AUTHORIZATION_FILE=/PRIVATE/ENCRYPTED/PATH/migrate-0011.json
npm run migrate:cloudflare:remote -- \
  --confirm-primary contourcast-trips --confirm-bookmark-recorded

export RELEASE_MIGRATION=0012_validation_protocol.sql
export RELEASE_AUTHORIZATION_FILE=/PRIVATE/ENCRYPTED/PATH/migrate-0012.json
npm run migrate:cloudflare:remote -- \
  --confirm-primary contourcast-trips --confirm-bookmark-recorded

export RELEASE_MIGRATION=0013_validation_feasibility_pilot.sql
export RELEASE_AUTHORIZATION_FILE=/PRIVATE/ENCRYPTED/PATH/migrate-0013.json
npm run migrate:cloudflare:remote -- \
  --confirm-primary contourcast-trips --confirm-bookmark-recorded

export RELEASE_MIGRATION=0014_validation_feasibility_recruitment_and_corrections.sql
export RELEASE_AUTHORIZATION_FILE=/PRIVATE/ENCRYPTED/PATH/migrate-0014.json
npm run migrate:cloudflare:remote -- \
  --confirm-primary contourcast-trips --confirm-bookmark-recorded

export RELEASE_MIGRATION=0015_validation_snapshot_suppression.sql
export RELEASE_AUTHORIZATION_FILE=/PRIVATE/ENCRYPTED/PATH/migrate-0015.json
npm run migrate:cloudflare:remote -- \
  --confirm-primary contourcast-trips --confirm-bookmark-recorded

export RELEASE_MIGRATION=0016_data_resilience_indexes.sql
export RELEASE_AUTHORIZATION_FILE=/PRIVATE/ENCRYPTED/PATH/migrate-0016.json
npm run migrate:cloudflare:remote -- \
  --confirm-primary contourcast-trips --confirm-bookmark-recorded

export RELEASE_MIGRATION=0017_trip_idempotency.sql
export RELEASE_AUTHORIZATION_FILE=/PRIVATE/ENCRYPTED/PATH/migrate-0017.json
npm run migrate:cloudflare:remote -- \
  --confirm-primary contourcast-trips --confirm-bookmark-recorded

export RELEASE_MIGRATION=0018_ai_review_queue.sql
export RELEASE_AUTHORIZATION_FILE=/PRIVATE/ENCRYPTED/PATH/migrate-0018.json
npm run migrate:cloudflare:remote -- \
  --confirm-primary contourcast-trips --confirm-bookmark-recorded

npm run postflight:cloudflare:remote
```

The postflight must prove the exact full ledger; approval, privacy, species, validation, and
snapshot-suppression schema; all 15 workload-backed data-resilience indexes; the exact nullable
text trip-idempotency column; the exact empty advisory-review job table and its two indexes;
every pre-release trip classified `legacy_unverified`; zero photo
locators; zero discussion approval metadata; zero validation activations/events; and no
foreign-key violations. Preserve its aggregate evidence hash. Once `0011` begins, never route
ordinary traffic to the older safety Worker. On failure, keep the maintenance bridge active
and fix forward from a newly reviewed immutable commit.

After postflight succeeds, run `PRAGMA optimize` as a separate reviewed primary-D1 operation,
then capture the representative `EXPLAIN QUERY PLAN` and rows-read evidence defined in
`docs/PERFORMANCE-READINESS.md`. Do not combine that evidence operation with application deploy.

## 7. Publish the normal release and run live checks

Deploy the same reviewed commit with the checked-in maintenance switch restored to `false`:

```sh
export RELEASE_AUTHORIZATION_FILE=/PRIVATE/ENCRYPTED/PATH/deploy-normal.json
npm run release:cloudflare
./node_modules/.bin/wrangler deployments status --config wrangler.jsonc --json
```

Record the final deployment and version IDs and prove one version has `100%` traffic. Run the
all-host command in [Discussion moderation](DISCUSSION-MODERATION.md) with
`--expected-worker-version-id FINAL_VERSION_ID`. Confirm `/api/health` reports
`releaseMaintenance: false`, every discussion endpoint is empty and non-cacheable, aliases
are exact `308` redirects, protected account mutations enforce the current legal version, and
normal trip start/completion succeeds with the species contract.

Then complete the production-shaped synthetic containment, account deletion/export,
encrypted backup, restore, alerts, edge rate limits, Turnstile default-off/activation, privacy,
and SEO gates in the linked runbooks. Do not enable public discussions, validation activation,
photo uploads, or Turnstile merely because this schema release succeeds.

## Evidence checklist

The private release record must include:

- UTC timestamp and operator; full and safety source commits;
- the private packet and redacted authorization receipt for every exact production action,
  including distinct operator and independent-review evidence;
- automatic-deployment and snapshot-schedule pause evidence;
- safety, maintenance, and final deployment/version IDs plus `100%` traffic observations;
- direct and redirect host lists and every live-verifier result;
- D1 backend information and the pre-mutation Time Travel bookmark;
- initial aggregate preflight output/hash, each reconciliation/migration result, and final
  aggregate postflight output/hash;
- aggregate synthetic, deletion, backup/restore, alert, and rate-limit outcomes required by
  the other P0 runbooks.

Do not include raw production rows or stable user/object identifiers. Re-enable only the
reviewed snapshot schedule after the default branch contains the PR-only workflow. Keep
Cloudflare automatic deployment disabled until an equivalently guarded release system exists.
