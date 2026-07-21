# Asynchronous privacy exports

## Current truth

The repository contains a complete, default-off asynchronous packaging path. Production does
not have a checked-in `PRIVACY_EXPORT_QUEUE` producer, Queue consumer, or `PRIVACY_EXPORTS` R2
binding, and `PRIVACY_EXPORT_QUEUE_ENABLED=false`. Local tests are not provider or deployment
evidence. Until a separately reviewed activation passes every gate below, the profile control
falls back to the existing authenticated direct JSON response.

The asynchronous path is a portability mechanism, not a new retention source. It never limits
account-linked rows to product/UI ceilings. Photos remain separate authenticated downloads; the
packaged JSON contains only their manifest.

## Frozen contract

- `POST /api/profile/export` is same-origin, owner-authenticated, and sensitive-rate-limited. It
  creates or returns the one active job for that account.
- Queue messages validate against
  `contracts/privacy-export-queue-message.schema.json` and contain exactly `version` and an
  opaque `pexj_…` job ID. No account ID, email, trip, note, object locator, or export content is
  placed on the Queue.
- D1 `privacy_export_jobs` is authoritative for ownership, attempts, leases, completion,
  expiry, content digest, and object cleanup. Queue delivery is only a wake-up signal.
- The consumer packages the complete authenticated dataset off the request path, checks photo
  availability with concurrency four, reserves a unique lease-scoped locator in D1, writes JSON
  to the private `PRIVACY_EXPORTS` bucket, then conditionally commits completion only while it
  still owns the same account/job lease. A stale attempt can never delete the newer attempt's
  object; every failed uncommitted-object cleanup retains its own attention-ledger locator.
- `GET /api/profile/exports/{jobId}` and `/download` bind both the authenticated account and the
  opaque job ID. Before streaming, the download fails closed unless the D1 locator hash and exact
  byte count match the private object and its immutable upload SHA-256 and contract metadata match
  the D1 completion record. Downloads are `private, no-store`, attachment-only JSON responses.
- Completed files expire after 24 hours. Cleanup claims at most 50 objects per scheduled pass,
  removes the private object, clears its locator/digest/size/count, and retains only an expired
  tombstone until the ordinary 90-day ledger cleanup.
- Account deletion cancels export jobs in the same D1 batch that removes active account access.
  Already committed export objects become typed tasks in the durable deletion ledger. If
  deletion wins between the consumer's object write and D1 completion, the consumer deletes the
  uncommitted object; a failed delete persists the locator in `needs_attention` for retry.
- Application attempts stop at five. Provider delivery must additionally use the locked batch,
  concurrency, retry, and dead-letter limits in
  `security/privacy-export-queue-policy.json`.
- Maintenance mode stops backlog dispatch and defers Queue work. An invalid feature flag or
  incomplete binding set fails closed.

## Activation gate

Keep the feature off unless all items are independently reviewed on one immutable release
commit:

- [ ] Apply `0019_async_privacy_exports.sql` through the guarded maintenance release before
      adding either provider binding. Postflight must prove the empty table, five indexes,
      deletion-task storage class, integrity check, and exact ordered migration ledger.
- [ ] Create one private R2 bucket with no public development URL or custom domain. Record bucket
      identity, environment, IAM roles, retention/lifecycle defense, encryption boundary, cost
      limit, and deletion procedure privately without recording an object key.
- [ ] Create the producer/consumer Queue and dead-letter Queue with batch size 5, batch timeout
      10 seconds, eight provider retries, concurrency 1, and a delivery/retention window that
      fits the documented incident response. Record exact binding identities privately.
- [ ] Deploy the bindings with `PRIVACY_EXPORT_QUEUE_ENABLED=false`. Confirm the existing direct
      export still works, status paths remain owner-only, account deletion sees both storage
      classes, and no provider message or export object is created while disabled.
- [ ] In isolated production-shaped staging, package a fixture above current saved-site/gear UI
      ceilings and prove every row appears. Capture aggregate rows read/written, CPU, duration,
      object bytes, Queue age/retries, and cost without retaining the export or identifiers.
- [ ] Exercise duplicate delivery, poison messages, publish failure, consumer exception, lease
      expiry during an object write, overlapping stale/current attempts, worker restart,
      maintenance deferral, DLQ delivery, replay, missing/wrong bucket, exact 24-hour expiry, and
      cleanup retry exhaustion.
- [ ] Exercise deletion before packaging, during D1 reads, after object write, after completion,
      and during expiry cleanup. Each case must end with no downloadable object and either a
      completed deletion task or a locator-preserving attention record.
- [ ] Prove another authenticated account receives the same generic not-found result for both
      status and download; inspect logs/alerts to confirm no account ID, email, job ID, object key,
      or export content appears.
- [ ] Configure and deliver alerts for aged pending/queued/processing jobs, every
      `needs_attention` job, DLQ depth, object-delete failures, Queue failures, R2 errors, and
      unexpected object/ledger inventory differences.
- [ ] Run the protected release suite, dependency review, CodeQL, release provenance, and an
      isolated smoke/load test at the exact candidate commit. Keep production untouched.
- [ ] Only then use a separate reviewed release to set the flag to exact lowercase `true`.
      Re-run owner export, expiry, account deletion, alert delivery, cost, and rollback checks on
      that exact deployed version before normal beta traffic uses the path.

## Rollback and containment

Return the flag to `false` through the guarded release path. This restores the authenticated
direct JSON response and stops new jobs/backlog dispatch. Do not remove the R2 or Queue bindings
while any job has an object locator or any deletion task has `object_store=privacy_exports`.
Drain or preserve those ledgers first. During an incident, maintenance mode defers consumers;
it does not authorize deleting evidence, acknowledging unknown private work, or bypassing
account deletion.
