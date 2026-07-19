# CastingCompass goal status

Last reconciled: **2026-07-19 UTC**

This is the owner-facing dashboard for the complete goal list. The detailed acceptance
criteria and immutable receipts remain in [PRODUCT_ROADMAP.md](PRODUCT_ROADMAP.md); provider
steps remain in [PRODUCTION-OPERATIONS.md](PRODUCTION-OPERATIONS.md). A checked item here means
its complete acceptance boundary passed. “Local complete” means the repository control passed
but the parent stays open until its production, provider, legal, or independent-review gate is
also satisfied.

## Active seven-step work cycle — deterministic mobile map readiness

- [x] Reconcile exact protected `main` and freeze the acceptance boundary. Starting `main` is
      `698064d89952f0042ad7dd8853c9982cf3c63464`; Cloudflare and production remain paused, and
      this test-only cycle cannot claim deployment, provider, native-client, or production
      readiness.
- [x] Diagnose the repeated exact failure rather than changing product code. Two WebKit jobs on
      unchanged product bytes each passed 139/140 cases but timed out waiting for `Center Bay`;
      independent runs on the same commits passed, isolating a test-readiness race instead of a
      map geometry regression.
- [x] Freeze the non-weakening contract: keep the existing 15-second readiness ceiling, retain
      the exact overlay non-collision and viewport assertions, add no global retries, and exercise
      the real `Open interactive map` action whenever it is the authoritative visible state.
- [x] Replace the one-shot state sample and swallowed click failure with a bounded transition
      assertion. The test now scrolls through Playwright's actionability boundary, observes both
      loader and loaded states, performs a bounded user click when available, and fails if the map
      never reaches the real `Center Bay` control.
- [x] Complete local verification: 20/20 repeated WebKit map cases; 15/15 repeated Chromium map
      cases across three phone viewports; 140/140 full Chromium/WebKit mobile, offline, recovery,
      404, and safe-area cases; Cloudflare build and 374/374 Node tests; ESLint; TypeScript; the
      exact npm 10.9.8 integrated security/SBOM gate with zero audit findings; 29/29 API tests;
      18 migrations, 14 critical query plans, and every foreign-key child path indexed; Ruff;
      81/81 pipeline tests with one documented optional-raster skip; and deterministic smoke.
- [ ] Publish a protected draft PR from the exact clean branch and accept every exact-head hosted
      check without relying on a rerun to conceal the original outcome.
- [ ] Merge only the accepted exact head, reconcile protected `main`, and add the immutable
      receipt. Cloudflare, provider resources, and production remain unchanged throughout.

## Completed seven-step work cycle — authorship and public-asset provenance

- [x] Reconcile exact protected `main` and freeze the public/private/legal boundary. Starting
      `main` is `ea922c8dfbdb7e35a81836d1f6a9e9e35c9081bb`; Git history is custody evidence,
      not proof of creation or ownership, and this cycle cannot make a copyright, trademark,
      assignment, counsel, deployment, or production-readiness claim.
- [x] Inventory all 15 shipped JPG, PNG, SVG, and WebP assets, their local hashes, Git custody
      history, current live copy, duplicate documentation, seven third-party source pages,
      creator/license metadata, and eight unresolved legacy brand/texture paths.
- [x] Freeze the strict JSON Schema, exact pre-policy legacy allowlist, canonical license map,
      source-review fields, private-evidence boundary, and `productionReadiness: false` policy.
      New public visual assets cannot inherit the legacy exception.
- [x] Add the fail-closed verifier and deterministic public-safe report. CI now rejects missing or
      duplicate records, symlinks, path/hash drift, new legacy exceptions, malformed or unknown
      licenses, missing source evidence, sensitive record values, live credit/license/change-copy
      drift, stale documentation, or a stale report.
- [x] Correct the shipped reference attribution: Frank Kovalchek replaces the incorrect USGS
      sandbar credit, Sharon Mollerus is the single pilings source, and Town of Chatham is retained
      in the Fish and Wildlife Service tidal-channel credit. The UI now links source and license
      separately and states the documented local transformation. Add the safe update process,
      legacy owner-confirmation questions, and the future artist-agreement checklist without
      committing contracts or private legal/business records.
- [x] Publish protected PR `#104` from exact head
      `854f9d249174ed2a01953a0bcde3906477af2af0`. Complete local evidence is green:
      Cloudflare build and 374/374 Node tests; 29/29 API tests; 18 migrations, 14 critical query
      plans, and every foreign-key child path indexed; Ruff and 81/81 pipeline tests with one
      documented optional-raster skip plus deterministic smoke; ESLint; TypeScript; secrets;
      zero-execution npm policy; exact Python locks; both SBOM gates; both npm audits with zero
      vulnerabilities; the focused provenance verifier/tests; and 140/140 Chromium/WebKit mobile,
      offline, recovery, 404, and safe-area cases. Exact-head CI `29676342215`, release provenance
      `29676342222`, CodeQL `29676341710`, and native image security `29676342217` passed. A
      duplicate push CI initially hit one WebKit map-control wait timeout; failed-job rerun
      `88165071812` passed on the unchanged head, matching the already-green PR run. No code or
      test weakening was used, and no deployment or Cloudflare change occurred.
- [x] Merge only the accepted exact head and reconcile protected `main`. PR `#104` merged as
      `9cb3bf12524bf17bf699bfc1508575ceee727db6`; main CI `29676832214`, release provenance
      `29676832217`, CodeQL `29676832077`, and native image security `29676832201` passed that
      exact commit, including the 140-case browser matrix, dependency submission,
      release-bundle provenance, release/SBOM attestations, and both image architectures. Open
      PRs and Dependabot, code-scanning, and secret-scanning alerts are all zero; issue `#86`
      remains open by design. Cloudflare and production remain paused. The parent business-record
      goal stays open for owner confirmation of eight legacy assets, private evidence,
      assignments/contributor agreements, accepted-artifact archives, counsel, and the future
      operator dashboard.

## Completed seven-step work cycle — mobile web and API compatibility controls

- [x] Reconcile exact protected `main` and freeze the acceptance boundary. Starting `main` is
      `a1dd23c85c9540cc86b52fd35942a7ebceeb53dd`; production and Cloudflare remain paused, issue
      `#86` remains open, and this cycle cannot claim native-client or production readiness.
- [x] Add an additive API compatibility contract. Existing first-party web requests may omit the
      header; opt-in clients must send exact version `1`, and incompatible or ambiguous values fail
      with a no-store `400` before rate limiting, body reads, authentication, routes, storage, or
      provider work. Every API response receives the centrally owned version header.
- [x] Complete the fixed-surface safe-area contract across top, right, bottom, and left insets,
      while retaining viewport fallbacks and dynamic viewport bounds. A rebuilt focused Chromium
      browser check passed deterministic simulated-inset geometry.
- [x] Expand the hosted mobile matrix from three Chromium viewports to those three plus a WebKit
      iPhone viewport. The existing offline/recovery suite plus the new inset test now enumerates
      140 browser cases; exact-head WebKit acceptance remains part of the protected PR gate.
- [x] Add the strict machine-readable policy, fail-closed verifier, focused runtime/static tests,
      and [mobile/API boundary](MOBILE-READINESS.md). The current secure host-cookie web model is
      preserved, browser credential storage remains forbidden, and PKCE/OS-protected token work is
      an explicit precondition for any native release.
- [x] Publish protected PR `#102` only after the complete local suite passed on exact head
      `6af7f91a4ca5f06c182e793818e87393edaeda12`. Evidence: Cloudflare build and 369/369 Node
      tests; 29/29 API tests; 18 migrations, 14 critical query plans, and every foreign-key child
      path indexed; Ruff and 81/81 pipeline tests with one documented optional-raster skip plus
      deterministic smoke; ESLint; TypeScript; secrets; zero-execution npm policy; exact Python
      locks; both SBOM gates; both npm audits with zero vulnerabilities; 105/105 local Chromium
      mobile/offline cases; and a 140-case four-project hosted matrix including WebKit. Exact-head
      CI `29673948911`, release provenance `29673948924`, and CodeQL `29673948165` passed; 13
      checks succeeded, five event-appropriate jobs skipped, and none failed. No deployment or
      Cloudflare change occurred.
- [x] Merge only the accepted exact head and reconcile protected `main`. PR `#102` merged as
      `fb2c23a254ee40a9d4abb47d905910e8eb66ccfd`; main CI `29674131431`, release provenance
      `29674131446`, and CodeQL `29674131178` passed that exact commit, including the WebKit
      matrix, dependency submission, release-bundle provenance, and release/SBOM attestations.
      Open PRs and Dependabot, code-scanning, and secret-scanning alerts are all zero; issue `#86`
      remains open by design. Cloudflare and production remain paused. The parent roadmap item
      stays open for native PKCE/token work, isolated staging, provider bindings, physical-device
      acceptance, deployment, and production-scale evidence.

## Completed seven-step work cycle — default-off advisory AI review queue

- [x] Reconcile exact protected `main`, the owner roadmap, and the highest-risk repository gap.
      Starting `main` is `bb3bdc4cef3bbd38370d14924803adf5ea6ed2b3`; production, Cloudflare,
      provider resources, and issue `#86` remain unchanged.
- [x] Recheck Cloudflare's current at-least-once delivery, explicit acknowledgement/retry,
      batching, retry ceiling, concurrency, and dead-letter behavior from primary documentation.
- [x] Inventory the complete advisory-review lifecycle across request creation, provider work,
      retries, deletion, maintenance, operator recovery, release migration, and observability.
- [x] Implement a fail-closed, production-default-off D1 outbox/lease consumer. Queue messages
      contain only an opaque job ID; work is idempotent, attempts are bounded at five, deletion
      wins, expired leases recover, and terminal failure becomes explicit `needs_attention`.
- [x] Add the strict message schema, policy verifier, migration/query-plan/release guards,
      redacted structured logging, non-executing operator replay plan, owner UI state, threat and
      access-control documentation, and adversarial runtime/policy coverage.
- [x] Publish protected PR `#100` only after the complete local suite passed on exact head
      `8b5f4059cf92b1364f856331ea5c3724c88cad7e`. Evidence: Cloudflare build and 366/366
      Node tests; 29/29 API tests; 18 migrations, 14 critical query plans, and every foreign-key
      child path indexed; Ruff and 81/81 pipeline tests with one documented optional-raster
      skip plus deterministic smoke; ESLint; TypeScript; secrets; zero-execution npm policy;
      exact Python locks; both SBOM gates; both npm audits with zero vulnerabilities; and clean
      exact-commit privacy-rights and operational-restore drills that correctly remained
      production-closed. Exact-head CI `29672461273`, release provenance `29672461228`, CodeQL
      `29672460408`, and native image security `29672461239` passed; 15 checks succeeded, five
      event-appropriate jobs skipped, and none failed.
- [x] Merge only the accepted exact head and reconcile protected `main`. PR `#100` merged as
      `1ffe0bcbd46ebbf518747ca26abb8d348c06624e`; main CI `29672574145`, release provenance
      `29672574141`, CodeQL `29672574061`, and native image security `29672574136` passed that
      exact commit. Open PRs and Dependabot, code-scanning, and secret-scanning alerts are all
      zero; issue `#86` remains open by design. Cloudflare and production remain paused, the
      queue flag remains false, and no provider queue or binding was created.

## Completed seven-step work cycle — isolated security-exercise guard

- [x] Reconcile exact protected `main` and the prioritized roadmap. Starting `main` is
      `983752ae8950c6611e0a943e3bb33527e7871e3b`; L10 isolated-staging DAST preparation is the
      highest-risk repository work that can advance without touching paused production.
- [x] Inventory the dynamic attack surface and preserve the hard boundary: no production host,
      alias, binding, user data, provider call, deployment, DNS change, load test, or intrusive
      scan is authorized by this cycle.
- [x] Freeze the maintained primary scanner approach and supply-chain identity. OWASP ZAP
      2.17.0 is locked to image-index digest
      `sha256:8d387b1a63e3425beef4846e39719f5af2a787753af2d8b6558c6257d7a577a2`;
      the runner uses the Automation Framework with fixed scope, duration, rate, and resource
      ceilings and never pulls implicitly. The pinned image accepted the generated active plan
      with `zap.sh -cmd -autocheck` and exit 0 while Docker networking was disabled.
- [x] Implement the production-refusing private authorization contract, staging-only health
      marker/version preflight, passive/public-active plan generator, hardened Docker command,
      private evidence boundary, and aggregate-only receipt that can never claim production
      readiness by itself.
- [x] Add adversarial coverage for production aliases/subdomains, hostile URLs, active-loopback
      and IP targets, stale/oversized windows, every safety assertion, extra/private fields,
      redirect/header/marker/version mismatch, fixed scan limits, missing confirmation,
      no-subprocess-on-refusal, private-file permissions/symlinks, and receipt redaction.
- [x] Pass the full clean repository/security suite, publish protected PR `#98` at exact head
      `c95816d2dc55d4f8a046c1c22d1f4aecab34936d`, and accept every exact-head gate without
      deploying. Evidence: CI `29669614571` including dependency review, release provenance
      `29669614572`, CodeQL `29669613529`, and native image security `29669614580` passed; 15
      checks succeeded, five event-appropriate jobs skipped, and none failed. Local evidence
      also passed the Cloudflare build and 351/351 Node tests, 29/29 API tests, 81/81 pipeline
      tests with one documented optional-raster skip, Ruff, ESLint, TypeScript, D1 query plans,
      secrets, zero-execution install policy, exact Python locks, both SBOM checks, both npm
      audits with zero vulnerabilities, and the network-disabled pinned-ZAP plan check.
- [x] Merge only the accepted exact head and reconcile protected `main`. PR `#98` merged as
      `fb4662cf725c3a1f99b4e918a19c6e72971a6b85`; main CI `29669810196`, release provenance
      `29669810179`, CodeQL `29669809994`, and native image security `29669810191` passed that
      exact commit. Open PRs and Dependabot, code-scanning, and secret-scanning alerts are all
      zero; issue `#86` remains open by design. Cloudflare and production remain paused. L10
      remains explicitly open for isolated provider resources, written independent
      authorization, public/authenticated/manual testing, remediation/retest, and independent
      acceptance.

## Completed seven-step work cycle — privacy-rights case handling

- [x] Reconcile the exact protected `main` after the source-admissibility receipt. Evidence:
      `main` is `9ad0ab8aa4bafd3e73253f382a5f23bb363358f7`; CI `29665671557`, release
      provenance `29665671589`, and CodeQL `29665671354` passed; open PRs and all three alert
      classes were empty; issue `#86` remains open by design.
- [x] Audit active-row, public-copy, object, ledger, browser, validation, log, provider, and
      backup deletion semantics. Immediate active deletion is already the stronger public
      promise; no recoverable 30-day account copy is currently authorized.
- [x] Recheck primary EU, UK, and California clock sources and freeze a conservative rule:
      always use the 28-calendar-day internal target, never infer jurisdictional applicability,
      and require recorded legal review before selecting a statute-specific clock reference.
- [x] Freeze a strict case schema and default-deny policy that reject extra fields and prohibit
      raw identifiers, contact details, credentials, precise location, notes, photos, object
      locators, and request/response text. Canonical policy SHA-256:
      `a87dee0cf45f35e9da35c4557ee0fff9040c02e0a333996383919b52c1592334`.
- [x] Implement the non-mutating evaluator/CLI and synthetic offline drill. Focused evidence:
      21/21 schema, lifecycle, cross-contract, chronology, export-before-erasure, closure,
      private-file, aggregate-receipt, and fail-closed production-gate tests pass. The clean,
      exact implementation commit `140c45da18bf1fdd87780c450a16139ee60a9a71` produced a private
      aggregate-only drill receipt with SHA-256
      `98aee26f45a1ad3351c4cb7da81887220d9b5522e0900b0667e91c454748d1b1` and
      `production_ready: false`.
- [x] Publish protected PR `#96` and accept every exact-head check without deploying or changing
      Cloudflare. Exact head `140c45da18bf1fdd87780c450a16139ee60a9a71` passed CI
      `29666895832`, release provenance `29666895835`, CodeQL `29666895407`, and native image
      security `29666895825`; 15 checks passed, five event-appropriate jobs skipped, and none
      failed. Local evidence also passed the Cloudflare build and 338/338 Node tests, 29/29 API
      tests with all 13 critical query plans, Ruff, 81/81 pipeline tests with one documented
      optional-raster skip, deterministic smoke, 102/102 mobile-browser tests, lint, TypeScript,
      secrets, zero-execution install policy, every exact Python lock, both SBOM checks, and both
      npm audits with zero vulnerabilities.
- [x] Merge only after all required checks pass, then reconcile exact `main`, post-merge runs,
      PR/issue/alert state, and an immutable receipt update. PR `#96` merged as
      `b0931deaefc43e434eb28d5f43b55da9599901c1`; main CI `29667029304`, release provenance
      `29667029303`, CodeQL `29667029205`, and native image security `29667029297` passed that
      exact commit. Open PRs and Dependabot, code-scanning, and secret-scanning alerts are all
      zero; issue `#86` remains open by design. Cloudflare and production remain paused.

## Completed seven-step work cycle — source admissibility

- [x] Reconcile the exact protected `main` after the model-governance receipt cycle. Evidence:
      `main` is `7a3ca95fe5449bc9b41dab9a0fe0a33ceaaaf237`; CI `29658714106`, release
      provenance `29658714150`, and CodeQL `29658714078` passed; open PRs and all three alert
      classes were empty; issue `#86` remains open by design.
- [x] Inventory every current source manifest and synthetic fixture, then review the current
      official Fishbrain and Meta terms without acquiring CDFW, social, private-group, profile,
      credential, or user-account data.
- [x] Freeze a strict source-admissibility JSON Schema and default-deny policy covering the exact
      manifest inventory, allowed preprocessing operations, current all-false supervised-model
      training, validation, and production-scoring roles, synthetic-test boundary, and
      Fishbrain/Facebook prohibitions. Canonical policy SHA-256:
      `54b245191ad8da6dac820e189a6a21834ccca7699e0ced7bcc29c7bf430cf817`.
- [x] Enforce the policy in the source-manifest loader, official CDFW context verifier,
      observation normalization, bathymetry ingestion, and terrain-pretraining entry points.
      Unknown sources, extra manifests, wrong operations, retrospective social content,
      credentials, automation, identity collection, and all current model roles fail closed.
- [x] Add semantic and cross-language adversarial tests plus owner-facing Fishbrain/Facebook and
      official-data guidance. Evidence: 81/81 executable pipeline tests pass with one documented
      optional-raster skip; 5/5 cross-language contract tests pass; Ruff passes.
- [x] Pass the complete local repository/security/lock/SBOM suite, publish protected PR `#94`,
      and accept every required check on exact head
      `8440158e5b7d8a7be71807310c710911e2f062ed`. Evidence: CI `29662734186`, release
      provenance `29662734148`, CodeQL `29662733032`, optional Python research
      `29662734176`, and native image security `29662734152` passed; 17 checks passed, five
      event-appropriate jobs skipped, and none failed. Local evidence also passed the Cloudflare
      build and 325/325 Node tests, 29/29 API tests in a fresh hash-pinned environment, Ruff,
      ESLint, TypeScript, secrets, the zero-execution install policy, all exact Python locks,
      both SBOM checks, and both npm audits with zero vulnerabilities.
- [x] Merge only after every required check passes, then reconcile exact implementation `main`
      `9f41e1afbafd907ee884cc8d6682e8d759182110`. Evidence: CI `29662858447`, release
      provenance `29662858449`, CodeQL dispatch `29662858267`, optional Python research
      `29662858432`, and native image security `29662858463` passed; open PRs and Dependabot,
      code-scanning, and secret-scanning alerts are empty; issue `#86` remains open by design.
      Cloudflare and production remain paused.

## Completed seven-step work cycle — model governance

- [x] Reconcile the exact protected `main` after the API-image renewal cycle. Evidence: `main` is
      `a3242e4369c970500835fa88ce187e670e623385`; CI `29655454304`, release-provenance
      `29655454306`, and CodeQL `29655454277` passed; open PRs and all three alert classes are
      empty; issue `#86` remains open for its mandatory 2026-08-04 review.
- [x] Inventory the existing model-run, opportunity, validation-v1, feasibility-v2, and model-card
      boundaries without treating the inactive protocols or terrain experiments as validation.
- [x] Freeze a strict, target-specific v1 governance policy and JSON Schema covering sequential
      stages, preregistered relational promotion gates, monitoring privacy/cadence, suppression,
      rollback, revalidation, and audit identity.
- [x] Implement a fail-closed evaluator and CLI that hash the policy, reject ambiguous evidence,
      suppress unauthorized trained serving, and never apply a promotion or restoration.
- [x] Document the operator decision matrix and pass focused schema, semantic, CLI, and Ruff
      checks. Evidence: 5/5 cross-language schema tests and 7/7 governance tests pass; canonical
      policy SHA-256 is `dac940bd123a2e6505cc20d535f28e7c84a585f9f3e5cd82efce06eae57f47a5`.
- [x] Publish protected PR `#92` at exact head
      `a83028558b39c145587279a984bfd906cd2625df` and accept every exact-head gate. Evidence: CI
      `29658229300` including dependency review, release provenance `29658229310`, CodeQL
      `29658228654`, optional research `29658229306`, and native image security `29658229337`
      passed; 17 checks passed, five event-appropriate jobs skipped, and none failed. Local
      evidence also passed 75/75 executable pipeline tests with one optional-raster skip, the
      Cloudflare build and 325/325 Node tests, Ruff, ESLint, TypeScript, repository security,
      lock, and SBOM checks.
- [x] Merge only after every required check passes, then reconcile exact implementation `main`
      `e74c2bd97fbb2fce1c9fabddf446ba2182b65a51`. Evidence: CI `29658373069`, release provenance
      `29658373025`, CodeQL `29658372800`, optional research `29658373038`, and native image
      security `29658373034` passed; open PRs and all three alert classes are empty; issue `#86`
      remains open by design. Cloudflare and production remain paused.

## Completed prior seven-step cycle — API image exception deadline

- [x] Reconcile the required handoff, exact `main`, open PRs/issues, Dependabot alerts, and
      post-merge workflows. Evidence: `main` is `e58a7f50359fc3e41f37e5ad168b9ecf089b50b8`,
      PRs and Dependabot alerts are empty, issue `#86` is the sole open issue, and CI,
      release-provenance, and CodeQL all passed that exact commit.
- [x] Re-check official Python and CPython sources. Python 3.13.14 remains the latest stable
      3.13 release; the three security fixes have upstream/backport PRs but no containing stable
      3.13 release; PEP 719 schedules Python 3.13.15 for 2026-08-04.
- [x] Re-check the Docker Official Image source and public registry. The selected tag still maps
      to source revision `f79aea5b8f6b2d65b31ba2bb3f69c0c2083345c8`, index digest
      `sha256:399babc8b49529dabfd9c922f2b5eea81d611e4512e3ed250d75bd2e7683f4b0`,
      AMD64 manifest `sha256:c25cd44f45df1279a2cba589e67dfcd9db04647ea483b117a7de8b1a99bdfb23`,
      and ARM64 manifest `sha256:0515d7a37d0febc8bd7d88b4879b8598f4e1a1aae16307c733fd34f36be18f15`.
- [x] Implement the bounded fallback without weakening mitigations: named security owner,
      mandatory 2026-08-04 re-review, 2026-08-08 hard expiry, primary-source binding, at most
      seven days of post-release grace, immediate stable-series-fix rejection, and preserved
      `tarfile`/`html.parser` removal plus import guards. Focused contract tests pass 16/16.
- [x] Pass the complete local repository, API, pipeline, security, SBOM, build, and mobile gates.
      Evidence: 325/325 repository tests, 29/29 API tests plus all 13 critical query plans,
      69/69 pipeline tests with one documented optional raster skip, 102/102 mobile-browser
      tests, lint, typecheck, secrets, exact Python locks, zero-execution npm policy, both SBOM
      checks, and both npm audits with zero vulnerabilities.
- [x] Publish the protected draft PR and accept fresh native AMD64/ARM64 image evidence plus all
      required checks on the exact head. PR `#90` head
      `f20c210bb8014baee62c9bf09010a3d5a99c5d97` passed CI `29652969717`, image-security
      `29652969712`, release-provenance `29652969706`, and CodeQL `29652968953`. AMD64 artifact
      `8432023776` (`sha256:a972eeb814fcdb28a56ca20b676645b0ba5c58d50a9fd3f19a9b34075cf77320`)
      and ARM64 artifact `8432025040`
      (`sha256:cfdd3f5a3d8ccea37ce051a1ded26474c96010434814da4e02759161423621de`)
      retain the raw and normalized evidence.
- [x] Merge only after every required check passes, then reconcile the exact `main` commit,
      post-merge workflows, artifacts, and alert state. PR `#90` merged as
      `f1a6579ca97fa509b0b1ac1367c6fa7e4c644104`; main CI `29653146497`, image-security
      `29653146520`, release-provenance `29653146479`, and CodeQL `29653146307` passed. AMD64
      artifact `8432074834`
      (`sha256:a82c248231ddf83164aad84563b3c5703951f6c39c409b2b71885daa7757b060`)
      and ARM64 artifact `8432075433`
      (`sha256:c9eaa3426e90188c0db8015a06018c0fffd20d072b71b4f77a7590ca0b0b2591`)
      preserve matching source-bound reports through 2026-08-17. Open Dependabot,
      code-scanning, and secret-scanning alerts are all zero; issue `#86` stays open for the
      mandatory 2026-08-04 re-review. Cloudflare and production remain paused.

## Completed prior seven-step cycle — official fisheries data

- [x] Reconcile PR `#87`, its exact post-merge checks, and the zero-open-alert repository state.
- [x] Inventory the existing CDFW, CRFS, and RecFIN contracts without ingesting private or
      social data.
- [x] Verify the current ds3185/ds3186 official service identities, revisions, dictionaries,
      sampling boundaries, license labels, and export drift.
- [x] Acquire and twice reproduce canonical owner-only snapshots with byte-binding receipts and
      a fail-closed acquisition command.
- [x] Verify support and allowed-use boundaries. Local evidence: 69/69 pipeline tests passed
      (one documented optional raster test skipped), 324/324 repository tests passed, Ruff,
      lint, typecheck, offline dependency audits, secrets, locks, and both SBOM checks passed.
- [x] Publish PR `#88` and obtain hosted network-audit and 102/102 mobile-browser evidence.
      API, dependency review, both pinned Python stacks, CodeQL for Actions/JavaScript/Python,
      pipeline, web, and release-provenance checks all passed on the exact PR commit.
- [x] Merge only after every required hosted check passes and reconcile the exact main commit.
      PR `#88` merged as `5b221f59c39f69d939f144f99a3ea81226e8908d`; post-merge CI
      `29645959440`, release provenance `29645959456`, optional Python `29645959451`, and CodeQL
      `29645959414` all passed. Dependabot remained at zero open alerts. Cloudflare and
      production remain paused.

## Completed earlier seven-step cycle

- [x] Triage PRs `#17`–`#32`; close unsafe, broken, duplicated, or superseded updates.
- [x] Upgrade and lock maintained runtimes and direct dependency families.
- [x] Produce and independently verify deterministic signed release provenance.
- [x] Produce the combined npm/Python/API-image/Worker/D1/assets release inventory and SBOM.
- [x] Accept the native AMD64/ARM64 API-image package, license, and vulnerability gate.
- [x] Run the clean-commit synthetic non-production restore/deletion-replay drill and preserve
      only private aggregate evidence. Production data, provider access, key custody, real-backup
      recovery, and second-person approval remain explicitly false.
- [x] Create this status dashboard, re-run the safe offline observability/performance/SEO and
      mobile checks, and preserve UI/brand work as the final priority. Verification: 319/319
      repository tests, 17/17 focused observability/scale/SEO tests, and 102/102 mobile tests.

## P0 — Immediate safety and launch integrity

- [x] Establish the cross-functional baseline audit and truthful model-claim rules.
- [ ] Prevent AI-generated trip summaries from publishing without explicit human approval.
      **Local complete;** guarded production migration/deployment, legacy-row audit, and live
      smoke evidence remain.
- [ ] Release production hardening: headers, health/security endpoints, abuse controls,
      sanitized logs, migrations, alerts, backup verification, and restore readiness.
      **Local implementation and synthetic restore drill complete;** Cloudflare deployment,
      rate-limit/WAF/Turnstile activation, alert delivery, key custody, and independent review
      remain.
- [ ] Make account privacy promises durable across active rows, public copies, objects,
      deletion queues, exports, receipts, retries, and restored data. **Local complete;**
      production migration/provider/counsel evidence remains.
- [ ] Complete defense-in-depth security and authorization review: session cookies, access
      matrix and ownership predicates, schema/input/output/upload/prompt boundaries, endpoint
      abuse ceilings, password safety, encryption/custody, version locks, SBOMs, provenance,
      vulnerability response, restore testing, and authorized staging penetration testing.
      **Most repository controls complete; the 13-layer owner reference mapping and zero-execution
      npm install-script boundary are locally complete;** production/provider/staging gates remain,
      including isolated DAST, active edge filtering, live detection/alerting, key custody, and
      independent review.
- [ ] Complete the privacy lifecycle: data inventory, cascade map, deletion semantics,
      retention decision, rights workflows, processor handling, and counsel approval. **Local
      inventory/cascade/deletion checks complete;** the optional 30-day recovery decision and
      external legal/provider drills remain.
- [ ] Provide and drill safe maintenance mode on every production hostname. **Local complete;**
      production activation, stale-client recovery, and captured evidence remain.

## P1 — Evidence, data contracts, discoverability, and scale

- [ ] Establish privacy-preserving production observability and an operator console, including
      structured logs, request IDs, redaction, searchable failures, alerts, backup/privacy-job
      views, immutable changes, and a separately authorized future financial domain. **Local
      logging schema/runbook complete;** provider dashboard, access, retention, cost, uptime,
      and delivered-alert evidence remain. PostHog remains deferred pending privacy review.
- [ ] Make data and execution paths measurably scalable: query plans/indexes, bounded access,
      cache matrix, justified asynchronous work, D1-managed connections, optional API pooling,
      and isolated load/soak/spike/failure tests. **Local query/index/cache/connection contracts,
      production-refusing harness, and the default-off advisory Queue adapter with its opaque
      message, D1 outbox/lease/attention ledger, bounded retries, deletion/maintenance recovery,
      DLQ policy, and guarded replay planner are complete;** migrations, provider Queue/DLQ
      bindings, IAM/alerts, staging measurements, failure injection, rollback evidence, and
      authorized penetration testing remain.
- [ ] Freeze and deploy the species-aware observation/model-run contract. **Local contract
      complete;** production migration, legacy-row audit, and first approved ingestion manifest
      remain.
- [ ] Freeze and govern the validation protocol. **v1 correctly inactive; v2 and the 730-day
      technical candidate are locally complete;** policy/key/schedule/legal review, external
      preregistration, witnessed restore, and activation remain.
- [ ] Acquire reproducible official CDFW/CRFS/RecFIN data with manifests, checksums, licenses,
      dictionaries, sampling support, and allowed-use declarations; begin a prospective cohort.
      **Exact aggregate ds3186/ds3185 snapshots and receipts complete;** both are context-only,
      while a complete-effort RecFIN export and the prospective cohort remain open.
- [ ] Treat Fishbrain only as an optional written-license partnership and Facebook groups only
      as admin-approved prospective recruitment—never scraped retrospective evidence.
      **Local default-deny policy/schema/loader and operation gates complete;** written platform
      permissions or license, administrator approval, direct participant opt-in, legal/privacy
      review, and any separately protected policy change remain open. No social data was acquired.
- [ ] Validate California halibut relative ranking against frozen baselines and publish
      uncertainty, limitations, negative results, and the current all-zero sample constraint.
- [ ] Define model promotion, drift, rollback, monitoring, and revalidation gates. **Local
      policy, schema, evaluator, CLI, and operator runbook complete;** the separate confirmatory
      protocol, eligible locked-test evidence, independent review, staged serving exercises,
      provider monitoring, and deployed release binding remain open.
- [ ] Establish truthful technical SEO and measurement. **Local crawl set, canonicals,
      metadata, social previews, JSON-LD, robots, sitemap, noindex, asset/font cleanup, and
      runbook complete;** deployment, Google/Bing verification/submission, coverage, Core Web
      Vitals, and privacy-reviewed funnel baselines remain.
- [ ] Make infrastructure mobile-ready with shared schemas, appropriate authentication,
      queue-based work, staging, bounded retries/costs, and WebKit/offline/safe-area coverage.
      **Local compatibility control implemented:** API responses advertise compatibility version
      `1`; opt-in incompatible clients fail before expensive work; current secure-cookie web
      clients remain compatible; shared schemas are inventoried; fixed surfaces consume all four
      safe-area insets; and hosted CI runs the mobile/offline suite on Chromium and WebKit. Native
      PKCE/token work, isolated staging, physical-device acceptance, provider bindings, deployment,
      and production-scale evidence remain open.

## P2 — Species and business expansion

- [ ] Add striped bass as the first distinct estuary/migration beta.
- [ ] Add defensible rockfish complexes, cabezon, and surfperch groups, each with its own source
      inventory, model card, validation gate, and regulation treatment.
- [ ] Complete business/legal readiness before promotion or revenue: entity/DBA, tax/local
      license, trademark, counsel/CPA, DMCA/UGC, and insurance review.
- [ ] Preserve authorship and business evidence: dated decisions, source/asset provenance,
      licenses/assignments, contributor agreements, release hashes, archived public artifacts,
      and counsel-guided copyright/trademark/patent/trade-secret decisions. **Local public-asset
      register, strict schema/policy, fail-closed hash/license/live-copy verifier, deterministic
      public-safe report, and owner/artist workflow are complete;** eight legacy brand/texture
      paths still need private owner evidence, and agreements, archived public artifacts,
      counsel decisions, and operator-console integration remain open.

## P3 — Experience and brand (intentionally last)

- [ ] Complete accessibility and interaction review: keyboard/screen reader, zoom/reflow,
      contrast, reduced motion, and a non-map path.
- [x] Add the branded accessible, noindex, non-cacheable `404` page and home action.
- [ ] Finish truthful operation-specific loading/progress/retry/cancel/reconnection states.
      **Route, profile, trip, deletion, edit, gear, sign-out, and saved-location safety states are
      locally complete;** only APIs that can report real progress may receive detailed progress.
- [ ] Add per-file photo upload states: visible glow plus copy shift, thumbnail, type, size,
      validation, independent progress/retry/cancel, and honest indeterminate state. Photos stay
      disabled until storage/privacy/security gates pass.
- [ ] Refresh visual design, graphics, species art, empty states, social cards, and brand
      illustration. Artist collaboration remains deferred until higher-risk work is complete.

## Product-owner work that is safe while Cloudflare stays paused

- [ ] Audit MFA/passkeys and recovery methods for GitHub, Cloudflare, the domain registrar,
      primary email, Google Search Console, and Bing Webmaster Tools. Store recovery codes
      offline; never paste them into Codex, GitHub, or a dashboard note.
- [ ] Choose the independent technical reviewer for restore/key-custody evidence. They should
      review aggregate receipts and the runbook, never receive production data or secret bytes.
- [ ] Choose an alert destination and escalation owner: monitored email/phone, acknowledgement
      expectation, backup contact, and quiet-hours policy.
- [ ] Make a private business-record folder for formation/tax/license questions, counsel/CPA
      notes, trademark research, insurance quotes, contracts, invoices, and renewal dates.
      Treat these as questions for qualified professionals, not completed legal conclusions.
- [x] Start an authorship/provenance register: all 15 public visual assets now have exact hashes,
      source/rights/release fields, AI-assistance state, evidence references, and a strict CI gate.
      Eight pre-policy brand/texture paths correctly remain `owner_confirmation_required`; keep
      their private source files, assignments, and legal notes outside Git.
- [ ] Before using your artist friend’s work, agree in writing on scope, credit, payment,
      ownership/license, modification rights, source-file delivery, and whether portfolio use is
      allowed. Actual visual commissioning can wait until P3.
- [ ] Prepare an SEO language sheet: audience questions, honest page purpose, candidate search
      phrases, prohibited accuracy claims, and desired snippets for the four public pages. Do
      not change DNS or submit URLs until the reviewed crawl foundation is deployed.
- [ ] Record current Google/Bing dashboard ownership and verification status with screenshots
      that contain no secrets. Leave sitemap submission and live URL inspection for deployment.
- [x] Build the official-data source register for CDFW/CRFS/RecFIN: dataset name, official URL,
      owner, retrieval method, license/terms, dictionary, update cadence, and intended use. Do
      not ingest private/social data. The register and exact ds3185/ds3186 receipts are in
      `docs/OFFICIAL-FISHERIES-DATA.md` and `pipeline/sources/receipts/`; neither aggregate is
      approved for training, validation, scoring, or point labels.
- [ ] Draft five short user-interview scripts focused on whether people understand the
      heuristic ranking, freshness labels, limitations, and trip-report privacy. Avoid collecting
      precise locations, credentials, or private trip notes while the service is paused.
- [ ] Track operating costs and receipts by provider in a simple accounting ledger. Keep this
      separate from application logs and analytics; a financial dashboard comes later.

## Do not do yet

- Do not resume Cloudflare, reconnect Git deployments, change production DNS, deploy,
      migrate D1, provision production secrets, enable Turnstile, or submit the sitemap until the
      guarded release checklist reaches those steps.
- Do not enable photos, public discussions, AI auto-publication, the validation pilot, or
      PostHog/session replay.
- Do not run load, stress, vulnerability scanning, or penetration testing against
      `castingcompass.com` or any production data. Use only an explicitly authorized isolated
      staging target later.
- Do not paste passwords, tokens, cookies, key material, recovery codes, private exports,
      user data, or unredacted provider screenshots into Codex, GitHub, logs, or PRs.
