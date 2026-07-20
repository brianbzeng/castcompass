# Independent review of the operational restore drill

The repository-controlled synthetic restore/deletion-replay drill produces a private,
aggregate-only three-file packet. This runbook lets a genuinely independent second person
review that packet and create a source-bound record without adding reviewer identity, raw
evidence, provider identifiers, user data, or secrets to Git.

This process reviews only the synthetic, production-shaped non-production drill. It does not
approve production key custody, verify a current production backup or deletion ledger, prove a
Cloudflare deployment, authorize a production change, or satisfy the complete restore gate.

## Separation and storage boundary

The drill operator and independent reviewer must be different people. The verifier can enforce
the required role label, file separation, timestamps, and a signed checklist assertion; it
cannot prove human identity or independence. Preserve that identity/separation evidence in the
private release record under the owner's access policy.

Keep all material on an encrypted, access-restricted volume outside every repository checkout:

- The immutable packet directory must be owner-only (`0700`) and contain exactly
  `acceptance-record.json`, `operational-restore-evidence.json`, and `storage-audit.ndjson`.
- Each packet file and the separate review record must be a regular, owner-readable file with
  no group/other access (`0600`), no hard link, and no symbolic link.
- Store the review record outside the immutable packet directory. Store the human review notes
  separately; the JSON contains only their SHA-256 digest.
- Never paste the packet, review record, reviewer identity, private note, key, provider output,
  or filesystem path into Codex, a pull request, an issue, chat, or analytics.

## Reviewer procedure

1. Receive the expected 40-character source commit through a channel independent of the
   packet. For the accepted 2026-07-18 synthetic drill, the recorded source commit is
   `0542074ce681c2fbecbe6ea93ffc443c276b6a7a`; confirm it against the protected repository
   history rather than copying it from the packet alone.
2. Review the aggregate acceptance, restore evidence, and audit chain. Confirm that the packet
   contains no user, trip, photo, precise-location, credential, prompt, provider, or raw-log
   content and that every limitation is understood.
3. Preserve the signed review note privately and compute its SHA-256 digest. The digest must be
   distinct from every packet digest; the note itself never enters the JSON or public receipt.
4. Create a lowercase UUIDv4 and an exact review JSON using the field order below. Use a UTC
   timestamp with milliseconds no later than seven days after the drill. Do not reuse the drill
   operator's evidence or simply assert values to make the verifier pass.
5. Run the verifier. Treat success as acceptance of this review record only, then preserve the
   minimized stdout receipt with the private release record after checking it again for
   disclosure.

```json
{
  "schema_version": "castingcompass.operational-restore-independent-review/1.0.0",
  "review_id": "REPLACE_WITH_LOWERCASE_UUIDV4",
  "packet_source_commit": "REPLACE_WITH_EXPECTED_FULL_COMMIT",
  "packet_acceptance_sha256": "REPLACE_WITH_ACCEPTANCE_FILE_SHA256",
  "packet_restore_evidence_sha256": "REPLACE_WITH_RESTORE_EVIDENCE_FILE_SHA256",
  "packet_storage_audit_sha256": "REPLACE_WITH_STORAGE_AUDIT_FILE_SHA256",
  "reviewed_at": "REPLACE_WITH_UTC_TIMESTAMP_WITH_MILLISECONDS",
  "reviewer_role": "independent_reviewer",
  "reviewer_was_not_drill_operator": true,
  "review_checklist": {
    "acceptance_boundaries_understood": true,
    "aggregate_only_evidence_confirmed": true,
    "no_production_authority_granted": true,
    "packet_integrity_confirmed": true,
    "source_binding_confirmed": true
  },
  "review_evidence_sha256": "REPLACE_WITH_DISTINCT_PRIVATE_REVIEW_NOTE_SHA256"
}
```

The machine contract is
[`contracts/operational-restore-independent-review.schema.json`](../contracts/operational-restore-independent-review.schema.json),
and the locked policy is
[`security/operational-restore-review-policy.json`](../security/operational-restore-review-policy.json).
The executable verifier additionally enforces canonical JSON, duplicate-key rejection, exact
packet contents, byte digests, audit event identity and strict chronology, the audit hash chain,
the independently supplied commit, review timing, the complete checklist, private file
permissions/ownership, and disclosure-minimized output.

## Verification command

From a reviewed CastingCompass checkout, set only paths to the private material and the
independently confirmed source commit:

```sh
export RESTORE_PACKET_DIRECTORY=/PRIVATE/ENCRYPTED/PATH/packet
export RESTORE_REVIEW_FILE=/PRIVATE/ENCRYPTED/PATH/independent-review.json
export RESTORE_EXPECTED_SOURCE_COMMIT=FULL_40_CHARACTER_SOURCE_COMMIT
npm run verify:operational-restore-review
```

The verifier makes no network, Cloudflare, D1, R2, deployment, migration, or write request. It
emits one public-safe JSON receipt to stdout. That receipt deliberately excludes the review ID,
review-note digest, audit head, audit-file digest, activation ID, runtime/platform details,
provider identity, and private paths. It also fixes all of these fields to `false`:

- `production_key_custody_approved`
- `production_provider_evidence_verified`
- `production_restore_gate_passed`
- `production_release_authorized`

After a real accepted review, update only the owner dashboard and protected review evidence.
Do not edit the original packet to change its `second_person_reviewed: false` boundary; the
separate receipt is the append-only evidence that a later review record was accepted.

## Remaining production work

Even after this review succeeds, production hardening remains blocked on approved key custody,
a recent real encrypted export and current deletion ledger, provider/source binding, guarded
migrations and deployment, live maintenance and normal-host verification, alert delivery,
rate-limit and Turnstile evidence, and a witnessed restore/recovery acceptance. Follow
[`PRODUCTION-OPERATIONS.md`](PRODUCTION-OPERATIONS.md) and
[`INTEGRATED-RELEASE.md`](INTEGRATED-RELEASE.md); never use this synthetic review as a substitute.
