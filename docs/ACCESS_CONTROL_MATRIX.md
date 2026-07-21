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
| Scheduled Worker / Queue consumer | Retry bounded AI review, auth cleanup, and privacy-deletion work through server bindings | Accept browser-supplied authority or queue content as trip/account data; publish model output; bypass deletion state; or continue schema-dependent work during release maintenance | Cloudflare invocation plus environment bindings; queue messages contain only a version and opaque job ID; D1 is authoritative; maintenance returns valid jobs to pending; deletion tombstones are checked before AI dispatch; retries, leases, attempts, batch size, and replay are bounded |
| AI provider/model | Return a narrow advisory JSON review from a minimized trip projection | Authenticate, authorize, call internal tools, see provider secrets, approve/reject a person, publish a discussion, or mutate privileged state | API secret stays in the Worker request header; model input omits account/email/token/photo data and allowlists legacy JSON fields; the request states that every user-role value is untrusted data; provider calls have a hard deadline and 64 KiB response cap; output must pass an exact type-and-length schema into a private draft; a separate human approval record is required for publication |
| Email and security providers | Deliver verification/welcome messages or verify a scoped anti-abuse challenge | Receive passwords, session cookies, trip content, or authority to create a session | Minimal provider-specific payloads; exact Turnstile action/hostname binding; verification precedes D1 side effects when enabled; provider failures are redacted in logs |

## Private object predicates

| Resource | Required server predicate | Current mutation rules |
| --- | --- | --- |
| Session | `token_hash = sha256(cookie)` and `expires_at > now` | Authentication atomically replaces any session presented by that browser and HTTPS uses `__Host-cc_session`; the prior cookie is accepted only for migration and rotated on session refresh; logout revokes presented sessions, while password reset and account deletion revoke every session for the account |
| Saved site | `user_id = authenticated_user.id` | Owner may add/remove only their row |
| Gear profile | `id = requested_id AND user_id = authenticated_user.id` | Owner may create, patch, or delete; an unknown, other-owned, or concurrently changed ID is `404`; PATCH/DELETE success requires exactly one D1 change and any unconfirmed result fails closed |
| Trip/profile record | `id = requested_id AND user_id = authenticated_user.id`; enrollment, forecast-impression, feasibility-start, and prior-recruitment sidecars repeat the owner predicate directly or through the parent trip | Owner may patch/delete only while `moderation_status = 'pending'`; success requires exactly one confirmed D1 change, a confirmed zero remains the generic reviewed-trip conflict, and an unconfirmable delete preserves an owner receipt for read-only recovery; active completion and cancellation bind `id`, `user_id`, `status = 'active'`, and `token_hash` together in the final D1 statement; manual advisory-review retry binds `id`, `user_id`, and retryable state in every final update and dispatches only D1-confirmed rows; server-controlled contract fields cannot be overridden |
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
predicate in the final statement and return success only when D1 confirms exactly one changed
row. A row that changes owner or disappears after the pre-read produces the same generic `404`;
unknown mutation metadata produces a retry-safe `503` rather than a false success receipt.

Pending-trip PATCH and DELETE distinguish an authoritative zero-change moderation race from a
missing or malformed D1 receipt. The former remains a correct generic `409`; the latter returns
`503` so the browser preserves its draft and blocks replay. An unconfirmed deletion also sets the
opaque owner receipt cookie, allowing status verification without exposing a job identifier.

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
