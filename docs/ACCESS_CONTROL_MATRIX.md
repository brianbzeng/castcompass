# CastingCompass access-control matrix

Status: reviewed implementation baseline, not production activation evidence  
Last reviewed source: `c064d07412721f98facef267c527c6ceb29d1f90` plus the
cross-account regression test introduced with this document

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
| Account owner | Read/export their account data and photos; manage their saved sites and gear; create trips; edit or remove only their own pending trips; accept legal updates; delete their account | Supply another account identity, read/mutate another account's objects, alter server-controlled observation identity, edit an approved trip, approve/publish an AI draft, activate validation, or perform operator actions | Random session token is stored only as a SHA-256 hash in D1 and sent in an `HttpOnly`, `SameSite=Lax` cookie; private SQL binds `user.id`; mutations also require same-origin requests; cross-account regression tests require indistinguishable `404` results and no mutation |
| Human moderator | No public application endpoint currently grants this role | Use a client-side role flag or model recommendation as approval; expose moderator identity publicly | Publication requires a separately recorded `approved_at` and `approved_by` plus matching approved trip state. Until a reviewed moderator service exists, approval remains an operator-controlled database/runbook action and public discussions remain default-off |
| Support staff | No private-data application role currently exists | Impersonate an account, reset credentials, read trip content, or bypass deletion through the web app | No support route or browser role exists. A future support surface requires purpose limitation, MFA, field-level minimization, time-bounded elevation, reason capture, and immutable audit events before use |
| Operator / administrator | Use separately authenticated Cloudflare/GitHub/provider consoles and reviewed runbooks for deployments, migrations, secrets, backups, recovery, and approved moderation | Gain application authority from browser state; expose secrets or raw private rows in dashboards/logs; bypass maintenance, migration, privacy, or human-approval gates | Provider IAM is outside the app session. Production mutations follow the integrated-release and production-operations runbooks. There is deliberately no client-side `admin` check or public admin API |
| Scheduled Worker | Retry bounded AI review, auth cleanup, and privacy-deletion work through server bindings | Accept browser-supplied authority, publish model output, or continue schema-dependent work during release maintenance | Cloudflare invocation plus environment bindings; maintenance mode stops scheduled work; deletion tombstones are checked before AI dispatch; retries are state/lease bounded |
| AI provider/model | Return a narrow advisory JSON review from a minimized trip projection | Authenticate, authorize, call internal tools, see provider secrets, approve/reject a person, publish a discussion, or mutate privileged state | API secret stays in the Worker request header; model input omits account/email/token/photo data and bounds notes; output is normalized and length-bounded into a private draft; a separate human approval record is required for publication |
| Email and security providers | Deliver verification/welcome messages or verify a scoped anti-abuse challenge | Receive passwords, session cookies, trip content, or authority to create a session | Minimal provider-specific payloads; exact Turnstile action/hostname binding; verification precedes D1 side effects when enabled; provider failures are redacted in logs |

## Private object predicates

| Resource | Required server predicate | Current mutation rules |
| --- | --- | --- |
| Session | `token_hash = sha256(cookie)` and `expires_at > now` | Login/reset creates a new random token; logout/password reset/account deletion revoke stored sessions |
| Saved site | `user_id = authenticated_user.id` | Owner may add/remove only their row |
| Gear profile | `id = requested_id AND user_id = authenticated_user.id` | Owner may create, patch, or delete; an unknown or other-owned ID is `404` |
| Trip/profile record | `id = requested_id AND user_id = authenticated_user.id` | Owner may patch/delete only while `moderation_status = 'pending'`; server-controlled contract fields cannot be overridden |
| Stored trip photo | Trip predicate above before any R2 key is read | Owner-only authenticated download with `no-store`; object key is never accepted from the URL or request body |
| Account export | Every account-linked query binds `authenticated_user.id` | Export is owner-only and omits internal object locators and moderator identity |
| Deletion receipt | Hash of a high-entropy, path-scoped `HttpOnly` receipt cookie | Exposes aggregate status only; receipt can be cleared and expires; it cannot restore content or authenticate an account |
| Public discussion | Approved post fields plus matching trip `moderation_status = 'approved'` | Read-only public projection; feature defaults off; sensitive/prompt-like text is rejected or minimized |
| Validation evidence | Server-created activation/account/attestation identity and append-only database guards | No client-supplied evaluator/admin role; default-off activation; account export/deletion use separately minimized mappings |

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

## Open gates

- Production edge rate limits, Turnstile activation, alert delivery, key custody,
  restore/deletion replay, and the guarded migration/deployment sequence remain
  open in `docs/PRODUCT_ROADMAP.md`.
- Password breach/common-pattern screening is locally implemented for new and reset
  passwords, but production activation evidence remains open. Session rotation/revocation
  policy and an approved operator/moderator IAM design also remain open. Their absence must
  not be hidden by calling the current matrix complete.
- Any future operator dashboard must use a separate server-enforced role model,
  MFA, least privilege, immutable audit history, and field-level privacy controls.
  It cannot reuse a client-side account flag.
