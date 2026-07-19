# CastingCompass data lifecycle and privacy-rights operations

Status: locally verified engineering baseline; not legal advice or production evidence
Last reviewed: 2026-07-18

This document is the cascade map and operator procedure for access, portability,
correction, restriction/objection, and deletion requests. It covers the current repository
contract. It does not prove that a production migration, provider request, backup deletion,
or jurisdiction-specific legal review has happened.

## Decisions that must remain explicit

- Account deletion removes active data immediately. CastingCompass does **not** currently
  keep a recoverable account copy or offer a 30-day account-recovery window.
- The 30-day deletion receipt is an aggregate cleanup-status credential, not a login token,
  archive, undo feature, or soft-deleted account. Dismissing it does not cancel cleanup.
- Completed pseudonymous deletion tombstones remain for about 90 days so a shorter-lived
  backup cannot silently restore deleted data. Unresolved object-cleanup work remains until
  it is actually resolved.
- If a future product decision offers recovery, it requires privacy/counsel review, updated
  public terms, a new legal version, immediate session revocation, isolation from every
  active/public/model path, an erasure bypass, automatic hard deletion at day 30, processor
  handling, and restore tests. Do not repurpose the current deletion ledger as recovery data.
- Browser flags, client-side roles, local storage, model output, and submitted account IDs do
  not grant access. The server-side session and same-statement ownership predicates in
  [the access-control matrix](ACCESS_CONTROL_MATRIX.md) remain authoritative.

## System inventory and cascade map

The inventory distinguishes active personal data from operational evidence that must outlive
active-row deletion for security, object cleanup, or restore suppression. Any new table,
object store, analytics event, log field, provider, export, or derived artifact must be added
here before activation.

| System or data | Contents and owner | Retention | Account/trip deletion behavior |
| --- | --- | --- | --- |
| `users` | Email, password hash/salt, legal and age-eligibility state | Until account deletion | Deleted last inside the account-deletion D1 batch after dependent active rows are removed |
| `auth_sessions` | Hashed opaque session tokens and expiry | Up to 30 days; expired rows cleaned periodically | `ON DELETE CASCADE` from `users`; also explicitly deleted in the account batch and revoked on password reset/logout as applicable |
| `saved_sites` and `gear_profiles` | Account-owned preferences and gear presets | Until owner removes them or deletes the account | Owner predicates on ordinary routes; explicitly deleted in the account batch and backed by `ON DELETE CASCADE` |
| `email_challenges` | Verification/recovery state, bounded attempt metadata, and optional account reference | Short-lived challenge plus cleanup buffer | Explicitly deleted by email/account in the account batch; account reference also has `ON DELETE CASCADE` |
| `auth_attempts` | Pseudonymous email hash and failed-login timing | Up to about 30 days | Explicitly deleted using a server-derived email hash in the account batch; otherwise periodic expiry |
| `signup_age_proofs` | One-use, short-lived eligibility token hash with no birth date, email, account ID, or age | Ten-minute use window plus about a 24-hour cleanup buffer | Not account-linkable; expires independently and is removed by scheduled cleanup |
| `trips` | Account-owned trip time/site, effort, catch, gear, notes, moderation/AI state, optional private photo locator, and a one-way idempotency-secret hash | Until owner deletion, subject to pending-only edit/delete rules | Account deletion explicitly removes `WHERE user_id = authenticated user`; trip deletion binds both trip and owner. The user foreign key is `SET NULL` for database compatibility, so the explicit owner-scoped delete and its regression tests are mandatory. The hash can return an existing write receipt but cannot authenticate an account session |
| `site_discussion_posts` | Human-approved public summary linked to a trip | While the approved source trip remains eligible | Explicitly removed before account/trip deletion and also `ON DELETE CASCADE` from `trips`; raw notes are never the public projection |
| `forecast_impressions` and `trip_validation_provenance` | Versioned forecast/validation evidence linked to a trip | While the linked active trip remains, unless a separately approved validation artifact applies | `ON DELETE CASCADE` from `trips`; provenance also cascades with its linked impression |
| `validation_feasibility_events` and `validation_feasibility_corrections` | Default-off pilot events/corrections tied to a trip | Active pilot record while the source trip remains | `ON DELETE CASCADE` from `trips`; delete guards allow removal only through trip privacy deletion, then aggregate removal and immutable snapshot-suppression triggers run |
| `validation_feasibility_recruitment_events` | Default-off pilot recruitment provenance tied to an account | Active pilot record while the account remains | `ON DELETE CASCADE` from `users`; a delete guard allows removal only through account privacy deletion, then aggregate removal and immutable snapshot-suppression triggers run |
| `validation_feasibility_activations` and `validation_feasibility_recruitment_campaigns` | Governance configuration with no browser-granted authority | Immutable/restricted according to the validation contract | Not deleted as account data; they identify the protocol/campaign rather than an account and are protected from ordinary mutation |
| `validation_feasibility_privacy_removals`, `validation_feasibility_recruitment_removals`, and `validation_feasibility_correction_removals` | Daily aggregate counts of removed pilot records | Validation-governance retention; no account/trip IDs | Created or incremented by deletion triggers; retained only as aggregate deletion evidence |
| `validation_feasibility_snapshot_suppressions` | Opaque hashes needed to suppress deleted pilot records from longer-lived validation-only snapshots | Must outlive every snapshot it suppresses; current candidate is 730 days and remains unapproved/default-off | Created by deletion triggers, contains no raw account/trip ID, and is immutable. It is a deletion control, not retained active content |
| `privacy_deletion_jobs` | Pseudonymous account/trip tombstone, receipt hash, aggregate object counts/state, and timestamps | Completed jobs about 90 days; unresolved jobs until resolved | Created in the same batch that removes active data; replayed before any restored database can serve traffic |
| `privacy_deletion_tasks` | Hashed object identity plus a temporary plaintext private-object locator while cleanup is unresolved | Locator erased on completion; task follows parent tombstone retention | `ON DELETE CASCADE` from its job, but unresolved parents must not be deleted. Leased, bounded retries end in explicit operator attention rather than false completion |
| Private R2 trip photos | Optional metadata-stripped, re-encoded photo objects; upload remains default-off | While linked trip/account exists | Locator is inventoried into the deletion ledger before D1 active-row removal; object deletion is retried. Uploads stay disabled until the serialized deletion fence and bucket drills pass |
| Browser state | HttpOnly session/receipt cookies, bounded anonymous reporter/age markers, local trip drafts, per-write trip recovery material, and ephemeral optional location | Cookie/storage-specific bounded lifetimes; trip recovery material is removed after an exact receipt; location is tab-memory only | Account deletion clears account cookies, reporter/age markers, and account-related drafts where browser storage permits; server deletion does not depend on client cleanup succeeding. Trip recovery material is not a session or administrator credential and is accepted only with the matching write identity and server-side principal checks |
| Cloudflare/Worker logs and future analytics | Operational/security metadata only; the structured observability project is not yet activated | Short, approved retention to be defined before scaling | Never log passwords, cookies, tokens, raw prompts, trip notes, photos, precise location, or stable full account IDs. Deletion-aware provider behavior must be documented before adding account-linked events |
| Resend, Xiaomi MiMo, HIBP, and Turnstile | Minimal provider-specific delivery, model-review, password-range, or security payload | Provider terms and configured retention; production review remains open | Product deletion removes CastingCompass active copies but cannot recall a provider request already authorized. Record processor follow-up where applicable without putting request content or identifiers in repository evidence |
| Encrypted operational D1 backups | Full database export sealed with AES-256-GCM outside the repository | Fixed 89-day local candidate; production custody and restore drill remain open | Before restore, preserve the current deletion ledger, restore in isolation, replay tombstones/tasks/suppressions, prove deleted data cannot serve, then destroy the drill copy |
| Public forecast/site assets | Non-account environmental and curated public-access data | Versioned by release/snapshot policy | Not account data; correct or retire through the public-data review process |

## Atomic account-deletion sequence

The account endpoint requires a valid server session, same-origin mutation, exact confirmation,
and password reauthentication. It then performs this sequence:

1. Inventory every current trip-photo locator and unresolved locator already owned by the
   account. Photo uploads remain off because a future enabled uploader also needs a serialized
   write fence before this inventory.
2. Derive account/trip tombstone hashes and a high-entropy receipt on the server. Never accept
   any of those values from the browser.
3. In one D1 batch, insert the deletion job/tasks, requeue the account's unresolved photo
   tasks, delete linked public posts and trips, remove saved sites, gear, sessions, challenges,
   and the email-hash attempt history, then delete the user. Trip/user cascades and deletion
   triggers remove linked validation rows and write only aggregate/opaque suppression evidence.
4. Only after that batch commits, attempt private-object cleanup. Return `200` only when all
   known objects are gone; return truthful `202` when cleanup remains pending or needs attention.
5. Expose only aggregate cleanup state through the path-scoped HttpOnly receipt. A receipt
   cannot authenticate an account, restore a record, reveal an object locator, or cancel work.

Any exception inside the D1 batch rolls the complete active-data change back. A failure after
commit may defer object cleanup, but it must not restore account access or report false
completion. The runtime concurrency, failure-injection, cross-account, AI/deletion, validation-
suppression, restore-replay, and object-lease tests are part of this contract.

## Privacy-rights request workflow

Offer the workflow to any account holder; do not make a person prove that a privacy statute
applies before accepting a request. Legal applicability, exceptions, controller duties,
international transfers, and regulator language still require qualified review.

### 1. Intake and clock

- Accept signed-in self-service export/deletion and requests sent to the address published in
  the Privacy Policy. Recognize plain-language requests; do not require a special legal phrase.
- Create a private, MFA-protected case record outside the repository. Record a random case ID,
  received-at time, channel, requested rights, jurisdiction if volunteered, identity status,
  response target, systems checked, disposition, and closed-at time. Store request content and
  contact details only where needed to respond; never paste them into GitHub, build logs, test
  fixtures, screenshots, analytics, or aggregate dashboards.
- Acknowledge promptly. Use a conservative internal target of 28 calendar days while counsel
  determines the controlling rule. EU GDPR requests generally require a response without
  undue delay and in principle within one month; UK guidance also uses a one-month deadline;
  if CCPA/CPRA applies, California describes a 10-business-day receipt confirmation and a
  45-calendar-day substantive response for know/delete/correct requests. Record both receipt
  and any legitimate identity-verification date. Do not silently restart a clock.
- An extension, fee, exception, or refusal needs documented legal review, notice within the
  initial applicable window, reasons, and complaint/appeal information. Never delay an
  ordinary in-product export or deletion merely to use the longer manual deadline.

### 2. Proportionate identity verification

- A current authenticated session is the normal proof for self-service export, correction,
  and deletion; account deletion also requires the password.
- For email intake, prefer a single-use verification sent to the already verified account
  address. Do not ask for government ID, birth date, precise location, fishing history, or a
  password unless counsel finds it necessary and a protected deletion path exists for it.
- Match verification strength to disclosure risk. A requester who cannot access the account
  email may need a narrowly reviewed alternative; do not disclose account existence or private
  content through ad-hoc questions.
- Verify third-party authority separately and disclose only the represented person's data.

### 3. Preserve request ordering

- If a person wants both a copy and deletion, produce and securely deliver the export first,
  then execute deletion after explicit confirmation. Immediate deletion intentionally makes
  the active account unavailable and must not be reversed from backup just to recreate an
  export.
- A restriction or accuracy dispute may require pausing a contested use while retaining the
  minimum record. There is no general restriction flag today. Escalate before promising this
  outcome; disable optional publication/model use through existing kill switches where the
  request can be honored safely.
- Correction is self-service only for fields the product allows (for example pending trip or
  profile data). Approved/public or immutable validation evidence needs the reviewed correction
  and moderation path, not a direct overwrite.

### 4. Search and act by system

1. Use the authenticated export to collect account, consent, saved-site, gear, trip, forecast,
   validation, discussion-linkage, and photo-manifest data. Download advertised photos only
   through their owner-authorized routes. Never expose internal object locators, hashes,
   moderator identity, session rows, or security secrets in the user package.
2. Check active D1 tables, deletion jobs/tasks, private R2, browser-facing state, retained
   validation projections/suppressions, operational logs, encrypted backups, and each relevant
   processor against the inventory above. Record only case-scoped outcomes and aggregate counts.
3. For deletion, use the product endpoint whenever the owner can authenticate. Follow
   [privacy durability](PRIVACY-DURABILITY.md) for unresolved objects and
   [production operations](PRODUCTION-OPERATIONS.md) for backup/restore suppression. Never
   delete or edit a tombstone to make a request appear complete.
4. For provider copies, determine whether the processor can locate data from the minimal
   identifiers actually sent. A request already authorized to a provider cannot be recalled;
   document the truthful disposition and applicable retention instead of promising universal
   instantaneous erasure.

### 5. Respond and close safely

- Deliver exports through an authenticated response or a short-lived, access-controlled
  channel. Do not attach raw exports to ordinary email or store them in the repository, a
  shared drive, analytics, or the future operations dashboard.
- Explain what was completed, what was not found, any narrowly retained category and reason,
  processor/backup timing, and how to challenge the outcome. Do not include internal hashes,
  object keys, other people, security signals, or privileged moderation information.
- Close the case only after delivery is confirmed or the response channel is exhausted, all
  required processor actions are recorded, and any deletion job is either completed or remains
  truthfully tracked as unresolved. Keep minimal case evidence under an approved retention
  schedule; do not retain a duplicate of the supplied data package as proof.

## Minimum evidence for a drill

A production-shaped drill uses synthetic accounts only and records no raw identifiers or user
content. The evidence should contain:

- immutable release/Worker identity and synthetic case ID;
- request types, received/acknowledged/verified/responded timestamps, and deadline result;
- aggregate counts of systems searched, export sections, photos advertised/downloaded, active
  rows removed, object tasks completed/pending, processor actions, and retained categories;
- confirmation that cross-account data, secrets, internal locators, and deleted content were
  absent from the response and evidence;
- deletion receipt state, current-ledger restore replay result, suppression result, and a
  second-person review; and
- any exception, owner, remediation deadline, and retest result.

Repository tests prove the local map and deletion invariants only. Keep the roadmap item open
until a witnessed production-shaped access/correction/export/deletion drill, provider review,
alerting, key custody, and counsel review are complete.

## Machine case boundary and local drill

The repository now freezes a default-deny local control around the procedure above:

- `contracts/privacy-rights-case.schema.json` accepts only a random case identifier, aggregate
  counts, enumerated outcomes, canonical timestamps, case state, and review flags. It rejects
  extra fields. The companion policy separately forbids names, email addresses, account IDs,
  contact details, credentials, cookies, network identifiers, precise location, notes, photos,
  object locators, and request/response text.
- `privacy/rights-policy.json` preserves immediate, non-recoverable active-account removal. It
  does not authorize a 30-day recovery copy, treat the cleanup receipt as a recovery credential,
  infer legal applicability from a volunteered location, or delay ordinary self-service.
- `scripts/privacy-rights-case.mjs` validates the schema and chronology, requires export delivery
  before irreversible erasure, checks the complete system and processor inventories, refuses to
  close unresolved cleanup, and returns only gap codes and aggregate state. It never executes a
  user-data search, disclosure, correction, deletion, provider request, or legal decision.
- A real case JSON file must be outside the repository, be a regular non-symlink file, be no more
  than 256 KiB, and have no group/other permissions. Request content and the identifier-to-person
  link belong only in a separately approved private case system. Do not commit even the minimized
  case file.
- The deterministic synthetic drill exercises access, portability, export-before-erasure,
  system/processor disposition, response delivery, safety assertions, and second-person case
  review. Its receipt contains no case ID or content. A local pass remains
  `production_ready: false` while privacy/counsel approval, processor-retention review, an
  approved provider case system, witnessed production-shaped drill, and independent acceptance
  are absent.

Verify the locked policy:

```sh
npm run verify:privacy-rights
```

Evaluate a private minimized case without echoing its case ID:

```sh
chmod 600 /private/path/privacy-case.json
node scripts/privacy-rights-case.mjs evaluate --case /private/path/privacy-case.json
```

Run the synthetic offline drill from an exact clean commit and keep its aggregate receipt outside
the repository:

```sh
npm run drill:privacy-rights:offline -- \
  --output-dir /private/path/new-private-evidence-directory \
  --source-commit 0123456789abcdef0123456789abcdef01234567
```

Canonical policy SHA-256:
`a87dee0cf45f35e9da35c4557ee0fff9040c02e0a333996383919b52c1592334`.

## Clock-source review

The references were rechecked on 2026-07-18. They are operator prompts, not a conclusion that a
law applies or a substitute for qualified advice:

- EU GDPR Article 12 requires action information without undue delay and generally within one
  month; a necessary extension can add up to two months, with notice during the first month.
- The UK ICO subject-access guide, updated 2026-07-16, likewise uses a one-month response period,
  proportionate identity checks and searches, secure disclosure, and a possible extension of up
  to two months for complex or numerous requests with timely notice.
- The California Privacy Protection Agency says know/delete/correct requests generally receive
  confirmation within 10 business days and a substantive response within 45 calendar days, with
  a possible additional 45 days and notice. Sale/share opt-out and sensitive-use limitation
  requests are described as due as soon as feasibly possible and no later than 15 business days.

The evaluator always applies the 28-calendar-day internal target. A statute-specific reference
cannot be selected unless the minimized case records legal-clock review. Its business-day alarm
counts weekdays without a holiday calendar, deliberately producing an earlier engineering alert
when a holiday applies; it must not be presented as an authoritative statutory calculation.

## Primary rights references

- [EU GDPR text](https://eur-lex.europa.eu/eli/reg/2016/679/oj)
- [European Commission: individual rights](https://commission.europa.eu/law/law-topic/data-protection/information-individuals_en)
- [European Commission: dealing with individual requests](https://commission.europa.eu/law/law-topic/data-protection/rules-business-and-organisations/dealing-individuals-requests_en)
- [UK ICO: subject access guide](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/subject-access-requests/a-guide-to-subject-access/)
- [California Privacy Protection Agency FAQ](https://cppa.ca.gov/faq.html)
