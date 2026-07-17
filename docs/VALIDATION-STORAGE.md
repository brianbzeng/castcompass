# Operational backup and validation-storage boundary

This runbook covers the repository's local encrypted D1 backup and isolated restore-drill
tooling. It does **not** claim that a production backup exists, that production key custody is
approved, or that the v2 feasibility pilot's 730-day validation-snapshot gate has passed.

## Two retention classes must stay separate

The current privacy runbook retains completed deletion tombstones for 90 days. A full D1
export contains account and trip data, so `scripts/validation-storage.mjs` fixes operational
snapshot and preserved-ledger retention at 89 days. The manifest parser rejects a different
value. This keeps an operational copy inside the current tombstone window.

The frozen v2 pilot separately requires daily validation snapshots retained for 730 days.
Extending a full D1 export to 730 days would contradict the current deletion/restore promise.
Therefore this tool records
`validation_snapshot_and_restore_gate_passed: false` even after a successful operational
restore drill.

Before v2 activation, the data steward, privacy reviewer, and legal reviewer must approve a
long-lived validation-only snapshot and deletion-suppression design. It must either retain a
privacy-minimized suppression index for at least as long as every recoverable validation copy,
or make every affected historical snapshot reliably deletable/rekeyable. It must prove that a
deleted participant's rows cannot reappear from any retained copy. Do not solve this by silently
retaining full account exports or raw identifiers for 730 days.

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

## Still required outside the repository

- approve production key generation, custody, rotation, recovery, and destruction;
- create the actual encrypted production artifacts and test their retention deletion;
- record the D1 Time Travel window and keep it shorter than the current tombstone window;
- exercise the drill against a production-shaped non-production target with deleted account,
  trip, discussion, completed object task, and unresolved object task fixtures;
- obtain the required second-person review; and
- separately approve and implement the 730-day validation-only snapshot/suppression policy
  before marking the v2 activation storage gate complete.
