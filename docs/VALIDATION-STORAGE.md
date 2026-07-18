# Operational backup and validation-storage boundary

This runbook covers the repository's local encrypted D1 backup, privacy-replay, and
validation-only restore-drill tooling. It does **not** claim that a production backup exists,
that production key custody is approved, that the 730-day policy has governance approval, or
that the v2 feasibility pilot's storage activation gate has passed.

## Two retention classes must stay separate

The current privacy runbook retains completed deletion tombstones for 90 days. A full D1
export contains account and trip data, so `scripts/validation-storage.mjs` fixes operational
snapshot and preserved-ledger retention at 89 days. The manifest parser rejects a different
value. This keeps an operational copy inside the current tombstone window.

The frozen v2 pilot separately requires daily validation snapshots retained for 730 days.
Extending a full D1 export to 730 days would contradict the current deletion/restore promise.
The tool therefore has a separate 730-day artifact class containing only the sealed activation,
campaign provenance, privacy-minimized recruitment/events/corrections, aggregate removal
ledgers, and opaque deletion-suppression digests. It excludes account IDs, email, credentials,
object locators, receipts, notes, photos, IP/user-agent data, and coordinates. The manifest and
artifact parsers reject an 89-day/730-day class substitution.

Migration `0015_validation_snapshot_suppression.sql` supplies opaque, immutable suppression
records when a recruitment or validation event is deleted. A current suppression artifact is
cumulative and retained for the same 730 days. The local validation drill authenticates both
artifacts, verifies every frozen event hash, rejects non-cumulative or mismatched suppression
records, removes matching recruitment/events and their corrections, reconciles current
aggregate removals, computes no candidate performance, and emits aggregate-only evidence.

This is a tested technical candidate, not an approved policy. Before v2 activation, the data
steward, privacy reviewer, and legal reviewer must decide whether retaining these encrypted,
privacy-minimized validation rows and suppression digests for 730 days is compatible with the
study notice, deletion promise, key custody, access model, and incident response. Do not solve
this by silently retaining full account exports or broader account data for 730 days.

## Local cryptographic contract

The tool:

- requires a regular 32-byte random key file and input/output directories inaccessible to
  group or other users;
- encrypts with AES-256-GCM using a fresh 96-bit nonce and authenticates the complete header;
- writes an atomic private manifest with the encrypted artifact's SHA-256 checksum, byte count,
  key ID, creation time, and fixed retention deadline;
- requires explicit plaintext deletion after sealing and never records plaintext content or
  identifiers in evidence;
- maintains a private, verified hash-chained operator-role audit log; and
- fails on checksum, authentication, schema, foreign-key, validation-ledger integrity, audit
  chain, or privacy-replay errors.

The local audit chain detects mutation and broken chronology, but it is not an independent
timestamp or third-party publication receipt. Store it in an access-controlled location,
archive the reviewed evidence, and require the second-person review described in
`docs/PRODUCTION-OPERATIONS.md`.

## Seal an operational D1 export

Use the repository-pinned Wrangler from a verified release checkout. The plaintext path must
be on an encrypted, private volume and outside repositories and cloud-sync folders.

```sh
umask 077
openssl rand -out /PRIVATE/KEY-CUSTODY/castingcompass-d1.key 32

WRANGLER_LOG_PATH=/PRIVATE/OPERATIONS/wrangler.log \
  ./node_modules/.bin/wrangler d1 export contourcast-trips --remote \
  --config wrangler.jsonc --output /PRIVATE/OPERATIONS/castingcompass-d1.sql

node scripts/validation-storage.mjs seal-snapshot \
  --input /PRIVATE/OPERATIONS/castingcompass-d1.sql \
  --artifact /PRIVATE/OPERATIONS/castingcompass-d1.ccv2 \
  --manifest /PRIVATE/OPERATIONS/castingcompass-d1.manifest.json \
  --key-file /PRIVATE/KEY-CUSTODY/castingcompass-d1.key \
  --key-id REPLACE_WITH_APPROVED_KEY_ID \
  --activation-id REPLACE_WITH_ACTIVATION_OR_RELEASE_SCOPE \
  --audit-log /PRIVATE/OPERATIONS/storage-audit.ndjson \
  --operator-role data-steward \
  --destroy-plaintext
```

The tool unlinks the plaintext only after the encrypted artifact, manifest, and audit event are
durable. Storage-platform secure-deletion limitations still apply. If any step fails, treat a
remaining plaintext file as sensitive and resolve it immediately.

## Preserve the current deletion ledger before restore

Stop writes and deletion workers first. Export the current database separately, then extract
and seal only the current deletion jobs/tasks. The temporary full export is removed after the
minimized ledger artifact is encrypted.

```sh
WRANGLER_LOG_PATH=/PRIVATE/OPERATIONS/wrangler.log \
  ./node_modules/.bin/wrangler d1 export contourcast-trips --remote \
  --config wrangler.jsonc --output /PRIVATE/OPERATIONS/current-before-restore.sql

node scripts/validation-storage.mjs seal-ledger \
  --input /PRIVATE/OPERATIONS/current-before-restore.sql \
  --artifact /PRIVATE/OPERATIONS/current-ledger.ccv2 \
  --manifest /PRIVATE/OPERATIONS/current-ledger.manifest.json \
  --key-file /PRIVATE/KEY-CUSTODY/castingcompass-ledger.key \
  --key-id REPLACE_WITH_APPROVED_LEDGER_KEY_ID \
  --activation-id REPLACE_WITH_ACTIVATION_OR_RELEASE_SCOPE \
  --audit-log /PRIVATE/OPERATIONS/storage-audit.ndjson \
  --operator-role privacy-reviewer \
  --destroy-plaintext
```

The ledger artifact remains sensitive because unresolved object tasks retain private object
locators. Keep its key separately custodied and never attach the artifact or decrypted rows to
an issue, pull request, dashboard, or release record.

## Run the isolated restore/deletion-replay drill

The work parent must be a private directory on an encrypted local volume. The tool creates a
uniquely named child, restores there, replaces the restored privacy ledger with the preserved
current ledger, suppresses resurrected account/trip/discussion data, runs integrity and foreign-
key checks, verifies the v2 ledger without computing candidate performance, and removes the
isolated database before writing aggregate evidence.

```sh
node scripts/validation-storage.mjs restore-drill \
  --activation-id REPLACE_WITH_ACTIVATION_OR_RELEASE_SCOPE \
  --snapshot-artifact /PRIVATE/OPERATIONS/castingcompass-d1.ccv2 \
  --snapshot-manifest /PRIVATE/OPERATIONS/castingcompass-d1.manifest.json \
  --snapshot-key-file /PRIVATE/KEY-CUSTODY/castingcompass-d1.key \
  --ledger-artifact /PRIVATE/OPERATIONS/current-ledger.ccv2 \
  --ledger-manifest /PRIVATE/OPERATIONS/current-ledger.manifest.json \
  --ledger-key-file /PRIVATE/KEY-CUSTODY/castingcompass-ledger.key \
  --audit-log /PRIVATE/OPERATIONS/storage-audit.ndjson \
  --work-parent /PRIVATE/RESTORE-DRILL \
  --evidence /PRIVATE/OPERATIONS/restore-evidence.json \
  --operator-role data-steward \
  --destroy-restored

node scripts/validation-storage.mjs verify-audit \
  --audit-log /PRIVATE/OPERATIONS/storage-audit.ndjson
```

The evidence file contains aggregate counts and checksums only. A named second reviewer must
verify the source manifests, key-custody record, retention deadline, empty work directory,
aggregate evidence, and audit head before the operational restore drill is accepted.

### Reproduce the synthetic non-production acceptance drill

The repository also provides a production-shaped synthetic fixture for an offline technical
acceptance drill. It creates a restored account, trip, public discussion, validation rows, and
both pending and completed object-deletion tasks; seals the snapshot and a newer current
privacy ledger with separate ephemeral keys; proves tampered-artifact and wrong-key rejection;
replays deletion suppression; checks SQLite integrity and foreign keys; then destroys every
plaintext source, key, encrypted fixture artifact, and restored database. Only three private,
aggregate-only files remain: restore evidence, the hash-chained audit log, and an acceptance
record. The runner refuses a dirty checkout or a `HEAD` that differs from `--source-commit`.

Run it from an exact committed checkout into a new output directory outside the repository:

```sh
umask 077
npm run drill:restore:offline -- \
  --output-directory "$HOME/.local/share/castingcompass/release-evidence/UTC-restore-drill" \
  --source-commit "$(git rev-parse HEAD)"
```

The acceptance record deliberately keeps `production_data_used`,
`production_provider_accessed`, `production_key_custody_approved`,
`second_person_reviewed`, and `production_restore_gate_passed` false. This drill proves the
repository-controlled offline mechanism only. It does not restore the real encrypted
pre-release backup, replace a current production deletion-ledger export, approve key custody,
or satisfy the separate 730-day validation-snapshot governance gate. A reviewer must verify
the exact source commit and file hashes before accepting even this non-production receipt.

## Exercise the 730-day validation-only technical candidate

Do not run this workflow against production until migration `0015` is applied and the data
steward, privacy reviewer, and legal reviewer approve the policy and key/access controls. The
commands below document the tested operator interface; they do not grant that approval.

For each required daily recovery point, export D1 to a private temporary file and immediately
seal only the requested activation's validation projection:

```sh
WRANGLER_LOG_PATH=/PRIVATE/OPERATIONS/wrangler.log \
  ./node_modules/.bin/wrangler d1 export contourcast-trips --remote \
  --config wrangler.jsonc --output /PRIVATE/OPERATIONS/validation-snapshot-source.sql

node scripts/validation-storage.mjs seal-validation-snapshot \
  --input /PRIVATE/OPERATIONS/validation-snapshot-source.sql \
  --artifact /PRIVATE/OPERATIONS/validation-snapshot.ccv2 \
  --manifest /PRIVATE/OPERATIONS/validation-snapshot.manifest.json \
  --key-file /PRIVATE/KEY-CUSTODY/validation-snapshot.key \
  --key-id REPLACE_WITH_APPROVED_VALIDATION_KEY_ID \
  --activation-id REPLACE_WITH_SEALED_V2_ACTIVATION_ID \
  --audit-log /PRIVATE/OPERATIONS/storage-audit.ndjson \
  --operator-role data-steward \
  --destroy-plaintext
```

Immediately before a restore drill, export the current D1 state separately and seal its
cumulative opaque suppressions plus current aggregate removal ledgers. The temporary full
export is deleted after the minimized artifact is durable:

```sh
WRANGLER_LOG_PATH=/PRIVATE/OPERATIONS/wrangler.log \
  ./node_modules/.bin/wrangler d1 export contourcast-trips --remote \
  --config wrangler.jsonc --output /PRIVATE/OPERATIONS/validation-suppression-source.sql

node scripts/validation-storage.mjs seal-validation-suppression \
  --input /PRIVATE/OPERATIONS/validation-suppression-source.sql \
  --artifact /PRIVATE/OPERATIONS/validation-suppression.ccv2 \
  --manifest /PRIVATE/OPERATIONS/validation-suppression.manifest.json \
  --key-file /PRIVATE/KEY-CUSTODY/validation-suppression.key \
  --key-id REPLACE_WITH_APPROVED_SUPPRESSION_KEY_ID \
  --activation-id REPLACE_WITH_SEALED_V2_ACTIVATION_ID \
  --audit-log /PRIVATE/OPERATIONS/storage-audit.ndjson \
  --operator-role privacy-reviewer \
  --destroy-plaintext

node scripts/validation-storage.mjs restore-validation-drill \
  --activation-id REPLACE_WITH_SEALED_V2_ACTIVATION_ID \
  --snapshot-artifact /PRIVATE/OPERATIONS/validation-snapshot.ccv2 \
  --snapshot-manifest /PRIVATE/OPERATIONS/validation-snapshot.manifest.json \
  --snapshot-key-file /PRIVATE/KEY-CUSTODY/validation-snapshot.key \
  --suppression-artifact /PRIVATE/OPERATIONS/validation-suppression.ccv2 \
  --suppression-manifest /PRIVATE/OPERATIONS/validation-suppression.manifest.json \
  --suppression-key-file /PRIVATE/KEY-CUSTODY/validation-suppression.key \
  --audit-log /PRIVATE/OPERATIONS/storage-audit.ndjson \
  --evidence /PRIVATE/OPERATIONS/validation-restore-evidence.json \
  --operator-role data-steward \
  --destroy-restored
```

Successful local evidence sets `technical_validation_snapshot_restore_passed: true`,
`candidate_performance_computed: false`, and `governance_approval_recorded: false`. It keeps
`validation_snapshot_and_restore_gate_passed: false` until the external approvals, production
configuration, and witnessed production-shaped acceptance drill are complete. Never publish
the encrypted artifacts, manifests, audit log, or raw validation rows.

## Acceptance status and work still required outside the repository

- approve production key generation, custody, rotation, recovery, and destruction;
- create the actual encrypted production artifacts and test their retention deletion;
- record the D1 Time Travel window and keep it shorter than the current tombstone window;
- [x] Exercise the repository-controlled drill against a production-shaped synthetic non-
  production target with deleted account, trip, discussion, completed object task, and
  unresolved object task fixtures. Clean source commit
  `0542074ce681c2fbecbe6ea93ffc443c276b6a7a`; private packet time
  `2026-07-18T06:24:47.211Z`; restore-evidence SHA-256
  `585a156ecbec933c6cdb485340bd04f802be4781d8a0e2bd6a54668c59c309d8`; audit head
  `ff60f51a34be01d73dfc2a8182d174d4386e6bf03ede2ad71fdf0365d7f5b96c`.
- obtain the required second-person review;
- approve the 730-day validation-only snapshot/suppression policy and production controls;
- create and retention-test actual 730-day validation artifacts with separately custodied keys;
- schedule and monitor daily snapshot/suppression capture, missed-run alerts, and expiration;
- witness a production-shaped validation restore/deletion-replay drill and archive its reviewed
  aggregate evidence before marking the v2 activation storage gate complete.
