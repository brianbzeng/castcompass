# CastingCompass access-control matrix

Status: reviewed implementation baseline, not production activation evidence  
Last reviewed source: `9ee519f11362811b8ffa44ddca5e0c8974884c04` plus the
executable route inventory introduced with this revision

CastingCompass uses Cloudflare D1/SQLite, which does not provide PostgreSQL-style
native row-level security. The required equivalent is a deny-by-default server
boundary: authenticate the request, derive the account identity only from the
server-side session, include that identity in every private object query or
mutation, and return the same not-found response for absent and other-owned
objects. A browser flag, hidden button, route name, submitted account ID, or AI
output never grants authority.

## Actor matrix

| Actor | Allowed | Explicitly not allowed | Enforcement and evidence |
| --- | --- | --- | --- |
| Anonymous visitor | Read public pages/assets, aggregate trip summary, health status, and approved public discussion summaries when the feature is enabled; start account verification and recovery flows | Read private trips, photos, saved sites, gear, exports, drafts, validation ledgers, or operator data; mutate trip/account data | Public route allowlist; all other account routes require `getAuthenticatedUser`; trip mutations are rejected before the trip handler without a session; public discussion queries require complete human-approval fields |
| Account owner | Read/export their account data and photos; manage their saved sites and gear; create trips; edit or remove only their own pending trips; accept legal updates; delete their account | Supply another account identity, read/mutate another account's objects, alter server-controlled observation identity, edit an approved trip, approve/publish an AI draft, activate validation, or perform operator actions | Random session token is stored only as a SHA-256 hash in D1 and sent over HTTPS in a `Secure`, `HttpOnly`, `SameSite=Lax`, host-only cookie; private SQL binds `user.id`; mutations also require same-origin requests; cross-account regression tests require indistinguishable `404` results and no mutation |
| Human moderator | No public application endpoint currently grants this role | Use a client-side role flag or model recommendation as approval; expose moderator identity publicly | Publication requires a separately recorded `approved_at` and `approved_by` plus matching approved trip state. Until a reviewed moderator service exists, approval remains an operator-controlled database/runbook action and public discussions remain default-off |
| Support staff | No private-data application role currently exists | Impersonate an account, reset credentials, read trip content, or bypass deletion through the web app | No support route or browser role exists. A future support surface requires purpose limitation, MFA, field-level minimization, time-bounded elevation, reason capture, and immutable audit events before use |
| Operator / administrator | Use separately authenticated Cloudflare/GitHub/provider consoles and reviewed runbooks for deployments, migrations, secrets, backups, recovery, and approved moderation | Gain application authority from browser state; expose secrets or raw private rows in dashboards/logs; bypass maintenance, migration, privacy, or human-approval gates | Provider IAM is outside the app session. Production mutations follow the integrated-release and production-operations runbooks. There is deliberately no client-side `admin` check or public admin API |
| Scheduled Worker / Queue consumer | Retry bounded AI review, auth cleanup, and privacy-deletion work through server bindings | Accept browser-supplied authority or queue content as trip/account data; publish model output; bypass deletion state; continue schema-dependent work during release maintenance; or start several independently bounded pipelines that overrun one shared invocation | Cloudflare invocation plus environment bindings; one deterministic sequential cron lane runs per five-minute tick and all four lanes repeat every 20 minutes; every lane has a tested D1 budget below the 50-query Free ceiling; queue messages contain only a version and opaque job ID; D1 is authoritative; maintenance returns valid jobs to pending; deletion tombstones are checked before AI dispatch; retries, leases, attempts, batch size, and replay are bounded |
| AI provider/model | Return a narrow advisory JSON review from a minimized trip projection | Authenticate, authorize, call internal tools, see provider secrets, approve/reject a person, publish a discussion, or mutate privileged state | API secret stays in the Worker request header; model input omits account/email/token/photo data and allowlists legacy JSON fields; the request states that every user-role value is untrusted data; provider calls have a hard deadline and 64 KiB response cap; output must pass an exact type-and-length schema into a private draft; a separate human approval record is required for publication |
| Email and security providers | Deliver verification/welcome messages or verify a scoped anti-abuse challenge | Receive passwords, session cookies, trip content, or authority to create a session | Minimal provider-specific payloads; exact Turnstile action/hostname binding; verification precedes D1 side effects when enabled; provider failures are redacted in logs |

## Private object predicates

| Resource | Required server predicate | Current mutation rules |
| --- | --- | --- |
| Session | `token_hash = sha256(cookie)` and `expires_at > now` | Authentication atomically replaces any session presented by that browser and HTTPS uses `__Host-cc_session`; the prior cookie is accepted only for migration and rotated on session refresh. The server discloses a new token only after exact read-back of its random hash, owner, creation, expiry, live user, and absent deletion fence; unreadable or mismatched state triggers candidate cleanup and clears both cookie forms. Logout clears cookies only after primary-key read-back proves every distinct presented token absent; ambiguity retains the cookie as a revocation handle. Password reset and account deletion revoke every session for the account |
| Sign-in attempt | Random server attempt ID plus `email_hash = sha256(normalized_email)`, exact server timestamp, state, and a rolling one-hour failed-attempt window | One atomic conditional INSERT claims one of ten failure slots before account lookup or password derivation. Exact read-back must prove the pending row and a valid bounded window; exact absence plus ten existing failures is the only `429`, while unreadable, changed, or impossible state is `503`. Correct credentials then classify that same row and require exact successful state with the prior pending state absent before session issuance. Mutation metadata and transport success grant nothing, so lost committed responses recover without replay. Unknown and wrong-password paths still perform equal password work and return the same response |
| Email challenge attempt | Complete challenge snapshot: `id`, kind, email/user binding, code and optional credential material, age/legal fields, creation time, prior attempt count, resend count, exact expiry, and live expiry | Every submitted six-digit code first claims the next bounded attempt with one compare-and-set UPDATE. Mutation metadata and transport success grant no credential authority; exact read-back must prove the same complete snapshot at the claimed attempt and exclude the prior state. Missing or mismatched state authorizes no credential/session transition, concurrent changes remain `409` for signup, password recovery preserves its generic error, and six claims remain the hard ceiling |
| Account creation | One-use signup challenge containing server-created credential hash, age-eligibility timestamp, and exact current legal versions | The plaintext age proof is exposed only after complete hash/gate/timestamp read-back; proof consumption proves exact consumed versus still-valid prior state before challenge creation. Initial challenge creation rechecks the five-per-hour ceiling and proves the complete stored credential snapshot before delivery. Resends compare-and-set the complete prior version and prove the complete next/prior state; cleanup repeats the candidate snapshot. Final user insertion and challenge deletion repeat the verified challenge. Welcome delivery and first-session issuance begin only after exact account/legal/cardinality/session/fence read-back; mutation metadata and transport success grant nothing |
| Password reset | One-use verified challenge bound server-side to `email_challenges.user_id`; final credential update repeats that user ID | Enumeration-resistant request/resend responses remain identical for missing accounts and every unconfirmed D1 state. Initial and resend delivery require the same complete challenge creation/transition receipts as signup. The atomic reset repeats the exact challenge snapshot for credential replacement, all-session revocation, and challenge consumption; success then requires the exact new credential row, zero prior sessions, zero challenge rows, and no account-deletion fence. A concurrent resend remains generic; unreadable or mismatched state cannot deliver a code or create a replacement session |
| Legal acceptance | Complete authenticated account/legal version plus the exact session token hash, owner, and expiry after an active server-side lookup | The compare-and-set repeats account ID/email, immutable creation and age timestamps, prior legal fields, update version, and the still-live session. Read-back must prove the request's exact accepted timestamps/versions, absence of its prior snapshot, unique account identity, and continuing session authority. Mutation metadata and transport success grant nothing: committed response loss recovers; rollback, unreadable, or changed state is `503`; account deletion or session revocation is `401` with stale-cookie clearing |
| Saved site | `user_id = authenticated_user.id` | Owner may add/remove only their row. Creation and removal return their exact browser state receipt only after authoritative zero-or-one D1 change metadata; missing or impossible metadata is an ambiguous `503`, and an authoritative zero delete is safely idempotent |
| Gear profile | `id = requested_id AND user_id = authenticated_user.id` | Owner may create, patch, or delete. Creation requires the exact owner-bound inserted row. PATCH requires the exact normalized owner row and server timestamp after the write. DELETE requires both the owner row and global opaque-ID row to be absent; another owner's row remains an enumeration-resistant `404`, while an unreadable or mismatched post-state fails closed |
| Trip/profile record | `id = requested_id AND user_id = authenticated_user.id`; enrollment, forecast-impression, feasibility-start, and prior-recruitment sidecars repeat the owner predicate directly or through the parent trip | Owner may patch/delete only while `moderation_status = 'pending'`; success requires exactly one confirmed D1 change, a confirmed zero remains the generic reviewed-trip conflict, and an unconfirmable delete preserves an owner receipt for read-only recovery; active completion and cancellation bind `id`, `user_id`, `status = 'active'`, and `token_hash` together in the final D1 statement; manual advisory-review retry binds `id`, `user_id`, and retryable state in every final update, dispatches only D1-confirmed rows, returns `503` for ambiguous metadata, and lets the bounded scheduled backlog recover a committed `queued` row without replaying the owner request; server-controlled contract fields cannot be overridden |
| Stored trip photo | Trip predicate above before any R2 key is read | Owner-only authenticated download with `no-store`; object key is never accepted from the URL or request body |
| Account export | Every account-linked query and status/download lookup binds `authenticated_user.id`; asynchronous Queue messages contain only an opaque job ID | Export is owner-only and omits internal object locators and moderator identity. The default-off package is private, expires after 24 hours, and is canceled/adopted atomically by account deletion |
| Deletion receipt | Hash of a high-entropy, path-scoped `HttpOnly` receipt cookie | Exposes aggregate status only; receipt can be cleared and expires; it cannot restore content or authenticate an account |
| Public discussion | Approved post fields plus matching trip `moderation_status = 'approved'` | Read-only public projection; feature defaults off; sensitive/prompt-like text is rejected or minimized |
| Validation evidence | Server-created activation/account/attestation identity and append-only database guards | No client-supplied evaluator/admin role; default-off activation; account export/deletion use separately minimized mappings |
| Advisory AI queue job | Opaque job ID resolved server-side to one D1 trip foreign key | No browser route; no trip/account identity in the message; unique trip job, atomic lease, five-attempt attention state, and trip-delete cascade; replay plan accepts only an opaque attention-job ID |
| Privacy export queue job | Opaque job ID plus authenticated account predicate in D1 | Same-origin owner request; read-only owner status; sensitive owner download; exact two-field Queue message; one active job per account; five-attempt attention state; 24-hour expiry; account-deletion cancellation and multi-store purge |

## Mandatory rules for every new route

1. Classify the route as public, owner, moderator, support, operator, scheduled,
   or provider callback before implementation. Unknown classifications are denied.
2. Derive identity and role on the server. Never trust `userId`, `role`, `admin`,
   hidden UI, local storage, an unsigned claim, or model output from a request.
3. Bind both resource ID and authorized account/role in the same database
   statement. A prior unscoped lookup followed by a client-side check is not
   sufficient.
4. Return an enumeration-resistant response for absent and unauthorized private
   resources, normally the same `404` body.
5. Require same-origin/CSRF protection for cookie-authenticated mutations, strict
   schemas and body limits, no-store responses, and an endpoint-specific abuse
   ceiling.
6. Add positive, unauthenticated, wrong-account, wrong-role, stale-session,
   deleted-account, and concurrent-state tests before the route is enabled.
7. Record only pseudonymous, redacted authorization outcomes in production logs;
   never record cookies, tokens, passwords, raw prompts, trip notes, photo data,
   precise location, or full account identifiers.

## Executable route inventory

`worker/route-policy.ts` is the source-controlled API inventory. Every route records
its stable identifier, path template, accepted methods, actor boundary, handler,
same-origin requirement, current-legal-acceptance requirement, and extra abuse-limit
classes. Dynamic path patterns are imported by both the inventory and the route
handlers so their object shapes cannot drift independently.

The Worker returns a generic, non-cacheable `404` for any `/api/` path that is not
in the inventory. A newly written handler therefore remains unreachable until its
security policy is reviewed. Known paths with unsupported methods still reach their
handler's explicit `405` response. The rate limiter consumes the same inventory and
retains a generic read/write ceiling for unclassified probes before they are denied.

`tests/route-policy-runtime.test.mjs` machine-checks unique route identities, actor,
CSRF/legal and abuse metadata, representative dynamic resources, malformed and
lookalike paths, every exact route branch in the Worker handlers, and the central
trip-owner gate. Object-level ownership and cross-account behavior remain covered by
the runtime privacy and trip suites. The terminal-trip regression supplies the exact
token from a second authenticated account and also changes ownership between the
handler pre-read and final update; cancellation and completion both remain `404`, and
the final D1 predicates leave the active row unchanged. All owner-path TripStore reads
now receive the server-derived account identity, including validation sidecars and prior
recruitment reuse; profile-edit feasibility start/completion/correction reads repeat the
same parent-owner predicate. The one intentionally global trip-ID query selects only the constant
`1` by primary key so a random client identity collision remains a generic `409`; it
cannot project a trip field, account identity, or validation record.

Manual advisory-review retry follows the same atomic rule. Its owner-scoped pre-read does
not authorize a later ID-only mutation: every final state transition repeats the authenticated
`user_id`, and only statements that D1 confirms changed exactly one row enter the internal
review scheduler. A forced ownership change between selection and batch execution therefore
queues and dispatches zero rows; the new owner can subsequently request the retry normally.

Gear mutation receipts are equally database-authoritative. PATCH and DELETE retain the owner
predicate in the write, but transport success and mutation metadata grant no receipt. PATCH
requires an exact owner-bound read-back of every normalized field plus the server timestamp.
DELETE requires exact global absence for the opaque ID; a same-owner concurrent removal is
idempotent success, an ownership transfer is the same generic `404`, and an unreadable or
mismatched post-state is a retry-safe `503`.

Pending-trip PATCH and DELETE distinguish an authoritative zero-change moderation race from a
missing or malformed D1 receipt. The former remains a correct generic `409`; the latter returns
`503` so the browser preserves its draft and blocks replay. An unconfirmed deletion also sets the
opaque owner receipt cookie, allowing status verification without exposing a job identifier.

Legal reacceptance is also database-authoritative. The response marks the account accepted only
when D1 confirms one owner-row change. A confirmed zero after session lookup means the account no
longer exists, clears both session-cookie forms, and returns `401`; unavailable change metadata
returns `503` without manufacturing a Terms or Privacy acceptance receipt.

Password reset uses the same receipt boundary for a more sensitive transition. The credential
update, prior-session revocation, and one-use challenge deletion remain atomic. Each repeats the
verified challenge's ID, kind, user, code hash, creation time, attempt count, and live expiry; a
resend between verification and the batch therefore changes zero rows and preserves the newer
code. Mutation metadata and transport success grant no reset receipt. The replacement session is
created only after read-back proves the exact new salt, password hash, server timestamp and user,
zero remaining prior sessions, zero challenge rows, and no active deletion fence. Missing metadata
or a lost committed batch response therefore resolves without replay, while rollback, unreadable
or conflicting state, and a new deletion fence return `503` with clearing browser cookies.

Verified signup similarly couples user insertion and challenge consumption in one batch. Both
statements repeat the challenge ID, kind, email, code and credential hashes, salt, age and legal
fields, attempt/resend counts, creation time, and exact live expiry. Welcome delivery and the first
session are downstream of an exact post-state receipt for the complete user and legal timestamps,
unique ID/email cardinality, zero prior sessions, zero challenge rows, and no deletion fence. The
user INSERT first requires the exact verified challenge snapshot to still exist, and the DELETE
repeats that snapshot, so a concurrent resend cannot let the old code create an account. If the
batch commits but mutation metadata or the response is lost, exact read-back recovers without
replaying the challenge. Rollback, unreadable or conflicting state, and a deletion fence return
`503` before any welcome or session side effect.

Every path that creates or rotates a session applies one final independent receipt boundary. The
server hashes the candidate token once, then reads back that random hash with the exact owner,
creation time, expiry, live-user predicate, and absent account-deletion fence before exposing the
plaintext token in a cookie. Mutation metadata and transport success grant nothing, so a lost
committed batch response resolves without replay. Unreadable, absent, or mismatched state returns
`503` with both session-cookie forms cleared and deletes the candidate hash; a cleanup execution
failure is recorded only as a redacted structured error and the token is still never disclosed.

Sign-out uses exact stored absence rather than mutation metadata. Every distinct presented token is
hashed and deleted in one transactional batch, then read back independently by the session primary
key. Only readable zero cardinality for all hashes returns the exact receipt and clears cookies.
Rollback, unreadable state, or row reappearance returns `503 sign_out_unconfirmed` without clearing
the cookie, preserving the user's revocation handle and read-only status-check path.

Secret-bearing age and email steps apply that boundary before disclosure or external side effects.
An age proof is returned only after read-back proves its complete random-hash, gate, expiry, and
creation snapshot. One-use consumption proves the exact consumed row and absence of its prior
state before challenge creation. Initial challenges prove the complete credential snapshot, unique
ID, and bounded rolling email count. Resends compare-and-set the complete prior version and read
back complete next/prior snapshots plus ID cardinality before delivery. Missing metadata and lost
committed responses recover without replay; rollback, unreadable, colliding, or changed state
authorizes no plaintext or provider side effect. Cleanup repeats the complete candidate snapshot,
and password recovery keeps its intentionally generic anti-enumeration response.

## Open gates

- Production edge rate limits, Turnstile activation, alert delivery, key custody,
  restore/deletion replay, and the guarded migration/deployment sequence remain
  open in `docs/PRODUCT_ROADMAP.md`.
- Password screening and session rotation/revocation are locally implemented, but production
  activation and live revocation evidence remain open. An approved operator/moderator IAM
  design also remains open. These gates must not be hidden by calling the current matrix complete.
- Any future operator dashboard must use a separate server-enforced role model,
  MFA, least privilege, immutable audit history, and field-level privacy controls.
  It cannot reuse a client-side account flag.
