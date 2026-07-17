# Key custody and encryption contract

Status: **the repository contract and local controls are reviewed; production account
evidence remains open**. This document inventories names and responsibilities, never secret
values. A passing repository test cannot prove which secret, role, database, or encryption
setting is active in Cloudflare.

## Security boundary

Treat source code, browser state, requests, uploads, provider responses, model inputs and
outputs, logs, dashboards, support records, and release evidence as untrusted destinations for
secret material. Runtime credentials belong in encrypted Cloudflare Worker secret bindings,
not Wrangler `vars`, Git, `.env` or `.dev.vars` files committed to Git, build arguments,
screenshots, logs, issues, analytics, or operator dashboards. Local development may use an
ignored `.dev.vars` file containing non-production values.

Cloudflare documents Worker secrets as encrypted bindings whose values are hidden after entry.
It also documents that ordinary `wrangler secret put` creates and immediately deploys a new
Worker version. Therefore secret changes are production changes and must use the guarded,
immutable release process; they are not an ad hoc dashboard or local-shell operation.

## Runtime secret inventory

This table is the repository-required inventory, not proof that a production binding exists.
Each production and non-production environment needs distinct values and access grants.

| Secret name | Purpose and activation boundary | Expected storage | Missing/invalid behavior | Rotation boundary |
| --- | --- | --- | --- | --- |
| `RESEND_API_KEY` | Transactional account email | Environment-specific Worker secret | Verification email operations return a sanitized unavailable response; optional welcome mail is skipped | Replace through a reviewed Worker version, exercise synthetic delivery, then revoke the old provider credential |
| `TURNSTILE_SECRET_KEY` | Server-side Turnstile verification; `TURNSTILE_ENABLED` remains default-off | Environment- and widget-specific Worker secret | Off means no provider call; enabled but incomplete configuration fails protected account actions closed | Keep enforcement off while staging a replacement, verify exact widget/hostname/action binding, then enable through a separate reviewed release |
| `MIMO_API_KEY` | Optional, bounded advisory trip-review provider | Environment-specific Worker secret | Missing key skips advisory review; provider failures return claimed work to retry without publishing | Replace on a reviewed version, verify redacted failure/retry behavior, then revoke the old credential |
| `OBSERVABILITY_PSEUDONYM_SECRET` | HMAC pseudonymization for short-lived request/session correlation; logging itself remains enabled without it | Environment-specific Worker secret, 32–256 characters, distinct from every other HMAC role | Request logs omit `actor_session_key`; request IDs, normalized route/status/latency, and scheduled events remain available | Rotation intentionally breaks cross-rotation correlation without affecting sessions or authorization; record the boundary and retain no translation table |
| `RATE_LIMIT_KEY_SECRET` | HMAC pseudonymization for request-limit keys; `RATE_LIMITING_ENABLED` remains default-off | Environment-specific Worker secret, 32–256 characters | Off retains durable D1 limits; enabled with a missing or malformed key returns a generic `503` before protected work | Rotation changes every network pseudonym and temporarily resets affected edge counters; coordinate it as a control change, never an authentication-key rotation |
| `VALIDATION_PARTICIPANT_HMAC_SECRET` | Default-off v2 pilot participant pseudonyms | Activation- and environment-specific Worker secret, 32–512 bytes | Missing/invalid material prevents a participant context from being created | Never rotate during an activation: it would split one participant into multiple pseudonyms. Rotate only at a sealed activation boundary unless versioned identifiers and a reviewed migration are implemented first |
| `VALIDATION_RECRUITMENT_HMAC_SECRET` | Default-off v2 pilot recruitment-token signatures | Activation- and environment-specific Worker secret, 32–512 bytes | Missing/invalid material prevents recruitment-token verification | Never rotate during an active campaign: it invalidates outstanding tokens. Use an activation boundary unless versioned signing keys and bounded dual verification are implemented first |

`AUTH_EMAIL_FROM`, `TURNSTILE_SITE_KEY`, `TURNSTILE_ALLOWED_HOSTNAMES`, provider model names,
feature switches, activation commitments, and Worker version metadata are not confidential
keys. They are still integrity-sensitive configuration: review them in an immutable change,
validate exact values, and never let a browser-controlled value authorize server work.

Do not configure every inventory name as globally required in `wrangler.jsonc`. Several
features intentionally default off or are optional. Their server-side activation paths already
fail closed or skip optional work as described above. A future environment-specific
`secrets.required` policy may be added only when it can express these activation boundaries
without breaking safe preview builds.

## Separation rules

- Never reuse material across providers, environments, or purposes.
- Keep the observability and rate-limit pseudonym keys separate from each other and from session
  tokens, validation HMAC keys, provider credentials, deletion receipts, deployment credentials,
  and backup keys.
- Keep the participant and recruitment HMAC keys separate from each other and from every
  activation that follows them.
- Keep the four documented backup key roles distinct: operational D1 snapshot, current
  deletion ledger, validation snapshot, and validation suppression ledger.
- Keep Cloudflare deployment/API credentials separate from Worker runtime secrets. A deploy
  credential must not be readable by the running application.
- Use synthetic, separately scoped credentials in development and staging. Production values
  must never be copied into local development.

## Data encryption boundaries

Cloudflare's D1 documentation states that D1 data is encrypted at rest with Cloudflare-managed
keys and that Worker/D1 and API/Wrangler transfers use TLS. This is managed infrastructure
encryption: the application does **not** implement field-level or end-to-end encryption for D1,
does not hold a customer-managed D1 key, and a correctly authorized Worker can read the fields
it needs. Do not represent managed encryption as protection from a compromised Cloudflare
account or deployed Worker.

The repository's export tooling provides a separate application-controlled boundary for local
operational artifacts: it requires private regular 32-byte key files and private directories,
seals each artifact with AES-256-GCM and a fresh 96-bit nonce, authenticates its header, records
a checksum and retention deadline, and supports isolated restore/deletion replay. The four key
paths in [Validation storage](VALIDATION-STORAGE.md) are deliberately separate. Local tests are
not proof of approved production custody, scheduled capture, recovery, destruction, or a
witnessed restore drill.

Photo upload storage remains disabled, so this contract makes no production R2 or Images
encryption claim. Reassess provider encryption, private-bucket identity, access roles, object
retention, export, deletion, and restore behavior before enabling uploads.

Field-level encryption should be added only for a defined threat model and recovery design.
Putting ciphertext and its decryption key in the same Worker account does not protect against
that Worker or account being compromised and can make deletion, support, indexing, and recovery
less reliable.

## Access, custody, and recovery

Limit Cloudflare account, secret, D1, deployment, and provider access to named roles in the
[access-control matrix](ACCESS_CONTROL_MATRIX.md). Require phishing-resistant MFA where the
provider supports it, least-privilege scoped tokens, short-lived access where practical, and a
separate emergency recovery path. Prefer two named custodians or a custodian plus independent
reviewer for production key generation, rotation, recovery, and destruction.

Custody records may contain the secret name, opaque key/version ID, environment, provider,
owner role, creation/activation/retirement timestamps, reason, and approval evidence. They must
not contain the value. Never paste a value into a password-reset flow, issue, pull request,
chat, alert, analytics event, logging dashboard, or release record.

Backup recovery material must remain available until every artifact encrypted by it has
expired and been deletion-tested or has been verifiably re-encrypted. Destruction requires a
witnessed record that names the key ID and affected retention class, not the bytes. Loss of a
backup key is data loss; unauthorized disclosure is a security incident.

## Reviewed rotation procedure

1. Record the reason, affected environment and feature, owner, reviewer, opaque old/new key
   IDs, rollback boundary, and synthetic acceptance checks without recording either value.
2. Assess semantic impact before changing bytes. Rate-limit rotation resets pseudonyms;
   validation HMAC rotation can break identity continuity or tokens; backup-key rotation must
   preserve decryptability through retention.
3. Stage one replacement at a time in a non-production environment or a reviewed versioned
   secret workflow. Because ordinary `wrangler secret put` immediately deploys a version, do
   not run it outside the immutable release procedure. Never rotate secrets while an unrelated
   migration or emergency fix is being diagnosed.
4. Deploy the exact reviewed Worker version with no schema mutation. Run feature-specific
   synthetic checks and confirm logs, alerts, and dashboards contain only redacted metadata.
5. Revoke the old provider credential only after the new version is healthy and the rollback
   consequence is understood. For a suspected disclosure, revoke first, enter maintenance or
   disable the affected optional feature as needed, and use the incident path.
6. Record activation and revocation timestamps, exact Worker version/deployment evidence, test
   result, and reviewer. Schedule the next exercise; never store a calendar reminder containing
   secret material.

## Production acceptance evidence

Keep this gate open until the account-level evidence exists:

- [ ] Exact secret names exist in the intended environment, with distinct opaque key IDs and
      no values captured in evidence.
- [ ] Named account/provider roles, MFA, scoped deploy access, emergency recovery, and removal
      of stale users/tokens were reviewed.
- [ ] D1 identity and transport/at-rest provider controls were confirmed for the production
      account without claiming field-level or customer-managed encryption.
- [ ] Each enabled feature passed missing-key, valid-key, rotation, provider-revocation, and
      rollback checks on the exact reviewed version; optional/default-off features remain off.
- [ ] Rate-limit and validation rotation consequences were accepted before activation.
- [ ] Backup keys have approved custody, recovery, retention, rotation/destruction records,
      and a witnessed production-shaped restore/deletion-replay drill.
- [ ] Alerts and centralized logs were tested for redaction and cannot expose secret values.

Authoritative provider references:

- [Cloudflare D1 data security](https://developers.cloudflare.com/d1/reference/data-security/)
- [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Cloudflare Workers security best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
