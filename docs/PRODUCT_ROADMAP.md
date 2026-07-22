# CastingCompass product roadmap

This list is ordered by user harm and launch risk first, followed by measurement,
validation, expansion, business readiness, and visual polish. An item is complete only
after its acceptance checks pass in the intended environment.

## P0 — Immediate safety and launch integrity

- [x] Complete the cross-functional baseline audit and establish model-truthfulness rules.
- [ ] Prevent AI-generated trip summaries from publishing without explicit human approval.
  Done when the production endpoint defaults off, AI can write only a private draft,
  legacy rows are quarantined, human approval is auditable, copy is truthful, and live
  smoke tests pass.
  - [x] Implement and verify the patched isolated safety-floor commit plus the additive
    approval release.
  - [x] Make the no-runtime-publisher invariant repository-wide. The release source preflight
    now recursively scans every Worker TypeScript module and rejects any `INSERT`, `REPLACE`, or
    `UPDATE` writer for `site_discussion_posts`; private AI-draft storage and bounded cleanup
    deletes remain allowed. Adversarial mixed-case, conflict-clause, quoted-table, and multiline
    writer fixtures fail closed, while the runtime route, migration, and source-safety suite
    passes 24/24. Full local acceptance passes lint, TypeScript, 670 repository tests, the complete
    security/SBOM/policy chain, and both npm audits with zero vulnerabilities. This repository
    guard does not replace the production migration, legacy-row audit, or live smoke gate.
  - [x] Audit the live D1 ledger/schema without reading user rows and locally verify the
    integrated release path: exact `0007` drift reconciliation, one-file migration staging,
    a default-off API/scheduled-work maintenance bridge, aggregate pre/postflight checks,
    immutable checkout binding, and rollback boundaries. Production remains unchanged.
  - [ ] Publish the safety commit first, record its deployment as the rollback floor, apply
    the approved integrated migration sequence, publish the approval release, audit all legacy
    rows, and run live smoke tests using `docs/INTEGRATED-RELEASE.md`.
- [ ] Release production hardening from a clean worktree at the reviewed immutable commit:
  Worker and static-asset security
  headers, health/security endpoints, edge abuse controls, sanitized logs, staged migration
  tests, monitoring, alerts, backup verification, and a restore drill.
  - [x] Implement and locally verify request/body guards, non-cacheable API and security
    headers, a D1-backed health check and security.txt endpoints, provider-log redaction,
    secret scanning, immutable CI actions, dependency-update automation, and fail-closed
    release tooling.
  - [x] Implement and locally verify AES-256-GCM sealing for full-D1 operational exports,
    fixed 89-day retention, private checksum manifests, a role-labeled hash-chained audit log,
    isolated restore, current deletion-ledger replay, validation-ledger integrity checks, and
    aggregate-only evidence.
  - [x] Create an initial encrypted pre-release production D1 artifact with fixed 89-day
    retention, owner-only file modes, a verified audit-chain head, separately stored key
    material, and confirmed plaintext destruction. This is real backup evidence, but it is not
    an accepted restore drill or an approved key-custody policy.
  - [x] Implement and locally verify default-off Turnstile protection for all seven public
    account-abuse flows, including exact action/hostname binding, staged-toggle recovery,
    privacy-minimized provider requests, mobile/accessibility coverage, and provider-independent
    privacy-rights routes.
  - [x] Implement and locally verify the schema-release maintenance bridge, exact staged D1
    wrapper, primary-ledger pre/post checks, live maintenance verifier, and post-`0011`
    fix-forward boundary required to release the accumulated migrations safely.
  - [ ] Deploy the reviewed release, configure and test edge rate limits, create the production
    Turnstile widget and activate it through a separate reviewed change, deliver test alerts,
    approve key custody, complete a non-production restore/deletion-replay drill, and attach
    the remaining production evidence required by `docs/PRODUCTION-OPERATIONS.md`.
    - [x] Complete the repository-controlled, production-shaped synthetic non-production
      restore/deletion-replay drill from clean commit
      `0542074ce681c2fbecbe6ea93ffc443c276b6a7a`. The private aggregate packet created at
      `2026-07-18T06:24:47.211Z` has restore-evidence SHA-256
      `585a156ecbec933c6cdb485340bd04f802be4781d8a0e2bd6a54668c59c309d8`, audit-file
      SHA-256 `1784e89ac1fc4d9798a13c0175ff3dd4c31b8141a621ace3c679f08c1ba30366`, and
      verified audit head
      `ff60f51a34be01d73dfc2a8182d174d4386e6bf03ede2ad71fdf0365d7f5b96c`. It passed
      tamper/wrong-key rejection, integrity and foreign-key checks, current synthetic deletion-
      ledger replay, account/trip/discussion suppression, pending/completed object-task
      preservation, private-value exclusion, and destruction checks. It used no production
      data or provider and deliberately leaves second-person review, real production restore,
      key custody, and the production gate false.
    - [ ] Obtain independent review of the aggregate packet, approve production key custody,
      and complete the provider/deployment evidence without using this synthetic receipt as a
      substitute for the real encrypted backup or a current production deletion ledger.
      - [x] Prepare the fail-closed independent-review handoff: a locked policy and schema,
        immutable three-file packet verification, independently supplied source binding, strict
        audit chronology/hash validation, distinct owner-only review evidence, a minimized
        non-authorizing receipt, and adversarial path/disclosure tests. A guarded packet-derived
        writer now creates the unfilled record exclusively with exact packet hashes, while every
        file requires stable current-user-owned `0600` identity through a bounded no-follow read.
        The actual second-person review, key-custody approval, and provider/production evidence
        remain open.
      - [x] Prepare the separate fail-closed production key-custody evidence handoff. Its locked
        policy covers all seven runtime-secret roles and four backup-key roles; guarded exclusive
        writers create a source-bound evidence manifest and an evidence-hash-bound independent
        review, while stable owner-only readers reject checkout files, broad permissions, links,
        stale evidence, chronology errors, digest reuse, incomplete accepted reviews, and secret
        material. Even an accepted review leaves custody, restore, deployment, and production
        authority false. No provider evidence, secret value, actual custodian, or qualified review
        was supplied during this repository-only preparation. The Cloudflare build, ESLint,
        TypeScript, all 545/545 Node tests, the complete offline security/SBOM/source-integrity
        chain, and both zero-vulnerability npm audits pass under the pinned Node/npm toolchain.
- [ ] Make account privacy promises durable: deletion queue/tombstones for photos and public
  copies, truthful completion semantics, and an age-only first step before email/password.
  - [x] Implement and locally verify single-use age proofs, consent-safe reacceptance,
    authenticated export, atomic active-data removal, durable object cleanup, aggregate
    receipts, retry/lease safety, restore suppression, and operator recovery guidance.
  - [ ] Apply and audit the production migration, verify the exact private R2 binding and
    zero-photo invariant, exercise deletion/export/retry fixtures, deploy the age-proof edge
    ceiling and alerts, complete the restore replay drill, and obtain provider/counsel review.
- [ ] Complete a defense-in-depth security and authorization review before growth, validation
  activation, or broader AI use. Treat every browser, API, uploaded file, model input, model
  output, webhook, and provider response as untrusted; a checklist or nominal layer count is
  not completion without attack-specific tests and production evidence.
  - [x] Map the owner's security-layer reference images into the threat model when the original
    attachments are available, reconcile them with the existing controls, and record each
    control's owner, evidence, alert, recovery path, and residual risk. The three original
    screenshots were recovered and integrity-receipted; `docs/THREAT_MODEL.md` now maps all 13
    layers and preserves the exact acceptance boundary. This completes the mapping only: L10
    dynamic testing, L12 edge filtering, and L13 live detection remain open or partial, and the
    production/provider/independent-review gates below remain unchanged.
  - [ ] Keep session credentials out of `localStorage`: verify `HttpOnly`, `Secure`, appropriately
    scoped `SameSite` cookies, rotation, expiry, revocation, fixation resistance, CSRF defenses,
    and enumeration-safe login/recovery behavior. Client-side session or admin checks may guide
    the interface but must never grant access.
    - [x] Locally implement and verify HTTPS `__Host-` session cookies, hashed 256-bit opaque
      tokens, migration of the prior cookie, atomic rotation after authentication, stale-cookie
      clearing, fixed expiry, logout/password-reset/account-deletion revocation, same-origin
      mutation checks, equal-work invalid login, and generic deferred recovery behavior across
      request, resend, and invalid-code paths. Live cookie, email-delivery, expiry, and revocation
      evidence remains required after the guarded production deployment.
    - [x] Centralize the complete account-bound browser recovery manifest and clear it from both
      `localStorage` and `sessionStorage` only after an exact sign-out receipt, a read-only session
      check that confirms logout, or an accepted account-deletion receipt. Cleanup now covers the
      active-trip recovery secret, anonymous reporter identifier, trip/profile drafts, stable
      idempotency request material, pending-operation markers, and actual legacy keys; unrelated
      site preferences remain untouched. Ambiguous sign-out preserves the data, and blocked local
      cleanup leaves the server sign-out authoritative while visibly directing the user to clear
      site data before sharing the browser.
  - [ ] Define and approve a deny-by-default access-control matrix for anonymous users, account
    owners, moderators, support, operators, and administrators. Enforce it server-side on every
    route and object lookup, with privilege-escalation, insecure direct-object reference, and
    cross-account tests. Because D1/SQLite has no native PostgreSQL-style row-level security,
    require an equivalent per-record ownership/role predicate in the data-access layer and test
    that omitted or mismatched identity fails closed.
    - [x] Document the current matrix, add an executable fail-closed route inventory shared
      by routing and abuse controls, and locally verify that a second authenticated account
      cannot read an owner's photo/export data or delete the owner's trip/gear. Approval of
      future moderator, support, and operator roles remains open.
    - [x] Close the registry's method-classification gap. A known path no longer permits an
      unclassified method to reach handler-local checks: the Worker derives the exact method set
      from the same executable policy, returns a generic non-cacheable `405` plus its narrow
      `Allow` header for a method mismatch, preserves generic `404` for unknown paths, and performs
      this rejection after the generic abuse ceiling but before body reads and every API handler
      dispatch. Exhaustive policy examples cover ordinary and extension methods, and source-order
      tests keep the central boundary ahead of request parsing and handlers.
    - [x] Remove first-match precedence from the executable access-control registry. A request is
      admitted only when exactly one policy claims its path and method; overlapping policies now
      return a generic non-cacheable `503` before body parsing and handler dispatch instead of
      allowing array order to choose an actor, handler, same-origin, legal, or abuse-control
      contract. Rejected conflicts retain the union of stronger abuse-limit tags, and synthetic
      owner/public plus wildcard/specific-method collisions prove the boundary fails closed.
    - [x] Make the registry's same-origin field centrally enforceable rather than descriptive.
      After the generic abuse ceiling but before body parsing or dispatch, every admitted policy
      marked `sameOriginRequired` now requires the exact canonical request origin; missing,
      opaque, malformed, noncanonical, downgraded, lookalike, and cross-site values receive a
      generic non-cacheable `403`. Conflict, unknown-path, and wrong-method rejection retain
      precedence, public/read routes stay origin-independent, and handler-local assertions remain
      as defense in depth.
    - [x] Make the registry's handler field executable rather than descriptive. Every classified
      API request now dispatches only to the health, Turnstile, discussion, account, or trip
      handler named by its singleton policy. A missing policy, unknown handler value, or assigned
      handler that returns null produces a generic non-cacheable `503` before the request can
      reach another handler, image optimization, or the static application. The focused registry
      suite passes 10/10, including representative production-bundle dispatch for all five
      families, and the production-off build plus all 693/693 Node tests pass under the pinned
      runtime; non-API routing and protected-trip owner/legal checks remain unchanged.
    - [x] Make the registry's owner and current-legal fields executable before body parsing.
      Every singleton `owner` policy now resolves a live server-side session after generic abuse,
      route/method/conflict, and same-origin rejection but before the body guard. Missing storage,
      missing authority, deletion fences, and stale legal acceptance fail with distinct truthful
      responses. Exactly six policy rows preserve the existing export/profile/delete access
      needed during deletion; receipt and optional-session routes remain separate. Account and
      trip execution repeat live authorization so revocation/fence races fail closed. The focused
      registry suite passes 10/10, the production-off build plus all 694/694 Node tests pass, the
      feature-on photo lane passes 8/8, the restored phone matrix passes 228/228, and the full
      security/SBOM/query-policy chain plus both zero-vulnerability audits pass under the pinned
      runtime.
    - [x] Make the registry's deletion-receipt class executable and correct its clear-route
      classification. The only receipt-protected policy now validates the path-scoped cookie and
      live hash-bound D1 row centrally before body guarding, then the account handler repeats the
      lookup so removal or expiry wins. Any future receipt policy fails closed until it has an
      explicit preflight. `DELETE /api/privacy/deletion-status` is now truthfully public but
      same-origin: it only expires this browser's cookie, performs no privileged or provider
      mutation, grants no authority, and remains available when D1 is unavailable. Optional-
      session behavior is unchanged. Exact-tree acceptance passes the production-off build and
      all 695/695 Node tests, the feature-on 8/8 photo lane, the restored 228/228 phone matrix,
      ESLint, TypeScript, the complete security/SBOM/query-policy chain, and both zero-
      vulnerability npm audits. The same reviewed slice also advances Next.js and its matching
      lint config from 16.2.10 to the advisory-fixed 16.2.11 and refreshes deterministic SBOMs.
    - [x] Bind active-trip completion and cancellation to the authenticated account in both
      the handler precheck and the final D1 update. The write now requires the same trip ID,
      account ID, active state, and token hash atomically; exact-token cross-account and
      ownership-change race regressions prove mismatched identity remains an indistinguishable
      `404` without completing or canceling the row.
    - [x] Resolve lost terminal-write responses from exact D1 post-state instead of mutation
      metadata. Completion binds owner, live source, persistent idempotency hash, cleared token,
      server timestamps, mode, and photo locator; cancellation binds owner, live source,
      persistent hash, cleared token, and request timestamp. Lost committed-response regressions
      prove truthful success without weakening the final ownership/token predicates.
    - [x] Remove fetch-then-check reads from owner trip flows. Trip rows and their enrollment,
      forecast-impression, feasibility-start, feasibility-recruitment, and prior-recruitment
      context now bind the server-derived account in the query itself. Profile-edit reads for
      feasibility start, completion, and correction state repeat the parent-trip owner gate.
      A separately named
      collision check returns only constant `1` by random client-trip ID so duplicate identities
      remain a generic `409` without projecting another account's row or sidecars. The complete
      D1 inventory machine-checks all nine owner reads and this narrow opaque exception.
    - [x] Bind manual advisory-review retry to the complete authenticated trip version. Every
      transactional compare-and-set repeats `id`, `user_id`, completed state, the exact prior AI
      status/payload/model/timestamp fields, and the trip update version. Read-back then proves
      exact queued/prior/owner/global cardinality by primary key before scheduling or returning the
      queued count. Ownership or input-version drift queues and dispatches nothing.
    - [x] Recover manual advisory-review retry after missing metadata or a lost committed batch
      response without trusting either. Exact queued state enters the internal scheduler; rollback
      or an unreadable receipt returns `503`; changed/claimed/completed state is not rescheduled.
      The default-off backlog still includes queued rows for durable recovery, while both direct
      and queue-enabled downstream paths use separate high-entropy claim tokens so concurrent
      callbacks cannot duplicate provider authority. One ten-row owner request starts at most one
      immediate background scheduler; the remaining exact queued rows stay in the durable backlog,
      avoiding ten same-invocation pipelines and retaining local D1-budget headroom. All model
      output remains private and human-gated.
    - [x] Make owner gear mutation receipts database-authoritative. PATCH and DELETE repeat `id`
      plus `user_id`, but mutation metadata and transport success no longer decide the receipt.
      PATCH requires the exact normalized owner row and server timestamp; DELETE requires zero
      global rows for the opaque ID, treats a same-owner concurrent removal as idempotent success,
      and returns the same `404` if ownership moved. Lost committed responses recover without
      replay, while a mismatched post-state remains `503`.
    - [x] Make gear-preset creation database-authoritative after storage response loss. The
      server-generated identifier, authenticated owner, every normalized field, and both server
      timestamps must match an exact D1 row before the `201` receipt is returned; absence resolves
      to the documented 100-row limit only when an owner-bound bounded read confirms that limit.
    - [x] Make saved-location receipts database-authoritative. The browser changes its confirmed
      saved state only after an exact server receipt, so creation and removal now read the exact
      owner/site row after D1. Presence authorizes saved state; absence authorizes idempotent
      removal, and a bounded owner read distinguishes a real 100-location ceiling from an
      unconfirmed write. Lost committed responses resolve without replaying the mutation.
    - [x] Separate pending-trip moderation conflicts from missing mutation receipts. PATCH and
      DELETE keep the final `id` plus `user_id` plus pending-state predicate; an authoritative zero
      remains `409`, while malformed D1 metadata is now a replay-blocking `503` rather than a
      false reviewed-trip claim. Unconfirmed deletion preserves the opaque status receipt cookie.
    - [x] Make legal reacceptance receipts database-authoritative. The compare-and-set repeats the
      complete authenticated account/legal version and the exact still-live session. Read-back
      must prove the request's current Terms/Privacy timestamps and versions, absence of the prior
      snapshot, unique account identity, and continuing session authority. Missing metadata and a
      lost committed response recover without replay; rollback, unreadable or changed state
      returns `503`, while a deleted account or revoked session returns `401` and clears stale
      cookies. Prior age eligibility remains untouched.
    - [x] Require an exact credential-lifecycle receipt before completing password reset. Password
      update, all-session revocation, and one-use challenge consumption remain one atomic batch;
      success requires the exact new salt/hash/timestamp row, zero prior sessions, zero challenge
      rows, and no deletion fence. Missing metadata and a lost committed response recover without
      replay; rollback, unreadable or conflicting state, and fence races return `503` and create no
      replacement session. A rotated challenge remains the same safe `409`.
    - [x] Require an exact account-lifecycle receipt before completing verified signup. User
      creation and one-use challenge deletion remain atomic and repeat the complete challenge
      snapshot. Welcome delivery and first-session issuance require the exact new credential,
      age/legal fields and timestamps, unique ID/email cardinality, zero prior sessions, zero
      challenge rows, and no deletion fence. Missing metadata and a lost committed response recover
      without replay; rollback, unreadable or conflicting state, and fence races return `503` with
      no downstream side effect. A rotated challenge remains the same safe `409`.
    - [x] Require an exact database session receipt before setting any login, signup, password-
      reset, or legacy-rotation cookie. The candidate token is hashed once and exposed only after
      read-back proves its random hash, owner, timestamps, live user, and absent deletion fence.
      Missing metadata and lost committed batch responses resolve from that state without replay;
      unreadable or mismatched state returns `503`, clears both cookie forms, and deletes the
      candidate hash so no usable or orphaned session survives an ambiguous receipt.
    - [x] Require exact stored-state revocation receipts before returning the sign-out response
      that permits browser recovery-state deletion. Every distinct presented token is hashed and
      deleted transactionally, then read back by its primary key; only readable zero cardinality
      for every token permits cookie clearing. Missing mutation metadata and a lost committed
      response recover from exact absence. Rollback, unreadable state, or row reappearance returns
      `503` while retaining the cookie so sign-out can be retried or checked without losing the
      only revocation handle.
    - [x] Bind every secret-bearing age-proof and email-challenge side effect to exact stored-state
      receipts. Plaintext age proofs require the full random-hash/timestamp/gate snapshot; one-use
      consumption proves exact consumed versus prior state before challenge creation. Initial
      signup and recovery challenges prove the complete credential snapshot, unique ID, and
      rolling email ceiling. Resends compare-and-set the full prior version and read back complete
      next/prior snapshots before delivery. Missing metadata and committed response loss recover
      without replay; rollback, unreadable or changed state authorizes no secret/provider side
      effect. Candidate-only cleanup repeats the complete snapshot, and password recovery retains
      its generic anti-enumeration response.
    - [x] Bind final signup and password-reset authority to the exact verified challenge snapshot,
      not a pre-transaction read. User/password mutation, session revocation, and one-use challenge
      consumption repeat kind, user where applicable, code hash, creation time, attempt count, and
      expiry in the atomic batch. A concurrent resend makes the old code change zero rows and leaves
      the newer code intact; success requires authoritative receipts for every terminal statement.
  - [ ] Verify strict schema/size/type validation, contextual output encoding, safe database
    binding, upload signature and metadata checks, and AI prompt-injection boundaries. Model
    instructions and user content remain data, never authority; models receive no ambient
    secrets or unrestricted tools, outputs must match narrow schemas, and no model output can
    publish or mutate privileged state without a separately authorized server action.
    - [x] Locally enforce and attack-test endpoint field allowlists, duplicate multipart-field
      rejection, existing body/type/length bounds, parameter-bound D1 writes, default-off
      image uploads with signature verification and metadata-stripping WebP re-encoding, React
      output encoding, and the escaped JSON-LD script context. The advisory AI boundary now
      minimizes stored input, separates untrusted data from system instructions, has no tools
      or ambient authority, applies a hard deadline and 64 KiB response cap, requires an exact
      bounded output schema without type coercion or prose wrapping, redacts failure logs, and
      still cannot create a public post. Production edge evidence and authorized staging
      penetration testing remain open.
    - [x] Make every future private trip-photo object discoverable before R2. The default-off
      upload path commits and exactly reads back a typed locator reservation before the object
      write; exact attachment removes it, while ambiguous provider/database outcomes remain in a
      leased, bounded scheduled reconciler. Atomic pending-state predicates serialize attachment
      against cleanup ownership. Reconciliation preserves an attached object, deletes only an
      unattached object, and makes zero R2 calls on a locator-hash mismatch. Migration
      `0020` plus production alerts/drills remain required before enabling uploads.
    - [x] Locally serialize account deletion against private-photo writes. Password-confirmed
      deletion establishes a leased D1 account fence before inventory; new sessions, trip inserts,
      photo reservations, and photo attachment repeat that fence predicate in the authoritative
      statement. Pre-fence reservations are adopted into the deletion ledger with their later
      safe-cleanup time, every destructive statement repeats the exact fence lease, and exact
      post-state resolves lost committed responses. Failed batches retain the fence and freeze
      account mutations for a safe retry. Production migration, monitoring, bucket drills, plan-
      budget evidence, independent review, and explicit upload activation remain open.
      - [x] Bound large private-object inventories without truncation. Four source-bound
        `INSERT INTO ... SELECT` statements materialize prior cleanup tasks, reservations,
        export objects, and attached trip photos in D1; the destructive account transaction is
        fixed at 18 statements regardless of object count. `trips.photo_key_hash` makes the
        attached-object identity exact, and a legacy locator without its hash inserts no job,
        removes no active row, touches no object, and leaves the account fenced for protected
        migration. Cold 75-photo and lost-committed-response tests stay within the 50-query Free
        ceiling and 100-parameter ceiling. Runtime auth initialization now performs one
        read-only migration-readiness query instead of request-time DDL. Production application,
        timing/rows-read evidence, private-bucket drills, and independent review remain open.
  - [ ] Verify endpoint-specific rate limits and abuse ceilings for login, recovery, signup,
    uploads, exports, deletion, reports, and AI routes. Adopt length-based password rules that
    allow password managers/passphrases, block breached/common passwords using a privacy-safe
    lookup, reject account-derived patterns, and avoid arbitrary composition rules that reduce
    usability without improving security.
    - [x] Locally implement and verify new-password length rules, account/service-derived
      pattern rejection, padded five-character HIBP range lookup, fail-closed provider handling,
      privacy disclosure/versioning, and compatibility for existing ten-character passwords.
    - [x] Locally implement and attack-test default-off Worker ceilings for public auth and
      email flows, authenticated writes, reads, exports/deletion/manual AI retry, and aggregate
      AI-provider dispatch. Request counters receive only a secret-keyed IP pseudonym; they run
      before body parsing, return generic non-cacheable responses, and fail closed when enabled
      configuration is missing or unavailable. Existing D1 login/email/trip ceilings remain the
      durable exact controls. Production secret provisioning, activation, outer WAF rules,
      threshold tuning, monitoring, and live endpoint evidence remain open.
    - [x] Make the durable D1 login and email-code ceilings atomic under concurrency. Sign-in
      claims one of ten rolling failure slots, requires exact pending-row and rolling-window
      read-back before credential work, and issues no session until exact read-back proves that
      same row successfully classified with its prior pending state absent. Signup and recovery
      challenge creation recheck the five-per-hour ceiling inside their INSERT, before provider
      delivery. Every verification or
      reset code submission compare-and-sets the complete challenge snapshot to its next attempt
      count, then requires exact read-back of that claimed version with the prior state absent.
      Missing metadata and lost committed responses recover without replay; rollback, unreadable
      or changed state authorizes no credential transition, concurrent signup changes remain
      `409`, and password recovery retains its generic anti-enumeration response. Six claims remain
      the hard ceiling.
  - [ ] Verify encryption in transit and at rest, key separation/rotation/recovery, least
    privilege, secret scanning, dependency/runtime/action version locks, reproducible builds,
    an SBOM, vulnerability-response ownership, and restore-tested backups. Pinning must include
    a scheduled reviewed update path so security fixes are not frozen out.
    - [x] Locally pin direct npm packages, Node/Python CI runtimes, runner labels, and immutable
      action commits; remediate the known npm advisory tree to zero; add high/production-
      moderate audit gates, pull-request dependency review, a deterministic CycloneDX
      production SBOM bound to the package-lock hash, and an owner/deadline/update runbook.
      The exact npm CLI and a fail-closed zero-execution install-script policy are now locally
      enforced; hosted Linux and merge evidence remain required. Cloudflare deployed-digest
      evidence, key custody, and restore drills remain open.
    - [x] Remediate the later `fast-uri` `GHSA-v2hh-gcrm-f6hx` and Sharp/libvips
      `GHSA-f88m-g3jw-g9cj` disclosures with exact `3.1.4` and `0.35.3` overrides. Both audits
      return zero vulnerabilities, Sharp no longer declares an install hook, and production-SBOM
      membership is derived from locked root reachability so cross-platform Sharp artifacts stay
      covered without admitting development-only Playwright or Ajv paths.
    - [x] Add a fail-closed Cloudflare provider-state policy and redacted read-only analyzer that
      distinguishes disconnected Git builds from a paused Worker, compares the active runtime and
      binding contract, and refuses source/hold/release claims without private exact identity and
      live-host evidence. CI performs only offline verification. The 2026-07-19 reconciliation
      found the Worker active with maintenance off and configuration drift; provider repair,
      deployment, migrations, and production acceptance remain open.
    - [x] Locally require a locked, action-specific production-change authorization before every
      Worker deployment and staged D1 mutation. The canonical packet stays private and outside all
      release checkouts, expires within six hours, and binds full official-main release and gate
      commits (the same commit except for the pinned historical safety-floor target). It requires
      distinct operator and independent-review evidence and contains only SHA-256 evidence
      references. The no-shell deploy wrapper authorizes before exact-tool reinstall/build/Wrangler
      execution, while the migration wrapper maps `0007` and each `0009`–`0018` file to separate
      actions. This prevents an environment variable or static confirmation alone from reaching
      Wrangler; it does not supply missing human review, provider evidence, key custody, alerts,
      migrations, live verification, or production acceptance.
    - [x] Define source-bound, exact, SHA-256-hashed, binary-only optional Geo/PyTorch locks for
      CPython 3.12 on macOS 15+ ARM64/MPS and manylinux_2_28 x86-64/CPU; add scheduled hosted
      execution that checks platform/backend identity, exact package identity, GeoTIFF/CRS
      behavior, pipeline tests, and deep smoke. CUDA, ROCm, Windows, Intel macOS, and other
      unlisted environments remain outside the approved reproducibility claim. PR `#72`, main
      CI `29628030773`, optional-platform run `29628030735`, exact dependency snapshot
      `83450872`, and CodeQL run `29628030502` are the immutable merge receipts.
    - [x] Produce and independently verify a deterministic GitHub release candidate plus signed
      SLSA build provenance and CycloneDX predicates without granting OIDC/write permission to
      repository or dependency code. Corrective PR `#77` merged as
      `fa73c4dd4162b6834113f40a6f77be6907bdd202`; main release-provenance run
      `29629689167` signed bundle digest
      `e2d8b79a39a28c9ae97ba1c384e1f8eacffe95275ea6b7eaf79d3baee8f12ad0`
      as attestations `35935237` and `35935240`. A fresh artifact download passed checksums,
      the independent bundle verifier, and identity-constrained `gh attestation verify` for
      both predicates. Main CI `29629689192`, dependency snapshot `83454900`, and CodeQL
      `29629688765` passed, followed by zero open dependency, code-scanning, or secret-scanning
      alerts. This completes GitHub release-candidate provenance only; the combined inventory,
      Cloudflare deployed-digest proof, unapproved platform locks, key custody, and restore drill
      remain open.
    - [x] Produce and independently verify the deterministic combined release SBOM that embeds
      the production npm graph, exact hashed API/pipeline Python graphs, identity-level pinned API
      image/Debian runtime, and Worker/D1/assets contracts. Keep package-level Debian image
      contents and Cloudflare deployed bytes outside the claim until separately evidenced. PR
      `#79` merged as `d98d947360df4845901ca95c921b9e10733f6aaa`; release-provenance run
      `29630783417` signed the independently verified 124-file bundle digest
      `5a106e016c15ae269a7dc1b28ebdb04f281e125dfb63456b03f20b2b43938805` and combined-SBOM
      digest `bccfc8e094de5fe3783d8c834ae9782ef70c9354999956c562454588eae57d0a` as SLSA
      attestation `35937141` and CycloneDX attestation `35937144`. Main CI `29630783432`, exact
      dependency snapshot `83457741`, and CodeQL `29630783254` passed, followed by zero open
      Dependabot, code-scanning, or secret-scanning alerts. This closes the source-bound combined
      inventory only; package-level image scanning, deployed Worker proof, and license/advisory
      reconciliation remain open.
    - [x] Build and accept a native AMD64/ARM64 package-level API image gate. The reviewed
      candidate upgrades only the API from Python 3.12.13/Bookworm to maintained Python 3.13.14
      on the exact official Alpine 3.24 image index, reducing the local ARM64 scan from 215 total
      findings (8 critical, 30 high) to 11 total findings (0 critical, 3 high). It also removes
      pip/ensurepip and the unused affected `tarfile`/`html.parser` modules, eliminates shell-based
      startup, verifies all 22 applicable locked Python packages plus 29 APK packages and their
      licenses, and fails closed on unreviewed/expired high or any critical finding. The three
      temporary CPython exceptions originally expired 2026-08-01. PR `#81` merged exact accepted head
      `7de5d51c3e8b7d02faff242ad2acc33d6e04441a` as
      `73d0e3ca879a609673ba57188f59b37f541083a5`. Exact-head native run `29632875263`
      passed both architectures; artifacts `8426086733` (AMD64) and `8426089424` (ARM64)
      preserve the raw SBOM/Grype reports and normalized summaries through 2026-08-17. Fresh
      downloads bound that exact head and confirmed 29 APK packages, 22 applicable Python
      packages, 11 findings, 0 critical, 3 reviewed high, and the 2026-08-01 exception expiry on
      each architecture. Main run `29633038674` repeated the proof for the merge commit in
      artifacts `8426143583` and `8426146269`; main CI `29633038669` passed with dependency
      snapshot `83465511`, release-provenance `29633038673`, optional-platform `29633038688`, and
      CodeQL `29633038335` passed, followed by zero open dependency, code-scanning, or
      secret-scanning alerts. CodeQL alert `#4` was fixed in source without dismissal before merge.
      A 2026-07-18 primary-source review found no fixed stable Python 3.13 image, so PR `#90`
      added an owner-bound 2026-08-04 re-review and 2026-08-08 hard expiry without restoring the
      removed modules. Exact head `f20c210bb8014baee62c9bf09010a3d5a99c5d97` passed native
      image run `29652969712` plus CI, provenance, and CodeQL, then merged as
      `f1a6579ca97fa509b0b1ac1367c6fa7e4c644104`. Main image run `29653146520` preserved AMD64
      artifact `8432074834` and ARM64 artifact `8432075433`; both record 29 APK packages,
      22 locked Python packages, 8 medium, 3 reviewed high, and 0 critical findings. Main CI
      `29653146497`, release-provenance `29653146479`, and CodeQL `29653146307` passed, followed
      by zero open dependency, code-scanning, or secret-scanning alerts. Issue `#86` stays open
      and fails closed after the bounded renewal unless the first fixed stable official image is
      adopted and natively re-verified. A dependency-free daily official-source watch now closes
      the Monday-native-scan/Tuesday-release cadence gap and fails on maintained-version,
      checksum, source-revision, tag, directory, or AMD64/ARM64 publication drift. This is early
      detection only; it neither closes `#86` nor substitutes for the required two-architecture
      native replacement scan.
    - [x] Enable live `main` protection with pull requests, strict app-bound GitHub Actions and
      Advanced Security `CodeQL` checks, resolved conversations, administrator enforcement, and
      force-push/deletion denial; enable Dependabot security updates, secret-scanning push
      protection, private vulnerability reporting, and GitHub-managed CodeQL for Actions,
      JavaScript/TypeScript, and Python. The initial CodeQL findings were individually reviewed:
      the public test-protocol identifier was documented as a test-only false positive, while
      biased verification-code generation and overly broad CLI output were remediated and
      regression-tested.
    - [x] Lock the exercised FastAPI and pipeline CI Python graphs to exact transitive versions
      and committed SHA-256 distribution hashes, bind lock metadata to its source inputs, keep
      test-only packages out of the API image, enforce pip
      all-or-nothing hash checking and binary-only installs in CI/API containers, pin the API
      Python base image by patch and multi-platform digest, and schedule Docker updates. The
      unapproved optional Geo/PyTorch platforms and signed deployment provenance remain open.
    - [x] Locally remediate the dependency-graph alerts by upgrading the validation/CI graph to
      `cryptography` 48.0.1 and the API test graph to `pytest` 9.0.3; regenerate the source-bound
      hashed locks and pass isolated Python 3.12.13 installs, query-plan checks, API tests,
      pipeline lint/tests, and the deterministic smoke workflow. The patched files are on the
      default branch; at that point Dependabot alert `#2` had not refreshed and remained open
      pending a fresh dependency-graph evaluation rather than being manually hidden as proof.
    - [x] Locally repair the managed Python graph inputs after GitHub's job evidence showed two
      ingestion failures: its per-directory API resolver selected Python 3.14 and could not use
      the old `psycopg-binary` wheel, while its pipeline parser would not follow a `.lock`
      constraint suffix. Preserve the canonical frozen validation lock behind a byte-identical
      parser-readable `.txt` mirror, group the Psycopg family, upgrade it to the reviewed 3.3
      releases, regenerate all source-bound hashed locks, and pass isolated API/pipeline
      verification. Both configured graph updates then completed with exact `pytest` 9.0.3 and
      Psycopg 3.3.4 package URLs, and alert `#2` automatically changed to fixed without
      dismissal. A separate hosted version-update job used Python 3.14.5 despite the
      directory-local selectors, so those selectors are documented only as local-tool mirrors
      rather than a provider-runtime control.
    - [x] Locally add and attack-test a main-only, post-API/pipeline dependency-submission job
      that converts all three exact hashed Python locks into versioned PyPI package URLs, scopes
      runtime versus development graphs, records direct versus indirect relationships, rejects
      non-main or incomplete commit identity, and holds its required write permission only in
      the isolated submission job. Main CI run `29621586247` accepted snapshot `83398229` after
      both tested Python jobs passed at commit `716c3ecef29af7a85791972593ee96fca0c7f8af`; the
      configured graph already exposed exact SPDX `versionInfo` values and alert `#2` was fixed
      automatically, completing this subitem's provider evidence.
    - [x] Remediate the six distinct Starlette advisories surfaced by the exact graph (12 alerts
      across the API runtime and test manifests), including three high-severity denial-of-service
      or Windows file-serving findings. Upgrade the reviewed pair to FastAPI 0.139.2 and
      Starlette 1.3.1, the first Starlette release above every affected range; regenerate the
      source-bound locks and verify malformed Host/path handling plus the API's GET/OPTIONS-only
      surface. Move the test client from deprecated `httpx` compatibility to Starlette's
      preferred exact `httpx2` backend. Main CI run `29622373929` passed the API, pipeline,
      web/mobile, and dependency-submission jobs at merge commit
      `8d130c47c7cd708eefc47bdbfd83e391ce4b08c7`; snapshot `83408257` was accepted, managed graph
      run `29622376160` succeeded, and the SPDX graph recorded FastAPI 0.139.2, Starlette 1.3.1,
      and httpx2 2.7.0. GitHub then closed alerts `#3` through `#14` automatically as fixed
      without dismissal, completing the external evidence gate.
    - [x] Upgrade and externally verify the frozen validation runtime from scikit-learn 1.6.1
      to 1.9.0 with
      exact narwhals 2.24.0 identity and source-bound wheel hashes while intentionally retaining
      the reviewed NumPy 2.0.2, SciPy 1.13.1, and pandas 2.2.3 boundaries. Isolated old/new
      seed-12 and seed-42 comparisons preserved every spatial fold and all naive/boosted aggregate
      outputs exactly; the largest linear aggregate delta was `0.000150451`, below the committed
      `0.001` numerical canary. The change removes the deprecated explicit logistic-regression
      penalty, renormalizes clipped multiclass probabilities, rejects future deprecation warnings
      in CI, and passes exact hash installation, 62 pipeline tests, the deterministic smoke workflow,
      and 305 repository contract tests. PR `#64` passed dependency review, API, warning-strict
      pipeline/smoke, web/mobile, and all CodeQL analyses before merge commit
      `9a66eb65f8222fce6338d2518371ea8d6d413b09`. Main CI run `29625410418` passed all jobs and
      accepted exact dependency snapshot `83443013`; managed graph run `29625412040` and main
      CodeQL run `29625410265` succeeded; the SPDX graph records scikit-learn 1.9.0 and narwhals
      2.24.0; and the post-merge alert audit found zero open dependency, code-scanning, or secret-
      scanning alerts. The paired NumPy/SciPy review is tracked separately below; pandas and
      optional-platform locks remain open.
    - [x] Advance the coupled numerical foundation to NumPy 2.5.1 and SciPy 1.18.0
      while retaining scikit-learn 1.9.0 and pandas 2.2.3 for separate review. Promote SciPy to
      an explicit direct dependency, regenerate the 15-package source-bound hash lock, bind both
      versions to evaluator identity, and add an exact relief-filter canary. Isolated seed-12 and
      seed-42 comparisons produced byte-identical synthetic fixtures and identical spatial folds;
      naive outputs were exact, boosted differences were floating-point roundoff, and the largest
      aggregate delta was `0.000000357`, far below the committed `0.001` canary. A clean Python
      3.12.13 hash-only install passed `pip check`, Ruff, 62 warning-strict pipeline tests, and the
      deterministic smoke workflow. PR `#68` passed dependency review, API, warning-strict
      pipeline/smoke, web/mobile, and all CodeQL analyses before merge commit
      `6ce2ec37de9f6cbe22f85cae05baff256adb3a51`. Main CI run `29626219455` passed all jobs and
      accepted exact dependency snapshot `83445590`; managed graph run `29626220947` and main
      CodeQL run `29626219486` succeeded; the SPDX graph records NumPy 2.5.1, SciPy 1.18.0,
      scikit-learn 1.9.0, narwhals 2.24.0, and retained pandas 2.2.3; and the post-merge alert
      audit found zero open dependency, code-scanning, or secret-scanning alerts. The separate
      pandas 3 review remains open.
    - [x] Advance pandas 2.2.3 through the recommended warning-clean 2.3.3 bridge to
      pandas 3.0.3, while retaining NumPy 2.5.1, SciPy 1.18.0, and scikit-learn 1.9.0. Do not use
      pandas 3.0.4: PyPI yanked it for reported datetime-related segmentation faults. Bind the
      pandas 3 dedicated-string and copy-on-write semantics with an explicit ingestion canary.
      Under Python 3.12.13, all three pandas versions produced byte-identical seed-12 and seed-42
      observation fixtures and metric artifacts; the 2.3.3 bridge and 3.0.3 candidate each passed
      `pip check`, Ruff, 62 warning-strict pipeline tests, and deterministic smoke workflows. The
      regenerated 14-package source-bound lock then passed a clean hash-only install, `pip check`,
      Ruff, 63 warning-strict tests including the new canary, and both deterministic seeds. PR
      `#70` passed hosted dependency review, API, warning-strict pipeline/smoke, web/mobile, and
      all CodeQL analyses before merge commit
      `3d5751b3ec8ce0f263fd9afebe4a6018315a63c3`. Main CI run `29626959333` passed all jobs and
      accepted exact dependency snapshot `83447588`; managed graph run `29626961391` and main
      CodeQL run `29626959344` succeeded. The SPDX graph records exact pandas 3.0.3, NumPy 2.5.1,
      SciPy 1.18.0, scikit-learn 1.9.0, and narwhals 2.24.0 entries, and the post-merge alert audit
      found zero open dependency, code-scanning, or secret-scanning alerts. Only the separate
      optional-platform lock work remains open for this dependency family.
    - [x] Locally inventory all seven Worker runtime secrets, extend named-secret scanning and
      ignored local Wrangler secret files, define environment/purpose/backup-key separation,
      document D1 managed-encryption and application-controlled AES-256-GCM boundaries, and
      record feature-specific rotation and recovery hazards. Production IAM/MFA evidence,
      actual binding/key IDs, approved custody, rotation exercises, and restore drills remain
      open, so the parent gate is not complete.
  - [ ] Exercise the attack surface in an isolated staging environment with authorized load,
    stress, and penetration tests; remediate critical/high findings and retest before production
    promotion. Never aim stress or intrusive security testing at production user data.
    Repository preparation is locally complete: the strict private authorization contract,
    staging-only API/Worker/exercise health identity with live cross-contract tests, permanently
    blocked production inventory, bounded digest-pinned ZAP runner, and a read-only load harness
    that requires a clean reviewed exact-source checkout plus the exact isolated-staging identity
    before any timed remote request. Adversarial refusal tests, private raw security evidence, and
    the aggregate-only security receipt are in
    [SECURITY-TESTING.md](SECURITY-TESTING.md). PR `#98` merged as
    `fb4662cf725c3a1f99b4e918a19c6e72971a6b85`; main CI `29669810196`, release provenance
    `29669810179`, CodeQL `29669809994`, and native image security `29669810191` passed that
    exact commit without a deployment. This item remains open until isolated provider resources,
    written independent authorization, a real public/authenticated/manual exercise,
    remediation/retest, and independent acceptance exist.
    - [x] Prepare the narrow authenticated advisory-review drill without creating an execution
      path: lock a private exact-source authorization/schema and plan-only CLI; require one hashed
      synthetic account plus disjoint ten-trip direct and Queue sets; distinguish client response
      loss from D1 mutation-receipt loss; and make unique D1/stub identities authoritative rather
      than summing HTTP queued fields. Add an exact exercise/service-binding/account/stub-version
      gate and a deterministic no-route stub that rejects credentials, echoes no trip input, and
      can never fall back to the real provider. Production config is machine-checked to contain
      none of these bindings or variables. No staging target, Queue, provider, D1, or production
      resource was contacted; provisioning, authorization, execution, remediation, and independent
      acceptance remain open.
    - [x] Freeze the main isolated-staging Worker configuration before provider provisioning:
      validate two private resolved Wrangler configurations against an exact schema and locked
      production exclusion inventory; require one shared non-production host, D1 database, six
      rate-limit namespaces, exercise service, synthetic account, and stub version; keep all public
      features and undeclared providers/bindings off; and generate only a minimized hash receipt.
      Correct the drill to require distinct direct and durable-Queue Worker versions because the
      Queue feature flag and bindings are deployment configuration. The verifier has no deploy or
      network command. Provider resources, both deployments, live identity evidence, written
      authorization, exercise execution, remediation/retest, and independent acceptance remain
      open. See [ISOLATED-STAGING-CONFIGURATION.md](ISOLATED-STAGING-CONFIGURATION.md).
- [ ] Complete the privacy lifecycle and deletion policy before broader account recruitment.
  Maintain a data inventory and cascade map covering primary rows, public copies, objects,
  queues, logs, analytics, exports, derived artifacts, and backups; make deletion retries and
  restore suppression observable and auditable without retaining raw deleted content.
  - [x] Document and locally machine-check the complete D1/object/provider/browser/backup
    inventory, foreign-key and trigger cascade map, atomic active-data deletion order,
    non-recoverable current behavior, and a privacy-minimized EU/UK/California-aware request
    workflow. Production-shaped drills, processor execution, dashboard case controls, and
    privacy/counsel approval remain open.
  - [x] Freeze a strict PII-minimized case schema, default-deny clock/deletion policy, semantic
    evaluator, safe CLI, and deterministic synthetic access/portability/export-before-erasure
    drill. The aggregate receipt deliberately refuses production readiness while counsel,
    processor-retention review, an approved case provider, a witnessed production-shaped drill,
    and independent acceptance remain absent.
  - [x] Require exact lease authority and recompute the store-bound locator hash immediately
    before every private-object deletion. Corrupt bindings fail closed without an R2 call;
    privacy-export locator clearing and task completion are atomic; and exact terminal read-back
    resolves lost committed responses without trusting mutation metadata. This is local runtime
    evidence only—the production binding, migration, alert, restore, and independent-review gates
    remain open.
  - [ ] Decide with privacy/counsel review whether an ordinary account closure may offer a
    clearly disclosed 30-day recovery window. If adopted, revoke access immediately, isolate
    recovery data from active/public use, automatically hard-delete it at day 30, and let a
    verified erasure request bypass recovery. Do not silently weaken the existing immediate
    active-data removal and durable public/object cleanup promises.
  - [ ] Publish and drill GDPR/UK GDPR/CCPA-style access, correction, portability, deletion,
    objection, and appeal workflows; verify identity proportionately, meet applicable response
    clocks, inventory processors and transfers, minimize logs, and document lawful retention
    exceptions rather than claiming universal compliance without review.
- [ ] Provide a safe maintenance experience on every production hostname: a branded,
  accessible maintenance page for browsers; non-cacheable `503` API responses with bounded
  `Retry-After`; operator-only health diagnostics; no write paths that bypass maintenance; and
  tested activation, recovery, and stale-service-worker behavior.
  - [x] Locally implement the self-contained browser `503`, preserve crawler-control files,
    fail closed for current and future mutation routes, mark responses for the PWA, rotate the
    offline cache, and extend the immutable-version live verifier across browser/API behavior.
  - [ ] Activate and recover the exact reviewed release on every production hostname, verify
    the public minimized health check and private diagnostics, and record stale-client evidence.

## P1 — Evidence, data contracts, discoverability, and scalable foundations

- [ ] Expand California-halibut planning coverage to the Santa Barbara South Coast without
  weakening the existing safety or evidence boundary.
  - [x] Curate public Gaviota, Goleta, Santa Barbara, Summerland, Carpinteria, and Rincon access locations;
    bind official access/regulation sources; explicitly exclude no-take or ambiguous water;
    bind NOAA Gaviota/Santa Barbara/Rincon tide-prediction stations and West/East Santa Barbara
    Channel buoys to their appropriate subregions; add regional weather/marine mappings; move
    wave exposure from brittle region names to casting-zone metadata; and adapt the map,
    metadata, tests, and disclosures for a multi-region heuristic.
  - [x] Archive the exact original Bay Area site population and bind both frozen validation
    protocols to that immutable catalog so an evolving public catalog cannot rewrite prior
    evidence semantics. New-region trip reports remain model-excluded product observations.
  - [x] Regenerate a fresh 72-hour snapshot from the declared public regional sources, bind its
    exact catalog and scoring identity into the compact attestation index, and pass local build,
    contract, pipeline, API, and security gates.
  - [ ] Review the regional site/access list with local anglers, obtain protected-PR evidence,
    and deploy only through the still-open guarded production-security release process. Do not
    claim Santa Barbara training, calibration, validation, catch probability, complete access,
    or guaranteed safety.
    - [x] Freeze and machine-check a blank 14-site local access-review packet with one review per
      open site, two per limited site, at least two regional reviewers, a seven-day official-source
      recheck, zero unresolved corrections, 30-day raw-response disposal, private evidence only,
      and explicit denial of deployment, safety/legal, and model-validation authority. Actual
      local review, its aggregate receipt, final protected checks, and guarded deployment remain
      open.
    - [x] Add the offline, fail-closed evidence evaluator missing from that packet. Private files
      must be regular `0600` non-symlinks outside the repository; checkout and evidence digests,
      random pseudonymous reviewer keys, per-site thresholds, six-month observation recency,
      seven-day source freshness, correction resolution, strict field/size bounds, and authority
      denial are machine-checked. The public receipt contains aggregate counts and a private-file
      digest only. The policy is CI- and release-inventory-bound and makes no network or provider
      request. No local responses or accepted receipt exist yet.
  - [ ] Complete the separately prioritized P2 pollution/water-quality score contract and
    location-by-location structure/depth inventory before claiming either as regional capability.
    The exclusion-only Santa Barbara BeachWatch action slice and first display-only 14-site NOAA
    chart inventory are locally implemented, but neither is a numeric score input or a substitute
    for independent site review, complete structure coverage, or guarded production evidence.
    Those goals retain their canonical acceptance boundaries in P2 below and do not block private
    trip logging or this source-bound geographic checkpoint.

- [ ] Establish privacy-preserving production observability and an operator console before
  scaling traffic. Evaluate Cloudflare-native logs/analytics and focused vendors such as
  PostHog by data fit, searchability, alerting, cost, retention, residency, deletion support,
  access controls, and lock-in; analytics is not a substitute for error logging or an audit
  ledger.
  - [ ] Emit structured, schema-versioned events with UTC timestamp, severity, release, route,
    request/trace ID, outcome, latency, and a rotating pseudonymous account reference only when
    necessary. Never log passwords, tokens, cookies, precise location, trip notes, photo data,
    raw prompt content, or other high-risk fields. Development debug logs must be gated and
    production logs redacted, sampled, access-controlled, retained briefly, and deletion-aware.
  - [ ] Centralize searchable errors and aggregate operational summaries; correlate browser,
    Worker, queue, D1, R2, AI-provider, deployment, and scheduled-job failures; add actionable
    alerts, runbook links, acknowledgement/escalation, and synthetic checks. Prove alert delivery
    and incident reconstruction using non-sensitive fixtures.
  - [ ] Build a least-privilege, MFA-protected operator dashboard for health, deployments,
    request/error trends, queues, backup/restore evidence, privacy jobs, security events, and
    immutable change history. Keep future financial reporting as a separately authorized data
    domain with accounting-grade source records and reconciliation, not values inferred from
    application logs.
  - [x] Locally centralize Worker logging behind a schema-enforcing module, add server-generated
    request IDs and secret-keyed session pseudonyms, normalize dynamic/unknown routes, replace
    ad hoc console output, correlate scheduled work, disable raw URL invocation logs, and publish
    the Cloudflare dashboard/query/incident recipe plus the PostHog privacy decision. A fail-closed
    offline drill now reconstructs request, Queue, and scheduled-task timelines from a bounded
    non-sensitive fixture only when per-identity timestamps are strictly ordered and completion or
    start/terminal positions are unambiguous; it emits a deterministic aggregate receipt without
    actor pseudonyms or raw payloads. A second fail-closed policy now verifies a private,
    source-bound activation manifest against an independently supplied expected commit and emits a
    public-safe receipt containing that commit plus aggregate readiness/blocker state; it cannot
    query Cloudflare or authorize production. Production/preview stream reconstruction, dashboard
    creation, IAM/retention/cost evidence, external uptime checks, and delivered alert drills
    remain open. PR `#119` merged exact accepted head
    `986271b9bed89a1adc5c977ec2037383c5f5f19f` as protected-main commit
    `d71f17cad8642c09c8f64460ce3c8ef1cba55555`; exact-head and merge-commit CI, release
    provenance, CodeQL, hosted mobile, and dependency-submission evidence passed without a
    deployment or provider query.
- [ ] Make the data and execution paths measurably scalable before a traffic campaign.
  - [ ] Inventory every production query, capture representative `EXPLAIN QUERY PLAN` evidence,
    add only workload-justified indexes, bound scans/pagination, eliminate N+1 patterns, verify
    cross-account predicates, and regression-test query latency and migration cost.
    - [x] Add a deterministic AST-backed inventory for all 254 Worker `.prepare()` sites across
      eight files, including exact review contracts for 14 nonliteral expressions and nine literal
      multi-row reads without `LIMIT`. CI and release provenance fail closed on inventory drift,
      computed/aliased prepare access, unreviewed dynamic SQL, unscoped literal writes, and
      unreviewed multi-row reads; the policy and generated ledger are SBOM-bound release inputs.
    - [x] Resolve the four explicitly disclosed `open-account-cardinality` saved-site/gear UI
      reads with exact 100-item resource ceilings, `LIMIT 101` overflow detection, atomic
      count-guarded creates, idempotent duplicate saves, and fail-closed legacy overflow.
      Complete privacy exports remain deliberately untruncated.
    - [x] Batch-limit scheduled authentication/retention deletes to 100 selected primary rows per
      table and invocation, preserve ineligible rows, drain backlogs on later runs, and run the
      actual bounded statements through the query-plan contract. Completed privacy tombstones now
      prune at most 100 locator-free task rows from one oldest job before deleting up to 100
      childless parents, so the parent foreign-key cascade has zero child rows rather than hidden
      unbounded write fan-out. Privacy object work claims at most five tasks and reconciles at most
      100 jobs with one set-based statement.
    - [x] Bound the cron as one aggregate Cloudflare invocation. A deterministic four-lane
      rotation runs exactly one sequential lane per five-minute tick, so every lane is serviced
      every 20 minutes without four concurrent `waitUntil` pipelines sharing the same quota.
      Saturation tests hold queue dispatch, trip-photo cleanup, expired-export cleanup, and auth
      retention/deletion below conservative D1 query budgets of 32, 44, 36, and 44 against the
      stricter 50-query Free ceiling. Trip schema initialization is now one fail-closed read-only
      readiness probe instead of 35 runtime DDL statements. Enabled public discussions likewise
      use one fail-closed read-only readiness probe instead of runtime table/index DDL, while the
      default-off path makes no D1 call. Deployed-plan, cron, latency, cost, backlog, and alert
      evidence remain isolated-staging gates.
    - [x] Make owner profile-trip edits follow exact D1 post-state rather than mutation metadata.
      A server-generated validation-evidence identity, the optional immutable feasibility
      correction, and every normalized/recomputed trip field must match before success or review
      dispatch; missing metadata and a lost committed batch response recover without replay,
      while a moderator race remains fail-closed.
    - [x] Make owner deletion of pending trips follow the exact secret-bound D1 deletion ledger
      plus exact trip/discussion absence rather than final mutation metadata. Missing metadata and
      a lost committed batch response recover without replay; a corrupted task ledger stops before
      private-object purge, and a concurrent moderator still wins without creating deletion work.
    - [x] Make password-confirmed account deletion follow one exact secret-bound job, canonical
      set-based task ledger, and zero active owner rows rather than final mutation metadata. The
      verified task count controls cleanup fallback; rollback and corrupt-ledger ambiguity return a
      read-only status receipt without private-object deletion or automatic replay.
    - [x] Locally move complete export packaging behind a default-off managed Queue adapter with
      an opaque two-field message, owner-bound D1 job/lease ledger, private 24-hour object,
      progress/download UI, bounded retries/expiry, and account-deletion race adoption. Direct
      authenticated export remains the disabled-mode fallback, and rights rows are never
      truncated.
    - [x] Bind export dispatch, consumer claims, object reservation, completion, and expiry
      cleanup to exact private-token/state read-backs. Ambiguous D1 responses cannot authorize a
      Queue send or R2 mutation, a committed completion cannot lose its valid object, cleanup
      locators remain durable, and an abandoned fifth lease reaches explicit attention.
    - [ ] Apply `0019`, provision the private Queue/DLQ/R2 bindings, capture production-shaped
      latency, rows-read/written, bounded-retention/migration cost and race/failure evidence in
      isolated staging, activate alerts/IAM, then enable only through the separate gate in
      `docs/ASYNC-PRIVACY-EXPORTS.md`.
  - [x] Publish a cache matrix by asset/data class with owner, privacy classification, cache key,
    TTL, invalidation trigger, stale policy, and failure behavior. Authenticated, personalized,
    error, cookie-setting, and every `/api/*` response fail closed to browser/CDN `no-store`; the
    PWA bypasses APIs and accepts only explicitly public successful responses.
  - [ ] In isolated staging, record an explicit edge purge, canonical/alias warm and cold headers,
    snapshot rollover, version skew, offline fallback, service-worker replacement, and prior-cache
    removal. Local policy and browser tests are not provider purge or rollover evidence.
  - [ ] Queue only slow or retryable side effects such as AI generation, media processing,
    notifications, cleanup, and aggregation. Keep authorization and consistency-critical writes
    synchronous; require idempotency keys, deduplication, bounded retry/backoff, dead-letter
    handling, cost ceilings, progress state, cancellation where safe, and operator replay tools.
    - [x] Locally implement the advisory AI slice as a default-off managed Queue adapter with an
      exact opaque two-field message, D1 outbox/unique trip job/lease authority, at-least-once
      deduplication, bounded batch and five-attempt exponential retry, `needs_attention` state,
      deletion and maintenance recovery, provider-DLQ policy, and a non-executing state-guarded
      replay planner. Production migration, Queue/DLQ bindings, IAM/alerts, isolated failure and
      rollback drills, and the separate activation change remain open.
    - [x] Make the still-default direct fallback claim independently lease-owned: a provider call
      follows only exact high-entropy claim read-back, terminal writes repeat that identity,
      malformed or active processing state is never reclaimed, expired claims recover through
      the bounded scheduled backlog, and stale workers cannot overwrite a newer result. The
      internal claim envelope is suppressed from profile and portability responses.
    - [x] Bind Queue publishing and consumer settlement to separate high-entropy D1 tokens:
      exact read-back resolves missing mutation metadata, active leases survive maintenance and
      duplicate deliveries, stale workers cannot settle replacement work, and an abandoned
      fifth attempt reaches explicit attention instead of an infinite redispatch loop.
  - [x] Use Cloudflare's managed D1 binding lifecycle instead of inventing a traditional SQL
    connection pool. The optional FastAPI/Postgres process owns one bounded pool with validated
    minimum, maximum, wait-queue, and checkout-timeout settings plus explicit startup/shutdown;
    it is not part of the Worker request path.
  - [ ] Size the optional pool against the approved provider plan and process count, export its
    queue/wait/error statistics, and test exhaustion and recovery in isolated staging before
    enabling that service in production.
  - [ ] Define performance budgets and run isolated load, soak, spike, and failure-injection
    tests with production-shaped synthetic data. Record saturation points, tail latency, error
    rates, queue depth, database contention, cache effectiveness, cost, and a safe rollback plan.
  - [x] Locally add workload-backed D1 indexes, machine-check 34 critical `EXPLAIN QUERY PLAN`
    paths plus every foreign-key child index, remove the public-site N+1 behind a bounded cache,
    publish the cache/async/connection contracts, add a bounded Postgres process pool only for
    the optional API, and provide a read-only load harness that permanently refuses production.
    Remote load execution also rejects cleartext, IP literals, widened routes/budgets, unreviewed
    or dirty source, redirects, stale API/Worker identity, an absent opaque exercise marker,
    unhealthy D1, or maintenance mode before its timed workers start; aggregate output omits the
    target hostname, Worker version, and exercise marker.
    The actual built Worker also passed a 2,835-request, zero-failure smoke against a disposable
    local D1 database after all 18 migrations (18.51 ms p95; 32.79 ms p99). The default-off
    advisory Queue path and D1 ledger are locally implemented. This developer-machine smoke is
    not staging evidence: provider migration application, `PRAGMA optimize`, production-shaped
    staging measurements, Queue/DLQ activation, failure injection, and authorized penetration
    testing remain open.

- [ ] Freeze the species-aware observation and model-run contract before new ingestion or
  recruitment: canonical/versioned taxa or explicit complexes; one primary target per
  evaluable effort segment; structured per-taxon encounters, retained/released counts, and
  identification confidence; distinct target-no-encounter versus no-fish outcomes; and a
  loader that rejects mixed/unexpected taxa and records the target in every artifact.
  - [x] Implement and locally verify the closed catalog, cross-runtime schemas/validators,
    complete-attempt loader, trip persistence, target-stamped run/artifact identity, and
    compact static/API opportunity identity.
  - [ ] Apply and audit the production migration, confirm all historical rows are
    `legacy_unverified` and model-excluded, deploy the versioned snapshot/API, and preserve
    the frozen contract in the first approved ingestion manifest.
- [ ] Freeze the validation protocol before collecting more outcomes: complete targeted
  trips including skunks, effort and mode, immutable source-separated splits, geographic and
  temporal holdouts, preregistered baselines, outcome-independent incentives, preserved
  model version and `scoreInfluencedChoice`, and independent or safely randomized trip
  selection where possible. Curated site IDs support site × time-window claims only; precise
  casting-zone research requires separate consent, minimization, access, retention/deletion,
  and sensitive-location controls.
  - [x] Freeze and locally verify the strict human/machine preregistration, exact 46-site
    geography, absolute time blocks, fixed-interval census, frozen recruitment provenance,
    baseline/metric/sample/promotion gates, private-manifest contract, adversarial semantic
    tests, and narrow ordinal claim boundary. The audit concluded that v1 must not activate
    because its bespoke external transparency-log and independent-publication services do not exist.
  - [x] Freeze and locally verify the v2 successor schemas and operational-pilot contract:
    externally timestamped read-only preregistration, immutable release/Worker identity,
    complete starts and outcomes including skunks, source labeling, privacy-minimized fields,
    append-only corrections, encrypted snapshots/restores, fixed feasibility gates, no
    candidate-performance analysis, and permanent exclusion of pilot rows from confirmation.
  - [x] Locally implement and verify the default-off v2 start/completion/safe-cancellation
    ledger, activation- and account-bound HMAC participant grouping, private account export,
    exact retained/deleted-start reconciliation, append-only/identity guards, and transactional
    runtime fixtures. This records no email, raw account ID, coordinates, notes, photos, IP, or
    user agent in the pilot ledger and computes no candidate-performance result.
  - [x] Locally implement and verify append-only correction handling plus outcome-independent
    direct/community recruitment-source capture. Direct/community invitations must match an
    immutable campaign sealed by D1 server time before activation; an HMAC invitation alone is
    not treated as proof of issue time. First-source-wins, account export/deletion, correction
    chaining, source-separated reconciliation, and adversarial mutation/timing cases are covered.
  - [x] Locally implement and verify the separate 730-day validation-only technical candidate:
    privacy-minimized encrypted projections, immutable opaque suppression capture on deletion,
    cumulative suppression/aggregate-removal artifacts, strict retention-class separation,
    frozen-hash verification, deletion replay, and aggregate-only evidence. The drill computes
    no candidate performance and deliberately records governance approval and the overall
    activation storage gate as false.
  - [ ] Approve the 730-day validation-only snapshot and deletion-suppression policy; configure
    production key custody, least-privilege storage, daily schedules/alerts, retention deletion,
    and operator evidence; complete a witnessed production-shaped restore/deletion-replay drill;
    complete legal/privacy/data-steward review; externally preregister the exact artifact; and
    seal/deploy a valid activation manifest before the first pilot-eligible row. The 89-day
    full-D1 operational restore remains a separate artifact class and cannot satisfy this gate.
  - [ ] If the pilot passes, freeze and preregister a separate confirmatory protocol with a fixed
    candidate and baselines, source-separated development and locked test data, geographic/time
    holdouts, clustered uncertainty, minimum support, and promotion/drift/rollback gates. Never
    backdate activation or treat pilot/product rows as confirmatory evidence.
- [ ] Acquire reproducible official CDFW/CRFS/RecFIN data—starting with CDFW ds3186
  all-species/all-effort and ds3185 rockfish/cabezon blocks—and start a prospective first-party
  cohort. Every snapshot needs its query/export manifest, retrieval date, checksum, license,
  attribution, dictionary, source version, sampling design, denominator, and spatial/time
  support. Keep samples separate from expanded estimates, never invent point labels from
  blocks, and declare training/validation/context permissions per source.
  - [x] Acquire and twice reproduce exact current ds3186 and ds3185 FeatureServer snapshots,
    commit byte-binding receipts, pin layer identity/revision/dictionary and the `-9999`
    missing-value sentinel, and explicitly restrict both block/time-bin aggregates to
    descriptive context. The stale ds3185 convenience export was rejected rather than silently
    accepted as current data.
  - [ ] Obtain a permitted, reproducible complete-effort CRFS/RecFIN sample export and begin the
    prospective first-party cohort. The aggregate layers cannot substitute for complete
    attempts, species-specific target effort, exact support, or source-separated validation.
- [ ] Treat Fishbrain as an optional written-license partnership and Facebook groups as
  admin-approved prospective recruitment—not scraped retrospective evidence. Licensed social
  data without complete attempts, no-catch, effort, coverage, and sampling propensity is for
  discovery, weak supervision, or external trend corroboration only; the independent benchmark
  remains a source-separated prospective cohort.
  - [x] Freeze a default-deny source-admissibility policy and strict schema, bind the complete
    manifest inventory, reject unreviewed sources, gate each allowed operation, and explicitly
    deny Fishbrain/Facebook automation, credentials, retrospective import, social identity, and
    model use. Policy SHA-256:
    `54b245191ad8da6dac820e189a6a21834ccca7699e0ced7bcc29c7bf430cf817`.
  - [ ] Obtain any required written platform/license permissions, group-administrator approval,
    direct participant opt-in, legal/privacy review, and source-quality evidence before a
    separately protected policy change. No social data has been acquired.
- [ ] Validate the California halibut relative ranking against frozen baselines before broader
  claims; publish uncertainty, limitations, negative results, and the current all-zero sample
  constraint. Attempt probability calibration only after a trained occurrence model has a
  sufficiently representative held-out set of positive and negative outcomes.
- [ ] Run a model-agnostic selection benchmark once eligible labeled data exists. Deep learning
  is one candidate, not the default winner. Before opening the locked test data, preregister a
  representative comparison set spanning naive and regularized linear/GAM models, tree-based
  models, an appropriate spatial or hierarchical model, the bathymetric deep encoder, and
  justified hybrid/ensemble candidates. Give every candidate the same source-separated
  geographic/time folds, leakage checks, calibration and uncertainty evaluation, and ranking
  metrics; also compare inference cost, latency, maintainability, explainability, and missing-
  coverage behavior. Promote the simplest candidate that demonstrates a material, reproducible
  held-out advantage. If candidates are statistically indistinguishable, prefer the simpler
  model. Do not begin this benchmark or tune the comparison set against confirmation data before
  the validation/data-eligibility gates above are satisfied.
- [ ] Define model promotion, drift, and rollback gates: beat preregistered geographic/time
  holdout baselines before promotion; monitor by site, season, mode, and taxon; version every
  release; and require rollback/revalidation when performance or data support drifts. **Local
  governance control complete:** the strict California-halibut v1 policy and schema freeze
  sequential development/candidate/shadow/limited/production stages, relational confirmatory
  promotion tests, privacy-minimized monitoring, immediate integrity suppression, performance/
  calibration/drift/support rollback, 180-day and material-change revalidation, immutable
  fallback order, and append-only decision identity. The fail-closed evaluator hashes the policy,
  rejects ambiguous evidence, suppresses any trained model under today's heuristic-only policy,
  and never applies promotion/restoration. A separate preregistered confirmatory protocol,
  eligible locked-test evidence, independent approval, isolated shadow/limited exercises,
  provider monitoring, and exact deployed-release binding remain open.
- [ ] Establish truthful technical SEO and measurement without promoting unvalidated accuracy:
  Google Search Console and Bing Webmaster Tools verification, sitemap submission, crawl/index
  coverage, canonical URLs, metadata, social previews, appropriate structured data, Core Web
  Vitals, mobile/accessibility checks, and privacy-conscious conversion analytics.
  - [x] Implement and locally verify the four-page crawl set, self-canonicals, route-specific
    social metadata, `/profile` noindex, robots/sitemap files, narrow `WebSite` JSON-LD, and
    a dashboard/runbook that keeps heuristic ranking claims truthful.
  - [x] Remove the 1MB header/offline icon fetch and third-party font requests from the staged
    Vinext build while preserving the existing branded social card and install icons.
  - [ ] Deploy the reviewed crawl foundation after P0 and verify every canonical/redirect host.
  - [ ] Verify the Google domain property through DNS, import or verify Bing, submit the sitemap,
    inspect the four public URLs, confirm `/profile` noindex, and record initial coverage.
  - [ ] Establish real-user Core Web Vitals and privacy-reviewed funnel baselines without
    collecting precise location, trip content, account identifiers, or free text.
- [ ] Make infrastructure mobile-ready and scalable with versioned APIs/shared schemas,
  appropriate mobile authentication, queue-based AI work, staging, bounded retries/costs,
  and WebKit/offline/safe-area coverage.
  - [x] Implement the local mobile/API compatibility control: additive version negotiation and
    centrally owned response headers, exact opt-in rejection before expensive work, preserved
    secure-cookie web authentication, an explicit native-PKCE release gate, shared-contract
    inventory, four-edge safe-area handling, and hosted Chromium/WebKit offline coverage.
  - [x] Stabilize the local map-readiness acceptance after repeated WebKit timing races without
    increasing the readiness ceiling, enabling global retries, or weakening the exact overlay
    geometry assertions. The browser test now follows the real explicit-load transition and a
    20-run WebKit plus 15-run Chromium stress check passed before the full 140-case matrix.
  - [x] Contain MapLibre GL `5.24.0`'s expected raster-tile cancellation at the map boundary.
    The capture-phase handler matches only the exact `AbortError` message plus `abortTile` and
    the dedicated `maplibre-gl*.js` module in the stack, is removed on unmount, and deliberately
    leaves application aborts and genuine MapLibre failures observable. A direct reproduction in
    Vinext development mode across five location reports produced no overlay or page error;
    adversarial unit coverage, the full 672-test Node
    suite, and all 208 Chromium/WebKit mobile cases passed under the pinned runtime. The
    same-day `6.0.0` major upgrade was not taken without evidence that it fixes this path. Exact
    consolidated head `1198bd90b55b69d9e9a04a1c0daafbc4abd23668` then passed hosted CI run
    `29956970498` and CodeQL run `29956967448`. This closes the observed defect and its automated
    review boundary only; independent human review and every deployment/provider gate remain open.
  - [ ] Complete native-client contract/authentication work, isolated staging and provider setup,
    physical-device acceptance, deployment, and production-scale performance/failure evidence.

## P2 — Species and business expansion

- [ ] Incorporate pollution and water-quality conditions into a separately versioned score
  component only after its intended meaning is frozen (fishing-quality context versus human-health
  advisory), official or explicitly licensed sources are inventoried, spatial/temporal support and
  freshness are preserved, missing or stale inputs fail closed, and the contribution is validated
  against frozen baselines. Keep agency advisories visible and authoritative; never imply that a
  fishing score proves water, contact, or seafood-consumption safety.
  - [x] Freeze and locally implement the first human-health advisory slice without changing the
    attested fishing score: an exact six-site SFPUC mapping, fixed-source bounded collector,
    policy/collector/catalog hashes, ten-day weekly-sample freshness, strict multi-station
    precedence, explicit stale/unmonitored/unavailable/unmapped states, active-posting
    recommendation suppression, neutral no-posting results, public UI disclosure, deterministic
    adversarial fixtures, and scheduled-review refresh integration.
  - [x] Freeze and locally implement the second exclusion-only source slice for the Santa Barbara
    South Coast: the fixed California State Water Resources Control Board BeachWatch action table,
    all 14 sites covered by explicit countywide actions, 11 direct station mappings, strict
    closure/posting/rain precedence, action start/end handling, unknown-by-absence semantics,
    isolated source failures, bounded historical anomaly handling, public action-date disclosure,
    and deterministic plus live-source adapter checks. Numeric `scoreDelta` remains null.
  - [ ] Extend reviewed official/licensed current-status coverage across the Bay Area and
    remaining launch catalog; independently review the Santa Barbara mappings, source latency,
    rainfall/geographic support, licensing, and outage behavior; validate any proposed numeric
    fishing-quality contribution against frozen baselines; obtain independent product/safety
    review; and collect guarded deployment plus post-deployment freshness evidence.
    - [x] Preserve the San Mateo negative-evidence boundary for Poplar Beach and Seal Point Park
      Shoreline. Their nearest reviewed County stations are different named public locations at
      1,944 m and 2,102 m, so neither site inherits a nearby status; both remain `not-covered`,
      unknown, and null-score pending exact official coverage and independent review.
    - [x] Complete a hash-bound negative-evidence inventory for the current 61-site launch catalog.
      All 22 sites without a provisional source mapping now bind to an explicit review receipt.
      Dumbarton Fishing Pier remains unmapped because the State directory exposes no Alameda
      County program and neither relevant option set contains a Dumbarton identity; the audit
      fails closed if a candidate later appears instead of creating a mapping automatically.
    - [x] Freeze a machine-checked source and meaning boundary before considering any numeric
      pollution component. Water-contact actions, bacteria samples, consumption advisories,
      tissue monitoring, ambient results, and community-burden screening remain separate.
      Existing exact current actions stay exclusion-only; OEHHA advice stays authoritative;
      measurement sources stay research-only; CalEnviroScreen is rejected for site scoring; and
      both positive and negative score contribution remain disabled pending pre-registered
      held-out validation and independent fisheries plus public-health review.
    - [x] Prepare a fail-closed two-discipline independent-review handoff for that exact inactive
      boundary. Private canonical records bind the final PR `#145` policy commit and digest,
      require distinct fisheries/marine-ecology and public-health/risk-communication reviewers,
      accept honest changes-required outcomes, and emit only an aggregate receipt. Even two
      accepted reviews authorize no collection, score, model claim, merge, deployment, or
      production action. No real independent review has yet been supplied.
- [ ] Build the map location by location until every available location has a reviewed inventory
  of notable structure and useful depth levels. Bind each feature to a reproducible official or
  licensed bathymetry/chart source, units, vertical datum, resolution, retrieval date, checksum,
  uncertainty, and permitted display/model use; reject false precision and protect sensitive
  habitat or access information. Ship each location only after visual and data acceptance, while
  keeping unmapped locations explicitly incomplete.
  - [x] Freeze and locally implement the first display-only Santa Barbara South Coast slice for all
    14 regional catalog sites. A fixed NOAA ENC Direct `Approach` collector verifies 13 reviewed
    layer identities, bounds responses, rejects redirects/truncation/schema or date drift,
    deduplicates overlapping-cell soundings, and binds a normalized source snapshot plus strict
    public artifact to exact policy/collector/catalog hashes. The UI exposes sector bands, nearby
    chart features, record age, meters, MLLW, and the unavailable resolution/accuracy/uncertainty
    fields while keeping `scoreDelta` null, catalog priors unchanged, exact structure geometry
    private, and navigation/access/castability claims prohibited.
  - [x] Extend the same display-only contract to the ten San Francisco coast and waterfront
    catalog locations without changing a score or catalog prior. The fixed 2026-07-21 source
    snapshot provides sector depth bands at nine sites and keeps Crane Cove Park explicitly
    partial because no reviewed depth-area band intersects its configured sector, even though
    seven deduplicated point soundings and selected chart features exist within 1 km. Contract
    version 1.1 preserves exact, month-precision, year-only, and missing source-date states
    separately instead of rejecting valid partial dates or inventing a day.
  - [x] Extend the same contract to ten San Mateo Coast and Half Moon Bay locations. The fixed
    2026-07-21 source snapshot provides depth-area bands and nearby soundings for all ten configured
    sectors, keeps selected feature records display-only, and leaves every score/catalog value
    unchanged. Pacifica Municipal Pier remains closed, excluded from ranking, and absent from
    forecast/detail/trip-start flows instead of allowing chart context to imply access. Contract
    version 1.2 binds exactly 34 reviewed sites.
  - [x] Extend the same contract to seven Point Reyes and Marin Coast locations. The fixed
    2026-07-21 source snapshot provides depth-area bands at five configured sectors and nearby
    soundings at all seven. Bolinas and Muir remain explicitly partial because no reviewed
    depth-area band intersects either configured sector; charted seabed records and catalog clues
    are not substitutes. Contract version 1.3 binds exactly 41 reviewed sites without changing a
    score, catalog prior, access decision, or navigation boundary.
  - [x] Extend the same contract to ten North and East Bay locations. The fixed 2026-07-21 source
    snapshot provides depth-area bands at eight configured sectors and nearby soundings at all ten.
    McNears Beach Pier and Ferry Point Fishing Pier remain explicitly partial because no reviewed
    depth-area band intersects either configured sector; charted shoreline records and catalog
    clues are not substitutes. Contract version 1.4 binds exactly 51 reviewed sites without
    changing a score, catalog prior, access decision, or navigation boundary.
  - [x] Extend the same contract to the final ten Oakland-through-South-Bay launch-catalog
    locations. The fixed 2026-07-21 source snapshot provides depth-area bands and nearby soundings
    at all ten configured sectors while preserving old, partial, and missing source dates.
    Contract version 1.5 binds exactly 61 reviewed sites without changing a score, catalog prior,
    access decision, or navigation boundary.
  - [ ] Obtain location-by-location local-angler and independent chart review; verify sector
    orientation and usefulness; source dynamic bars, troughs, reef, vegetation, and other catalog
    clues separately or leave them explicitly unvalidated; add BlueTopo or another qualified
    uncertainty-bearing source only where coverage permits; and collect protected, guarded
    deployment plus post-deployment evidence before calling any of the 61 covered locations fully
    reviewed or using this evidence in a score.
    - [x] Prepare the first executable 14-site Santa Barbara review handoff without pretending the
      review occurred. A source-bound blank policy and guarded private template require one current
      local-angler review and one independent chart/GIS review per site, two distinct local
      reviewers region-wide, strict reviewer-role separation, a seven-day NOAA source-identity
      recheck, zero unresolved corrections, private `0600` evidence outside Git/Codex, 30-day raw
      response disposal, and an aggregate-only receipt. The verifier rejects digest/catalog/
      artifact drift, extra or identifying fields, unsafe correction text, stale evidence, role
      overlap, incomplete coverage, invented score/navigation authority, and provider execution.
      No real response, accepted receipt, score change, model evidence, or deployment exists yet.
- [ ] Add striped bass as the first new beta using a distinct estuary/migration model.
- [ ] Define and evaluate explicit shore-relevant rockfish species/complexes next; then model
  cabezon as its own taxon; then split surfperch into defensible habitat/taxon groups. Each beta
  needs its own source inventory, model card, validation gate, and current regulation treatment.
- [ ] Complete business/legal readiness before substantial promotion or revenue: entity/DBA,
  tax and local-license review, trademark clearance, startup counsel/CPA review, DMCA/UGC
  posture, and broker quotes for cyber/privacy, technology E&O, general, and media liability.
- [ ] Preserve authorship and business records: maintain dated design/decision notes, source and
  asset provenance, license/assignment records, contributor agreements, release hashes, and
  archived public artifacts. Have counsel distinguish automatic copyright protection,
  registration strategy, trademark/brand protection, patent/trade-secret questions, and third-
  party or AI-assisted material. Surface the evidence in the operator console without exposing
  private keys, personal data, or privileged legal material.
  - [x] Implement the local public-asset provenance control: strict schema and policy, all 15
    shipped visual assets hash-bound exactly once, seven evidence-reviewed third-party source and
    license records, eight explicitly unresolved pre-policy legacy paths, corrected live credits,
    direct license/change disclosure, deterministic public-safe report, adversarial CI coverage,
    and the private owner/artist record workflow.
  - [ ] Obtain and preserve private owner confirmations, source layers, assignments/licenses and
    contributor agreements; archive accepted public artifacts and release receipts; complete
    counsel-guided copyright/trademark/patent/trade-secret decisions; then surface only safe
    evidence in the MFA-protected operator console.

## P3 — Experience and brand

- [ ] Improve accessibility and interaction quality after core risks are controlled, including
  keyboard/screen-reader review, zoom/reflow, contrast, reduced motion, and a non-map path.
  - [x] Establish one clean banner/main/footer landmark structure, add a first-focusable visible
    skip link, replace incomplete tab semantics with grouped pressed-state controls, and announce
    location-state changes without interrupting the user.
  - [x] Share one stack-aware modal focus boundary across forecast details, account, trip report,
    trip edit, methodology, comparison, location disclosure, and the required water reminder.
    Only the top dialog traps focus or consumes Escape; nested close restores its opener or the
    surviving parent, while the required reminder cannot be bypassed with Escape.
  - [x] Preserve the ranked list as the complete keyboard-accessible alternative to the map,
    expose an explicit list-only choice, connect the map region to that alternative, and make all
    MapLibre fit/cluster transitions honor the browser's reduced-motion setting.
  - [x] Add focused source and Chromium/WebKit phone coverage for skip navigation, selected state,
    nested focus, reminder behavior, list-only use, and 320 px reflow. The bounded slice passes
    24/24, the complete repository suite passes 684/684, and the full mobile matrix passes 228/228
    plus build, lint, TypeScript, security/SBOM, and zero-vulnerability dependency audits under
    the pinned runtime without adding a new dependency.
  - [ ] Complete independent manual screen-reader, keyboard-only desktop, text-zoom, contrast,
    reduced-motion, and physical-device review. Automated coverage does not establish full WCAG
    conformance or production acceptance.
- [x] Add a branded, accessible `404` page with a clear return-to-home action, useful navigation,
  correct `404` status, noindex behavior, and service-worker-safe non-caching.
- [ ] Add honest loading and recovery states after the underlying operations are bounded:
  route-appropriate skeletons, immediate acknowledgement, progressive status for slow work,
  inline retry/cancel where safe, and carefully scoped optimistic updates that roll back on
  failure. Do not display fake precision or let optimistic UI imply a privileged write succeeded.
  - [x] Add and locally verify an accessible route-level indeterminate loading shell plus a
    render-error boundary with generic copy, explicit retry/home actions, reduced-motion
    behavior, no raw diagnostics, and no claim that an in-flight account write completed.
  - [x] Keep profile request failures distinct from verified empty accounts: preserve the last
    successful copy, validate response shape, show unknown counts and accessible skeletons
    before first load, and provide a generic inline retry without exposing diagnostics.
  - [x] Give trip writes truthful connection and slow-request states: pause new submissions when
    the browser reports offline, keep drafts, show indeterminate progress without invented
    percentages, and never automatically replay an ambiguous write after reconnection. Start,
    completion, and past-report writes now use stable high-entropy request identities, retain
    only one-way recovery-secret hashes after completion, bind replay to the same account/device,
    require exact operation/trip receipts, and permit only an explicit idempotent user retry.
  - [x] Fail account deletion safely in the client: block offline submission, keep slow requests
    visibly unconfirmed, and treat a dropped response as potentially committed so the user is
    directed to the durable deletion receipt instead of retrying a destructive write.
  - [x] Apply the same fail-safe boundary to pending trip deletion: pause while offline, keep
    slow deletion unconfirmed, and block another destructive submission after any ambiguous
    response until the profile and durable deletion receipt are reconciled.
  - [x] Keep pending-trip edits fail safe: preserve the local draft, block offline submission,
    lock the submitted fields while waiting, require a matching authoritative success receipt,
    and block retry, editing, or deletion after an ambiguous outcome until the server copy is
    reconciled after refresh. Authoritative client errors remain correctable.
  - [x] Keep gear-preset creation and removal fail safe: allow local draft editing while offline
    but block submission, lock submitted fields, require matching creation/removal receipts, and
    block conflicting gear writes after an ambiguous outcome until the profile is refreshed and
    reconciled. Never discard a creation draft without authoritative confirmation.
  - [x] Make sign-out fail safe: do not imply that the secure server session ended while offline
    or after a dropped or unverifiable response, require an exact server receipt, and use an
    explicit read-only session check before permitting a retry after an ambiguous outcome. After
    authoritative confirmation only, remove the complete account-bound recovery manifest from
    both browser stores, verify that it is gone, preserve unrelated preferences, and disclose any
    browser-blocked cleanup instead of silently claiming the shared device is clean.
  - [x] Make saved-location creation and removal fail safe: block writes while offline, retain
    the last confirmed local state, require an exact action/site receipt, keep slow or dropped
    responses visibly unconfirmed, block conflicting location writes, and reconcile an ambiguous
    outcome through the read-only saved-location list before allowing a retry.
  - [ ] Add operation-specific progress, timeout, retry, cancellation, and reconnection states
    only where the underlying API can report them truthfully; retain authoritative confirmation
    for account, trip, privacy, and other privileged writes.
- [ ] Improve trip-photo upload states with accessible visual emphasis (including the requested
  glow plus a copy/state change, not color alone), thumbnail, file type, size, validation result,
  and per-file progress/retry/cancel. Multiple files receive independent state and progress;
  indeterminate progress is used when byte progress is unavailable, and completed uploads remain
  distinguishable from files that are merely selected or locally previewed.
  - [x] Make the current one-photo trip contract truthful and fail closed. The browser feature is
    now explicit opt-in; selection and validation remain local; the UI shows name, type, size,
    preview, copy plus visual emphasis, honest indeterminate sending, authoritative stored-photo
    confirmation, correctable failure, and ambiguous may-have-committed retry states. Removal is
    available only before submission or after an authoritative failure; no fake byte percentage
    or unsafe post-submit cancellation is offered. Dedicated Chromium/WebKit acceptance builds
    the dormant feature on, tests it, then rebuilds the production bundle with uploads off. The
    bounded slice passes 4/4 source contracts, 8/8 feature-on Chromium/WebKit cases, 688/688
    repository tests, and 228/228 production-off phone cases plus build, lint, TypeScript,
    security/SBOM policy checks, and both zero-vulnerability dependency audits.
  - [ ] Design and independently review a versioned multi-file API and schema before claiming
    per-file upload, progress, cancellation, or retry. The current authoritative trip write and
    D1 schema support one photo only; uploads remain disabled until the existing storage,
    privacy, migration, provider, drill, review, and explicit activation gates all pass.
- [ ] Refresh visual design, graphics, species art, empty states, social cards, and brand
  illustration. Artist collaboration is intentionally deferred and can focus on expressive
  assets while product interaction remains usability-led.
