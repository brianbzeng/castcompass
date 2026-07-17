# Privacy durability release gate

The repository implementation separates active-data removal from external-object cleanup.
It is not evidence that the production D1 migration, R2 binding, backup retention, or restore
procedure is live. Keep the parent roadmap item open until the production checks below have
captured aggregate, non-sensitive evidence.

The complete system inventory, cascade map, 30-day-recovery decision boundary, and manual
access/correction/portability/deletion workflow are maintained in
[Data lifecycle and privacy-rights operations](DATA-LIFECYCLE-AND-RIGHTS.md).

## Local contract

- Signup eligibility accepts only a birth date. It stores a short-lived hash and timestamps,
  never the entered date, email, password, or legal choices. A proof is single use.
- An ineligible response sets a bounded first-party marker without age or identity data.
- Account/trip deletion inserts its job and the locators inventoried immediately before it in
  the same D1 batch that removes active rows and linked public discussion copies. Because that
  inventory is not fenced against a concurrent photo write, the Worker independently rejects
  every photo upload unless `TRIP_PHOTO_UPLOADS_ENABLED` is explicitly `true`; production and
  checked-in configuration keep it `false`.
- HTTP `200` means active rows and all known objects are gone. HTTP `202` means active rows are
  gone while object cleanup is processing or needs attention.
- Completed tasks erase their plaintext object locator. Pseudonymous completed tombstones
  outlive the permitted backup window; unresolved tasks remain until resolved.
- Authenticated account deletion automatically requeues that account's earlier
  `needs_attention` photo tasks, preserving cumulative attempts, so the account job and prior
  trip job can each perform an idempotent, lease-owned delete. This is the bounded exception
  to operator-only requeue; no anonymous or unrelated job can trigger it.
- The browser receipt can read only aggregate status and can be dismissed without deleting
  the server-side tombstone.

## Migration sequence

Migration `0010_privacy_durability.sql` is part of the authoritative
[integrated production release](INTEGRATED-RELEASE.md). Use its immutable release verifier,
read-only aggregate preflight, Time Travel evidence, explicit `0007` reconciliation, and
one-file migration wrapper. Do not run raw `wrangler d1 migrations apply`, and do not pass a
read-only audit to Wrangler with `--file`: remote D1 returns a batch summary instead of the
selected rows. Record aggregate output only.

The integrated preflight captures the six application row counts, missing-age and
legal-acceptance cohorts, zero-photo invariant, schema boundary, and foreign-key state before
any mutation. Its final postflight covers the accumulated approval, privacy, species, and
validation release. Before rollout, record an explicit support or
migration decision for every aggregate cohort with no retained age confirmation; those
accounts will be paused, but export and deletion remain available without reacceptance.
A fresh migration must report 6 age-proof columns, 13 deletion-job columns, 13
deletion-task columns, one owner lookup index, exactly one `trips.user_id` → `users.id`
foreign key with `ON DELETE SET NULL`, zero new-table rows, zero forbidden age/identity
columns, and zero foreign key violations. Remote D1 does not authorize
`PRAGMA integrity_check`; the complete migration chain and isolated restore must report
`integrity_check = ok` in local/restore verification. Stop on any mismatch.

## Production behavior checks

- Invalid, future, underage, expired, and replayed age attempts create no user, email
  challenge, or provider request. The underage marker expires within 24 hours.
- An eligible proof expires after 10 minutes and can authorize only one credentials-stage
  attempt. The legal version stored on the account matches the public document version.
- Deletion fixtures cover zero photos, a successful object delete, transient retry, exhausted
  retry, missing/wrong binding, a prior pending trip-photo task, and linked public discussion
  rows. Never use a real person's record as a synthetic test fixture.
- Verify every photo locator against the intended private bucket. A successful delete against
  an empty or wrong bucket is not evidence that the correct object was removed.
- Alert on aged `processing` using `requested_at`, and alert on every `needs_attention` job,
  without including object keys, receipt hashes, subject hashes, emails, trip notes, or account
  identifiers. `updated_at` is a reconciliation heartbeat and must not be used as deletion age.
- Populate an export fixture and verify account/consent data, saved sites, gear, full trip
  fields, discussion linkage, secret-field exclusion, photo manifest truthfulness, and the
  bytes/content type of each advertised photo download.
- Exercise AI-review/deletion interleavings on both sides of the final tombstone check. A
  deletion committed before review authorization must prevent provider dispatch. A review
  authorized first may finish at the processor, but a late response must write zero trip rows
  and zero public posts after deletion. This is the dispatch linearization point; do not claim
  that deletion can recall an already authorized external request.

## `needs_attention` operator procedure

Treat `needs_attention` as an unresolved deletion, not as a completed request. Keep the
receipt endpoint available, retain the task indefinitely, and page the named privacy
operator. Never copy an object locator, receipt hash, subject hash, email, trip note, or
account identifier into a ticket, terminal transcript, or alert.

1. Verify the immutable release commit and confirm that `TRIP_PHOTOS` is bound to the exact
   intended private bucket. Compare the binding and bucket identity with the release record;
   an empty or similarly named bucket is not sufficient.
2. List only bounded, pseudonymous job metadata from the remote database:

   ```sql
   SELECT id, scope, state, objects_total, objects_deleted, last_error_code,
          requested_at, updated_at
   FROM privacy_deletion_jobs
   WHERE state = 'needs_attention'
   ORDER BY requested_at ASC
   LIMIT 50;
   ```

3. For one selected job ID, inspect aggregate task state only:

   ```sql
   SELECT state, last_error_code, COUNT(*) AS task_count
   FROM privacy_deletion_tasks
   WHERE job_id = 'REPLACE_WITH_ONE_JOB_ID'
   GROUP BY state, last_error_code;
   ```

4. Correct the binding or transient storage incident first. Then requeue only unresolved
   tasks belonging to that one still-open job. Run this through the reviewed D1 operations
   path and have a second operator verify the job ID and affected-row count before execution:

   ```sql
   UPDATE privacy_deletion_tasks
   SET state = 'pending', available_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       lease_expires_at = NULL, lease_token = NULL, last_error_code = NULL,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE job_id = 'REPLACE_WITH_ONE_JOB_ID'
     AND state = 'needs_attention'
     AND object_key IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM privacy_deletion_jobs
       WHERE id = 'REPLACE_WITH_ONE_JOB_ID' AND state = 'needs_attention'
     );
   ```

5. Let the scheduled worker perform the delete. Do not manually mark a task complete merely
   because an object is absent from an unverified bucket. Confirm that every task for the job
   is `completed`, every plaintext locator is `NULL`, and the parent job is `completed`:

   ```sql
   SELECT j.id, j.state, j.objects_total, j.objects_deleted,
          SUM(CASE WHEN t.state = 'completed' THEN 1 ELSE 0 END) AS completed_tasks,
          SUM(CASE WHEN t.object_key IS NOT NULL THEN 1 ELSE 0 END) AS retained_locators
   FROM privacy_deletion_jobs AS j
   LEFT JOIN privacy_deletion_tasks AS t ON t.job_id = j.id
   WHERE j.id = 'REPLACE_WITH_ONE_JOB_ID'
   GROUP BY j.id, j.state, j.objects_total, j.objects_deleted;
   ```

The retry counter is cumulative and must not be reset by this procedure. If requeue returns
zero rows or the job does not close, stop and investigate the reviewed Worker logs using error
codes only. Do not delete the tombstone, lower the retry evidence, or issue a replacement
receipt to make the queue appear healthy.

## Restore invariant

Before any restore, stop writes, preserve the current deletion ledger outside the restore
target, restore only in isolation, replay current account/trip tombstones and unresolved
tasks, and prove no deleted row or public copy can serve. The maximum recoverable backup and
Time Travel window must remain shorter than the 90-day completed-tombstone retention. Follow
the evidence and second-person-review requirements in `docs/PRODUCTION-OPERATIONS.md`.

Photo uploads remain disabled in the reviewed production build, including a server-side gate
that defaults off. Do not enable them until the private bucket binding, object inventory,
retry alert, export, deletion, orphan-upload cleanup, and R2 restore/deletion drill have all
passed. Before the first enablement, account deletion must establish a D1-serialized write
fence before taking its photo inventory so an upload/attach request cannot commit a new R2
locator between inventory and active-row removal. Cleanup must also be bounded below the
deployed Cloudflare plan's D1-query and subrequest limits, or the release record must include
reviewed evidence that its plan safely covers the worst case.
