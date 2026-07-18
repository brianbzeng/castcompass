# CastingCompass threat model and owner security-layer mapping

Status: **repository mapping complete; production activation evidence remains open**
Last reconciled: **2026-07-18 UTC**

This document turns the owner's three security reference screenshots into an attack-specific
CastingCompass control map. The screenshots are a generic checklist, not evidence that a
control exists and not a requirement to adopt every named vendor. Each layer below records an
accountable role, current evidence, alert path, recovery action, residual risk, and next gate.

Cloudflare remains paused. This review did not deploy, inspect user rows, change DNS, provision
secrets, activate rate limits, run DAST, or aim load or security traffic at production.

## Reference provenance

The owner supplied three screenshots on 2026-07-17. They are not copied into the repository;
only privacy-safe integrity receipts and the transcribed layer names are retained.

| Reference | Layers | Dimensions | SHA-256 |
| --- | --- | --- | --- |
| Architectural and development | L01-L05 | 700 x 506 | `6c903ecfb6841f84902847bf35eb91c8a776bf6d0c31950ccfea4f85dc65e535` |
| Application and data | L06-L10 | 712 x 470 | `439bdec67066301258b306b94f1d4ae4e78a1e804a53f1e90c11b6e9b26f7795` |
| Network and infrastructure | L11-L13 | 743 x 535 | `2fceefee494a36222b6c6a02b723da18c8b1a37f917dbd3468ca460f31886996` |

The reference layers are: security-first prompts; IDE/repository scanning; dependency
integrity; static application security testing; post-generation review; managed
authentication; strict access controls; input sanitization and parameterized queries; secrets
management; dynamic application security testing; API rate limiting; DDoS and traffic
filtering; and runtime threat defense.

## Scope and trust boundaries

Protected assets are account sessions and password hashes; private D1 rows and future private
objects; deletion and restore evidence; provider and backup keys; deployment authority;
moderation drafts and public claims; model and data provenance; and service availability.

The principal trust boundaries are:

1. the untrusted browser/PWA to the Cloudflare edge and Worker;
2. the Worker to D1, future R2, rate-limit bindings, scheduled work, and optional AI/email/
   security providers;
3. the public snapshot generator and optional API to official upstream sources and optional
   PostgreSQL;
4. source and dependency inputs to GitHub review, CI, release provenance, and deployment;
5. operator consoles and local encrypted evidence to production infrastructure; and
6. model instructions versus untrusted trip text and narrowly validated model output.

Threat actors include unauthenticated abuse, a malicious or compromised account, cross-account
object probing, prompt or data injection, compromised dependencies or provider credentials,
operator error, a compromised provider or deployment identity, and ordinary upstream failure
that could become a privacy, integrity, or availability incident.

## State vocabulary

- **accepted-local** — the repository control and attack-specific tests pass; this does not
  claim a live production control.
- **provider-evidenced** — the repository control also has current GitHub-side evidence.
- **partial** — a meaningful control exists, but a production, governance, or independent-
  review gate is open.
- **open** — the layer has not been exercised or activated in its intended environment.

## Layer summary

| ID | Owner reference layer | Current state | Most important open boundary |
| --- | --- | --- | --- |
| L01 | Security-first prompts | partial | Prompts are advisory; high-risk changes still need accountable review and tests |
| L02 | IDE and repository scanning | provider-evidenced | Unknown secret formats and material outside Git remain residual risks |
| L03 | Dependency integrity | provider-evidenced | Scanner lag, zero-days, and time-bounded image exceptions remain |
| L04 | Static application security testing | provider-evidenced | Business-logic and runtime-only flaws require other controls |
| L05 | AI post-generation review | partial | No mandatory second-person reviewer exists for every change |
| L06 | Managed authentication | partial | CastingCompass uses reviewed custom opaque sessions; live evidence remains open |
| L07 | Strict access controls / RBAC / ABAC | accepted-local | Future moderator, support, and operator application roles are not approved |
| L08 | Input sanitization and parameterized queries | accepted-local | Parser differentials and deployed composition still need authorized DAST |
| L09 | Secrets management | partial | Production custody, MFA/IAM evidence, and rotation drills remain open |
| L10 | Dynamic application security testing | open | No authorized isolated staging target or DAST receipt exists |
| L11 | API rate limiting | partial | Worker bindings are default-off and outer edge rules are not active |
| L12 | DDoS and traffic filtering | open | Cloudflare is paused; no active WAF/DDoS configuration is claimed |
| L13 | Runtime threat defense | partial | Structured events exist locally; live alerts and detection are not active |

### L01 — Security-first prompts

- **Reference intent:** Give code-generating systems explicit secure defaults such as existing
  authentication libraries, parameterized queries, and no embedded credentials.
- **Owner:** Product/security owner for instructions; pull-request owner for the resulting code.
- **State:** partial.
- **Evidence:** The [product roadmap](PRODUCT_ROADMAP.md),
  [access-control matrix](ACCESS_CONTROL_MATRIX.md), route-policy contracts, secret scanner,
  and AI-review attack tests define outcomes that generated code must preserve.
- **Alert:** Required CI or review fails when a generated change violates a checked invariant;
  a disagreement between prose and executable behavior blocks release.
- **Recovery:** Do not merge; close or replace the unsafe change. If already merged, enter the
  relevant feature kill switch or maintenance mode, revert through a reviewed PR, and rerun the
  attack-specific suite.
- **Residual risk:** A prompt is not a security boundary and cannot prove that generated code is
  correct. Ambiguous business logic and novel attacks can pass generic instructions.
- **Next gate:** Require independent review for future authentication, authorization,
  cryptography, deletion, and deployment-boundary changes when a qualified reviewer is chosen.

### L02 — IDE and repository scanning

- **Reference intent:** Prevent credentials and sensitive configuration from entering source
  control.
- **Owner:** Repository administrator and credential owner.
- **State:** provider-evidenced.
- **Evidence:** `scripts/check-secrets.mjs`, `tests/repository-security.test.mjs`, ignored local
  secret files, CI secret scanning, GitHub secret-scanning push protection, and the current zero
  open secret-scanning alert count.
- **Alert:** Local/CI secret scan, GitHub push protection, or a GitHub secret-scanning alert.
- **Recovery:** Treat any committed value as disclosed: revoke or rotate it immediately, disable
  the affected integration if necessary, assess provider use, and record only opaque incident
  metadata. Removing a value from a later commit does not make it secret again.
- **Residual risk:** Pattern scanners can miss unknown formats, encoded material, screenshots,
  local files, console history, or values pasted into third-party systems.
- **Next gate:** Exercise provider revocation and alert routing with synthetic credentials; never
  place real secret bytes in the receipt.

### L03 — Dependency integrity

- **Reference intent:** Reject invented, malicious, vulnerable, or unreviewed dependencies and
  transitive changes.
- **Owner:** Dependency/release owner.
- **State:** provider-evidenced.
- **Evidence:** Exact npm and hash-locked Python graphs, immutable Actions, dependency review,
  Dependabot, deterministic CycloneDX release inventory, signed provenance, and native AMD64/
  ARM64 API-image SBOM/Grype/license gates documented in the
  [supply-chain policy](SECURITY-SUPPLY-CHAIN.md).
- **Alert:** Dependency review, npm audit, Python lock verification, Dependabot, image policy,
  SBOM drift, provenance verification, or release-checkout failure.
- **Recovery:** Block promotion, remove or upgrade the dependency, regenerate exact locks and
  SBOMs, rebuild from the reviewed commit, and verify provenance before restoring the feature.
- **Residual risk:** Advisory and scanner databases lag new issues; a correctly named package
  can still be compromised; the three accepted CPython image exceptions expire 2026-08-01.
- **Next gate:** Re-evaluate or remove every image exception before expiry and preserve the
  scheduled reviewed update path rather than freezing vulnerable versions.

### L04 — Static application security testing

- **Reference intent:** Find code-level injection, authorization, secret, and unsafe-flow defects
  before runtime.
- **Owner:** Repository security owner and code owner for the affected path.
- **State:** provider-evidenced.
- **Evidence:** GitHub-managed CodeQL covers Actions, JavaScript/TypeScript, and Python; required
  `main` protection binds those analyses to pull requests; repository security and runtime
  tests cover business invariants that SAST cannot infer. The current open code-scanning alert
  count is zero.
- **Alert:** Required CodeQL check or GitHub code-scanning alert.
- **Recovery:** Block the PR or deployment, remediate the source, add a regression test, and let
  the alert close as fixed rather than dismissing a real defect.
- **Residual risk:** SAST cannot prove object ownership, moderation state, deletion semantics,
  provider configuration, or deployed behavior and can miss unsupported language/runtime paths.
- **Next gate:** Keep CodeQL required and pair it with authorized DAST and manual business-logic
  review before production promotion.

### L05 — AI post-generation review

- **Reference intent:** Never publish generated code blindly; review authorization and business
  logic and require independent checks.
- **Owner:** Pull-request owner; product/security owner remains accountable for merge decisions.
- **State:** partial.
- **Evidence:** Pull requests, strict required CI/CodeQL/dependency checks, resolved-conversation
  protection, immutable release provenance, and attack-specific tests prevent direct unverified
  publication from the repository workflow.
- **Alert:** Review comments, required-check failures, release identity mismatch, or a post-merge
  `main` failure.
- **Recovery:** Keep the PR draft, correct the change, or revert by reviewed PR; disable the
  affected feature or use maintenance mode when runtime safety is uncertain.
- **Residual risk:** The project currently has a solo product owner and no mandatory qualified
  second-person review for every security-sensitive change. Automated checks can share the same
  mistaken assumption as generated code.
- **Next gate:** Assign an independent reviewer for cryptography/key custody and require targeted
  review for future auth, access-control, privacy, and release-control changes.

### L06 — Managed authentication

- **Reference intent:** Avoid fragile home-grown token formats and client-granted authority;
  prefer a mature authentication boundary when it reduces risk.
- **Owner:** Authentication owner and production identity/IAM owner.
- **State:** partial.
- **Evidence:** CastingCompass deliberately uses server-side opaque sessions rather than JWTs:
  HTTPS `__Host-` cookies, `HttpOnly`, `Secure`, scoped `SameSite`, hashed 256-bit tokens,
  rotation, expiry, revocation, fixation resistance, same-origin mutation checks, and generic
  equal-work login/recovery behavior are covered by auth and password security tests.
- **Alert:** Authentication regression tests and structured auth outcomes locally; production
  anomaly alerts and email-delivery/revocation drills remain absent.
- **Recovery:** Enter maintenance or disable signup/recovery, revoke affected sessions and
  provider credentials, restore only the reviewed auth path, and require reauthentication.
- **Residual risk:** Maintaining custom auth carries ongoing implementation burden; live cookie,
  expiry, email, revocation, abuse, and account-recovery evidence remains open. Adding Auth0,
  Clerk, or Supabase Auth would add a processor, migration, deletion, availability, and lock-in
  boundary and is not automatically safer without a reviewed decision.
- **Next gate:** Capture live non-sensitive auth evidence after the guarded deployment and
  reassess managed identity if role complexity or assurance requirements grow.

### L07 — Strict access controls / RBAC / ABAC

- **Reference intent:** Enforce every role and record decision on the server; never trust a
  browser role, account ID, or hidden interface state.
- **Owner:** API/data-access owner; provider IAM owner for operator consoles.
- **State:** accepted-local.
- **Evidence:** The [deny-by-default matrix](ACCESS_CONTROL_MATRIX.md), executable route
  inventory, server-derived session identity, D1 owner predicates, same-response IDOR behavior,
  and cross-account tests. D1 has no PostgreSQL-style native RLS, so the tested equivalent is a
  record ID plus authenticated-owner predicate in the same server query.
- **Alert:** Route-inventory, unauthenticated, wrong-account, stale-session, and cross-account
  regression failures; sanitized forbidden/not-found outcome trends when live monitoring exists.
- **Recovery:** Disable the affected route or enter maintenance, revoke sessions if exposure is
  plausible, repair the predicate and add the exact exploit fixture before re-enabling.
- **Residual risk:** Moderator, support, and operator application roles do not yet exist or have
  approved workflows; provider-console IAM is outside repository proof.
- **Next gate:** Do not add any privileged route until its matrix row, least-privilege fields,
  time bounds, reason/audit record, negative tests, and provider role are approved.

### L08 — Input sanitization and parameterized queries

- **Reference intent:** Bound and validate untrusted input, use parameterized data operations,
  encode output for its context, and keep prompt content from becoming authority.
- **Owner:** Route owner; AI boundary owner for model input/output.
- **State:** accepted-local.
- **Evidence:** Endpoint field allowlists, body/type/length limits, duplicate multipart rejection,
  parameter-bound D1 operations, React output encoding, escaped JSON-LD, default-off signature-
  checked metadata-stripped uploads, and the no-tools/no-ambient-secrets exact-schema AI
  boundary with attack tests.
- **Alert:** Schema, route-policy, upload, prompt-boundary, output-context, or database runtime
  test failure; sanitized validation outcomes in structured logs.
- **Recovery:** Reject or quarantine the payload, disable the AI/upload/affected route, repair
  the parser or query, and add the exploit as a non-sensitive regression fixture.
- **Residual risk:** “Sanitization” is context-dependent and cannot replace allowlists,
  parameterization, output encoding, or authorization. Parser/canonicalization differentials and
  the deployed provider composition still need authorized DAST.
- **Next gate:** Exercise browser/Worker/API boundaries in isolated staging with synthetic data;
  model output must remain unable to publish or invoke privileged actions.

### L09 — Secrets management

- **Reference intent:** Keep secrets out of source and browsers; inject least-privilege,
  environment-specific values through a managed runtime boundary.
- **Owner:** Credential owner and named production custodian/reviewer.
- **State:** partial.
- **Evidence:** The seven-secret inventory, Cloudflare Worker secret boundary, named-secret
  scanning, environment/purpose separation, and feature-specific rotation/recovery rules in
  [key custody and encryption](KEY-CUSTODY-AND-ENCRYPTION.md). No secret value is stored in
  Wrangler vars or repository evidence.
- **Alert:** Repository/provider secret scanning, missing/invalid binding failures, provider
  revocation events, and future redacted runtime alerts.
- **Recovery:** Revoke first when disclosure is suspected; enter maintenance or disable the
  optional feature, rotate one purpose/environment at a time, preserve backup-key decryptability,
  verify rollback, and record only opaque key IDs.
- **Residual risk:** Production IAM/MFA, actual binding IDs, custody, recovery, rotation, and
  destruction evidence are not approved. A compromised Cloudflare account or Worker can access
  the data and secrets granted to it; D1 managed encryption is not field-level encryption.
- **Next gate:** Name custodians and an independent reviewer, audit account access and MFA, then
  run synthetic rotation and recovery drills without exposing values.

### L10 — Dynamic application security testing

- **Reference intent:** Test the running composition for injection, authentication,
  authorization, configuration, and browser/runtime defects that static analysis cannot see.
- **Owner:** Independent security tester and staging owner.
- **State:** open.
- **Evidence:** No DAST acceptance receipt exists. The current
  [performance policy](PERFORMANCE-READINESS.md) and load harness refuse production and require
  explicit authorization for remote staging; that safety boundary is preparation, not a DAST
  pass.
- **Alert:** A future signed/immutable DAST report, staging runtime alerts, and a tracked finding
  with severity, owner, deadline, fix commit, and retest receipt.
- **Recovery:** Block promotion, isolate the staging target, remediate critical/high findings,
  add regression coverage, rebuild, and retest before production.
- **Residual risk:** The deployed composition has not been attack-tested in an authorized
  isolated environment. This is an explicit launch gate, not a presumed pass.
- **Next gate:** Create an isolated staging hostname and synthetic dataset, written scope and
  authorization, tester identity, rate/cost ceilings, emergency stop, and evidence location.
  Never target `castingcompass.com`, aliases, production bindings, or user data.

### L11 — API rate limiting

- **Reference intent:** Bound credential attacks, request floods, expensive work, and repeated
  destructive or privacy-sensitive actions by operation.
- **Owner:** API/abuse owner and Cloudflare configuration owner.
- **State:** partial.
- **Evidence:** Six endpoint-class Worker rate-limit bindings, secret-keyed IP pseudonyms,
  pre-body enforcement, generic non-cacheable failures, fail-closed enabled configuration, D1
  durable auth/email/trip ceilings, and `tests/rate-limit-runtime.test.mjs`. Repository defaults
  keep the Worker layer off until reviewed production activation.
- **Alert:** Local abuse-contract failures; future Cloudflare binding failures, threshold trends,
  retry exhaustion, and attack-volume alerts.
- **Recovery:** Enter maintenance for unsafe load, use a reviewed configuration change to tune or
  disable a malfunctioning optional edge layer, preserve durable D1 ceilings, and verify normal
  and abuse fixtures before restoring traffic.
- **Residual risk:** Bindings, key material, production thresholds, outer WAF rules, distributed
  attack behavior, cost, and false-positive monitoring are not live-tested.
- **Next gate:** Provision distinct production bindings/key, activate through a separate reviewed
  release, test each endpoint class and recovery path, and capture redacted evidence.

### L12 — DDoS and traffic filtering

- **Reference intent:** Reject abusive network traffic at the edge before it consumes Worker,
  database, provider, or operator capacity.
- **Owner:** Cloudflare account/security owner.
- **State:** open.
- **Evidence:** Cloudflare is the intended edge and the production runbook requires outer rate-
  limiting/WAF evidence, but the service is paused and no active DDoS/WAF configuration or test
  is claimed by this repository.
- **Alert:** Future Cloudflare Security Events/analytics, origin error and saturation alerts,
  provider cost alerts, and external uptime checks.
- **Recovery:** Keep or enter maintenance, block abusive classes at the edge, protect provider
  and database budgets, roll back the reviewed Worker when needed, and verify legitimate traffic
  before reopening.
- **Residual risk:** Resuming traffic without reviewed edge rules and alerts would leave
  availability, cost, and downstream provider exhaustion insufficiently evidenced.
- **Next gate:** Review managed protections and narrow custom WAF/rate rules, test false positives
  in isolated staging, record rollback, and activate only in the guarded release sequence.

### L13 — Runtime threat defense

- **Reference intent:** Detect anomalous or malicious live behavior quickly enough to contain it
  and reconstruct the incident without leaking more sensitive data.
- **Owner:** On-call operator/security owner.
- **State:** partial.
- **Evidence:** Schema-versioned structured Worker events, server request IDs, normalized routes,
  secret-keyed rotating account pseudonyms, redaction tests, scheduled-work correlation, and the
  Cloudflare dashboard/query/incident recipe in [observability](OBSERVABILITY.md).
- **Alert:** Local schema/redaction tests today; future exception, 5xx, auth abuse, D1, CPU,
  scheduled-job, deletion-job, uptime, and volume alerts with acknowledgement/escalation.
- **Recovery:** Enter maintenance or disable the affected optional route, preserve redacted event
  evidence, revoke exposed credentials, roll back to the reviewed release, reconcile privacy
  and deletion work, and complete the incident runbook.
- **Residual risk:** No production dashboard, retention/IAM approval, external uptime check,
  delivered-alert drill, or staffed escalation path is active while Cloudflare is paused.
- **Next gate:** Choose the alert destination and backup owner, create least-privilege saved
  views, prove delivery and redaction with synthetic failures, and record acknowledgement and
  recovery timing.

## Attack register

| Threat | Primary layers | Current control | Residual launch gate |
| --- | --- | --- | --- |
| Session theft, fixation, credential stuffing, or recovery abuse | L06, L07, L11, L13 | Opaque rotated cookie sessions, same-origin mutations, generic auth behavior, exact D1 ceilings | Live cookie/revocation/email evidence, active edge ceilings, alerts |
| IDOR/BOLA or client-side privilege escalation | L04, L07, L10 | Server-derived identity, owner predicates, deny-by-default route inventory, cross-account tests | Authorized staging DAST; future privileged-role design |
| SQL/XSS/multipart/parser/prompt injection | L01, L04, L08, L10 | Allowlists, bounds, parameter binding, contextual encoding, no-tools exact-schema AI boundary | Deployed-composition DAST and provider-edge evidence |
| Secret, dependency, build, or release compromise | L02, L03, L04, L05, L09 | Secret scanning, exact locks, dependency/image gates, CodeQL, signed provenance, protected main | Production IAM/key custody, scanner lag, exception expiry |
| Model output publishing or performing a privileged action | L01, L05, L07, L08 | Private bounded draft only; separate auditable human approval; no model tools or authority | Guarded production migration, legacy audit, live smoke evidence |
| Privacy deletion, restore, migration, or backup failure | L05, L07, L09, L13 | Atomic deletion, tombstones/tasks, aggregate receipts, restore suppression, synthetic drill | Production migration/provider/custody and independent review |
| Request flood, DDoS, cost exhaustion, or provider saturation | L03, L11, L12, L13 | Local endpoint ceilings, bounded retries/cost contracts, production-refusing harness | Active edge controls, isolated load/attack evidence, live alerts |
| Monitoring, support, or operator access leaking private data | L07, L09, L13 | Structured redacted events, no raw URLs/content, no application admin route | Provider IAM/retention, named roles, delivered incident drill |

## Acceptance boundary

This document completes the repository task of mapping all 13 owner-supplied layers into the
threat model. It does **not** complete the parent defense-in-depth or production-hardening gate.
L10 and L12 remain open; L01, L05, L06, L09, L11, and L13 remain partial. Production deployment,
key custody, external alert delivery, edge/WAF activation, isolated staging DAST, independent
review, and live evidence must remain unchecked until their own acceptance records exist.
