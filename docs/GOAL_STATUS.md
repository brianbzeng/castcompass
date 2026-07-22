# CastingCompass goal status

Last reconciled: **2026-07-22 UTC**

This is the owner-facing dashboard for the complete goal list. The detailed acceptance
criteria and immutable receipts remain in [PRODUCT_ROADMAP.md](PRODUCT_ROADMAP.md); provider
steps remain in [PRODUCTION-OPERATIONS.md](PRODUCTION-OPERATIONS.md). A checked item here means
its complete acceptance boundary passed. “Local complete” means the repository control passed
but the parent stays open until its production, provider, legal, or independent-review gate is
also satisfied.

Current provider truth overrides historical “paused” language in completed receipts below. The
2026-07-19 read-only reconciliation found an active Worker; no production mutation is authorized
by that discovery.

## Active checkpoint — bounded privacy-tombstone retention

- [x] Remove the remaining hidden child-cascade fan-out from scheduled retention. One oldest
      eligible completed deletion job now contributes at most 100 completed, locator-free task
      rows per pass; a separate delete removes at most 100 parent tombstones only after no child
      row remains, so the foreign-key cascade writes zero children.
- [x] Preserve privacy truth while draining the backlog. Incomplete, locator-bearing, leased,
      pending, or attention-state tasks cannot be pruned, while a 101-task completed fixture
      leaves exactly one child and its parent after the first pass and removes both on the next.
- [x] Bind the candidate, exact parent compare-and-set, bounded child delete, claim clear, and
      childless-parent delete to the existing completed-job, job/object, and primary-key indexes.
      Drift after candidate selection deletes nothing; a simulated lost post-commit response
      leaves the exact completed retention result and no partial claim. The current repository
      ledger covers 254 Worker prepare sites (240 literal and 14 reviewed nonliteral), and the D1
      contract now exercises 54 critical plans across all 20 migrations.
- [x] Re-run the repository acceptance matrix after the bounded-retention change: project-source
      lint, TypeScript, the complete security policy chain, release SBOM, Cloudflare build, 669
      Worker/runtime tests, 200 mobile/browser tests, 29 API tests, Ruff, 128 pipeline tests, and
      the seeded synthetic smoke workflow all pass. These are local deterministic controls; they
      do not substitute for the isolated-staging measurements below.
- [ ] Capture actual rows-read/written, latency, backlog-drain, and migration-cost evidence on
      production-shaped synthetic data in isolated staging. This local checkpoint performs no
      deployment, provider request, migration, production mutation, or load exercise.

## Active checkpoint — hybrid seafloor representation experiment

- [x] Resume model work from the recorded negative result rather than from product intuition. The
      frozen seafloor-character probe found that bathymetry pretraining improved log loss and
      beat depth-only features but did not beat the classical multiscale geomorphology baseline
      on macro F1, so its encoder remains unpromoted and disconnected from scoring.
- [x] Freeze a comparable three-way bathymetry-only, backscatter-only, and fused experiment.
      Every mode uses the same source corpus, geographic fold, seed, architecture capacity,
      optimizer, mask policy, and epoch budget; the new target-agnostic dataset kind cannot carry
      a California-halibut target or observation contract.
- [x] Implement the documented hybrid objective: shared multiscale ResNet features feed spatial
      NT-Xent and a measured-channel reconstruction decoder. Each survey-bound intensity keeps a
      binary availability input that is never noised, dropped, masked, or reconstructed, and
      loss excludes every unavailable source pixel. Overlapping surveys remain distinct rather
      than being silently averaged or mislabeled as calibrated dB.
- [x] Add fail-closed aligned-layer and corpus provenance boundaries. CRS/shape/affine alignment,
      source identity, source-operation admission, checksum inputs, paired missingness metadata,
      binary availability, unique channel order, and modality-specific reconstruction targets
      must all pass before training.
- [x] Prove the architecture and runner on synthetic tensors using the locked macOS ARM64
      Geo/PyTorch environment. The test performs a real one-epoch fused run and verifies its
      checkpoint, metrics, content-derived target-agnostic model identity, and explicit
      non-catch-accuracy claim. This is pipeline plumbing evidence only.
- [x] Acquire every official byte twice and reproduce the full aligned corpus exactly. The
      matching bathymetry plus four 2 m survey archives and extracted GeoTIFFs matched their
      recorded SHA-256 values on two downloads. A seeded reservoir retained 4,096 locations from
      7,075 eligible centers across all 53 tiles and all four survey footprints; two independent
      builds produced corpus SHA-256
      `dd88342209522d12726208259640fe7ac9379a61fa79cd9e606475945dd9af4a`.
      Survey overlaps remain separate and the southern 2006 footprint is no longer lost to the
      prior north-first early-stop bias.
- [x] Complete and exactly reproduce the three official-data hybrid pretraining runs at source
      commit `01ca3fee9b514034068ccbc05858cf1f72c6b913`. All modes used validation fold `3`,
      the first deterministic availability-only fold whose training geography contains measured
      pixels from all four surveys, plus the same seed, spatial split, optimizer, mask policy,
      and 20-epoch budget. The second execution reproduced every training-history value, learned
      tensor, normalization statistic, and corpus binding for all three modes. The minimized
      [experiment receipt](../pipeline/evidence/hybrid-seafloor-v1.receipt.json) preserves the
      exact clean model identities and artifact hashes. Best held-out hybrid losses were 1.621
      for bathymetry, 1.526 for backscatter, and 1.575 for fused; these differently targeted
      optimization losses do not rank representation quality or authorize promotion.
- [x] Run the same source-separated downstream probe for all three frozen encoders plus declared
      input-matched classical and architecture-matched random baselines, then a separate
      rare-structure probe. The common probe exactly reused pretraining holdout `3`; fused deep
      features reached macro F1 `0.7020` and reliably exceeded both single-modality encoders, but
      remained reliably below fused classical summaries at `0.7574`. The 192-row balanced rare
      case-control corpus retained 82 connected components, held out 37 with zero overlap after a
      512 m buffer, and reproduced byte-for-byte. Fused deep features reached macro F1 `0.7259`,
      reliably beat their random encoder and backscatter pretraining, but did not reliably beat
      bathymetry pretraining or fused classical summaries. Two executions reproduced exact common
      and rare metrics/prediction bytes; the minimized
      [probe receipt](../pipeline/evidence/hybrid-seafloor-probes-v1.receipt.json) binds the clean
      source and official artifacts. The USGS target was itself interpreted from bathymetry,
      backscatter, and video, and the rare set is not prevalence-representative. No encoder was
      promoted or connected to the live score; model-governance and confirmatory-validation gates
      remain independently open.
- [x] Add and exactly reproduce the post-hoc survey-footprint diagnostic before selecting another
      downstream target. The runner audits exact availability patterns, coordinate context,
      missingness-only and bathymetry-plus-missingness baselines, low-support seam slices, and
      leave-one-survey-domain-out transfer. A domain now needs at least 32 total rows and 16 rows
      per class on both sides; unsupported domains are recorded rather than pooled.
- [x] Record the negative shortcut result without promotion. The fixed holdout contains only the
      2004 survey at measured centers, and availability summaries add a reliable `+0.0968`
      macro-F1 to bathymetry summaries inside that source-degenerate fold. On the two admissible
      unseen-survey tests, fused pretraining is reliably worse than bathymetry pretraining by
      `-0.1634` (2004) and `-0.0572` (2008) median macro F1. The sparse 2007 and single-class 2006
      domains fail closed. Two executions reproduced exact metrics and predictions; the
      [shortcut receipt](../pipeline/evidence/hybrid-seafloor-shortcut-diagnostic-v1.receipt.json)
      preserves the complete boundary. Shortcut risk remains unresolved, and no encoder, score,
      or serving path changes.
- [x] Audit the official raw USGS camera observations as a more direct endpoint before changing
      architecture or touching fishing labels. Exact archive/member hashes, strict Point/DBF
      parsing, the existing hybrid patch contract, and a whole-cruise/line/tape split gate are
      frozen in code. Of 3,759 classified observations, 187 land on valid reference centers and
      166 retain every required patch; their class counts are 94 smooth, 22 mixed/rugose, and 50
      mobile coarse.
- [x] Record the video endpoint as not admissible rather than leaking adjacent track rows. All 50
      mobile-coarse rows and 21 of 22 mixed/rugose rows occur in one of four retained track groups;
      none of the seven unique whole-group partitions leaves at least 16 rows of every class on
      both sides. Two clean executions reproduced byte-identical metrics. The
      [video endpoint receipt](../pipeline/evidence/usgs-sf-video-endpoint-audit-v1.receipt.json)
      records that no model ran and no encoder, score, serving path, or production state changed.
- [x] Expand the direct-video support search to the exact official Santa Barbara South Coast
      footprint without changing the San Francisco result. Four content-addressed USGS map blocks
      from Refugio through Carpinteria, 11 survey-specific backscatter layers, and four complete
      video archives are locked in a fail-closed manifest. The class collapse, west-to-east overlap
      assignment, three-scale patch contract, whole-cruise split, and 16-row per-class floor were
      committed before reading the `sw109sc` or `z107sc` labels; earlier exposure of `s1c08sc` and
      `z206sc` is disclosed rather than called confirmatory.
- [x] Record the South Coast endpoint as another truthful negative result. The four archives
      contain 4,251 labeled rows but zero raw class-4 observations. Of 1,327 complete hybrid rows,
      1,030 are smooth, 297 mixed/rugose, and zero mobile coarse; therefore none of seven
      whole-cruise partitions can meet the frozen three-class floor. Two independent-download
      executions produced byte-identical metrics. The
      [South Coast receipt](../pipeline/evidence/usgs-south-coast-video-endpoint-audit-v1.receipt.json)
      preserves the narrower Refugio-through-Carpinteria evidence boundary and confirms that no
      model, encoder, score, serving path, production state, or Gaviota coverage claim changed.
- [x] Screen the six residual official USGS DS781 video archives under a protocol frozen before
      their class values were read. Two independent downloads of 18,722 exact records match;
      strict archive, SHP, DBF, class-domain, and whole-cruise checks are reproducible. The
      [residual-screen receipt](../pipeline/evidence/usgs-residual-statewide-video-support-screen-v1.receipt.json)
      binds the protocol, source manifest, result, archive hashes, and no-training decision.
- [x] Preserve the residual catalog result as fail-closed rather than repairing labels or group
      identity. Among 15,335 nonblank class rows, `s2210mb` has 444 raw class-`0` rows outside the
      frozen domain and 26 rows without complete `LINE`/`TAPE` identity. Although 16 of 31
      recognized-row partitions pass the numerical support floor, that diagnostic depends on the
      invalid archive. Of the schema-valid archives, only `c0212sc` contains class 4; no valid
      whole-cruise split can place that class on both sides. No rasters were acquired and no model,
      encoder, score, serving path, production state, or deployment authority changed.
- [x] Preregister a materially different measured endpoint before computing its distribution.
      USGS Data Series 182 laboratory-extracted bulk-surficial `Gravel`/`Sand`/`Mud` percentages,
      strict surface and composition checks, whole-source transfer, continuous-support anchors,
      and stop conditions are frozen separately from the rejected interpreted/video classes.
- [x] Preserve the exact Data Series 182 text representation as another fail-closed source result.
      Two independent downloads match every archive member, but 14,950 of 16,485 `PAC_EXT.txt`
      rows have 31 fields under the exact 32-field header; only 1,535 have 32. The audit does not
      pad an assumed trailing blank, shift fields, or silently switch to the companion dBASE
      member. No composition aggregate or partition was computed, no raster pixel was read, and no
      corpus, model, score, serving path, or production state changed. A new exploratory dBASE
      protocol must disclose this exposure and remains insufficient for confirmatory promotion.
- [x] Audit the separately preregistered dBASE representation without repairing the failed text
      result. The exact 16,485-record fixed-width table and same-position Point geometry pass all
      structural checks, but only 136 distinct-sample records fall inside the exact San Francisco
      raster footprint and zero satisfy every frozen endpoint rule. Two independent-download runs
      reproduce byte-identical metrics. No source-quality or alignment review is authorized, no
      raster pixel is read, and no corpus, model, score, serving path, production state, or
      deployment authority changes.
- [x] Test the same frozen direct-sediment endpoint inside the exact Santa Barbara South Coast
      imagery before attempting local training. Ninety-five distinct samples fall inside the four
      metadata-only footprints; 26 rows/sites across three sources pass every endpoint rule, but
      zero are gravel-bearing and only three are sand-dominant. Zero of three whole-source
      partitions meets the fixed support floor. The result reproduces exactly, reads no raster
      pixels, and authorizes no source review, alignment, corpus, training, score, serving,
      production, or deployment change.
- [ ] Acquire a genuinely support-complete independent endpoint before the next representation
      comparison. Neither the San Francisco track groups, the Santa Barbara South Coast cruises,
      the residual statewide catalog, nor the San Francisco or Santa Barbara DS182
      direct-sediment screens provide a support-complete, source-separable endpoint inside the
      admitted imagery. Additional
      direct-video tracks must distribute every class across separable groups, a prospective
      independent survey must be designed, or a materially different scientific question must be
      preregistered before its labels are read; post-outcome class dropping, schema repair, and
      row-randomized adjacent observations remain prohibited.
  - [x] Complete a fail-closed official-source inventory before acquiring more pixels or fitting
        another probe. Seven candidate families were reviewed. NOAA's California hard/soft layer
        is an unvalidated compiled map, its California-halibut HSM is a bathymetry/substrate model,
        Digital Coast grab data has no California collection and cannot sample hard bottom, mapped
        cover/habitat reuses remote or acoustic inputs, and the DS781/DS182 families are the same
        support-incomplete evidence already audited. The machine policy gives every candidate an
        empty evidence role and authorizes no raster pairing, training, representation comparison,
        promotion, scoring, or production use.
  - [x] Freeze a prospective direct-video collection design without activating it. The frame hides
        model outputs and substrate texture, the three existing classes cannot be changed after
        label visibility, two blinded labelers plus adjudication are required, a whole
        vessel/platform collection day is indivisible, every boundary carries a 512 m buffer, and
        a later comparison requires at least 32 deployments per class, three groups, and three
        regions on both sides of an outcome-blind whole-group partition.
  - [ ] Activate and execute that survey only after externally timestamped preregistration; legal,
        privacy, safety, protected-area/permitting, and data-steward approval; fixed assignments;
        equipment and label-manual hashes; trained collectors/labelers; and approved custody for
        video and precise coordinates. Ordinary fishing-trip logs remain separate catch evidence
        and cannot be backfilled as seafloor labels.

This checkpoint changes no browser behavior, API, Worker, D1/R2/Queue state, production provider,
live score, public model claim, or deployment authority.

## Active checkpoint — exact isolated-staging exercise identity

- [x] Close the adjacent remote-load identity gap before designing any authenticated mutation
      drill. The prior read-only harness blocked known production aliases but a typed phrase alone
      could still authorize an arbitrary remote origin, and it did not prove the tested Worker was
      the reviewed build or the isolated synthetic target.
- [x] Require canonical named HTTPS staging, a clean exact commit reachable from the reviewed
      official `origin/main`, and the exact API compatibility, Worker version, opaque exercise
      marker, D1 health, no-store, non-redirect, and non-maintenance identity before any timed
      remote request. Lock the four GET-only routes, profile ceilings, and performance budgets;
      reject IP literals, cleartext, widened scope, dirty/unreviewed source, stale identity, and
      oversized health bodies. Aggregate stdout omits the target, Worker version, and marker.
- [x] Cross-test the load preflight against the actual current Worker health implementation and
      prove checkout refusal happens before preflight while identity refusal happens before any
      load worker. This repository-only preparation contacted no remote target and ran no load,
      stress, failure-injection, or penetration exercise.
- [x] Seal the remote-load identity checkpoint under Node 22.23.1/npm 10.9.8 with the Cloudflare
      build, 653/653 Node tests, ESLint, TypeScript, the complete offline security/source-
      integrity chain, two zero-vulnerability audits, 250-site D1 inventory, all 50 critical plans
      across 20 migrations, 29/29 API tests, Ruff, 83/83 pipeline tests with one documented
      optional-`rasterio` skip, deterministic smoke, and the 200/200 Chromium/WebKit phone matrix.
      A deterministic release bundle and this clean local commit complete only the repository
      receipt. Actual isolated-staging authorization, deployment, measurements, provider metrics,
      remediation, and independent acceptance remain open.
- [x] Prepare the next authenticated advisory-review checkpoint without creating an execution
      path. The strict private authorization and plan-only CLI fix one hashed synthetic account,
      disjoint ten-trip direct and Queue groups, two overlapping retry requests per mode, one
      authorized client-response drop, duplicate Queue delivery, exact source/API/Worker/exercise/
      stub identity, private evidence, and zero production or real-provider access. There is no
      run command.
- [x] Add the staging-only internal review seam and deterministic stub. Partial/mixed identity,
      wrong account hash, real MiMo configuration, injected public fetch, or wrong stub Worker
      version performs no accepted provider work; stub output is explicitly synthetic, private,
      human-gated, and never echoes trip input. The production build contains no exercise binding
      or variable. These controls are local preparation, not provider or staging evidence.
- [x] Freeze the evidence semantics: two overlapping retry responses may describe the same queued
      rows, so their counts cannot be summed. Ten unique D1 rows and ten unique stub requests per
      mode are authoritative. One fault-proxy response drop proves only client/Worker ambiguity,
      not D1 SDK mutation-receipt loss.
- [x] Freeze the missing main-Worker staging boundary before any provider action. Two private
      resolved Wrangler configurations now fail closed against the exact production Worker, D1,
      host, and rate-limit inventory; require shared isolated resources, rate limiting, the private
      exercise service, and no undeclared provider or feature binding; and emit only a minimized
      no-provider/no-deployment receipt. The verifier has no run or deploy command.
- [x] Correct an impossible drill identity claim: direct review and durable Queue review cannot
      share one application Worker version because `AI_REVIEW_QUEUE_ENABLED` and Queue bindings
      are deployment configuration. Authorization and planning now require two distinct exact
      Worker versions plus the exact configuration-receipt hash, source, target, exercise,
      synthetic-account, and stub identities.
- [x] Reconcile the guarded security runner with the current Worker health contract. API
      compatibility discovery had added a sixth exact field after the original five-field
      preflight was sealed, so a real authorized exercise would have refused a healthy current
      staging release before invoking the scanner.
- [x] Version the strict policy, authorization, and aggregate-receipt contracts together; require
      the written authorization's API compatibility version to equal the repository-locked value;
      and bind preflight to exact API version, Worker version, opaque exercise marker, D1 health,
      no-store headers, non-maintenance state, and the canonical response field set.
- [x] Add a cross-contract test that sends the exercise preflight through the actual current
      Worker health implementation, plus explicit stale API-version refusal. This repository-only
      compatibility repair contacts no target, invokes no scanner, changes no provider, and is
      not staging or penetration-test evidence.
- [x] Seal the compatibility repair under the exact supported Node 22.23.1/npm 10.9.8 toolchain:
      Cloudflare build and 647/647 Node tests; ESLint and TypeScript; the complete offline security,
      source-integrity, SBOM, policy, and two zero-vulnerability audit chain; all 50 D1 plans across
      20 migrations; 29/29 API tests; Ruff; 83/83 pipeline tests with one documented optional-
      `rasterio` skip; deterministic smoke; and the 200/200 Chromium/WebKit phone matrix. The
      intentionally unsupported Node 24 shell was separately rejected by the existing restore-
      evidence runtime gate rather than being misreported as product failure.
- [x] Seal the isolated main-Worker configuration checkpoint under the supported Node 22.23.1/
      npm 10.9.8 toolchain: Cloudflare build and 668/668 Node tests; ESLint and TypeScript; the
      complete security, source-integrity, SBOM, policy, and two zero-vulnerability audit chain;
      all 50 D1 plans across 20 migrations; 29/29 API tests; Ruff; 82 passed plus one documented
      optional-`rasterio` pipeline skip and 138 subtests; deterministic synthetic smoke; and an
      isolated 200/200 Chromium/WebKit phone matrix. Preserve one clean local commit and a
      reproducible deterministic release bundle. No provider, deployment, remote target, or
      production operation is part of this checkpoint.
- [ ] Provision the isolated synthetic target and obtain the documented independent written
      authorization before running any public, authenticated, load, or intrusive exercise. Keep
      every production hostname and binding permanently outside the harness.

## Active checkpoint — exact manual advisory-review retry receipts

- [x] Audit the last runtime use of the mutation-metadata helper after the legal boundary was
      sealed. Owner-triggered advisory-review retry conservatively scheduled only a confirmed
      one-row result, but could not recover a committed batch response loss and returned its
      queued count from transport metadata rather than stored trip state.
- [x] Make each selected owner/trip/AI version the transactional compare-and-set boundary. Every
      write repeats opaque trip ID, authenticated owner, completed status, exact prior AI status,
      payload, model and review time, plus the trip update version. One batch remains bounded to
      ten rows and mutation metadata is now ignored entirely.
- [x] Require per-trip primary-key read-back of exact queued, prior, owner, and global cardinality.
      Exact queued state may schedule and count; an exact surviving prior state makes rollback
      unconfirmed; ownership, deletion, input-version, or downstream claim changes schedule
      nothing; unreadable or impossible state is `503`. Missing metadata and a lost committed
      batch response recover without replay.
- [x] Preserve single provider authority independently of request overlap. The immediate callback
      only reaches the existing random-token direct-review claim or exact queue-job dispatch claim;
      the scheduled backlog retains queued rows for durable recovery. Force ownership drift,
      update-version drift, omitted metadata, post-commit batch response loss, rollback, unreadable
      post-state, and bounded backlog recovery in direct D1 runtime tests. The source ledger now
      covers 250 prepare sites: 236 literal, 14 reviewed nonliteral, and nine reviewed complete-
      rights multi-row reads; all 20 migrations and 50 critical plans include both retry shapes.
- [x] Bound the complete ten-row request as one durable admission rather than ten immediate
      background pipelines. At most one exact queued row enters direct or Queue dispatch in the
      originating invocation, enforced by a singular handler/caller callback contract; the other
      nine remain in the scheduled backlog. A lost committed ten-row batch now exercises both
      modes at 27 local D1 statements, one provider request or Queue send, and zero dropped rows,
      preserving headroom below the 50-query Free ceiling.
- [x] Seal the implementation with the pinned Cloudflare build; lint and type checks; all 646/646
      Node tests; 29/29 API tests; Ruff; 83/83 pipeline tests with one documented optional-
      `rasterio` skip; the complete offline security, SBOM, source-integrity, and two zero-
      vulnerability audit chain; deterministic smoke; all 50 critical plans across 20 migrations;
      and the 200/200 Chromium/WebKit phone matrix. Reproducible pre-commit and exact-commit
      release bundles plus the clean local commit complete this checkpoint receipt. No push, PR,
      merge, deployment, provider query, production database mutation, feature activation,
      public AI output, UI change, or model claim belongs to this checkpoint.
- [ ] Exercise true ten-row overlap, queue-enabled and direct-provider dispatch, response loss,
      provider/Queue latency, and actual D1 rows-read/written behavior with production-shaped
      synthetic data in isolated staging before treating the bounded local statement proof as
      deployed evidence.

## Active checkpoint — exact legal-acceptance receipts

- [x] Continue the database-authority audit at the higher-risk of the two remaining mutation-
      metadata call sites. Authenticated Terms/Privacy reacceptance could safely suppress a
      receipt when metadata was missing, but it could not recover a committed response loss and
      did not prove that the account version or browser session remained authoritative.
- [x] Make one complete authenticated account version plus its exact live session the compare-and-
      set boundary. The write repeats account ID/email, immutable creation and age timestamps,
      every prior legal field, the update version, and the token hash/owner/exact expiry of the
      still-live session. It never changes the prior age-eligibility proof.
- [x] Make exact read-back the only browser compliance authority. Success proves the request's
      accepted timestamps/current versions, absence of its prior snapshot, unique account ID, and
      continuing exact session. Mutation metadata and transport success grant nothing: omitted
      metadata and a lost committed response recover; rollback, unreadable or changed state is
      `503`; account deletion or session revocation is `401` with stale-cookie clearing.
- [x] Force each boundary in the direct D1 runtime, including account deletion before the write,
      omitted metadata, post-commit response loss, failed write, failed receipt read after commit,
      a changed account version, session revocation, and account deletion between commit and
      receipt. The source ledger now covers 249 prepare sites: 235 literal, 14 reviewed nonliteral,
      and nine reviewed complete-rights multi-row reads. All 20 migrations and 48 critical plans
      include the full legal compare-and-set and receipt through user/session indexes.
- [x] Seal the local checkpoint with the pinned Cloudflare build; lint and type checks; all
      645/645 Node tests; 29/29 API tests; Ruff; 83/83 pipeline tests with one documented optional
      rasterio skip; the complete offline security, SBOM, source-integrity, and two zero-
      vulnerability audit chain; deterministic smoke; all 48 critical plans across 20 migrations;
      the 200/200 Chromium/WebKit phone matrix; a reproducible release bundle; and a clean local
      commit. No push, PR, merge, deployment, provider query, production database mutation,
      feature activation, UI change, or model claim belongs to this checkpoint.
- [ ] Exercise legal reacceptance overlap, session expiry/revocation, response loss, latency, and
      D1 rows-read/written behavior with production-shaped synthetic data in isolated staging
      before treating local receipt proof as deployed evidence.

## Active checkpoint — exact secret-bearing credential receipts

- [x] Continue the credential audit upstream of code verification. Age-proof creation and
      consumption, initial signup/recovery challenges, and both resend paths still treated D1
      mutation metadata as authority. Missing metadata safely suppressed secrets, but could not
      recover a committed response loss and did not prove the complete row before plaintext proof
      disclosure or email-provider delivery.
- [x] Make the complete random age-proof snapshot authoritative. Creation read-back proves token
      hash, confirmed time, gate version, expiry, unconsumed state, creation time, and unique hash
      cardinality before returning plaintext. One-use consumption repeats that version and proves
      exact consumed versus live prior state. Mutation metadata and transport success grant
      nothing; committed response loss recovers, while rollback, unreadable, expired, consumed, or
      changed state starts no challenge.
- [x] Make the complete email-challenge version authoritative for initial creation and resend.
      Initial delivery requires exact credential/age/legal/timestamp state, unique random ID, and
      a valid five-per-hour email count. Resend compare-and-set repeats the complete prior version,
      then proves complete next/prior snapshots and ID cardinality before delivery. Candidate
      cleanup repeats every field so it cannot remove a newer or changed version. Password
      recovery preserves the same generic anti-enumeration response for all unconfirmed states.
- [x] Force missing metadata and lost committed responses across proof creation, consumption,
      signup/recovery creation, and resend; force actual rollback, receipt-read failures, changed
      proof/challenge rows, a concurrent issuance-ceiling crossing, and a concurrent resend
      rotation. Exact committed state discloses or delivers once; every other state authorizes no
      plaintext/provider side effect. The source ledger covers 248 prepare sites: 234 literal, 14
      reviewed nonliteral, and nine reviewed complete-rights multi-row reads. All 20 migrations
      and 46 critical plans cover the exact proof/challenge receipts and their indexes.
- [x] Seal the local checkpoint with the pinned Cloudflare build; lint and type checks; all 645/645
      Node tests; 29/29 API tests; Ruff; 83/83 pipeline tests with one documented optional rasterio
      skip; the complete offline security, SBOM, source-integrity, and zero-vulnerability audit
      chain; deterministic smoke output; all 46 critical plans across 20 migrations; the full
      200/200 Chromium/WebKit phone matrix; a reproducible release bundle; and a clean local
      commit. No push, PR, merge, deployment, provider query, production database mutation,
      feature activation, UI change, or model claim belongs to this checkpoint.
- [ ] Exercise concurrent issuance/resend, response loss, provider latency, and D1 rows-read/written
      behavior with production-shaped synthetic data in isolated staging before treating local
      receipt proof as deployed evidence.

## Active checkpoint — exact sign-out revocation receipts

- [x] Reopen the account-exit boundary after exact session issuance was sealed. Sign-out still
      treated per-DELETE mutation metadata as authority; a failed or lost batch response could
      clear the browser cookie without proving whether the bearer session remained valid in D1,
      removing the user's only practical handle for retrying revocation.
- [x] Make stored absence the sole sign-out authority. Hash each distinct presented host or legacy
      token, execute the deletes as one transactional batch, and read each random hash back through
      the session primary key. Only readable zero cardinality for every token can return
      `{ signedOut: true, user: null }` and clear cookies. Mutation metadata and transport success
      grant nothing; an already-absent token remains exactly idempotent.
- [x] Preserve the revocation handle on ambiguity. Rollback, an unreadable receipt, or a row that
      appears before receipt read-back returns `503 sign_out_unconfirmed` without clearing either
      cookie. A committed delete whose response was lost recovers from exact absence without
      replay, while the existing read-only status check remains available.
- [x] Force omitted mutation metadata, a lost committed batch response, an actual transactional
      rollback, a receipt-read failure after commit, row reappearance before read-back, and an
      already-absent token, plus simultaneous distinct host and legacy tokens. Exact absence
      succeeds; every surviving or unreadable state fails closed. The source ledger now covers
      246 prepare sites: 232 literal, 14 reviewed nonliteral, and nine reviewed complete-rights
      multi-row reads; all 20 migrations and 41 critical D1 plans include the exact sign-out
      primary-key receipt.
- [x] Seal the checkpoint with the pinned Cloudflare build, lint, TypeScript, all 641/641 Node
      tests, the complete offline security/source-integrity chain, two zero-vulnerability npm
      audits, 29/29 API tests, Ruff, 82 passing pipeline tests with one documented optional-
      `rasterio` skip, deterministic smoke, all 20 migrations and 41 query plans, and the isolated
      200/200 Chromium/WebKit phone matrix. Verify byte-identical 162-file release artifacts,
      preserve one clean local commit, and keep all production authority closed. No push, PR,
      merge, deployment, provider query, production database mutation, feature activation, UI
      change, or model claim belongs to this checkpoint.
- [ ] Exercise multi-token revocation, response loss, latency, and rows-read/written behavior with
      production-shaped synthetic data in isolated staging before treating local receipt proof as
      deployed evidence.

## Active checkpoint — exact sign-in attempt receipts

- [x] Continue the credential-boundary audit through login abuse accounting. The conditional
      failure-slot INSERT and correct-password success-classification UPDATE were atomic, but
      still treated their D1 mutation metadata as authority and could not distinguish rollback
      from an exact commit whose response was lost.
- [x] Make the random server attempt ID authoritative before password work. Exact read-back must
      prove the pending ID, email pseudonym, server timestamp, unsuccessful state, unique ID
      cardinality, and a valid rolling failed-attempt count. Exact absence plus ten existing
      failures is the only rate-limit receipt; unreadable, changed, colliding, or impossible state
      remains `503` and performs no password derivation.
- [x] Make successful classification a separate exact authority boundary. Correct credentials
      can begin session issuance only after read-back proves that same ID/hash/timestamp row is
      successful, the prior pending state is absent, and the opaque ID remains unique. Mutation
      metadata and transport success grant nothing, so a committed response loss recovers without
      replay while rollback or unreadable state exposes no session.
- [x] Force omitted metadata and lost committed responses for both transitions, actual failed
      writes, both receipt-read failures, a changed pending snapshot, a changed classified
      snapshot, and the concurrent tenth-attempt crossing. Exact committed state proceeds;
      rollback and changed or unreadable state fail closed; the tenth request remains `429`; known
      and unknown bad credentials still perform equal password work and return the same generic
      `401`; the exact one-hour cutoff remains inclusive and releases rows one millisecond after
      expiry. The source ledger covers 245 prepare sites: 231 literal, 14 reviewed nonliteral, and
      nine reviewed complete-rights multi-row reads; all 20 migrations and 40 critical D1 plans
      pass with the attempt primary key and existing email/time index.
- [x] Seal the checkpoint with the pinned Cloudflare build, lint, TypeScript, all 636/636 Node
      tests, the complete security/source-integrity chain, two zero-vulnerability npm audits,
      29/29 API tests, Ruff, 82 passing pipeline tests with one documented optional-`rasterio`
      skip, deterministic smoke, all 20 migrations and 40 critical query plans, and the isolated
      200/200 Chromium/WebKit phone matrix. Preserve one clean local commit and deterministic
      release bundle. No push, PR, merge, deployment, provider query, production database
      mutation, feature activation, UI change, or model claim belongs to this checkpoint.
- [ ] Exercise simultaneous attempts, response loss, latency, and rows-read/written behavior with
      production-shaped synthetic data in isolated staging before treating local receipt proof as
      deployed evidence.

## Active checkpoint — exact email-code attempt receipts

- [x] Continue the credential-boundary audit through the shared verification-code attempt claim.
      Signup and password reset atomically compare-and-set the next bounded attempt before checking
      the code, but still treated UPDATE metadata as authority and could not recover after a
      committed claim lost its response.
- [x] Make the complete challenge version authoritative. The claim repeats ID, kind, email/user
      binding, code and optional credential material, age/legal fields, creation time, prior attempt
      count, resend count, and exact live expiry. Success requires exact read-back at the claimed
      attempt with the prior snapshot absent; mutation metadata and transport success grant nothing.
- [x] Force omitted metadata, a lost committed mutation response, an actual failed update, a receipt-
      read failure, mutation of credential material after the claim, and a code rotation before the
      claim. Exact committed state proceeds without replay; rollback and unreadable state authorize
      no account/session change; changed signup state remains `409`; password-reset failures remain
      the same generic `401`. The source ledger covers 243 prepare sites: 229 literal, 14 reviewed
      nonliteral, and nine reviewed complete-rights multi-row reads; 38 critical D1 plans cover the
      exact claim and receipt.
- [x] Seal the checkpoint with the pinned Cloudflare build, lint, TypeScript, 631/631 Node tests,
      complete security/source-integrity chain, two zero-vulnerability npm audits, 29/29 API
      tests, Ruff, 83 pipeline tests with one documented optional-rasterio skip, deterministic
      smoke, all 20 migrations and 38 critical query plans, and an isolated 200/200
      Chromium/WebKit phone matrix. Preserve one clean local commit and its deterministic release
      bundle. No push, PR, merge, deployment, provider query, production database mutation,
      feature activation, UI change, or model claim belongs to this checkpoint.
- [ ] Exercise simultaneous attempts/resends, lost responses, expiry boundaries, latency, and rows-
      read/written behavior with production-shaped synthetic data in isolated staging before
      treating local receipt proof as deployed evidence.

## Active checkpoint — exact account-creation receipts

- [x] Continue the database-authority audit through verified signup. User insertion and one-use
      challenge deletion were atomic, but welcome delivery and first-session issuance still
      depended on two D1 mutation receipts and returned a safe but avoidable `503` after an exact
      committed account lost either metadata result or the batch response.
- [x] Make the complete account boundary authoritative. Both atomic statements repeat the full
      challenge snapshot. Success requires the exact server-generated user ID, unique email,
      credential material, age proof, current legal versions and timestamps; zero prior sessions;
      zero challenge rows; and no deletion fence. Only that state can send the idempotent welcome
      message and begin exact session issuance.
- [x] Force omitted user-insert metadata, omitted challenge-delete metadata, a lost committed batch
      response, an actual transaction rollback, a receipt-read failure, conflicting account state,
      a deletion fence before confirmation, and an intervening challenge rotation. Exact committed
      state recovers without replay; every ambiguous or fenced state sends no welcome and creates
      no session; the rotated challenge remains `409`. The source ledger covers 242 prepare sites:
      228 literal, 14 reviewed nonliteral, and nine reviewed complete-rights multi-row reads; 37
      critical D1 plans cover the complete account receipt.
- [x] Seal the checkpoint with the pinned Cloudflare build, lint, TypeScript, 628/628 Node tests,
      complete security/source-integrity chain, two zero-vulnerability npm audits, 29/29 API
      tests, Ruff, 83 pipeline tests with one documented optional-rasterio skip, deterministic
      smoke, all 20 migrations and 37 critical query plans, and an isolated 200/200
      Chromium/WebKit phone matrix. Preserve one clean local commit and its deterministic release
      bundle. No push, PR, merge, deployment, provider query, production database mutation,
      feature activation, UI change, or model claim belongs to this checkpoint.
- [ ] Exercise lost-response, simultaneous signup, unique-email, session creation, deletion-fence,
      provider idempotency, latency, and rows-read/written behavior with production-shaped
      synthetic data in isolated staging before treating local receipt proof as deployed evidence.

## Active checkpoint — exact password-reset receipts

- [x] Continue the database-authority audit through the credential-reset transaction. Password
      replacement, all-session revocation, and one-use challenge deletion were atomic, but the
      route still depended on three D1 mutation receipts and returned a safe but avoidable `503`
      after a committed response was omitted or lost.
- [x] Make the complete credential lifecycle authoritative. Success requires the exact account,
      email, new salt, password hash, and server timestamp; zero prior sessions; zero rows for the
      one-use challenge; and no account-deletion fence. Mutation metadata and transport success
      grant nothing, and only that state can begin exact replacement-session issuance.
- [x] Force omitted password-update metadata, omitted challenge-delete metadata, a lost committed
      batch response, an actual transaction rollback, a receipt-read failure, a conflicting
      credential timestamp, a deletion fence appearing before confirmation, and an intervening
      challenge rotation. Exact committed states recover without replay; rollback and ambiguous
      state return `503`, the fence creates no session, and the rotated challenge remains `409`.
      The source ledger covers 241 prepare sites: 227 literal, 14 reviewed nonliteral, and nine
      reviewed complete-rights multi-row reads; 36 critical D1 plans cover the full receipt.
- [x] Seal the checkpoint with the pinned Cloudflare build, lint, TypeScript, 625/625 Node tests,
      complete security/source-integrity chain, two zero-vulnerability npm audits, 29/29 API
      tests, Ruff, 83 pipeline tests with one documented optional-rasterio skip, deterministic
      smoke, all 20 migrations and 36 critical query plans, and an isolated 200/200
      Chromium/WebKit phone matrix. Preserve one clean local commit and its deterministic release
      bundle. No push, PR, merge, deployment, provider query, production database mutation,
      feature activation, UI change, or model claim belongs to this checkpoint.
- [ ] Exercise lost-response, simultaneous resets, session creation, deletion-fence, latency, and
      rows-read/written behavior with production-shaped synthetic data in isolated staging before
      treating local receipt proof as deployed evidence.

## Active checkpoint — exact session-issuance receipts

- [x] Continue the database-authority audit through the shared login, verified-signup,
      password-reset, and legacy-cookie rotation helper. It still treated final INSERT metadata
      as the browser receipt and deleted a valid committed candidate when D1 omitted or lost the
      response, forcing a safe but avoidable `503`.
- [x] Make one random 256-bit token hash plus complete D1 post-state authoritative. The plaintext
      token is disclosed only when its hash, authenticated owner, creation and expiry timestamps,
      live user, and absent account-deletion fence match exactly. Transport success and mutation
      metadata grant nothing; unreadable, absent, or mismatched state deletes the candidate and
      clears both cookie forms.
- [x] Force omitted INSERT metadata, a lost committed atomic-batch response, a receipt-read
      failure, deliberately mutated session timestamps, and an account-deletion fence appearing
      after commit but before confirmation. Exact committed states recover without replay; every
      ambiguous or fenced state returns `503`, exposes no bearer token, and removes the candidate.
      The source ledger covers 240 prepare sites: 226 literal, 14 reviewed nonliteral, and nine
      reviewed complete-rights multi-row reads; 35 critical D1 plans include the complete receipt.
- [x] Seal the checkpoint with the pinned Cloudflare build, lint, TypeScript, 622/622 Node tests,
      complete security/source-integrity chain, two zero-vulnerability npm audits, 29/29 API
      tests, Ruff, 83 pipeline tests with one documented optional-rasterio skip, deterministic
      smoke, all 20 migrations and 35 critical query plans, and an isolated 200/200
      Chromium/WebKit phone matrix. No push, PR, merge, deployment, provider query, production
      database mutation, feature activation, UI change, or model claim belongs to this
      checkpoint.
- [ ] Exercise lost-response, concurrent rotation, deletion-fence, latency, and rows-read/written
      behavior with production-shaped synthetic data in isolated staging before treating local
      receipt proof as deployed evidence.

## Active checkpoint — exact gear-preset mutation receipts

- [x] Continue the database-authority audit through owner PATCH and DELETE of existing gear
      presets. Both operations still treated D1 mutation metadata as the browser receipt, so a
      committed write with a lost storage response remained needlessly ambiguous even when the
      exact owner state was readable.
- [x] Make D1 post-state authoritative without weakening ownership. PATCH requires the exact
      preset ID, authenticated owner, every normalized field, and the server-generated update
      timestamp. DELETE requires both the owner row and the global opaque-ID row to be absent;
      same-owner concurrent removal is idempotent success, while ownership transfer remains the
      same enumeration-resistant `404`. Transport success and mutation metadata grant nothing.
- [x] Force omitted mutation metadata and a lost committed response for update and deletion,
      same-owner deletion overlap, ownership transfer before each write, and a deliberately
      mismatched update post-state. Exact states recover without replay, another owner's row is
      preserved, and corrupt state remains `503`. The source ledger covers 239 prepare sites:
      225 literal, 14 reviewed nonliteral, and nine reviewed complete-rights multi-row reads;
      34 critical D1 plans now include both primary-key receipt shapes.
- [x] Seal the checkpoint with the pinned Cloudflare build, lint, TypeScript, 619/619 Node tests,
      complete security/source-integrity chain, two zero-vulnerability npm audits, 29/29 API
      tests, Ruff, 83 pipeline tests with one documented optional-rasterio skip, deterministic
      smoke, all 20 migrations and 34 critical query plans, and an isolated 200/200
      Chromium/WebKit phone matrix. No push, PR, merge, deployment, provider query, production
      database mutation, feature activation, UI change, or model claim belongs to this
      checkpoint.
- [ ] Exercise overlap, lost-response, latency, rows-read/written, and legacy 100-preset account
      behavior with production-shaped synthetic data in isolated staging before treating local
      receipt proof as deployed evidence.

## Active checkpoint — exact account-deletion receipts

- [x] Continue the database-authority audit through password-confirmed account deletion. The prior
      happy path could trust the final user-delete change count without any read-back; the fallback
      proved only that a deletion job existed and the user/fence were absent, and still treated a
      set-based private-object inventory as zero objects if cleanup status became unreadable.
- [x] Make one high-entropy account deletion receipt plus the complete D1 post-state authoritative.
      Success requires the exact job identity, account/owner hashes, timestamps, initial state,
      exact task count, canonical pending task IDs/hashes/stores/lease state, and zero remaining
      user, owner trip, fence, reservation, email-attempt, user-bound export, or active owner-export
      rows. Mutation metadata and transport success grant no receipt; the proven task count now
      controls truthful cleanup fallback.
- [x] Force missing final mutation metadata, a lost post-commit batch response, a rolled-back
      transaction, post-commit cleanup failure, and a deliberately corrupted set-based task row.
      Exact committed states succeed without replay, rollback and corrupt-ledger paths return an
      opaque status receipt without touching R2, and the existing fence, legacy-locator, 75-object,
      prior-deletion adoption, and privacy-export adoption contracts remain green. The source
      ledger remains 237 prepare sites: 223 literal, 14 reviewed nonliteral, and nine reviewed
      complete-rights multi-row reads; 32 critical D1 plans now include every receipt subquery.
- [x] Seal the checkpoint with the pinned Cloudflare build, lint, TypeScript, 616/616 Node tests,
      complete security/source-integrity chain, two zero-vulnerability npm audits, 29/29 API tests,
      Ruff, 83 pipeline tests with one documented optional-rasterio skip, deterministic smoke, all
      20 migrations and 32 critical query plans, and an isolated 200/200 Chromium/WebKit phone
      matrix. A first CPU-contended mobile run exposed one slow-notice timing miss at 199/200; the
      complete release-equivalent isolated rerun passed 200/200 without a code change. No push,
      PR, merge, deployment, provider query, production database mutation, feature activation, UI
      change, or model claim belongs to this checkpoint.
- [ ] Exercise lost-response, same-account overlap, lease takeover, ledger corruption, latency,
      rows-read/written, and multi-store private-object purge behavior with production-shaped
      synthetic data in isolated staging before treating local receipt proof as deployed evidence.

## Active checkpoint — exact pending-trip deletion receipts

- [x] Continue the database-authority audit through owner deletion of pending trips. The prior
      path trusted final mutation metadata, so a committed transactional delete with a lost D1
      response returned `trip_delete_unconfirmed` after removing the trip and discussion while
      leaving a valid private-object deletion job for the browser to recover.
- [x] Make one high-entropy deletion receipt plus the complete transaction post-state
      authoritative. Success requires the exact job, trip and owner subject hashes, initial state,
      timestamps, object count, exact pending task identity/locator/hash/store, zero remaining
      owner-trip rows, and zero discussion rows; mutation metadata and transport success grant no
      receipt. A failed confirmation read returns an opaque recoverable receipt without replay.
- [x] Force missing final mutation metadata and a lost post-commit batch response; both return one
      truthful success and purge the private object exactly once. Deliberately corrupting the task
      store fails closed before object deletion, while the concurrent-moderator race remains `409`
      with no job or task. The current source ledger covers 237 prepare sites: 223 literal, 14
      reviewed nonliteral, and nine reviewed complete-rights multi-row reads; 31 critical D1 plans
      now include the receipt, task, trip, and discussion indexes.
- [x] Seal the checkpoint locally: the production-style Cloudflare build, ESLint, TypeScript,
      614/614 Node tests, the complete offline security/source-integrity chain, both zero-
      vulnerability npm audits, API 29/29, Ruff, 83 pipeline tests with one documented optional-
      `rasterio` skip, 20 migrations / 31 critical indexed D1 plans, deterministic synthetic
      smoke, and the full 200/200 Chromium/WebKit phone matrix passed. Preserve one clean local
      commit and its deterministic release bundle. No push, PR, merge, deployment, provider query,
      production database mutation, feature activation, UI change, or model claim belongs to this
      checkpoint.
- [ ] Exercise lost-response, same-account overlap, moderator-race, task corruption, latency,
      rows-read/written, and private-object purge behavior with production-shaped synthetic data
      in isolated staging before treating local receipt proof as deployed evidence.

## Active checkpoint — exact profile-trip edit receipts

- [x] Continue the database-authority audit through owner profile-trip edits. A committed D1
      batch with missing mutation metadata returned `trip_update_unconfirmed` after changing the
      trip and appending validation evidence, while a nominal metadata result could grant success
      without requiring the edited row to exist.
- [x] Make one server-generated validation-evidence ID plus the complete owner-bound edited trip
      state authoritative. Success requires the exact evidence-exclusion row, optional immutable
      feasibility-correction identity, every normalized trip field, recomputed species contract,
      AI-review reset, and required forecast invalidation. Mutation metadata and transport success
      grant no receipt, and the review callback runs only after exact confirmation.
- [x] Force both missing mutation metadata and a lost post-commit batch response. Each returns one
      correct `200` receipt from D1 post-state, invokes the callback once, and leaves exactly one
      edit-evidence row; a concurrent moderator still wins with `409` and no callback. The current
      source ledger covers 235 prepare sites: 221 literal, 14 reviewed nonliteral, and nine
      reviewed complete-rights multi-row reads. The exact receipt uses primary/unique indexes and
      expands the machine-checked D1 plan set to 30.
- [x] Seal the checkpoint locally: the production-style Cloudflare build, ESLint, TypeScript,
      612/612 Node tests, the complete offline security/source-integrity chain, both zero-
      vulnerability npm audits, API 29/29, Ruff, 83 pipeline tests with one documented optional-
      `rasterio` skip, 20 migrations / 30 critical indexed D1 plans, deterministic synthetic
      smoke, and the full 200/200 Chromium/WebKit phone matrix passed. Preserve one clean local
      commit and its deterministic release bundle. No push, PR, merge, deployment, provider query,
      production database mutation, feature activation, UI change, or model claim belongs to this
      checkpoint.
- [ ] Exercise lost-response, same-account overlap, moderator-race, latency, rows-read/written,
      and callback/queue behavior with production-shaped synthetic data in isolated staging
      before treating local receipt proof as deployed evidence.

## Active checkpoint — discussion schema authority

- [x] Remove the public-discussion route's cold `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF
      NOT EXISTS` fallback. Migration files are now the only authority that can create or change
      `site_discussion_posts`; request handling contains no table, index, or trigger DDL.
- [x] Add one read-only readiness probe for the two required tables, 20 required columns, two
      named indexes, and the exact cascading trip foreign key. An incomplete schema returns
      non-cacheable `503 discussion_schema_unavailable` without changing schema state; an
      unexpected read failure is logged only through the structured redaction boundary and
      returns a generic non-cacheable error.
- [x] Prove the default-off path performs zero D1 queries, the enabled cold path performs exactly
      one readiness query plus one bounded public read, and the same binding's warm path performs
      only the public read. The current source-bound ledger covers 234 prepare sites: 220 literal,
      14 reviewed nonliteral, and nine reviewed complete-rights multi-row reads, with zero runtime
      discussion DDL.
- [x] Pass the pinned Cloudflare build, ESLint, TypeScript, all 611/611 repository Node tests,
      the complete offline security/SBOM/source-integrity chain, both zero-vulnerability npm
      audits, API 29/29, Ruff, 83 pipeline tests with one documented optional-`rasterio` skip,
      20 migrations / 29 critical indexed D1 plans, deterministic synthetic smoke, and the full
      200/200 Chromium/WebKit phone matrix. Preserve a clean local commit and deterministic
      release artifact; no push, PR, merge, deployment, provider query, production database
      mutation, feature activation, UI change, or model claim belongs to this checkpoint.
- [ ] Apply and verify the migration chain, enabled-route behavior, latency, rows read, and alert
      delivery in isolated staging before discussions can be enabled. Public discussions remain
      default-off and human approval remains an independent release gate.

## Active checkpoint — aggregate scheduled-Worker budget

- [x] Replace the four concurrent cron `waitUntil` pipelines with one deterministic sequential
      lane per five-minute tick. Queue dispatch, trip-photo reconciliation, expired-export
      cleanup, and auth retention/privacy deletion each run every 20 minutes, so no lane can
      starve and no independently bounded task can silently borrow another task's invocation
      allowance.
- [x] Set explicit work caps of one advisory dispatch, five privacy-export dispatches, seven
      photo reservations, seven expired exports, and three privacy-deletion tasks. Saturated
      migration-complete D1 fixtures hold the four lanes below conservative query budgets of
      32, 44, 36, and 40, each under Cloudflare's 50-query Free invocation ceiling; external
      Queue/provider/R2 operations are sequential and capped at six, seven, seven, and three.
- [x] Replace the trip store's cold 35-statement runtime schema bootstrap with one read-only
      readiness probe over the migration-owned tables, 21 indexes, nine triggers, and photo hash
      column. An incomplete schema returns `trip_schema_unavailable` without creating or changing
      any table. The generated D1 ledger now covers 235 prepare sites: 221 literals, 14 reviewed
      nonliterals, and nine complete-rights multi-row reads.
- [x] Pass the pinned Cloudflare build, ESLint, TypeScript, all 609/609 repository Node tests,
      the complete offline security/SBOM/source-integrity chain, both zero-vulnerability npm
      audits, API 29/29, Ruff, 82 passed pipeline tests with one documented optional-`rasterio`
      skip, 20 migrations / 29 critical indexed D1 plans, deterministic synthetic smoke, and the
      full 200/200 Chromium/WebKit phone matrix. Preserve a clean local commit and deterministic
      release artifact; no push, PR, merge, deployment, provider query, production mutation,
      feature activation, UI change, or model claim belongs to this checkpoint.
- [ ] Confirm the actual Cloudflare account plan, cron delivery, rows read/written, CPU, latency,
      subrequests, durable backlog drain, cost, and alert delivery in isolated staging at the
      exact release commit. No deployment, provider query, production D1/R2 mutation, or feature
      activation belongs to this local checkpoint.

## Active checkpoint — consolidate the regional evidence stack

- [x] Reconcile the 18 open drafts against current protected `main`
      `086b2055f44ba5e2595d6bd249866ffb20c3c461`. Exact stack head
      `e906250079c9a54d35d9312906ba64b68f89779c` is a direct descendant of that commit,
      contains both original roots `#118` and `#130`, and includes every checkpoint through
      `#146`; no cherry-pick, history rewrite, merge, deployment, or provider mutation is
      required to expose the integrated diff.
- [x] Retarget existing draft PR `#146` to protected `main` as the single integration review
      surface and document the complete regional, chart-context, water-quality, and pollution-
      boundary scope. The PR remains draft and mergeable. PRs `#118` and `#130`–`#145`
      remained open only until the replacement head passed main-based review; they are now closed
      as superseded and none was merged individually or out of order.
- [x] Pass fresh exact-head checks against `main` at integration head
      `02388cdea067fcffaea4fab984fed3360d3d2495`. Push and pull-request CI runs
      `29856511274` and `29856516395` each passed 188/188 Chromium/WebKit phone cases plus
      API and pipeline; CodeQL run `29856511663` passed Actions, JavaScript/TypeScript, and
      Python; release-provenance runs `29856511359` and `29856516304`, native AMD64/ARM64
      API-image run `29856516190`, and automatic Linux CPU/macOS ARM64 optional-platform run
      `29856516287` passed. Pull-request dependency review passed, event-inapplicable jobs
      skipped as designed, and code-scanning, dependency, and secret-scanning alerts were all
      zero. No merge, deployment, or provider mutation occurred.
- [x] Close the 17 ancestor drafts `#118` and `#130`–`#145` as superseded only after
      every one of their exact heads was proven to be an ancestor of the green integration
      commit. Their branches, comments, commits, and hosted evidence remain preserved for audit
      and rollback reference; `#146` is now the repository's only open PR and remains a draft.

## Active checkpoint — durable trip-photo pre-upload reservations

- [x] Continue the database-authority audit through the dormant private photo path. A processed
      image was written to R2 before D1 attachment, but a failed attachment-reconciliation read
      retained the object without persisting its candidate locator anywhere. Production was not
      exposed because the server-side upload gate remains off.
- [x] Add additive migration `0020_trip_photo_upload_reservations.sql` and make its D1 row an
      exact prerequisite for every future R2 write. The ledger stores a typed locator hash and
      bounded retry/lease state; a failed reservation read performs no object-store call.
- [x] Add scheduled, lease-owned reconciliation. An exact trip/photo match preserves the object
      and removes only the reservation; an unattached object is deleted idempotently before the
      reservation can disappear. Locator-hash mismatch and unavailable storage fail closed to
      `needs_attention`, while retryable failure retains the locator. Trip attachment and cleanup
      claim repeat the same pending-state predicate in atomic D1 batches, so whichever commits
      first owns the object and the other path cannot cross that decision.
- [x] Force a lost committed reservation response, a lost terminal D1 response for an attached
      object, a transient R2 deletion failure, and a tampered locator hash. Exact receipts resolve
      both lost responses, attached bytes remain, the orphan is later deleted, and the tampered
      case makes zero R2 calls. The source-bound inventory now covers 274 prepare sites: 245
      literal, 29 reviewed nonliteral, and 13 reviewed multi-row reads.
- [x] Pass the pinned Cloudflare build, ESLint, TypeScript, all 597/597 repository Node tests,
      the complete offline security/SBOM/source-integrity chain, both zero-vulnerability npm
      audits, Ruff, 29/29 API tests, 82 passed pipeline tests with one documented optional-`rasterio`
      skip, the deterministic synthetic smoke, 20 migrations / 26 critical indexed D1 plans,
      and the full 200/200 Chromium/WebKit phone matrix. The serialized account-deletion
      checkpoint below, production migration/bindings/alerts/drills, and explicit upload activation remain
      open; no push, PR, merge, deployment, provider query, D1/R2 production mutation, model
      change, UI change, or upload enablement belongs to this checkpoint.

## Active checkpoint — serialized account deletion and private-photo writes

- [x] Establish a durable D1 `account_deletion_fences` row immediately after password
      reauthentication and before any private-object inventory. New sessions, account-bound trip
      inserts, photo reservations, and trip-photo attachment repeat the absence of that fence in
      their authoritative write statements; a stale authenticated request cannot cross it.
- [x] Bind the destructive account batch to one high-entropy bounded lease. Every deletion
      statement repeats the exact user, owner hash, and lease token; a lost fence response is
      accepted only by exact readback, a lost committed deletion response is accepted only when
      its receipt job exists and both user and fence are absent, and a failed batch leaves the
      account frozen for a safe lease-owned retry.
- [x] Adopt every pre-fence photo reservation into the account deletion ledger before removing
      the reservation row. Its future `available_at` is preserved so deletion cleanup cannot race
      an in-flight R2 write. Fault injection proves that the fenced request performs zero R2 puts,
      pre-fence attachment is rejected, and the adopted object is not deleted before its safe time.
- [x] Pass the pinned Cloudflare build, ESLint, TypeScript, all 601/601 repository Node tests,
      the complete offline security/SBOM/source-integrity chain, both zero-vulnerability npm
      audits, the 274-site D1 source inventory, 20 migrations / 26 critical indexed plans, Ruff,
      29/29 API tests, 82 pipeline tests with one documented optional-`rasterio` skip, deterministic
      synthetic smoke, and the full 200/200 Chromium/WebKit phone matrix. No push, PR, merge,
      deployment, provider query, D1/R2 production mutation, UI/model change, or upload enablement
      belongs to this local checkpoint.
- [ ] Apply the reviewed `0020` schema in production, verify both new tables are initially empty,
      exercise the lost-response and account-deletion/photo interleavings against the intended
      private bucket, monitor fenced/aged/attention states without locators, and obtain the
      independent release review. Uploads remain server-disabled until every activation gate passes.

## Active checkpoint — bounded account deletion inventories

- [x] Replace owner-sized application reads and per-object batch fan-out with four source-bound
      D1 `INSERT INTO ... SELECT` inventory statements. Prior deletion tasks, photo reservations,
      privacy exports, and attached trip photos now enter one deletion job inside the same fixed
      18-statement transaction that removes active rows, independent of object count.
- [x] Add `trips.photo_key_hash` as the exact identity for attached private objects and bind trip
      creation, completion, reservation attachment, reconciliation, migration pre/postflight, and
      deletion inventory to it. A legacy non-null locator without its hash inserts no deletion
      job, removes no active row, performs no R2 call, and leaves the account fence in place for
      protected migration rather than guessing identity.
- [x] Reduce cold auth initialization from 35 request-time DDL statements to one read-only schema-
      readiness probe that fails closed when the migration-owned schema is incomplete. Bound
      object cleanup to five tasks per invocation, reconcile up to 100 jobs with one set-based
      update, and reduce lost-commit account recovery to one inline cleanup task.
- [x] Prove a cold 75-photo account deletion and a lost-committed-response recovery remain within
      Cloudflare's 50-query Free ceiling and 100 bound-parameter ceiling; the account transaction
      never grows beyond 20 batch entries and all 75 tasks remain durable while active rows are
      removed. The current source inventory covers 240 prepare sites: 221 literal, 19 reviewed
      nonliteral, and nine reviewed complete-rights multi-row reads, with zero owner-lifecycle
      unbounded reads. All 29 critical query plans and every foreign-key child index pass.
- [x] Pass the pinned Cloudflare build, ESLint, TypeScript, all 604/604 repository Node tests,
      the complete offline security/SBOM/source-integrity chain, both zero-vulnerability npm
      audits, Ruff, 29/29 API tests, 83 pipeline tests with one documented optional-`rasterio`
      skip, deterministic synthetic smoke, 20 migrations / 29 critical indexed D1 plans, and the
      full 200/200 Chromium/WebKit phone matrix. Preserve a clean local commit and deterministic
      release receipt, while leaving production migration, provider-plan evidence, intended-
      bucket drills, alerts, and independent review open. No push, PR, merge, deployment,
      Cloudflare query, D1/R2 production mutation, model/UI change, or upload activation belongs
      to this checkpoint.

## Active checkpoint — lease-owned direct advisory review

- [x] Continue the database-authority audit through the default-off direct advisory-review path.
      It treated missing D1 mutation metadata as zero after setting a trip to `processing`; a
      committed claim could therefore become permanently invisible to the scheduled backlog.
- [x] Replace receipt-derived ownership with a high-entropy, exact compare-and-set claim stored
      only while the trip is processing. The worker must read back its own exact claim before
      provider dispatch, terminal review/retry writes repeat that identity, and the 60-second
      lease exceeds the provider's 30-second maximum deadline.
- [x] Add bounded stale-claim recovery to the default-off backlog without reclaiming active or
      malformed legacy state. Queue redispatch no longer resets a trip merely from a stale job
      snapshot, and profile/portability responses suppress the internal claim envelope.
- [x] Force a committed claim with missing metadata, simultaneous workers, a lost post-commit
      read, scheduled lease recovery, and an old worker returning after a newer lease. Exactly
      one worker dispatches per live claim and the late stale result cannot overwrite the newer
      review.
- [x] Pass the pinned Cloudflare build, ESLint, TypeScript, all 577/577 repository Node tests,
      the complete offline security/SBOM/source-integrity chain, both zero-vulnerability npm
      audits, Ruff, 29/29 API tests, 82 pipeline tests with one documented optional-`rasterio`
      skip and 138 subtests, the deterministic pipeline smoke test, 19 migrations / 23 critical
      D1 query plans, and the full 200/200 Chromium/WebKit phone matrix. Preserve a clean local
      commit and deterministic release-bundle receipt. No push, pull request, merge, deployment,
      provider query, D1 mutation, public AI output, model change, UI change, or production
      authorization belongs to this work.

## Active checkpoint — exact live-trip terminal receipts

- [x] Continue the database-authority audit through live-trip completion and safe cancellation.
      Both owner-bound writes still decided success from D1 mutation counts; a committed response
      lost in transit could produce a false `404` cancellation or an avoidable ambiguous
      completion even though the recovery token was already consumed.
- [x] Make the terminal D1 state authoritative. Completion requires the exact owner-bound live
      row, persistent idempotency hash, cleared token, server timestamps, mode, and photo locator;
      cancellation requires the exact owner-bound live row, same persistent hash, cleared token,
      and request timestamp. Mutation metadata and transport success no longer grant or deny the
      receipt.
- [x] Force a committed completion batch and a committed cancellation update to lose their
      responses. Both operations return success only after exact read-back; completion dispatches
      its callback once, cancellation does not manufacture a `404`, and cross-account/token
      predicates remain unchanged. The focused privacy/owner runtime passes 66/66 cases.
- [x] Regenerate the source-bound D1 inventory for all 240 prepare sites: 214 literal, 26
      reviewed nonliteral, and 12 reviewed multi-row reads.
- [x] Pass the pinned Cloudflare build, ESLint, TypeScript, all 591/591 repository Node tests,
      the complete offline security/SBOM/source-integrity chain, both zero-vulnerability npm
      audits, Ruff, 29/29 API tests, 83 pipeline tests with one documented optional-`rasterio`
      skip, the deterministic pipeline smoke test, 19 migrations / 23 critical D1 query plans,
      and the full 200/200 Chromium/WebKit phone matrix. Preserve a clean local commit and
      deterministic release-bundle receipt. No push, pull request, merge, deployment, provider
      query, D1 mutation, R2 mutation, model change, UI change, or production authorization
      belongs to this local work.

## Active checkpoint — exact gear-preset creation receipts

- [x] Continue the database-authority audit through the last direct mutation-metadata decision.
      Gear-preset creation could commit in D1 and then lose its storage response, leaving the
      browser with an ambiguous failure even though the new preset existed.
- [x] Make exact D1 post-state authoritative. A `201` now requires the server-generated ID,
      authenticated owner, every normalized gear field, and both server timestamps to match the
      owner-bound row. Mutation metadata and transport success cannot manufacture or suppress the
      receipt.
- [x] Preserve the 100-preset ceiling without guessing. If no exact new row exists, an
      owner-bound `LIMIT 1 OFFSET 99` read distinguishes a real full account from an unconfirmed
      write; only the former returns the existing `409` limit response.
- [x] Force a committed gear insert to lose its response and prove the exact row still yields one
      truthful `201`. The focused privacy/owner runtime passes 67/67 cases, and the source-bound
      D1 inventory covers all 242 prepare sites: 216 literal, 26 reviewed nonliteral, and 12
      reviewed multi-row reads.
- [x] Pass the pinned Cloudflare build, ESLint, TypeScript, all 592/592 repository Node tests,
      the complete offline security/SBOM/source-integrity chain, both zero-vulnerability npm
      audits, Ruff, 29/29 API tests, 83 pipeline tests with one documented optional-`rasterio`
      skip, the deterministic pipeline smoke test, 19 migrations / 23 critical D1 query plans,
      and the full 200/200 Chromium/WebKit phone matrix. Preserve a clean local commit and
      deterministic release-bundle receipt. No push, pull request, merge, deployment, provider
      query, D1 mutation, R2 mutation, model change, UI change, or production authorization
      belongs to this local work.

## Active checkpoint — exact saved-location state receipts

- [x] Continue the database-authority audit through saved-location creation and removal. Both
      idempotent operations still treated mutation metadata as the final receipt, so a committed
      response lost in transit left the browser in an avoidable ambiguous state.
- [x] Make the exact owner/site row authoritative after each write. Presence yields the exact
      `{ saved: true, siteId }` receipt; absence yields `{ saved: false, siteId }`, including an
      already-absent idempotent removal. Neither mutation metadata nor transport success decides
      the browser-visible state.
- [x] Preserve the 100-location ceiling with a bounded owner read. When creation has no exact row,
      `LIMIT 1 OFFSET 99` confirms a genuinely full account before returning `409`; otherwise the
      write remains an explicit `503` instead of inventing a limit result.
- [x] Force both a committed insert and a committed delete to lose their responses. Exact D1
      read-back returns the correct success receipt without replaying either mutation; the focused
      privacy/owner runtime passes 67/67 cases. The source-bound D1 inventory covers all 244
      prepare sites: 218 literal, 26 reviewed nonliteral, and 12 reviewed multi-row reads.
- [x] Pass the pinned Cloudflare build, ESLint, TypeScript, all 592/592 repository Node tests,
      the complete offline security/SBOM/source-integrity chain, both zero-vulnerability npm
      audits, Ruff, 29/29 API tests, 83 pipeline tests with one documented optional-`rasterio`
      skip, the deterministic pipeline smoke test, 19 migrations / 23 critical D1 query plans,
      and the full 200/200 Chromium/WebKit phone matrix. Preserve a clean local commit and
      deterministic release-bundle receipt. No push, pull request, merge, deployment, provider
      query, D1 mutation, R2 mutation, model change, UI change, or production authorization
      belongs to this local work.

## Active checkpoint — exact privacy-object deletion authority

- [x] Continue the database-authority audit through the GDPR/account-deletion object ledger.
      Task claims and completion still treated D1 mutation metadata as authority, and the stored
      object-locator hash was not recomputed before the irreversible R2 call.
- [x] Require an exact high-entropy lease receipt bound to the job, attempt, store, locator,
      locator hash, expiry, and incomplete state before deletion. Recompute
      `SHA-256(object_store + NUL + object_key)` immediately before R2; a mismatch moves the task
      to explicit operator attention without calling either private bucket.
- [x] Make privacy-export locator clearing and deletion-task completion one atomic D1 batch, then
      require exact terminal and linkage read-backs. A committed claim or finalization with a
      lost response resolves from database state, idempotent delete retry remains safe, and a
      stale worker cannot settle a newer lease.
- [x] Add regressions for a lost committed claim response, a lost committed privacy-export
      terminal-batch response, and a corrupted locator binding. The focused privacy suite passes
      65/65 cases, and its complete source-bound D1 inventory covered 239 prepare sites: 213
      literal, 26 reviewed nonliteral, and 12 reviewed multi-row reads.
- [x] Pass the pinned Cloudflare build, ESLint, TypeScript, all 590/590 repository Node tests,
      the complete offline security/SBOM/source-integrity chain, both zero-vulnerability npm
      audits, Ruff, 29/29 API tests, 83 pipeline tests with one documented optional-`rasterio`
      skip, the deterministic pipeline smoke test, 19 migrations / 23 critical D1 query plans,
      and the full 200/200 Chromium/WebKit phone matrix. Preserve a clean local commit and
      deterministic release-bundle receipt. No push, pull request, merge, deployment, provider
      query, D1 mutation, R2 mutation, or production authorization belongs to this work.

## Active checkpoint — receipt-owned privacy export packaging

- [x] Continue the database-authority audit through the default-off privacy-export Queue and
      private-object path. Queue dispatch, consumer claim, object reservation, completion, and
      expiry cleanup still trusted mutation metadata; a lost committed completion response could
      therefore delete the valid export object it had just authorized.
- [x] Require an exact private-token read-back before every Queue send, complete rights-data read,
      R2 write, or cleanup delete. Completion is authoritative only after the full D1 locator,
      hash, size, count, timestamps, and cleared lease are read back exactly.
- [x] Preserve a durable cleanup locator across failed, ambiguous, and stale object work. Never
      delete an export while D1 completion is unknown, never let a stale worker affect a newer
      object, and move an abandoned fifth packaging lease to explicit `needs_attention` instead
      of redispatching forever.
- [x] Force lost committed dispatch, claim, locator reservation, completion, cleanup claim, and
      cleanup-finalization responses plus abandoned final-lease recovery. Each side effect follows
      exact authority, a valid completed object remains downloadable, and expiry stays idempotent.
- [x] Pass the pinned Cloudflare build, ESLint, TypeScript, all 587/587 repository Node tests,
      the complete offline security/SBOM/source-integrity chain, both zero-vulnerability npm
      audits, Ruff, 29/29 API tests, 82 pipeline tests with one documented optional-`rasterio`
      skip, the deterministic pipeline smoke test, 19 migrations / 23 critical D1 query plans,
      and the full 200/200 Chromium/WebKit phone matrix. Preserve a clean local commit and
      deterministic release-bundle receipt. No push, pull request, merge, deployment, provider
      query, D1 mutation, object-storage mutation, production rights-data read, UI change, or
      activation belongs to this work.

## Active checkpoint — lease-owned advisory queue jobs

- [x] Continue the database-authority audit through the default-off managed Queue path. Consumer
      claims and terminal writes depended on mutation metadata and `state = 'processing'` alone,
      so a late worker could settle a newer lease; a crashed fifth attempt could also redispatch
      forever.
- [x] Add a private high-entropy `lease_token` to the still-unapplied additive queue migration.
      Queue publishing now follows exact dispatch-token read-back, consumer provider work follows
      exact processing-token read-back, and every success, retry, and attention transition repeats
      that identity.
- [x] Preserve active ownership during maintenance, deliberate disablement, duplicate delivery,
      and scheduled redispatch. Only an unleased or expired job may be deferred or recovered, and
      a well-formed expired fifth attempt moves both ledgers to explicit `needs_attention`.
- [x] Force missing dispatch metadata, a lost committed consumer response, a stale worker that
      returns after a replacement lease completes, maintenance during an active lease, and an
      abandoned fifth attempt. No stale worker sends without exact authority or overwrites the
      newer job/trip outcome.
- [x] Pass the pinned Cloudflare build, ESLint, TypeScript, all 582/582 repository Node tests,
      the complete offline security/SBOM/source-integrity chain, both zero-vulnerability npm
      audits, Ruff, 29/29 API tests, 82 pipeline tests with one documented optional-`rasterio`
      skip and 138 subtests, the deterministic pipeline smoke test, 19 migrations / 23 critical
      D1 query plans, and the full 200/200 Chromium/WebKit phone matrix. Preserve a clean local
      commit and deterministic release-bundle receipt. No push, pull request, merge, deployment,
      provider query, D1 mutation, public AI output, model change, UI change, or production
      authorization belongs to this work.

## Active checkpoint — atomic authentication attempt accounting

- [x] Continue the authentication audit through abuse-control accounting. Sign-in and initial
      email-challenge creation checked recent counts before recording the new event, while code
      verification incremented attempts after comparing the submitted code; concurrent requests
      could therefore cross the documented ceilings or authorize a stale challenge version.
- [x] Claim each failed-or-pending sign-in attempt with one conditional D1 insert and require its
      exact receipt before credential verification. A valid credential must then classify that
      exact row as successful before session creation; missing, malformed, zero, or impossible
      metadata fails closed and exposes no session.
- [x] Make the five-per-hour initial signup and password-recovery challenge ceiling authoritative
      in the insert itself. Provider delivery follows only a confirmed one-row claim; password
      recovery preserves its deliberately generic response when accounting is ambiguous.
- [x] Claim every submitted code attempt with an exact challenge-version compare-and-set before
      accepting the code. The six-attempt ceiling is atomic, concurrent resend makes the old
      version ineligible, and final signup or reset transactions repeat the claimed snapshot.
      Password-recovery ambiguity remains enumeration-resistant and cannot change credentials or
      create a session.
- [x] Force concurrent ceiling crossings, missing mutation receipts, success-classification
      ambiguity, a resend race, and a terminal sixth attempt in direct D1 runtime tests. Regenerate
      the complete 220-site query inventory and verify 23 critical plans, including use of the
      existing email/time and primary-key indexes for all new claims.
- [x] Pass the pinned Cloudflare build, ESLint, TypeScript, all 569/569 Node tests, the complete
      offline security/SBOM/source-integrity chain, both zero-vulnerability npm audits, Ruff,
      29/29 API tests, 83/83 pipeline tests with one documented optional-`rasterio` skip, the
      pipeline smoke test, and the full 200/200 Chromium/WebKit phone matrix. Preserve a clean
      local commit and deterministic release-bundle receipt. No push, pull request, merge,
      deployment, provider query, D1 mutation, model change, UI change, or production
      authorization belongs to this work.

## Active checkpoint — database-confirmed saved-location receipts

- [x] Continue the database-authority audit through the saved-location control. The browser
      deliberately updates its confirmed local state only after an exact `{ saved, siteId }`
      receipt, but removal returned that receipt without inspecting the D1 DELETE result.
- [x] Normalize both creation and removal through the strict mutation-receipt parser. Confirmed
      zero removal remains an idempotent success because the owner/site row is absent; missing,
      malformed, or impossible metadata is an ambiguous `503` and cannot manufacture the exact
      browser receipt.
- [x] Force committed creation and deletion with omitted metadata in the direct D1 runtime. Both
      routes return `503` while their database effects remain discoverable through the existing
      read-only saved-location reconciliation flow; no write is automatically replayed.
- [x] Retain the authenticated `user_id` plus curated `site_id` predicates, the atomic 100-row
      creation ceiling, and duplicate-at-limit idempotency. The complete generated D1 inventory
      continues to bind both saved-location writes and now explicitly machine-checks the scoped
      DELETE.
- [x] Pass the pinned Cloudflare build, ESLint, TypeScript, all repository Node tests, the complete
      offline security/SBOM/source-integrity chain, both zero-vulnerability npm audits, Ruff,
      API and pipeline tests, the pipeline smoke test, and the Chromium/WebKit phone matrix.
      Preserve a clean local commit and deterministic release-bundle receipt. No push, pull
      request, merge, deployment, provider query, D1 mutation, model change, UI change, or
      production authorization belongs to this work.

## Active checkpoint — recover ambiguous manual review retries

Historical implementation receipt: the newer exact manual advisory-review retry checkpoint at
the top supersedes this mutation-metadata authority while preserving its durable backlog recovery.

- [x] Continue the database-receipt audit through manual advisory-review retry. Missing D1
      metadata was collapsed into an authoritative zero: a committed row could become `queued`
      without entering the immediate scheduler, while the default-off legacy backlog selected
      only new and `retry` rows and therefore could leave that work stranded.
- [x] Parse every owner-bound retry result with the strict receipt helper. Dispatch only exact
      one-row transitions, preserve authoritative zero as an ownership/state race, and return
      `503 review_retry_unconfirmed` when any result is missing, malformed, truncated, or
      impossible instead of manufacturing the exact queued-count receipt.
- [x] Extend the bounded legacy scheduled backlog to select `queued` rows as well as new and
      retry rows. This reconciles a committed ambiguous transition without replaying the owner
      request and matches the already queue-enabled backlog and processing claim; AI output stays
      private, schema-bound, and unable to publish without separate human approval.
- [x] Force a committed retry transition with omitted metadata in direct D1 runtime tests. The
      route returns `503`, invokes no immediate callback, and leaves the row discoverably queued;
      the bounded backlog later claims it exactly once and reaches the provider boundary. The
      generated D1 inventory locks both the owner-scoped transition and queued recovery query.
- [x] Pass the pinned Cloudflare build, ESLint, TypeScript, all repository Node tests, the complete
      offline security/SBOM/source-integrity chain, both zero-vulnerability npm audits, Ruff,
      API and pipeline tests, the pipeline smoke test, and the Chromium/WebKit phone matrix.
      Preserve a clean local commit and deterministic release-bundle receipt. No push, pull
      request, merge, deployment, provider query, D1 mutation, model promotion, public AI output,
      UI change, or production authorization belongs to this work.

## Active checkpoint — database-confirmed session issuance

- [x] Continue the credential boundary through the final shared session-creation helper. Login,
      verified signup, password reset, and legacy-cookie rotation all created an opaque token and
      set it in the browser after a D1 batch, but did not inspect the session INSERT receipt.
- [x] Hash the candidate token once and require exactly one confirmed `auth_sessions` change before
      any path exposes it in a cookie. Missing, malformed, zero, or impossible metadata now returns
      `503 session_creation_unconfirmed` and clears both secure and legacy cookie forms.
- [x] Remove ambiguous committed state without creating a replay path. The unconfirmed response
      deletes the candidate token hash before returning; cleanup failure is recorded as a redacted
      structured event, but the unknown token is never disclosed and therefore cannot authenticate.
- [x] Force a committed INSERT with missing metadata in the direct D1 runtime. Rotation deletes the
      presented session, the candidate row is cleaned up, the response remains `503`, and no fresh
      session cookie or hidden account session survives. The generated 223-site inventory locks the
      shared batch INSERT and the exact cleanup DELETE.
- [x] Pass the pinned Cloudflare build, ESLint, TypeScript, all 555/555 Node tests, the complete
      offline security/SBOM/source-integrity chain, both zero-vulnerability npm audits, and the
      full 200/200 Chromium/WebKit phone matrix. Preserve a clean local commit and deterministic
      release-bundle receipt. No push, pull request, merge, deployment, provider query, D1 mutation,
      model change, UI change, or production authorization belongs to this work.

## Active checkpoint — database-confirmed sign-out receipts

Historical implementation receipt: the newer exact stored-state sign-out checkpoint at the top
supersedes this metadata-authoritative behavior and no longer clears cookies on ambiguity.

- [x] Continue the session audit through account exit. The browser intentionally deletes local
      trip recovery state only after `{ signedOut: true, user: null }`, but the server returned that
      exact receipt after a D1 batch without inspecting any presented-token revocation result.
- [x] Require one result per presented token and accept only authoritative zero-or-one change
      metadata. One means the active row was revoked; zero is also a valid idempotent receipt when
      the token is already absent. Missing, malformed, truncated, or impossible metadata cannot
      manufacture the exact success response.
- [x] Preserve the existing safe recovery path. An ambiguous revocation returns
      `503 sign_out_unconfirmed`, clears both browser cookie forms, and tells the UI to perform its
      read-only session check before clearing local state or permitting a retry.
- [x] Force a committed DELETE with missing metadata in the direct D1 runtime. The session row is
      gone and cookies are clearing, but the response remains explicitly unconfirmed and never
      exposes the exact sign-out receipt that authorizes local recovery-state deletion.
- [x] Pass the pinned Cloudflare build, ESLint, TypeScript, all 556/556 Node tests, the complete
      offline security/SBOM/source-integrity chain, both zero-vulnerability npm audits, and the
      full 200/200 Chromium/WebKit phone matrix. Preserve a clean local commit and deterministic
      release-bundle receipt. No push, pull request, merge, deployment, provider query, D1 mutation,
      model change, UI change, or production authorization belongs to this work.

## Active checkpoint — database-confirmed challenge issuance

Historical implementation receipt: the newer exact secret-bearing credential checkpoint at the
top supersedes this mutation-metadata authority while preserving its fail-closed behavior.

- [x] Continue the credential audit upstream of verification. Age eligibility returned a plaintext
      bearer proof after an unchecked D1 INSERT; signup and password recovery could invoke the
      email provider after unchecked challenge INSERTs or UPDATEs.
- [x] Require exactly one confirmed age-proof INSERT before disclosing its plaintext token and
      delete the candidate hash after an ambiguous receipt. Treat an authoritative zero during
      one-use consumption as expired, but missing metadata as explicitly unconfirmed, and stop
      before challenge creation in both cases.
- [x] Require exactly one confirmed initial challenge INSERT before provider delivery. Signup
      returns `503` and candidate-only cleanup after an ambiguous receipt; password recovery keeps
      its deliberately generic anti-enumeration response but performs no provider work.
- [x] Replace ID-only resend writes with prior-kind, code-hash, creation-time, and resend-count
      compare-and-set updates. Delivery follows the exact one-row receipt, never precedes it;
      candidate-only cleanup after ambiguity or provider failure cannot delete a newer code.
- [x] Force missing metadata for proof creation, proof consumption, signup challenge creation,
      signup resend, password-recovery creation, and password-recovery resend. No secret or provider
      side effect escapes an unconfirmed boundary; a deterministic concurrent signup-resend race
      preserves the newer challenge version and performs no provider call.
- [x] Pass the pinned Cloudflare build, ESLint, TypeScript, all 559/559 Node tests, the complete
      offline security/SBOM/source-integrity chain, both zero-vulnerability npm audits, and the
      full 200/200 Chromium/WebKit phone matrix. Preserve a clean local commit and deterministic
      release-bundle receipt. No push, pull request, merge, deployment, provider query, D1 mutation,
      model change, UI change, or production authorization belongs to this work.

## Active checkpoint — atomic verified-challenge consumption

- [x] Continue the challenge audit through the final credential transaction. Signup and password
      reset validated a code before their D1 batch, but terminal writes referenced only account or
      challenge IDs, so a concurrent resend could rotate the code while the prior code still
      authorized account creation or password replacement.
- [x] Make signup user insertion conditional on the exact verified challenge kind, code hash,
      creation time, attempt count, and live expiry. Repeat the same snapshot in one-use deletion;
      require exact one-row receipts for both before welcome delivery or session issuance.
- [x] Repeat the password-reset snapshot and server-bound user ID in the password update, every-
      session revocation, and challenge consumption statements. Require authoritative metadata for
      all three before issuing a replacement session; preserve sign-in recovery after an ambiguous
      committed batch.
- [x] Force a resend race after successful code verification for both flows. The old code creates
      no account, changes no password, revokes no session, and cannot delete the newer code. Force
      missing challenge-consumption metadata separately; committed credentials remain recoverable,
      but neither endpoint manufactures a success receipt or session.
- [x] Stop the final gate for newly published high-severity `fast-uri`
      `GHSA-v2hh-gcrm-f6hx` and Sharp/libvips `GHSA-f88m-g3jw-g9cj` findings. Exact overrides
      select `fast-uri` `3.1.4` and Sharp `0.35.3` without a force fix or toolchain widening; both
      complete-tree and production audits return zero vulnerabilities. Sharp's install hook is
      gone, reducing the fail-closed zero-execution policy from eight reviewed paths to seven.
- [x] Correct the production SBOM boundary exposed by Sharp `0.35.3`. Production membership now
      follows locked root dependency reachability through required, optional, and required-peer
      edges instead of npm's ambiguous `dev` path flag; representative cross-platform Sharp
      artifacts remain inventoried while Playwright and development-only `fast-uri` stay excluded.
- [x] Pass a fresh zero-script install of 535 audited packages, the pinned Cloudflare build,
      ESLint, TypeScript, all 561/561 Node tests, the complete offline security/SBOM/source-
      integrity chain, both zero-vulnerability npm audits, Ruff, 29/29 API tests, 82/82 pipeline
      tests plus 138 subtests with one documented optional-`rasterio` skip, and the full 200/200
      Chromium/WebKit phone matrix. Preserve a clean local commit and deterministic release-bundle
      receipt. No push, pull request, merge, deployment, provider query, D1 mutation, model change,
      UI change, or production authorization belongs to this work.

## Active checkpoint — terminal trip ownership predicates

- [x] Audit owner-scoped trip mutations against the documented D1/SQLite row-security
      equivalent. Active completion and cancellation authenticated the route and required the
      recovery token, but their final D1 updates did not repeat the authenticated `user_id`, so
      the database statement itself did not satisfy the atomic ownership rule.
- [x] Bind the server-derived account identity into both the handler precheck and final D1
      completion/cancellation update. The terminal writes now require the same `id`, `user_id`,
      active state, and token hash; no submitted account identifier or browser state grants
      authority.
- [x] Add exact-token cross-account tests for cancellation and completion plus an ownership-
      change race between the handler read and final update. Every mismatch returns the same
      `404`, leaves the trip active, and preserves its recovery token hash.
- [x] Regenerate the complete 221-site D1 query inventory and assert that both terminal updates
      retain the account predicate in the committed machine-readable ledger.
- [x] Pass the complete pinned repository verification: Cloudflare build, ESLint, TypeScript,
      all 546/546 Node tests, the complete offline security/SBOM/source-integrity chain, and both
      zero-vulnerability npm audits are green. Commit and exact bundle receipts are recorded in
      the local checkpoint; no push, pull request, merge, deployment, provider query, D1
      mutation, model change, or UI change is part of this work.

## Active checkpoint — owner-scoped trip read boundary

- [x] Continue the P0 authorization audit beyond terminal writes. Nine owner-flow data-access
      methods still selected a trip or validation sidecar by object/group identity and relied on
      a later in-memory ownership check, contradicting the matrix requirement that private
      queries carry the server-derived account predicate.
- [x] Bind `user_id IS ?` into the trip-row and feasibility-recruitment reads and through the
      parent trip for enrollment provenance, forecast impressions, feasibility starts, and
      prior recruitment-event reuse. Profile-edit feasibility start/completion/correction reads
      now repeat the same parent owner gate. Every handler call and idempotent/race reconciliation
      read now supplies the authenticated account identity.
- [x] Preserve enumeration-resistant client identity collisions without reopening private data.
      The only intentionally global trip-ID lookup selects constant `1` by primary key; it
      exposes no trip/account field and keeps live-start and past-report collisions on the same
      generic `409` path before rate-limit or storage details can differ.
- [x] Expand the complete D1 inventory from 221 to 222 prepare sites and machine-check the nine
      owner-bound reads, removal of the old unscoped trip projection, and the exact constant-only
      collision query. Direct D1 tests prove another account cannot retrieve the row even with
      its exact trip ID while the owner can.
- [x] Pass the complete pinned repository verification: Cloudflare build, ESLint, TypeScript,
      all 546/546 Node tests, the complete offline security/SBOM/source-integrity chain, and both
      zero-vulnerability npm audits are green. The clean local commit and exact release-bundle
      receipt close this repository-only checkpoint; no push, new pull request, merge,
      deployment, provider query, D1 mutation, model change, or UI change occurred.

## Active checkpoint — owner-bound manual review retry

- [x] Continue the P0 row-security audit into the signed-in manual advisory-review retry route.
      Its initial trip selection bound the authenticated account, but each final transition to
      `queued` used only the trip ID and retry state. That contradicted the matrix rule that a
      prior owner lookup cannot authorize a later private-object mutation by ID alone.
- [x] Repeat the server-derived `user_id` in every retry update and treat exactly one D1 change as
      the dispatch boundary. Rows that lose ownership or retry eligibility after selection do
      not enter the internal scheduler, and the response reports only confirmed transitions.
- [x] Add a deterministic ownership-change race: the selected trip moves to a second account
      immediately before the final statement. The prior owner receives `queued: 0`, no callback
      is dispatched, and the row remains retryable; the new owner can then queue exactly that row.
      The generated 222-site D1 inventory also requires the exact owner predicate and rejects
      regression to the old ID-only update.
- [x] Pass the pinned Cloudflare build, ESLint, TypeScript, all 548/548 Node tests, the complete
      offline security/SBOM/source-integrity chain, both zero-vulnerability npm audits, and the
      full 200/200 Chromium/WebKit phone matrix. Preserve the clean local commit and exact
      deterministic release-bundle receipts for this repository-only checkpoint. No push, pull
      request, merge, deployment, provider query, D1 mutation, model change, or UI change belongs
      to this work.

## Active checkpoint — database-confirmed account creation

- [x] Continue the one-use challenge audit through verified signup. User insertion and challenge
      deletion were already atomic and unique-email protected, but welcome delivery and the first
      authenticated session occurred without inspecting the user-insert result.
- [x] Require exactly one confirmed D1 change before either downstream side effect. Missing,
      malformed, zero, or impossible metadata returns `503 account_creation_unconfirmed`, sends no
      welcome, and creates no session rather than manufacturing a verified-account receipt.
- [x] Preserve recovery after an ambiguous committed batch. The one-use challenge is consumed and
      cannot be replayed; the response directs the new account owner to try ordinary sign-in before
      starting signup again.
- [x] Force that path in the direct D1 runtime. The account and legal/age fields commit, the
      challenge disappears, the verify response remains `503` without a session, and a normal
      sign-in with the submitted password succeeds and creates the only authenticated session.
- [x] Pass the pinned Cloudflare build, ESLint, TypeScript, all 554/554 Node tests, the complete
      offline security/SBOM/source-integrity chain, both zero-vulnerability npm audits, and the
      full 200/200 Chromium/WebKit phone matrix. Preserve the clean local commit and exact
      deterministic release-bundle receipts for this repository-only checkpoint. No push, pull
      request, merge, deployment, provider query, D1 mutation, model change, or UI change belongs
      to this work.

## Active checkpoint — database-confirmed password reset

- [x] Continue the credential-lifecycle audit through password reset. Credential replacement,
      all-session revocation, and one-use challenge consumption were already one D1 batch, but the
      handler created a fresh authenticated session without inspecting the credential-write result.
- [x] Require exactly one confirmed user-row change before creating that replacement session. A
      confirmed zero returns `404 account_not_found`; missing, malformed, or impossible metadata
      returns `503 password_reset_unconfirmed`. Both paths clear stale browser session cookies.
- [x] Preserve safe recovery for an ambiguous committed batch. The consumed challenge cannot be
      replayed and no fresh session is issued; the response directs the owner to sign in with the
      submitted password before requesting another code.
- [x] Force the missing-receipt path in the direct D1 runtime. The password changes, every prior
      session and the challenge disappear, the reset response remains `503` with clearing cookies,
      and a subsequent sign-in with the submitted password succeeds and creates the only session.
- [x] Pass the pinned Cloudflare build, ESLint, TypeScript, all 553/553 Node tests, the complete
      offline security/SBOM/source-integrity chain, both zero-vulnerability npm audits, and the
      full 200/200 Chromium/WebKit phone matrix. Preserve the clean local commit and exact
      deterministic release-bundle receipts for this repository-only checkpoint. No push, pull
      request, merge, deployment, provider query, D1 mutation, model change, or UI change belongs
      to this work.

## Active checkpoint — database-confirmed legal acceptance

Historical implementation receipt: the newer exact legal-acceptance checkpoint at the top
supersedes this mutation-metadata authority while preserving its fail-closed behavior.

- [x] Continue the authenticated-receipt audit through current Terms and Privacy reacceptance.
      The route bound the server-derived account ID and preserved age eligibility, but returned
      `legalAccepted: true` without proving the user row changed.
- [x] Require exactly one confirmed D1 change before issuing the compliance receipt. A confirmed
      zero after session lookup now returns `401` and clears both secure and legacy session-cookie
      forms; missing, malformed, or impossible metadata returns `503 legal_acceptance_unconfirmed`.
- [x] Force both failure modes in the direct D1 runtime. A concurrent account deletion cascades
      the session, produces no acceptance, and sends clearing cookies. A committed write with an
      omitted receipt updates both legal versions but remains explicitly unconfirmed to the client.
- [x] Pass the pinned Cloudflare build, ESLint, TypeScript, all 552/552 Node tests, the complete
      offline security/SBOM/source-integrity chain, both zero-vulnerability npm audits, and the
      full 200/200 Chromium/WebKit phone matrix. Preserve the clean local commit and exact
      deterministic release-bundle receipts for this repository-only checkpoint. No push, pull
      request, merge, deployment, provider query, D1 mutation, model change, or UI change belongs
      to this work.

## Active checkpoint — database-confirmed pending-trip mutations

- [x] Continue the private-object receipt audit through owner trip PATCH and DELETE. Both final
      statements already repeat `id`, authenticated `user_id`, and `moderation_status = 'pending'`,
      but the handler collapsed missing D1 metadata into the same definite conflict as a confirmed
      zero-change moderation race.
- [x] Preserve the real distinction. A confirmed zero remains the generic `409 trip_reviewed`;
      missing, malformed, or impossible change metadata returns a replay-blocking `503` and never
      invokes the trip-update callback or manufactures a successful deletion response.
- [x] Preserve recovery after an ambiguous committed delete. The server attaches the opaque,
      HttpOnly owner deletion-status receipt even when the final D1 metadata is unavailable, so a
      read-only status check can locate the durable cleanup job without exposing its identifier.
- [x] Force both ambiguous commits in the direct D1 runtime. The PATCH row changes but returns
      `503` with no callback; the DELETE row and durable deletion job commit, return `503`, and set
      the receipt cookie. The existing moderation-race test separately proves real zero-change
      outcomes stay `409`, while the generated 222-site inventory locks the final owner delete.
- [x] Pass the pinned Cloudflare build, ESLint, TypeScript, all 551/551 Node tests, the complete
      offline security/SBOM/source-integrity chain, both zero-vulnerability npm audits, and the
      full 200/200 Chromium/WebKit phone matrix. Preserve the clean local commit and exact
      deterministic release-bundle receipts for this repository-only checkpoint. No push, pull
      request, merge, deployment, provider query, D1 mutation, model change, or UI change belongs
      to this work.

## Active checkpoint — database-confirmed owner gear mutations

- [x] Continue the private-object audit from identity predicates into mutation receipts. Gear
      PATCH and DELETE already repeated the authenticated `user_id`, so they could not mutate
      another owner's row, but both returned success without verifying that the final statement
      changed anything.
- [x] Require exactly one D1 change for both operations. A row that changes owner or disappears
      after the owner pre-read now returns the same generic `404`; missing or impossible mutation
      metadata fails with a retry-safe `503` instead of manufacturing a success receipt.
- [x] Force both concurrent states in the direct D1 runtime: one row moves to a second account
      immediately before PATCH and retains its original fields, while another disappears before
      DELETE. Neither request reports success, and the generated 222-site inventory separately
      locks both final SQL statements to `id` plus `user_id`.
- [x] Pass the pinned Cloudflare build, ESLint, TypeScript, all 550/550 Node tests, the complete
      offline security/SBOM/source-integrity chain, both zero-vulnerability npm audits, and the
      full 200/200 Chromium/WebKit phone matrix. Preserve the clean local commit and exact
      deterministic release-bundle receipts for this repository-only checkpoint. No push, pull
      request, merge, deployment, provider query, D1 mutation, model change, or UI change belongs
      to this work.

## Active checkpoint — confirmed-session browser privacy cleanup

- [x] Audit every browser-persisted account/trip recovery value and both account-exit paths. The
      existing account-deletion cleanup omitted stable trip request tokens and pending-operation
      markers, while successful sign-out cleared none of the account-bound browser recovery state.
      The secure account session itself remains an opaque `HttpOnly` cookie and is not stored in
      browser script storage.
- [x] Move the active-trip secret, anonymous reporter identifier, trip/profile draft prefixes,
      stable idempotency request material, pending-operation markers, and actual legacy names into
      one shared manifest consumed by both trip recovery and account cleanup. Removal is scoped to
      those exact keys/prefixes across `localStorage` and `sessionStorage`; unrelated CastingCompass
      preferences and unrelated application keys on the same origin are preserved.
- [x] Run cleanup only after an exact logout receipt, a read-only session check that confirms the
      logout, or an accepted account-deletion receipt. Offline, dropped, malformed, rejected, or
      otherwise ambiguous sign-out outcomes keep both the server session status and browser data
      explicitly unresolved instead of erasing the user's only safe retry material.
- [x] Verify rather than assume removal. If browser storage access or deletion is blocked, the
      server-side sign-out/deletion remains authoritative while the signed-out interface warns
      that local trip recovery data may remain and directs the user to clear CastingCompass site
      data before sharing the device.
- [x] Pass the pinned Cloudflare build, ESLint, TypeScript, all 547/547 Node tests, the complete
      offline security/SBOM/source-integrity chain, both zero-vulnerability npm audits, 44/44
      focused account-exit browser cases, and the full 200/200 Chromium/WebKit phone matrix.
      Preserve the clean local commit and exact release-bundle receipts for this repository-only
      checkpoint. No push, pull request, merge, deployment, provider query, D1 mutation, model
      change, or production authorization occurred.

## Active checkpoint — observability activation private-evidence handoff

- [x] Bind the unfilled handoff to consolidated draft PR `#146` receipt head
      `377dec41c9fc1842c682b7556f2b0a8b1b83e87c`. No provider query, dashboard change,
      PostHog activation, secret access, production mutation, deployment, merge, or new PR occurs.
- [x] Add an exclusive guarded writer for the complete activation manifest. It accepts only a
      normalized absolute destination in a current-user-owned private directory outside the
      checkout, creates one synchronized `0600` regular file without following links, never
      overwrites, and emits only a minimized non-authorizing receipt.
- [x] Make the template visibly incomplete and fail closed. Provider timestamps and evidence
      digests start blank, every operational claim starts false, PostHog remains disabled, and the
      exact required view/drill names are present without claiming that they exist in a provider.
- [x] Harden private evidence ingestion before any bytes are parsed: current-user ownership,
      exactly one hard link, exact `0600` mode, nonempty size at most 256 KiB, repository
      exclusion, no-follow open, and pre/post-read device, inode, link, mode, owner, size, and
      modification checks are required.
- [x] Pass 14/14 focused deterministic and adversarial tests for the policy, template, writer,
      reader, receipt minimization, commit binding, chronology, no-overwrite behavior, checkout/
      permission/symlink/hard-link/empty/oversized rejection, and provider/production separation.
- [x] Materialize one unfilled commit-bound private manifest outside Git and Codex. This is only
      an operator aid: no provider evidence was supplied and `activation_ready` remains false.
- [x] Verify the repository-only follow-up under pinned Node `22.23.1`/npm `10.9.8`: the
      Cloudflare build, ESLint, TypeScript, all 537/537 Node tests, both zero-vulnerability npm
      audits, secret and install-policy checks, deterministic SBOMs, source integrity, D1 query
      inventory, production-change boundary, and every offline security policy pass. The API,
      pipeline, browser runtime, provider state, public artifacts, and model are unchanged.
- [ ] Capture fresh least-privilege preview and production evidence for structured-only logs,
      saved views, access, retention/cost ownership, alert delivery and acknowledgement, uptime,
      reconstruction, pseudonym-key separation, and exact release binding. PostHog remains
      separately deferred; hosted review, deployment, and production acceptance remain open.

## Active checkpoint — production key-custody independent-review handoff

- [x] Freeze a locked non-authorizing policy for all seven runtime-secret roles and the four
      distinct operational/validation backup-key roles. The contract requires exact production
      scope, independently supplied source binding, current evidence, role ordering, six distinct
      private evidence artifacts, and an independent cryptography/key-custody reviewer.
- [x] Add exclusive guarded writers for the unfilled private evidence manifest and review record.
      Both require a normalized absolute destination in an existing current-user-owned `0700`
      directory outside the checkout, create one synchronized exact-`0600` file without following
      links, never overwrite, and emit only minimized receipts with every authority boundary false.
- [x] Validate the complete canonical evidence manifest before binding its exact SHA-256 into the
      review template. The manifest exposes no key IDs or values to Git; it references runtime
      inventory, backup custody, access/MFA, rotation/recovery, restore/deletion replay, and
      redaction evidence only by six distinct digests. Stale evidence, source mismatch, role drift,
      digest reuse, secret capture, or reordered scope fails closed.
- [x] Require an exact current independent review: competence, custody-manifest, and review-note
      digests are distinct; the review cannot predate evidence capture; all 15 checks and zero
      blocking findings are required for `accepted_evidence_boundary`; and `changes_required`
      cannot falsely present a complete result. Private identity/evidence fields never enter the
      public-safe aggregate receipt.
- [x] Preserve the launch boundary even after a valid accepted review. Production key custody,
      the restore gate, deployment, and release remain false until current provider bindings,
      separate action-specific authorization, current production restore/deletion-ledger evidence,
      deployment, and live smoke evidence pass independently.
- [x] Pass 6/6 focused deterministic and adversarial tests covering locked policy/schema/workflow
      integration, both writers, exact evidence binding, accepted and changes-required semantics,
      chronology, source/role/digest mutation, checkout/permission/symlink/hard-link rejection,
      no-overwrite behavior, receipt minimization, and permanent production-authority separation.
- [x] Verify the repository-only handoff under pinned Node `22.23.1`/npm `10.9.8`: the
      Cloudflare build, ESLint, TypeScript, all 545/545 Node tests, the complete offline
      security/SBOM/source-integrity chain, and both zero-vulnerability npm audits pass. The
      Worker/API behavior, database, model, browser UI, private evidence, provider state, and
      production are unchanged.
- [ ] Collect the real private provider/custody evidence, assign the qualified independent
      reviewer, and evaluate the record outside Git. No provider query, secret value, custodian
      identity, private evidence, rotation/recovery exercise, reviewer acceptance, deployment, or
      production mutation occurred during this repository-only handoff.

## Active checkpoint — launch-catalog water-quality mapping independent-review handoff

- [x] Bind this local-only follow-up to consolidated draft PR `#146`'s exact receipt head
      `377dec41c9fc1842c682b7556f2b0a8b1b83e87c`. No push, new PR, merge, deployment,
      Cloudflare or D1 mutation, source collection, public-artifact change, site-prior change, or
      numeric fishing-score contribution occurred.
- [x] Freeze the complete review target instead of sampling convenient sites. Eight hash-locked
      repository inputs produce aggregate digest
      `6cb921149782483338f602b5b3df09ae41243e6a05743ae1534a0fe6892d3346` and exactly
      61 mutually exclusive outcomes: 39 provisionally mapped and 22 `not-covered`. Every
      `scoreDelta` remains null, and absence, staleness, or missing coverage remains unknown.
- [x] Add a strict private review contract for two distinct qualified roles: official-source
      mapping and public-health risk communication. Owner-only regular files outside the checkout
      must bind the exact source commit, aggregate target, policy version, reviewer independence,
      ten inventory checks, and three checks for each of all 61 sites; private identity,
      qualifications, notes, paths, and findings enter the public receipt only as digests.
- [x] Add a guarded private-template writer so the handoff does not depend on error-prone shell
      redirection. It requires an existing owner-only non-symlink directory outside the checkout,
      creates canonical `0600` files exclusively without overwrite, synchronizes before success,
      and emits only a minimized non-authorizing receipt. Both unfilled role templates were
      materialized outside Git as `changes_required`; this is preparation, not a review outcome.
- [x] Preserve honest outcomes and fail closed. Acceptance requires all ten inventory checks and
      all 183 site checks with zero blocking findings. A valid `changes_required` review stays
      incomplete, while omission, reordering, remapping, station substitution, input drift,
      reviewer reuse, role reuse, symlinks, hard links, broad file permissions, and non-canonical
      JSON are rejected by deterministic adversarial coverage.
- [x] Keep every authority boundary false even if both reviewers accept the frozen target:
      mapping changes, runtime status, numeric scoring, catch-probability claims, water-contact or
      seafood-safety claims, merge, deployment, and production all remain unauthorized. The gate
      is bound into pull-request and release security workflows, the release SBOM/source inventory,
      and the deterministic release bundle.
- [x] Complete the clean local release matrix under pinned Node `22.23.1`/npm `10.9.8` and the
      available Python environments: fresh zero-script install, both zero-vulnerability npm
      audits, Cloudflare build, 527/527 Node tests including 9/9 focused mapping-review tests,
      ESLint, TypeScript, the full security/SBOM/source-integrity chain, Ruff, 29/29 API tests,
      all 19 critical D1 query plans, 83/83 pipeline tests with one documented optional-`rasterio`
      skip, deterministic synthetic smoke, 188/188 Chromium/WebKit phone cases, and a 157-file
      deterministic release bundle whose manifest, SBOM, and archive checksums verified.
- [x] Verify the private-writer follow-up under the same pinned Node/npm toolchain. The Cloudflare
      build and 529/529 Node tests passed, including 11/11 focused mapping-review tests; ESLint,
      TypeScript, both zero-vulnerability audits, deterministic SBOMs, source-integrity checks,
      security policies, D1 inventory, and provenance all passed. The follow-up changes only the
      offline reviewer CLI, tests, runbook, and package command surface; it does not alter the API,
      pipeline, browser runtime, frozen target, public artifact, model, or production state.
- [ ] Obtain the two real qualified independent reviews outside Git and evaluate their private
      records. Exact-head hosted CI, dependency review, CodeQL, release provenance, merge,
      deployment, provider/database mutation, and post-deployment evidence remain separate open
      gates. This repository handoff is not an independent-review receipt.

## Active checkpoint — pollution-score independent-review handoff

- [x] Preserve protected draft PR `#145` at exact final receipt head
      `9fd337d561056fef5227eb013fa8f7b909f69343` as the immutable policy source. This
      follow-up is isolated from the dirty primary checkout and does not merge, deploy, mutate
      Cloudflare or D1, collect pollution data, admit a source, change the advisory runtime or
      public artifact, alter a site prior, or authorize a numeric fishing-score contribution.
- [x] Freeze a strict private review schema and source-bound verifier for the two required
      disciplines. Separate owner-only non-symlink files must bind the exact source commit, policy
      version, and policy digest; identify distinct fisheries/marine-ecology and public-health/
      risk-communication roles; preserve qualification and substantive notes outside Git by
      digest only; and assert independence from implementation.
- [x] Add a guarded writer for both private role templates. It requires an existing owner-only
      non-symlink directory outside the checkout, creates canonical `0600` files exclusively,
      never overwrites, synchronizes before success, and emits only a minimized non-authorizing
      receipt. Both unfilled templates were materialized privately as `changes_required`; no
      independent review has been conducted or accepted.
- [x] Preserve honest review outcomes. An accepted boundary requires all ten safety/meaning checks
      and zero blocking findings, while a valid `changes_required` record must expose at least one
      failed check or blocking finding and produces an explicitly incomplete receipt. Reviewer
      IDs, private evidence digests, notes, findings, and paths never enter the aggregate receipt.
- [x] Keep every authority boundary false even when both reviews accept the inactive policy:
      runtime collection, positive or negative numeric scoring, catch-probability claims, water-
      contact or seafood-safety claims, merge, deployment, and production remain unauthorized.
      Focused deterministic and adversarial tests pass 6/6, and the policy/contract are bound into
      the CI security chain, release-source inventory, and deterministic release bundle.
- [x] Complete the clean full local release matrix under pinned Node `22.23.1` and the locked
      Python environments: fresh zero-script install, both zero-vulnerability npm audits,
      Cloudflare build, 518/518 Node tests, ESLint, TypeScript, the complete offline security/
      SBOM/source-integrity chain, Ruff, 29/29 API tests, all 19 critical D1 query plans, 83/83
      pipeline tests with one documented optional-`rasterio` skip, deterministic synthetic smoke,
      deterministic release-bundle tamper checks, and 188/188 Chromium/WebKit phone cases passed.
- [x] Publish protected stacked draft PR `#146` without merge or deployment. Exact implementation
      head `8b1e120095541c5c833efd812140090221c9831a` passed push and pull-request CI runs
      `29854838680` and `29854880247`, including two independent 188/188 Chromium/WebKit phone
      matrices; release-provenance runs `29854838744` and `29854880224`; native API-image run
      `29854880183` on Linux AMD64 and ARM64; and explicitly dispatched optional research-stack
      run `29854908836` on Linux CPU and macOS ARM64. Event-inapplicable dependency and release-
      attestation jobs skipped as designed; the immutable final receipt head is recorded on the
      draft PR.
- [x] Verify the guarded-writer follow-up under pinned Node `22.23.1`/npm `10.9.8`. The
      Cloudflare build and 531/531 Node tests passed, including 8/8 focused pollution-review
      tests; the exact package, offline CLI, runbook, and SBOM changes do not alter the inactive
      policy, source admission, runtime collection, score, model, API, pipeline, browser behavior,
      provider state, or production authority.
- [x] Respond to newly published high-severity `fast-uri` advisory
      `GHSA-4c8g-83qw-93j6` without widening the dependency surface. Ajv `8.20.0` already permits
      the patched `fast-uri` `3.1.3`, so only that transitive lock entry, its integrity hash, the
      deterministic SBOMs, and the expected production-SBOM serial changed. A fresh zero-script
      install completed with 534 audited packages and zero vulnerabilities; no direct dependency,
      install hook, major version, runtime feature, provider, database, or production state changed.
- [ ] Obtain the two real qualified independent reviews outside Git and verify their private
      records. CodeQL against protected `main`, every future source/target/measurement/validation
      gate, guarded deployment, and production evidence remain separate open work.

## Active checkpoint — pollution-score source and meaning boundary

- [x] Preserve draft PR `#144` at exact final receipt head
      `d3f30cdb1e90cd1a631ab4b55468ee30c1df75ad` as the stacked base. This follow-up is
      isolated from the dirty primary checkout and does not merge, deploy, mutate Cloudflare or
      D1, add a collector, change the advisory runtime or public artifact, alter a site prior, or
      add a numeric fishing-score contribution.
- [x] Separate six official-source meanings that the broad word “pollution” could otherwise
      conflate: water-contact actions, fecal-indicator-bacteria samples, fish-consumption advice,
      fish-tissue bioaccumulation monitoring, ambient multi-project measurements, and a community
      pollution-burden screen. Each retains its own spatial, temporal, quality, and claim boundary.
- [x] Freeze a strict research-only source policy. Existing exact current BeachWatch actions stay
      an exclusion-only guardrail; OEHHA advice stays authoritative safety display; BeachWatch
      samples, SWAMP tissue data, and CEDEN results stay unadmitted research candidates; and
      CalEnviroScreen is rejected for fishing-site scoring. Collection and positive or negative
      score contribution remain disabled and `numericScoreDelta` remains null.
- [x] Complete strict schema and semantic checks that reject premature scoring, non-null deltas,
      source promotion, or relabeling community burden as a site measurement. The clean local
      release matrix passed under pinned Node `22.23.1` and the locked Python environments: fresh
      zero-script install, both zero-vulnerability npm audits, Cloudflare build, 512/512 Node
      tests, ESLint, TypeScript, the complete offline security/SBOM/source-integrity chain, Ruff,
      29/29 API tests, all 19 critical D1 query plans, 83/83 pipeline tests with one documented
      optional-`rasterio` skip, deterministic synthetic smoke, and 188/188 Chromium/WebKit phone
      cases.
- [x] Publish protected stacked draft PR `#145` without merge or deployment. Exact implementation
      head `a03c4e2d97adae2fbef5e73ac3b73eb2175f88db` passed push and pull-request CI runs
      `29851557748` and `29851574693`, including two independent 188/188 Chromium/WebKit phone
      matrices; release-provenance runs `29851556959` and `29851574519`; native API-image run
      `29851574565` on Linux AMD64 and ARM64; and explicitly dispatched optional research-stack
      run `29851601034` on Linux CPU and macOS ARM64. Event-inapplicable dependency and release-
      attestation jobs skipped as designed.
- [ ] Obtain CodeQL evidence when this stack is eventually reviewed against protected `main`;
      default setup does not trigger on a non-default stacked base. Before any future activation,
      freeze and pre-register a distinct fishing-quality target and held-out validation protocol,
      prove incremental value with uncertainty, and obtain independent fisheries-methods and
      public-health risk-communication review. Deployment and production remain separate gates.

## Active checkpoint — complete launch-catalog water-quality negative evidence

- [x] Preserve draft PR `#143` at exact green receipt head
      `1845894b3464708ae16e37b78e419e6bf52197b9` as the stacked base. This follow-up is
      isolated from the dirty primary checkout and does not merge, deploy, mutate Cloudflare or
      D1, change the public advisory artifact, alter a site prior, or turn water quality into a
      numeric fishing score.
- [x] Reconcile all 61 launch-catalog sites against the five-source repository artifact and four
      existing source-specific mapping audits. Thirty-nine sites have provisional official-source
      mappings; 22 correctly remain `not-covered`, unknown, and null-score. Twenty-one of those 22
      already had explicit negative-evidence receipts, leaving Dumbarton Fishing Pier as the sole
      inventory gap.
- [x] Audit the fixed State Water Board BeachWatch county directory and the two relevant station
      option sets read-only at `2026-07-21T16:22:00Z`. The directory exposes no Alameda County
      program; East Bay Parks District exposes eight station identities, Water Boards exposes
      zero, and neither contains a Dumbarton identity. This is directory/station-identity evidence
      only, never current status, clean-water, seafood-safety, or score evidence.
- [x] Add a strict hash-bound coverage inventory that requires each not-covered site to appear in
      exactly one negative-evidence receipt, refuses duplicate or missing evidence, fails closed
      if a Dumbarton candidate appears, cannot edit policy, and leaves all 22 sites unmapped.
      Deterministic and adversarial tests pass against bounded fixtures; independent review stays
      required.
- [x] Complete the clean local release matrix under pinned Node `22.23.1` and the locked Python
      environments: a fresh zero-script install, both zero-vulnerability npm audits, Cloudflare
      build, 509/509 Node tests, ESLint, TypeScript, the complete offline security/SBOM/source-
      integrity chain, Ruff and Python syntax, 29/29 API tests, 83/83 pipeline tests with one
      documented optional-`rasterio` skip, deterministic synthetic smoke, and all 19 critical D1
      query plans passed. The complete Chromium/WebKit phone matrix passed 188/188 cases.
- [x] Publish protected stacked draft PR `#144` without merge or deployment. Exact implementation
      head `f19e8a259e3325342e3976f6f039f6b9ea41aa9b` passed push and pull-request CI runs
      `29849110938` and `29849139024`, including two independent 188/188 Chromium/WebKit phone
      matrices; release-provenance runs `29849110653` and `29849139212`; explicitly dispatched
      optional research-stack run `29849168335` on Linux CPU and macOS ARM64; and native API-image
      run `29849168245` on Linux AMD64 and ARM64. Event-inapplicable dependency and release-
      attestation jobs skipped as designed.
- [ ] Obtain independent directory/source review and CodeQL evidence when this stack is eventually
      reviewed against protected `main`; default setup does not trigger on a non-default stacked
      base. Exact official coverage changes must trigger a new review rather than automatic
      mapping. Guarded deployment, provider/database mutation, production activation, and every
      numeric-contribution gate remain separate open work.

## Active checkpoint — Seal Point water-quality negative evidence

- [x] Preserve draft PR `#142` at exact receipt head
      `1bf7037a88f74830d42d5062e492a2f3d26715bd` as the stacked base. This follow-up is
      isolated from the dirty primary checkout and does not merge, deploy, mutate Cloudflare or
      D1, alter a site prior, or turn water quality into a numeric fishing score.
- [x] Audit San Mateo County's fixed public station registry read-only at
      `2026-07-21T15:46:25Z`. The exact County station identity nearest Seal Point Park Shoreline
      is Coyote Point, 2,102 m away at a different named public location; the registry exposes no
      Seal Point identity in the reviewed set.
- [x] Preserve the negative mapping result rather than inheriting Coyote Point's current status.
      Seal Point remains `not-covered`, unknown, and null-score; the policy and generated public
      advisory artifact are unchanged.
- [x] Extend the deterministic San Mateo audit receipt and regression contract to bind both
      negative results—Poplar Beach and Seal Point—to source/tool/policy/catalog hashes, forbid
      automatic mapping, and continue requiring independent review.
- [x] Complete the clean local release matrix under pinned Node `22.23.1` and the locked Python
      environments: a fresh zero-script install, both zero-vulnerability npm audits, Cloudflare
      build, 506/506 Node tests, ESLint, TypeScript, the complete offline security/SBOM/source-
      integrity chain, Ruff and Python syntax, 29/29 API tests, 83/83 pipeline tests with one
      documented optional-`rasterio` skip, deterministic synthetic smoke, and all 19 critical D1
      query plans passed. The complete Chromium/WebKit phone matrix passed 188/188 cases.
- [x] Publish protected stacked draft PR `#143` without merge or deployment. Exact implementation
      head `370bd43a86fe76ecab0c2fdb643385fb972807f4` passed push and pull-request CI runs
      `29846031359` and `29846052760`, including two independent 188/188 Chromium/WebKit phone
      matrices; release-provenance runs `29846031486` and `29846053718`; and explicitly
      dispatched optional research-stack run `29846067566` on Linux CPU and macOS ARM64. Native
      API-image run `29846801493` passed on Linux AMD64 and ARM64 after rerunning an unchanged
      AMD64 job whose first attempt failed only because GitHub returned an HTTP 302 while the
      pinned Grype installer fetched its checksum. Event-inapplicable dependency jobs skipped as
      designed.
- [ ] Obtain independent mapping review and CodeQL evidence when this stack is eventually
      reviewed against protected `main`; default setup does not trigger on a non-default stacked
      base. Guarded deployment, provider or database mutation, production activation, and every
      numeric-contribution gate remain separate open work.

## Active checkpoint — East Bay Parks District action-only water-quality coverage

- [x] Preserve draft PR `#141` at exact receipt head
      `8b1f05ac43509fae112b583549eb58431c84fab0` as the stacked base. This follow-up is
      isolated from the dirty primary checkout and does not merge, deploy, mutate Cloudflare or
      D1, alter site priors, or turn water quality into a numeric fishing score.
- [x] Add a fifth independently failing official adapter request using only the fixed State Water
      Board BeachWatch East Bay Parks District identifier `19`. It shares the reviewed action-only
      semantics but cannot erase Santa Barbara, Marin, SFPUC, or San Mateo evidence when its own
      response fails.
- [x] Bind Keller Beach to its exact North and South station identities and Crown Memorial State
      Beach to its six exact Crown station identities. The official registry exposes no explicit
      districtwide action identity, so this source inherits none; absence remains unknown and
      every numeric `scoreDelta` remains null.
- [x] Preserve 11 negative mapping results for the other Richmond-through-San Leandro catalog
      sites reviewed in this slice. In particular, Ferry Point does not inherit Keller and the
      Alameda South Shore Rock Wall does not inherit Crown Windsurfer Corner; similar area and
      proximity do not authorize a public-location mapping.
- [x] Capture the bounded eight-station registry and five-source action snapshot at
      `2026-07-21T15:16:01Z`, with response/policy/tool/catalog hashes and an independent-review
      requirement. All five current-source reads succeeded; open-ended postings beginning May 5
      at Keller North and June 23 at Crown Crab Cove suppress both catalog sites in the repository
      artifact.
- [x] Complete the clean local release matrix under pinned Node `22.23.1` and the locked Python
      environments: a fresh zero-script install, both zero-vulnerability npm audits, Cloudflare
      build, 506/506 Node tests, ESLint, TypeScript, the complete offline security/SBOM/source-
      integrity chain, Ruff and Python syntax, 29/29 API tests, 82 passed pipeline tests with one
      documented optional-`rasterio` skip and 138 subtests, deterministic synthetic smoke, and all
      19 critical D1 query plans passed. The full Chromium/WebKit phone matrix passed 188/188 cases
      and proves Keller and Crown suppression is visible, source-linked, score-excluded, and
      mobile-safe.
- [x] Publish protected stacked draft PR `#142` without merge or deployment. Exact implementation
      head `bdf1e696c2ca52b5623ddd30ff3801ac7d5d1d38` passed push and pull-request CI runs
      `29843797530` and `29843816686`, including two independent 188/188 Chromium/WebKit phone
      matrices; release-provenance runs `29843796840` and `29843816690`; native API-image run
      `29843816787` on Linux AMD64 and ARM64; and explicitly dispatched optional research-stack
      run `29843823150` on Linux CPU and macOS ARM64. Event-inapplicable dependency and release-
      attestation jobs skipped as designed.
- [ ] Obtain independent mapping and source-latency review and CodeQL evidence when this stack is
      eventually reviewed against protected `main`; default setup did not trigger on the non-
      default stacked base. Guarded deployment, post-deployment freshness, provider/database
      mutation, production activation, and every numeric-contribution validation gate remain
      separate open work.

## Active checkpoint — Marin County action-only water-quality coverage

- [x] Preserve draft PR `#140` at exact receipt head
      `1ffa68cbb7be41d82eba86c74f56e1e3121684fc` as the stacked base. This follow-up is
      isolated from the dirty primary checkout and does not merge, deploy, mutate Cloudflare or
      D1, alter site priors, or turn water quality into a numeric fishing score.
- [x] Add a fourth independently failing official adapter using only the fixed State Water Board
      BeachWatch Marin County identifier `6`. It shares the reviewed action-only semantics but
      cannot erase Santa Barbara, SFPUC, or San Mateo evidence when its own response fails.
- [x] Bind six catalog sites only to exact official station identities: Drakes, Bolinas, three
      Stinson stations, three Muir stations, three Rodeo stations, and McNears. Every site also
      receives only an explicit countywide action; absence remains unknown and every numeric
      `scoreDelta` remains null.
- [x] Preserve four negative mapping results. Limantour, Point Reyes South, and Fort Baker have no
      exact registry identity; Paradise Beach Pier stays unmapped because the official
      `PARADISE COVE` identity is not the same public location. Similar names and proximity do not
      authorize a mapping.
- [x] Capture the bounded 31-station registry and four-source action snapshot at
      `2026-07-21T14:40:40Z`, with response/policy/tool/catalog hashes and an independent-review
      requirement. All four current-source reads succeeded; an open-ended July 15 Bolinas posting
      suppresses Bolinas in the repository artifact while the other Marin mappings remain unknown.
- [x] Complete the clean local release matrix under pinned Node `22.23.1` and the locked Python
      environments: a fresh zero-script install, both zero-vulnerability npm audits, Cloudflare
      build, 501/501 Node tests, ESLint, TypeScript, the complete offline security/SBOM/source-
      integrity chain, Ruff and Python syntax, 29/29 API tests, 83/83 pipeline tests with one
      documented optional-`rasterio` skip, deterministic synthetic smoke, and all 19 critical D1
      query plans passed. The full Chromium/WebKit phone matrix passed 188/188 cases, and a focused
      four-browser check proves Bolinas suppression is visible, linked to the State Board source,
      score-excluded, and mobile-safe.
- [x] Publish protected stacked draft PR `#141` without merge or deployment. Exact implementation
      head `200459d6f0ddbe40a7c74e3370d32766d7e9f7a9` passed push and pull-request CI runs
      `29841027844` and `29841054518`, including two independent 188/188 Chromium/WebKit phone
      matrices; release-provenance runs `29841028020` and `29841053253`; native API-image run
      `29841056083` on Linux AMD64 and ARM64; and explicitly dispatched optional research-stack
      run `29841066358` on Linux CPU and macOS ARM64. Event-inapplicable dependency and release-
      attestation jobs skipped as designed.
- [ ] Obtain independent mapping and source-latency review and CodeQL evidence when this stack is
      eventually reviewed against protected `main`; default setup did not trigger on the non-
      default stacked base. Guarded deployment, post-deployment freshness, provider/database
      mutation, production activation, and every numeric-contribution validation gate remain
      separate open work.

## Active checkpoint — San Mateo County action-only water-quality coverage

- [x] Preserve draft PR `#139` at exact receipt head
      `6c0c2a3b4dde9dfab005936b0c94d07a5c69e9f2` as the stacked base. This
      follow-up is isolated from the dirty primary checkout and does not merge, deploy, mutate
      Cloudflare or D1, alter site priors, or turn water quality into a numeric fishing score.
- [x] Add a third fixed official adapter for San Mateo County Health's current posting page. It
      accepts only the single dated `IMPORTANT NOTICE`, exact warning/closure statement, and
      ordered Ocean, Creek, and Bay sections. Drift, duplicate structure, future notice dates,
      response failures, and malformed records fail only this source closed.
- [x] Freeze action-only semantics: an exact current County listing suppresses a reviewed mapped
      recommendation; an absent listing stays unknown because missing or unsampled status cannot
      prove no warning. Every numeric `scoreDelta` remains null, the fishing score is unchanged,
      and official notices and posted signs stay authoritative.
- [x] Add local preliminary support for 11 catalog sites using 17 stable County station IDs. A
      bounded official-registry receipt records identity, historical coordinates, 140–995 m
      reviewed distances, response/policy/tool/catalog hashes, and the explicit requirement for
      independent mapping review. The registry is not used as current-status evidence.
- [x] Preserve the negative mapping result for Poplar Beach. Its nearest station in the reviewed
      set is Francis Beach at 1,944 m without exact identity or defensible local authority, so
      Poplar remains `not-covered`, unknown, and null-score.
- [x] Refresh the three-source repository snapshot at `2026-07-21T13:54:25Z`. All source reads
      succeeded. The County notice was updated July 15 from July 13 samples; exact current
      listings suppress Pacifica State Beach, Rockaway Beach through Calera Creek, and both
      Pillar Point jetty mappings. The time-bound artifact is not a live guarantee.
- [x] Complete the full fresh local release matrix under pinned Node `22.23.1` and the locked
      Python environments: a fresh zero-script install, both zero-vulnerability npm audits,
      Cloudflare build, 496/496 Node tests, ESLint, TypeScript, the complete offline
      security/SBOM/source-integrity chain, Ruff and Python syntax, 29/29 API tests, 83/83
      pipeline tests with one documented optional-`rasterio` skip, deterministic synthetic smoke,
      and all 19 critical D1 query plans passed. The complete Chromium/WebKit phone matrix passed
      188/188 cases, and a focused four-browser check proves the San Mateo suppression is visible,
      linked to the County source, score-excluded, and mobile-safe.
- [x] Publish protected stacked draft PR `#140` without merge or deployment. Exact implementation
      head `ff2d7bb17c4ed54e0bff8be58821eceec2717e43` passed push and pull-request CI runs
      `29836658793` and `29836660505` (successful attempt 2 after attempt 1 was canceled when the
      hosted browser installation stalled), including two independent 188/188 Chromium/WebKit
      phone matrices; release-provenance runs `29836660822` and `29836660567`; native API-image
      run `29836660545` on Linux AMD64 and ARM64; and explicitly dispatched optional research-
      stack run `29836696056` on Linux CPU and macOS ARM64. Event-inapplicable dependency and
      release-attestation jobs skipped as designed.
- [ ] Obtain independent mapping and source-latency review and CodeQL evidence when this stack is
      eventually reviewed against protected `main`; default setup did not trigger on the non-
      default stacked base. Guarded deployment, post-deployment freshness, provider/database
      mutation, production activation, and every numeric-contribution validation gate remain
      separate open work.

## Active checkpoint — San Francisco water-quality coverage negative evidence

- [x] Preserve draft PR `#138` at exact receipt head
      `19bb941c53b9ed1b2af04886f8c96e062922ec85` as the stacked base. This
      follow-up is isolated from the dirty primary checkout and does not merge, deploy, mutate
      Cloudflare or D1, change the catalog or score, or reinterpret current official status.
- [x] Audit the fixed SFPUC machine endpoint read-only for the four still-unmapped San Francisco
      sites. The `2026-07-21T13:03:50Z` capture returned 20 official station records and is bound
      by response, audit-tool, and catalog SHA-256 digests. The receipt contains only public
      station metadata and bounded nearest-candidate distances.
- [x] Preserve the negative result instead of inferring coverage from proximity. The closest
      official points to Torpedo Wharf, Pier 7, Pier 14, and Heron's Head Park Pier are 792 m,
      2,439 m, 2,520 m, and 1,508 m away and have different official location identities. All
      four remain `not-covered`, `unknown`, and null-score rather than inheriting another
      waterfront's sample status.
- [x] Add a deterministic audit tool and regression tests that validate coordinates and source
      structure, bind the source response, expose four candidates for manual review, forbid
      automatic mapping, and prove the checked-in policy and advisory artifact remain fail-closed.
- [x] Complete the local verification boundary under pinned Node `22.23.1` and the locked Python
      environments: a fresh zero-script install, both zero-vulnerability npm audits, Cloudflare
      build, 490/490 Node tests, ESLint, TypeScript, the complete offline security/SBOM/source-
      integrity chain, Ruff and Python syntax, 29/29 API tests, 83/83 pipeline tests with one
      documented optional-`rasterio` skip, deterministic synthetic smoke, and all 19 critical D1
      query plans passed. No application UI or runtime behavior changed, so the preceding exact
      base's 188-case mobile receipt remains the relevant visual boundary pending hosted CI.
- [x] Publish protected stacked draft PR `#139` without merge or deployment. Exact implementation
      head `8fa57c5c5a08d663ce9371428e25970f3bd46f41` passed push and pull-request CI runs
      `29832866054` and `29832885780`, including two independent 188/188 Chromium/WebKit phone
      matrices; release-provenance runs `29832866449` and `29832885652`; native API-image run
      `29833491767` on Linux AMD64 and ARM64; and explicitly dispatched optional research-stack
      run `29833494290` on Linux CPU and macOS ARM64. Event-inapplicable dependency and release-
      attestation jobs skipped as designed.
- [ ] Obtain independent spatial-support review or a more exact official source before mapping any
      of these four sites. Broader launch-catalog coverage, numeric-contribution validation,
      CodeQL on protected `main`, merge, deployment, provider/database mutation, and production
      activation remain separate open gates.

## Active checkpoint — Oakland through South Bay source-bound chart context

- [x] Preserve draft PR `#137` at exact final receipt head
      `488f8f78b4b292db88fd83800e9df4a46a9fc384` as the reviewed stacked base. This
      final catalog-extension work uses another isolated worktree and does not merge, deploy,
      mutate Cloudflare or D1, change a catalog prior, or alter the attested fishing score.
- [x] Select the final coherent ten-site launch-catalog cohort: Port View Park Fishing Pier,
      Middle Harbor Shoreline Park, Alameda South Shore Rock Wall, Crown Memorial State Beach,
      Oyster Bay Regional Shoreline, San Leandro Marina Shore, Dumbarton Fishing Pier, Coyote
      Point Jetty, Seal Point Park Shoreline, and Oyster Point Fishing Pier. The same NOAA ENC
      Direct `Approach` source, 13-layer inventory, meters/MLLW meaning, bounded geometry, and
      fail-closed drift rules apply.
- [x] Capture and normalize a fixed `2026-07-21T12:10:36Z` source snapshot for all 61 covered
      sites using 854 bounded layer queries. All ten new configured sectors intersect one or more
      depth-area bands and have nearby deduplicated soundings. The prior 51 site records and
      reviewed service metadata are unchanged; old, month-precision, and undated source records
      remain explicit.
- [x] Extend the strict artifact/schema/type contract to version 1.5 and add deterministic cohort,
      partial-date, score-exclusion, navigation-exclusion, and mobile truthfulness coverage. All
      ten locations retain `scoreDelta: null`; chart context cannot authorize access or imply
      shore-reachable depth, castability, wading safety, or navigation use.
- [x] Complete the fresh full local release matrix under pinned Node `22.23.1` and the
      hash-locked Python environments: fresh zero-script installation, both zero-vulnerability
      npm audits, Cloudflare build, 487/487 Node tests, ESLint, TypeScript, the complete
      security/SBOM/source-integrity chain, 12 deterministic/adversarial structure-depth tests,
      Python syntax/Ruff, 29/29 API tests, 83/83 pipeline tests with one documented optional-
      `rasterio` skip, deterministic synthetic smoke, and all 19 critical D1 query plans passed.
      The complete CI-profile Chromium/WebKit phone matrix passed 188/188 cases. Port View depth
      and date evidence plus Coyote Point display-only evidence were visually inspected from the
      production build at iPhone width.
- [x] Publish protected stacked draft PR `#138` without merge or deployment. Exact implementation
      head `79a356817322072ffe0dba22a0db5bce9f150504` passed push and pull-request CI runs
      `29830471008` and `29830496758`; release-provenance runs `29830470999` and `29830496817`;
      native API-image run `29830496822` on Linux AMD64 and ARM64; and explicitly dispatched
      optional research-stack run `29830504513` on Linux CPU and macOS ARM64. Hosted proof
      includes 487/487 Node tests, a 188/188 Chromium/WebKit mobile matrix, both zero-vulnerability
      audits, the secret/source-integrity/security chain, API and pipeline checks, and all 19
      critical D1 query plans. Event-inapplicable dependency and release-attestation jobs skipped
      as designed.
- [ ] Obtain CodeQL evidence when this stack is eventually reviewed against protected `main`;
      default setup did not trigger on the non-default stacked base. Independent location/chart
      review, merge, deployment, provider/database mutation, and production activation remain
      separate open gates.

## Active checkpoint — North and East Bay source-bound chart context

- [x] Preserve draft PR `#136` at exact final receipt head
      `d5c25d747e7b4a65915632ca78e3bfd5eecb366b` as the reviewed stacked base. This
      follow-up uses another isolated worktree and does not merge, deploy, mutate Cloudflare or
      D1, change a catalog prior, or alter the attested fishing score.
- [x] Select the coherent ten-site North/East Bay cohort: McNears Beach Pier, Paradise Beach Pier,
      Fort Baker Fishing Pier, Ferry Point Fishing Pier, Keller Beach, Point Isabel Shoreline,
      Albany Bulb Shoreline, Berkeley Marina North Basin Shore, Cesar Chavez Park Shoreline, and
      Emeryville Marina Fishing Pier. The same NOAA ENC Direct `Approach` source, 13-layer
      inventory, meters/MLLW meaning, bounded geometry, and fail-closed drift rules apply.
- [x] Capture and normalize a fixed `2026-07-21T11:15:36Z` source snapshot for all 51 covered
      sites using 714 bounded layer queries. Eight new sectors have one or more depth-area bands.
      McNears and Ferry Point remain explicitly `partial`: both have nearby soundings and charted
      shoreline-construction records, but no reviewed depth-area band intersects the configured
      offshore sector. The prior 41 site records and reviewed service metadata are unchanged.
- [x] Extend the strict artifact/schema/type contract to version 1.4 and add deterministic cohort,
      partial-depth, partial-date, score-exclusion, navigation-exclusion, and mobile truthfulness
      coverage. All ten locations retain `scoreDelta: null`; chart context cannot authorize access
      or imply shore-reachable depth, castability, wading safety, or navigation use.
- [x] Complete the fresh full local release matrix under pinned Node `22.23.1` and the
      hash-locked Python environments: fresh zero-script installation, both zero-vulnerability
      npm audits, Cloudflare build, 486/486 Node tests, ESLint, TypeScript, the complete
      security/SBOM/source-integrity chain, 11 deterministic/adversarial structure-depth tests,
      Python syntax/Ruff, 29/29 API tests, 83/83 pipeline tests with one documented optional-
      `rasterio` skip, deterministic synthetic smoke, and all 19 critical D1 query plans passed.
      The complete CI-profile Chromium/WebKit phone matrix passed 180/180 cases. McNears partial
      evidence and Berkeley chart/date evidence were visually inspected from the production build
      at iPhone width.
- [x] Publish protected stacked draft PR `#137` without merge or deployment. Exact implementation
      head `88f307fd85cc7b1aadfad0c4d1dc2c19c233c5cb` passed push and pull-request CI runs
      `29826805729` (successful attempt 2 after attempt 1 was canceled when hosted browser
      installation stalled) and `29826824190`; release-provenance runs `29826805768` and
      `29826824260`; native API-image run `29826824184` on Linux AMD64 and ARM64; and explicitly
      dispatched optional research-stack run `29826828121` on Linux CPU and macOS ARM64. Hosted
      proof includes 486/486 Node tests, a 180/180 Chromium/WebKit mobile matrix, both zero-
      vulnerability audits, the secret/source-integrity/security chain, API and pipeline checks,
      and all 19 critical D1 query plans. Event-inapplicable dependency and release-attestation
      jobs skipped as designed.
- [ ] Obtain CodeQL evidence when this stack is eventually reviewed against protected `main`;
      default setup did not trigger on the non-default stacked base. Independent location/chart
      review, merge, deployment, provider/database mutation, and production activation remain
      separate open gates.

## Active checkpoint — Point Reyes and Marin Coast source-bound chart context

- [x] Preserve draft PR `#135` at exact final receipt head
      `0e6d5a72099f5da54c011f6606d34ffdd272fe02` as the reviewed stacked base. This
      follow-up uses another isolated worktree and does not merge, deploy, mutate Cloudflare or
      D1, change a catalog prior, or alter the attested fishing score.
- [x] Select the coherent seven-site exposed-coast cohort: Limantour Beach, Drakes Beach, Point
      Reyes South Beach, Bolinas Beach, Stinson Beach, Muir Beach, and Rodeo Beach. The same fixed
      NOAA ENC Direct `Approach` source, 13-layer inventory, meters/MLLW meaning, bounded geometry,
      and fail-closed drift rules apply.
- [x] Capture and normalize a fixed `2026-07-21T10:38:30Z` source snapshot for all 41 covered
      sites using 574 bounded layer queries. Five new sectors have one or more depth-area bands.
      Bolinas and Muir remain explicitly `partial`: both have nearby soundings and charted seabed
      records, but no reviewed depth-area band intersects the configured offshore sector. Crane
      Cove remains the earlier third partial site.
- [x] Extend the strict artifact/schema/type contract to version 1.3 and add deterministic cohort,
      partial-depth, partial-date, score-exclusion, navigation-exclusion, and mobile truthfulness
      coverage. All seven locations retain `scoreDelta: null`; chart context cannot authorize
      access or imply shore-reachable depth, castability, wading safety, or navigation use.
- [x] Complete the fresh full local release matrix under pinned Node `22.23.1` and the
      hash-locked Python environments: fresh zero-script installation, both zero-vulnerability
      npm audits, Cloudflare build, 485/485 Node tests, ESLint, TypeScript, the complete
      security/SBOM/source-integrity chain, ten deterministic/adversarial structure-depth tests,
      Python syntax/Ruff, 29/29 API tests, 83/83 pipeline tests with one documented optional-
      `rasterio` skip, deterministic synthetic smoke, and all 19 critical D1 query plans passed.
      The complete Chromium/WebKit phone matrix passed 172/172 cases. Bolinas partial evidence and
      Drakes chart/date evidence were visually inspected from the production build at iPhone width.
- [x] Publish protected stacked draft PR `#136` without merge or deployment. Exact implementation
      head `69711aad640150385f4f3f5d1e8bf76f17f48236` passed push and pull-request CI runs
      `29824229852` and `29824250752`; release-provenance runs `29824229826` and `29824250787`;
      native API-image run `29824250751` on Linux AMD64 and ARM64; and explicitly dispatched
      optional research-stack run `29824261659` on Linux CPU and macOS ARM64. Hosted proof includes
      485/485 Node tests, a 172/172 Chromium/WebKit mobile matrix, both zero-vulnerability audits,
      the secret/source-integrity/security chain, API and pipeline checks, and all 19 critical D1
      query plans. Event-inapplicable dependency and release-attestation jobs skipped as designed.
- [ ] Obtain CodeQL evidence when this stack is eventually reviewed against protected `main`;
      default setup did not trigger on the non-default stacked base. Independent location/chart
      review, merge, deployment, provider/database mutation, and production activation remain
      separate open gates.

## Active checkpoint — San Mateo Coast and Half Moon Bay source-bound chart context

- [x] Preserve draft PR `#134` at exact final receipt head
      `f2ab34c8ca9968983a49e364235f86f16f91b4fa` as the reviewed stacked base. This
      follow-up is isolated from the dirty primary checkout and does not merge, deploy, mutate
      Cloudflare or D1, change a catalog prior, or alter the attested fishing score.
- [x] Select the next coherent ten-site cohort: Pacifica Municipal Pier, Sharp Park Beach,
      Rockaway Beach, Pacifica State Beach, Montara State Beach, both Pillar Point Harbor jetties,
      Surfer's Beach, Francis State Beach, and Poplar Beach. The same fixed NOAA ENC Direct
      `Approach` source, 13-layer inventory, meters/MLLW meaning, bounded geometry, and fail-closed
      drift rules apply.
- [x] Capture and normalize a fixed `2026-07-21T09:58:54Z` source snapshot for all 34 covered
      sites. Every new sector has one or more depth-area bands and at least one deduplicated
      sounding within 1 km. Existing Crane Cove evidence remains explicitly partial; no substitute
      source, catalog clue, or score value fills that gap.
- [x] Preserve access authority independently of chart coverage. Pacifica Municipal Pier remains
      closed and excluded from ranking and forecast/detail/trip-start flows; the main interface
      retains its official closure-status link. Chart context cannot authorize entry or weaken the
      closure.
- [x] Extend the strict artifact/schema/type contract to version 1.2 and add deterministic source,
      cohort, partial-date, score-exclusion, closed-access, and mobile truthfulness coverage.
- [x] Complete the fresh full local release matrix under pinned Node `22.23.1` and the
      hash-locked Python environments: fresh zero-script installation, both zero-vulnerability
      npm audits, Cloudflare build, 484/484 Node tests, ESLint, TypeScript, the complete
      security/SBOM/source-integrity chain, nine deterministic/adversarial structure-depth tests,
      Python syntax/Ruff, 29/29 API tests, 83/83 pipeline tests with one documented optional-
      `rasterio` skip, deterministic synthetic smoke, and all 19 critical D1 query plans passed.
      The complete bounded two-worker Chromium/WebKit phone matrix passed 164/164 cases. Francis
      State Beach chart evidence and Pacifica Municipal Pier's closed-access boundary were
      visually inspected at iPhone width.
- [x] Publish protected stacked draft PR `#135` without merge or deployment. Exact implementation
      head `ddd879d57a5e34de9d41aa6eb97d89d0a3c079d0` passed push and pull-request CI runs
      `29821712582` and `29821729772`; release-provenance runs `29821712499` and `29821729762`;
      native API-image run `29821729791` on Linux AMD64 and ARM64; and explicitly dispatched
      optional research-stack run `29821749747` on Linux CPU and macOS ARM64. Hosted proof includes
      484/484 Node tests, a 164/164 Chromium/WebKit mobile matrix, both zero-vulnerability audits,
      the secret/source-integrity/security chain, API and pipeline checks, and all 19 critical D1
      query plans. Event-inapplicable dependency and release-attestation jobs skipped as designed.
- [ ] Obtain CodeQL evidence when this stack is eventually reviewed against protected `main`;
      default setup did not trigger on the non-default stacked base. Independent location/chart
      review, merge, deployment, provider/database mutation, and production activation remain
      separate open gates.

## Active checkpoint — San Francisco source-bound depth and structure

- [x] Preserve draft PR `#133` at exact final receipt head
      `3f2570a88731f13d42801de77047eb4eb6387edd` as the reviewed stacked base. This
      follow-up remains isolated from the dirty primary checkout and does not merge, deploy,
      mutate Cloudflare or D1, change the catalog, or modify the attested fishing score.
- [x] Extend the display-only NOAA ENC Direct `Approach` policy from the 14 Santa Barbara sites
      to ten reviewed San Francisco coast and waterfront sites. The policy now binds exactly 24
      covered site IDs and retains meters, MLLW, fixed source layers, checksums, bounded sectors,
      and fail-closed source and metadata drift handling.
- [x] Capture and deterministically normalize the fixed source for all 24 sites. Nine of ten San
      Francisco sites have one or more charted depth-area bands and a deduplicated sounding within
      1 km. Crane Cove Park is deliberately `partial`: no depth-area band intersects its configured
      220 m sector, while seven nearby point soundings and reviewed feature records remain visible.
      Exact, month-precision, year-precision, and missing source dates remain distinguishable.
- [x] Add truthful detail-sheet rendering for complete, partial, and unavailable chart evidence.
      The UI presents chart context without claiming castable depth, complete structure inventory,
      navigation use, access, wading safety, or score improvement. Torpedo Wharf and Crane Cove
      Park were visually inspected at iPhone width, and the focused truthfulness matrix passed all
      12 Chromium/WebKit phone cases.
- [x] Complete the clean full local release matrix under pinned Node `22.23.1` and hash-locked
      Python environments: fresh zero-script installation, both zero-vulnerability npm audits,
      Cloudflare build, 483/483 Node tests, ESLint, TypeScript, the complete security/SBOM/source-
      integrity chain, strict schema validation, eight deterministic/adversarial collector tests,
      Python syntax/Ruff, 29/29 API tests, 83/83 pipeline tests with one documented optional-
      `rasterio` skip, deterministic synthetic smoke, and all 19 critical D1 query plans passed.
      The complete bounded two-worker Chromium/WebKit phone matrix passed 156/156 cases.
- [x] Publish protected stacked draft PR `#134` without merge or deployment. Exact implementation
      head `a7b9fe41d37e8f30a725fe55c99b1d7d59537d3a` passed push and pull-request CI runs
      `29819238921` and `29819273235`, including two independent 156/156 mobile matrices;
      release-provenance runs `29819238944` and `29819273244`; native API-image run `29819273236`
      on both architectures; and explicitly dispatched optional research-stack run `29819301646`
      on Linux CPU and macOS ARM64. Event-inapplicable dependency and release-attestation jobs
      skipped as designed.
- [ ] Obtain CodeQL evidence when this stack is eventually reviewed against protected `main`;
      default setup did not trigger on the non-default stacked base. Independent location/chart
      review, merge, deployment, provider/database mutation, and production activation remain
      separate open gates.

## Active checkpoint — Santa Barbara source-bound depth and structure

- [x] Preserve the green stacked demo base on draft PR `#132` at exact head
      `20b31eb31136481f160add020caa2f742a6da49a`. This work uses another isolated stacked
      branch and does not merge, deploy, mutate Cloudflare, alter D1, or rewrite the attested
      score or original Bay Area validation geography.
- [x] Freeze a display-only source policy for the exact 14 Santa Barbara South Coast locations.
      The source review records why current BlueTopo coverage (3/14 configured sectors) and the
      USGS 2012 10 m NAVD88 grid (6/14) cannot support a uniform regional claim, then selects only
      NOAA ENC Direct's `Approach` usage band. The product remains vector chart context in meters
      and MLLW, with no fixed grid resolution or exposed numeric positional/vertical uncertainty.
- [x] Capture a normalized fixed-source snapshot and produce a strict, hash-bound artifact for
      all 14 sites. Every site has one or more charted sector bands and a deduplicated point
      sounding within 1 km; selected nearby records are limited to reviewed chart feature classes.
      Overlapping cells and partial source dates remain explicit. Exact feature geometry stays out
      of the public artifact, `scoreDelta` is null, catalog mutation is forbidden, and source or
      metadata drift fails closed.
- [x] Add the chart evidence to each regional detail sheet without claiming a castable depth,
      complete structure inventory, navigation use, access, wading safety, or score improvement.
      The Goleta rendering was visually inspected at iPhone width, and the exact truthfulness and
      viewport contract passed 4/4 Chromium/WebKit phone cases.
- [x] Complete the final full local receipt under pinned Node `22.23.1`: Cloudflare build plus
      482/482 Node tests, ESLint, TypeScript, Python syntax/Ruff, strict schema validation, seven
      deterministic/adversarial collector tests, the complete security/SBOM/source-integrity
      chain, five release-wrapper tests, and zero-vulnerability full and production npm audits
      passed. A resource-saturated four-worker phone attempt passed 133/148; all 15 unrelated
      timing/setup failures then passed 15/15 alone, and the clean bounded two-worker Chromium/
      WebKit matrix passed 148/148.
- [x] Publish stacked draft PR `#133` without merge or deployment. Exact final receipt head
      `3f2570a88731f13d42801de77047eb4eb6387edd` passed push and pull-request CI runs
      `29816560795` and `29816563951`, release-provenance runs `29816560802` and `29816563860`,
      native API-image run `29816563887` on both architectures, and explicitly dispatched optional
      research-stack run `29816580920` on Linux CPU and macOS ARM64. Event-inapplicable dependency
      and release-attestation jobs skipped as designed; the immutable receipt is recorded on the
      draft PR.
- [ ] Obtain CodeQL evidence when this stack is eventually reviewed against protected `main`;
      GitHub default setup did not trigger on the non-default stacked base, so this checkpoint makes
      no CodeQL claim. Independent local-angler/site review, higher-resolution coverage, scoring
      validation, merge, and guarded production acceptance also remain separate open gates.

## Active checkpoint — Santa Barbara exclusion-only water-contact actions

- [x] Preserve the green regional demo base on draft PR `#131` at exact head
      `5696ea80afedd7085dc945796bb20bfd64e3fafd`. This follow-up uses a separate stacked branch;
      it does not modify, merge, deploy, or invalidate that demo receipt.
- [x] Freeze the second official-source boundary. The California State Water Resources Control
      Board BeachWatch action table is action-only: an exact current `Closure`, `Posting`, or
      `Rain` row may suppress a recommendation, but an absent, ended, future, malformed, or
      unavailable action never becomes a neutral/clean/safe claim and never changes the numeric
      score.
- [x] Bind all 14 Santa Barbara South Coast catalog sites to explicit countywide actions; bind 11
      of those sites to direct reviewed station IDs and leave Mesa Lane, the Harbor Breakwater,
      and Stearns Wharf countywide-only. Exact closure/posting/rain precedence, start/end dates,
      independent source failures, and source-specific unknown behavior are machine checked.
- [x] Extend the artifact contract, collector, browser types/UI, deterministic XML/HTML fixtures,
      and adversarial tests. The v2 artifact exposes both official sources and action dates while
      retaining null `scoreDelta` everywhere. The focused 11-test suite, TypeScript, and ESLint
      pass under pinned Node `22.23.1`.
- [x] Exercise the adapter against both fixed live official endpoints without changing a provider.
      The `2026-07-21T07:20:00Z` read-only snapshot parsed both sources, retained absent actions as
      unknown, and reported open-ended State Board postings for Gaviota and Refugio. The snapshot
      is time-bound review evidence, not a live guarantee or safety claim.
- [x] Complete the full local implementation receipt under pinned Node `22.23.1` and the locked
      Python environments: Cloudflare build plus 475/475 Node tests, ESLint, TypeScript, the
      complete security/SBOM/source-integrity chain, and zero-vulnerability full and production
      npm audits passed. The exact Python gates passed 29/29 API tests, Ruff, 83/83 pipeline tests
      with one documented optional-`rasterio` skip, the deterministic synthetic smoke, and 19
      migrations / 19 critical D1 query plans with every foreign-key child path indexed. The full
      Chromium/WebKit phone matrix passed 144/144 cases.
- [x] Publish protected draft PR `#132` without merge or deployment. Exact final head
      `20b31eb31136481f160add020caa2f742a6da49a` passed push and pull-request CI runs
      `29811484371` and `29811505876`, release-provenance runs `29811484319` and `29811505848`,
      native API-image run `29811505926` on both architectures, and explicitly dispatched optional
      research-stack run `29817324038` on Linux CPU and macOS ARM64. Event-inapplicable jobs skipped
      as designed.
- [ ] Obtain CodeQL evidence when this stack is eventually reviewed against protected `main`;
      default setup did not trigger on the non-default stacked base. Independent mapping and source-
      latency review, remaining launch-catalog coverage, merge, deployment, provider/database
      mutation, and production action remain separate open gates.

## Active checkpoint — non-production regional and water-quality demo integration

- [x] Reconcile protected `main` `086b2055f44ba5e2595d6bd249866ffb20c3c461`, draft
      regional PR `#118`, draft water-quality PR `#130`, issue `#86`, and the ordered roadmap.
      All remaining P0/P1 provider, counsel, staging, deployment, independent-review, and
      real-data gates remain open; this integration cannot satisfy or bypass them.
- [x] Preserve the reviewed Santa Barbara South Coast expansion from Gaviota through Rincon:
      14 public-access catalog entries, three NOAA tide anchors, West/East Channel buoy routing,
      the Campus Point no-take exclusion, a 2,160-window source-bound snapshot, truthful regional
      search language, and the original Bay Area validation geography frozen byte-for-byte.
      The score remains an explainable relative ranking, never a catch probability.
- [x] Preserve the local-access evidence boundary. The blank 14-site packet and offline evaluator
      remain machine-bound, privacy-minimizing, and non-authorizing. No review response has been
      supplied or accepted; every regional site remains pending, including five limited-access
      sites requiring two independent reviews. Regional trip reports remain ordinary private
      product observations rather than validation evidence.
      - [x] Replace the shell-redirection handoff with an exclusive owner-only packet writer. It
            accepts only a normalized absolute destination in a current-user-owned `0700`
            directory outside the checkout, creates one new `0600` file without following links,
            never overwrites an existing file, and emits only a minimized non-authorizing receipt.
      - [x] Enforce the private evidence boundary before reading: current-user ownership, exactly
            one hard link, exact `0600` mode, nonempty size at most 256 KiB, repository exclusion,
            no-follow open, and post-open device/inode/link/mode/owner/size verification.
      - [x] Materialize one unfilled digest-bound private packet outside Git and Codex for the
            consolidated 14-site catalog. The focused access-review suite passes 11/11, including
            adversarial destination, overwrite, symlink, hard-link, permission, empty-file, and
            oversized-file cases. This is preparation only; no human response or official-source
            recheck has been supplied and `access_review_accepted` remains false.
            The Cloudflare build, ESLint, TypeScript, all 534/534 Node tests, both zero-vulnerability
            npm audits, and the complete security/SBOM/source-integrity policy chain pass.
- [x] Preserve water quality as a separately versioned human-health advisory overlay, not a
      catch-probability, pollution-severity, or seafood-safety score. The fixed HTTPS SFPUC slice
      maps six exact San Francisco sites, rejects malformed or unreviewed source states, binds
      policy/collector/catalog hashes, independently expires neutral evidence, and suppresses a
      recommendation under a current active official status without rewriting its fishing score.
      Fresh no-posting evidence is neutral; stale, unavailable, unmapped, or incomplete evidence
      remains explicitly unknown.
- [x] Preserve the two independent exact-head receipts. Regional PR `#118` head
      `0c90f1afe08b9f8866b26d3bfeef07f541d226e8` passed all applicable hosted checks, including
      140/140 mobile cases. Water-quality PR `#130` implementation head
      `c6d261925168cff33b930413ddf1b0c770ad215c` and receipt head
      `3ac7bec5a3410bf0bdeb0de500e43a1fa7b1025b` passed push/PR CI, CodeQL, both native API-image
      architectures, release provenance, and the complete 144/144 mobile matrix.
- [x] Verify the combined non-production working tree from source. The advisory artifact was
      regenerated against the 61-site catalog; the Cloudflare build and 472/472 Node tests,
      144/144 Chromium/WebKit mobile cases, ESLint, TypeScript, the complete security/SBOM/source-
      integrity chain and both zero-vulnerability npm audits passed under pinned Node `22.23.1`.
      Exact Python environments passed 29/29 API tests, Ruff, 83/83 pipeline tests with one
      documented optional-`rasterio` skip, the deterministic synthetic smoke, and 19 migrations /
      19 critical D1 query plans with every foreign-key child path indexed.
- [x] Add a bounded [ML-engineer demo runbook](ML-ENGINEER-DEMO.md) that identifies what the
      local candidate demonstrates, what remains unvalidated, and which actions stay outside the
      demo. Docker, provider access, production credentials, Cloudflare, and deployment are not
      required.
- [x] Bind the fully verified implementation tree to merge commit
      `ec2d5bc26429eca1a7e45bbef62bfc5c0775d198`, whose parents are the reviewed regional head
      `0c90f1afe08b9f8866b26d3bfeef07f541d226e8` and water-quality receipt head
      `3ac7bec5a3410bf0bdeb0de500e43a1fa7b1025b`.
- [x] Publish documentation-only receipt head
      `378079d1613e3ef8c73505d44c1a496bff56f7ca` as draft integration PR `#131` and require
      exact-head hosted evidence. Push CI `29808408226` and pull-request CI `29808462035` passed,
      including two independent 144/144 mobile browser matrices, API, pipeline, dependency review,
      and zero-vulnerability audits. CodeQL `29808460165` passed all three languages; release-
      provenance runs `29808408273` and `29808461894`, native API-image run `29808461966`, and
      optional research-stack run `29808462019` also passed. Event-inapplicable attestation and
      dependency-submission jobs skipped as designed.
- [x] Keep the candidate draft-only for the ML-engineer demo. PR `#131` remains a draft; no merge,
      deployment, Cloudflare/provider mutation, database migration, or production activation ran.
      It must not merge or deploy until the Santa Barbara access review, guarded production
      checklist, and every other open gate above are independently satisfied. Structure/depth
      mapping and broader official water-quality coverage remain separate unchecked roadmap goals.

## Completed work cycle — deterministic mobile release evidence

- [x] Reconcile protected `main` after privacy-export PR `#127`. Exact merge commit
      `5756146d061dce9aa3ba63aef73f0d34bde4a21b` passed release provenance, both native API-image
      architectures, all three CodeQL languages, API, pipeline, dependency submission, and the
      complete web job after one failed-job rerun on the unchanged commit. No deployment,
      provider query, binding, migration, or production mutation ran.
- [x] Classify the failed main web result from run `29794888259` using its exact log rather than
      rerunning blindly. One WebKit case missed the reopened trip dialog; the exact case passed
      12/12 local repetitions and both pre-merge hosted web jobs. The prior main failure was a
      different WebKit lazy-map detachment, establishing a release-gate synchronization risk
      rather than a privacy-export regression.
- [x] Harden only the observed test boundaries. Recovery setup waits for the mocked authenticated
      `Profile` state and uses the fixed topbar trip control; close/reopen coverage proves the old
      dialog is hidden and the replacement is visible before checking the restored ambiguous
      state. Lazy-map scrolling now runs inside the existing retry and re-resolves the map after
      React replacement. Product behavior, timeouts, retries, and provider state are unchanged.
- [x] Stress the two revised WebKit boundaries sequentially in the clean worktree: trip recovery
      passed 10/10 and lazy-map loading passed 10/10. Earlier artificial concurrent repetition
      attempts were discarded after the machine reached temporary-storage and unrelated system-
      load saturation; no assertion result from that polluted environment is treated as evidence.
- [x] Classify draft PR `#128`'s first exact head rather than rerunning it. Both independent hosted
      web jobs passed 137/140 and failed the same three WebKit trip-network cases at one redundant
      location-option click: entering the exact site name had already committed the selection, then
      React replaced the suggestion during that second action. The helper no longer clicks
      replaceable option DOM, with no product or timeout change. The exact three-case cluster then
      passed 30/30 concurrent WebKit repetitions and the complete two-worker mobile matrix passed
      140/140 locally.
- [x] Classify the final receipt head's asymmetric hosted result. Its push web job passed 140/140;
      its pull-request web job passed 139/140 and showed one iPhone SE worker receiving the location
      catalog after the exact query was entered, leaving one matching result but no committed
      selection. The helper now waits for that result and selects it through the stable combobox
      keyboard contract, then proves the selected-site status and moves focus through the next real
      form control. The affected slice passed 60/60 two-worker repetitions across iPhone SE and
      WebKit, then 12/12 across all four mobile projects. No timeout, product behavior, provider
      state, or production state changed.
- [x] Complete the ordinary local release matrix. The exact two-worker hosted-CI shape passed all
      140 mobile cases, including both revised WebKit boundaries. Fresh npm installation, the
      Cloudflare build, 456/456 Node tests, ESLint, TypeScript, the complete security/SBOM/query-
      inventory chain and both zero-vulnerability npm audits, 29/29 API tests, Ruff, 19/19 D1
      query plans with every foreign-key child path indexed, 81/81 pipeline tests with one
      documented optional-raster skip, and the deterministic pipeline smoke all passed.
- [x] Publish protected draft PR `#128` and obtain complete exact-head hosted evidence for repaired
      implementation head `d7c02e5867657a16f3e51f0bec559c2297d8572d`. Push CI run
      `29797876950` and pull-request CI run `29797878595` each passed the complete web job with
      140/140 mobile cases plus API and pipeline; CodeQL run `29797877045` passed all three
      languages; release-provenance runs `29797876952` and `29797878558` passed. Skips were the
      event-inapplicable attestation, dependency-review, and dependency-submission jobs.
- [x] Require the final PR `#128` head to pass protected checks before merge. Exact head
      `8aec61bb05b45213ee1bc27b7c1c98f11ae42a1c` passed push CI run `29798632628` and
      pull-request CI run `29798634349`, including two independent 140/140 web jobs, plus CodeQL
      run `29798632819` and release-provenance runs `29798632624` and `29798634244`. It then
      merged as protected-main commit `26811fd3f5e4332a264af9e4e7c3f9078e745caf`.
- [x] Classify that merge commit's failed web job rather than rerunning it. Main CI run
      `29799012204` passed API, pipeline, and dependency submission but passed 139/140 mobile
      cases: one WebKit trip-recovery setup never received `Limantour Beach`. The app loads its
      site catalog and 2.9 MB forecast snapshot atomically, and the Vinext test server's recorded
      premature close on the snapshot correctly left the app on its three-site emergency
      fallback. CodeQL run `29799011924` and release-provenance run `29799012244` passed.
- [x] Classify draft follow-up PR `#129`'s first exact head rather than rerunning it. Its push web
      job passed 140/140 while its pull-request web job passed 139/140; the same WebKit setup
      missed `Limantour Beach`. Routing the exact 2.9 MB forecast around Vinext had removed the
      premature-close dependency but still made catalog publication wait for an irrelevant large
      transfer and parse. That transport is not part of trip-mutation recovery.
- [x] Classify PR `#129`'s second exact head rather than rerunning it. Its push web job again
      passed 140/140 while its pull-request web job passed 139/140 at the same setup. Reducing the
      forecast to a tiny schema-valid payload ruled out forecast size. A subsequent local WebKit
      trace showed the trip form already held a valid selected location while the driver waited
      for a replaceable combobox option. The failure was in unrelated catalog interaction, not the
      mutation-recovery behavior under test.
- [x] Isolate the mutation-recovery boundary completely. Only the three trip-recovery cases now
      use the form's already-valid default location and assert its stable selected-status contract.
      The past-report endpoint remains mocked, and the cases no longer type into the catalog,
      inspect transient option DOM, route static data, or make any catalog-ready timing assumption.
      Product behavior, public data, timeouts, retries, Cloudflare, and production are unchanged.
      With a fresh server on every run, the final driver passed 60/60 focused iPhone SE and WebKit
      repetitions and the exact two-worker four-project matrix passed 140/140, including while
      Vinext reproduced the irrelevant static-file premature-close warning. ESLint, TypeScript,
      the Cloudflare build, 456/456 Node tests, secret and install-policy checks, and both complete
      and production-only npm audits also passed. Hosted exact-head evidence remains required below.
- [x] Publish the isolated follow-up, require complete exact-head protected checks, merge only
      accepted evidence, and reconcile protected `main`. PR `#129` exact head
      `02d0789cda4c05d5d9ea81557aea31ec66a8b6c0` passed push CI `29801444205` and
      pull-request CI `29801446092`, including two independent 140/140 Chromium/WebKit web jobs,
      plus CodeQL `29801444300` and release-provenance runs `29801444203` and `29801446067`.
      It merged as protected-main commit `086b2055f44ba5e2595d6bd249866ffb20c3c461`;
      main CI `29801749298`, CodeQL `29801748832`, and release provenance `29801749264`
      passed that exact commit. Production and Cloudflare remained outside this cycle.

## Completed work cycle — default-off asynchronous privacy exports

- [x] Reconcile protected `main`, draft regional PR `#118`, draft asynchronous-export PR `#127`,
      issue `#86`, and the P1 scale roadmap without touching Cloudflare or production. Starting
      `main` is `a9f1efc1d0b7d095ed8b71738b403d1cdc1b23f9`; both draft PRs remain open.
- [x] Independently audit the complete default-off export path. Queue messages remain limited to
      an opaque job ID, D1 remains authoritative, objects remain private and owner-bound for 24
      hours, retries and expiry are bounded, account deletion adopts committed objects, and no
      producer/consumer or R2 provider binding is configured. Migration `0019` remains unapplied,
      the feature remains off, and no provider or production change was made.
- [x] Close the download-integrity gap found during that audit. Every download now recomputes the
      D1 object-locator hash and rejects any mismatch in the recorded byte count, SHA-256 upload
      metadata, or export-contract version before reading or streaming the private object. All
      integrity failures use one generic 503 response and a bounded error code; adversarial tests
      prove neither responses nor logs expose account, job, email, or object-locator identity.
- [x] Freeze the four download-integrity bindings in the machine-checked export policy, document
      the boundary in the export and data-lifecycle runbooks, regenerate the D1 source inventory,
      and bind the revised artifacts into the combined release SBOM. The check does not claim a
      full byte rehash on download or any provider/deployment evidence.
- [x] Complete the local release-sized verification matrix. A fresh npm `10.9.8` no-script install
      restored 533 packages and both audits found zero vulnerabilities; Cloudflare build,
      456/456 Node tests, 140/140 Chromium/WebKit mobile cases, ESLint, TypeScript, and every
      offline security/SBOM/query-inventory gate passed. Exact Python environments passed 29/29
      API tests, Ruff, 81/81 pipeline tests with one documented optional-raster skip, the
      deterministic synthetic smoke, 19 migrations, 19 critical query plans, and every
      foreign-key child index contract.
- [x] Complete the protected workflow without provider mutation. PR `#127` exact implementation
      head `719d4c3c142dbb0e029a6583aa86f122777fbc6a` passed push and pull-request CI, release
      provenance, CodeQL, and both native API-image architectures, then merged as protected-main
      commit `5756146d061dce9aa3ba63aef73f0d34bde4a21b`. Main CI run `29794888259` attempt 2 passed
      the unchanged commit, including 140/140 mobile cases; release provenance `29794888254`,
      API image security `29794888264`, and CodeQL `29794887894` also passed. Provider setup,
      migration `0019`, Queue/DLQ/R2/IAM/alerts, staging failure and deletion drills, activation,
      and production release remain separate reviewed gates.

## Completed work cycle — complete D1 query inventory

- [x] Reconcile protected `main`, draft regional PR `#118`, draft query-inventory PR `#125`, open
      issue `#86`, and the scale roadmap without touching Cloudflare or production. Starting
      `main` is `7ed0f97c499e853b6a3d1a5b6f8c9ef82e70ef2d`; both draft PRs remain open.
- [x] Identify the earliest repository-actionable P1 gap. Existing evidence covered 14
      representative plans but did not inventory every production D1 statement, so query source
      coverage and remaining unbounded reads could not be independently audited.
- [x] Implement a deterministic TypeScript-AST inventory for all 221 direct Worker `.prepare()`
      sites across eight files: 195 literal statements, 26 exact reviewed nonliteral expressions,
      and 12 reviewed literal multi-row reads without `LIMIT`. The gate rejects source drift,
      computed/aliased prepare access, unreviewed dynamic SQL, unscoped literal writes, and
      unreviewed multi-row reads.
- [x] Preserve truthful scale boundaries. Nine reads are complete authenticated rights exports
      and two are owner-lifecycle cleanup reads. The four saved-site/gear UI reads now use exact
      100-item account ceilings, `LIMIT 101` overflow detection, atomic count-guarded creates, and
      fail-closed legacy overflow without truncating rights exports. Complete export packaging,
      scheduled-cleanup batching, and isolated latency/load evidence remain open.
- [x] Resolve the newly published high-severity `brace-expansion` advisory in both locked
      development-tool paths by moving exactly from `1.1.14` to `1.1.16` and `5.0.6` to `5.0.7`.
      A fresh npm `10.9.8` zero-script install completed with 534 audited packages and both full
      and production-only audits returned zero vulnerabilities; no dependency lifecycle script
      ran.
- [x] Bound all five scheduled authentication/retention delete statements to 100 selected primary
      rows per table and invocation. A 101-row fixture proves one eligible row remains after the
      first run, the next run drains it, and current rows survive; all five actual statements use
      the intended indexes. Existing privacy cleanup remains bounded to 50 tasks and 100-job
      reconciliation. Completed-job child-cascade cost still needs isolated staging evidence.
- [x] Reconcile the already-enforced cache and connection boundaries into the owner checklist.
      The complete cache matrix and fail-closed API/PWA rules are locally tested; the Worker uses
      provider-managed D1 bindings, while the optional Postgres service owns one validated bounded
      pool. Edge purge/rollover evidence and provider-sized pool telemetry/exhaustion drills remain
      isolated-staging gates rather than implied production evidence.
- [x] Bind the policy and generated query ledger into CI, the combined release SBOM, and the
      deterministic release archive; add a 15th representative query-plan check for gear-profile
      ordering. Focused adversarial tests, ESLint, and all 15 plans pass.
- [x] Complete the full locked verification matrix. A fresh zero-script npm install audited 534
      packages with zero vulnerabilities; every offline security/SBOM gate, both npm audits,
      ESLint, TypeScript, the Cloudflare build, 441/441 Node tests, and 140/140 Chromium/WebKit
      mobile cases passed. The saved-location recovery cases use their committed forecast
      fixture's recorded clock, so their recovery assertions cannot expire with wall-clock time.
      Exact locked Python graphs passed 29/29 API tests, 81/81 pipeline tests
      with one documented optional-raster skip, Ruff, the deterministic synthetic smoke, 18
      migrations, 15 representative query plans, and every foreign-key child index contract.
- [x] Publish protected draft PR `#125` at exact head
      `0808c732c8210bd4d2f47e4f37a38c2f03361f55`; all applicable hosted checks passed. No
      deployment, D1 migration, provider query, or production mutation was part of that receipt.
- [x] Publish the local account-ceiling and bounded-retention follow-up on draft PR `#125` at
      exact implementation head `fe54c2d2152cabd793c7b83996b35584d9d06672`. Push and pull-request
      CI runs `29787542366` and `29787543587`, release-provenance runs `29787542385` and
      `29787543547`, and CodeQL run `29787542188` passed. The path-filtered native workflow was
      also dispatched explicitly at that exact head: run `29787982359` built, health-checked,
      inventoried, and policy-scanned both `linux/amd64` and `linux/arm64`. Its three known high
      CPython findings match the reviewed, module-removal-backed exceptions that expire
      2026-08-08; no new exception was added. No deployment, D1 migration, Cloudflare change, or
      production mutation occurred during that exact-head receipt.
- [x] Exercise the actual built Worker against a disposable local D1 database with all 18
      migrations, not the earlier synthetic HTTP server. Wrangler local HTTPS returned the
      hardened D1-backed health response and the bounded smoke profile completed 2,835 requests
      with zero failures, 18.51 ms p95, and 32.79 ms p99. This is developer-machine evidence only;
      isolated production-shaped staging load, soak, spike, failure injection, provider metrics,
      and cost evidence remain open.
- [x] Merge accepted PR `#125` as protected-main commit
      `cd5aa41a4e01bda59bbbd44b968730e1ba956785`. Main CI `29788509904`, release provenance
      `29788509895`, and all three CodeQL languages plus aggregate upload in `29788509768` passed.
      The merge did not run a deployment command, migration, provider query, or production
      mutation and is not evidence that the live Worker changed.

## Completed repository work cycle — independent operational restore-review gate

- [x] Reconcile protected `main`, draft regional PR `#118`, the owner roadmap, and the existing
      synthetic restore/deletion-replay evidence boundary. Starting `main` is
      `80b347c2a24dbab82543c107effd5a8b8d3c55fa`; production and provider state remain untouched.
- [x] Identify the earliest repository-actionable P0 gap. The synthetic restore packet existed,
      but no locked workflow could bind a separately supplied source commit, private packet,
      independent reviewer, strict review chronology, and privacy-minimized public receipt while
      keeping every production authorization claim false.
- [x] Freeze the independent-review boundary in a versioned policy and exact JSON Schema. The
      policy permits only the three expected packet files and audit identities, requires all
      acceptance checks and separation attestations, limits the review window to seven days, and
      prohibits reviewer identity, paths, provider details, audit content, and private evidence
      hashes from the public receipt.
- [x] Implement the offline verifier, operator/reviewer runbook, deterministic safe receipt, and
      adversarial tests. Canonical JSON, full source identity, file ownership/mode/type/link
      boundaries, immutable packet hashes, audit chronology/hash chain, reviewer separation, and
      private-note independence all fail closed. The verifier performs no network or provider
      action and cannot approve key custody, provider evidence, deployment, or production release.
- [x] Complete clean local verification. A fresh zero-script npm install audited 534 packages
      with zero vulnerabilities; Cloudflare build, 436/436 Node tests, 140/140 Chromium/WebKit
      mobile cases, ESLint, TypeScript, every offline security/SBOM gate, five Python lock graphs,
      and both npm audits passed. The exact Python graphs passed 29/29 API tests, 81/81 pipeline
      tests with one documented optional-raster skip, Ruff, the deterministic synthetic smoke,
      18 migrations, and 14 critical query plans.
- [x] Publish and merge the accepted implementation without deployment or provider mutation.
      PR `#124` final head `04f808f7fe165b856898c951fcac440cd2ba101d` merged as protected-main
      commit `7ed0f97c499e853b6a3d1a5b6f8c9ef82e70ef2d`. Main CI `29722159901`, release
      provenance and attestations `29722159925`, native API-image security `29722159912`, and
      CodeQL `29722159592` passed; both web engines, all three CodeQL languages, both image
      architectures, and dependency submission completed successfully. No Cloudflare, D1, DNS,
      deployment, migration, provider query, or production mutation ran.
- [x] Harden the private handoff follow-up. Every packet/review file now requires stable
      current-user ownership, exact `0600` mode, one hard link, and bounded size through a
      no-follow descriptor; the immutable packet directory requires exact `0700` mode. Device,
      inode, mode, owner, link, size, and modification identity are rechecked after reading.
- [x] Add a guarded packet-derived writer that validates the exact three-file packet and
      independently supplied source commit before binding all packet hashes into a new unfilled
      reviewer record. It refuses relative, checkout, packet-internal, permissive, symlinked, and
      existing destinations; its minimized receipt cannot accept a review or authorize key
      custody, provider evidence, the restore gate, or release. The focused deterministic and
      adversarial suite passes 6/6. No historical private packet or real reviewer record was read,
      generated, or claimed during this repository-only follow-up.
- [x] Verify the repository-only restore-review follow-up under pinned Node `22.23.1`/npm
      `10.9.8`: the Cloudflare build, ESLint, TypeScript, all 539/539 Node tests, the full offline
      security/SBOM/source-integrity chain, and both zero-vulnerability npm audits pass. The API,
      pipeline, browser runtime, private historical packet, provider state, public artifacts, and
      production remain unchanged.
- [ ] Obtain a real second-person review of the private historical packet outside Git. Until that
      reviewer supplies a valid private record and the verifier accepts it, independent review,
      production key custody, provider evidence, the restore gate, and release authorization all
      remain open.

## Completed work cycle — API image upstream watch

- [x] Reconcile protected `main`, draft regional PR `#118`, the owner roadmap, and GitHub work.
      Starting `main` is `4f20a786c8a88cce7104be7a73f012fca1440f02`; `#118` remains the only
      open PR and issue `#86` remains the only open issue. Production is untouched.
- [x] Identify the earliest repository-actionable P0 gap. The weekly native image scan runs on
      Monday, while Python 3.13.15 is scheduled for Tuesday 2026-08-04 and the bounded exception
      expires Saturday 2026-08-08, leaving a detection gap during the replacement window.
- [x] Implement a dependency-free daily/manual, read-only primary-source watch with bounded
      requests. Offline policy and adversarial fixture tests pass 5/5; a live 2026-07-20 check
      confirms Python `3.13.14`, source SHA-256
      `639e43243c620a308f968213df9e00f2f8f62332f7adbaa7a7eeb9783057c690`, source revision
      `f79aea5b8f6b2d65b31ba2bb3f69c0c2083345c8`, and AMD64/ARM64 publication remain current.
- [x] Regenerate the deterministic release inventory and pass the complete clean local gate.
      A fresh zero-script npm install audited 534 packages with zero vulnerabilities; the
      Cloudflare build, 430/430 Node tests, 140/140 Chromium/WebKit mobile cases, ESLint,
      TypeScript, every offline security/SBOM gate, five Python lock graphs, and both npm audits
      passed. Fresh hash-locked Python graphs passed 29/29 API tests and 81/81 pipeline tests
      with one documented optional-raster skip, 14 critical query plans, Ruff, and deterministic
      smoke. The local Homebrew Python 3.13.14 `pyexpat`/system-library mismatch prevents a clean
      exact-runtime API environment, so hosted CI remains the exact Python 3.13.14 authority.
- [x] Publish the exact accepted implementation head through protected CI, provenance, CodeQL,
      and native image checks without deployment or provider mutation. Draft PR `#121` head
      `20cd657686a9bd7e1ec8bfbac9c5742c37879f06` passed PR CI `29716510562`, release
      provenance `29716510577`, CodeQL `29716509307`, and native image security `29716510583`;
      duplicate branch-push CI `29716478066` and release provenance `29716478086` also passed.
      Fifteen checks succeeded and five event-appropriate jobs skipped. Both web runs completed
      all 140 Chromium/WebKit cases, hosted API used exact Python 3.13.14, and both native image
      architectures passed. No Cloudflare, D1, DNS, provider, or production action ran.
- [x] Merge only accepted evidence and reconcile exact protected `main`, workflows, alerts, and
      issue `#86`. PR `#121` merged normally as
      `8c051080abcb3f19b6ab7bc36f6aed67c5bb9f87`; main CI `29717064849`, release
      provenance `29717064802`, native API image security `29717064831`, and CodeQL
      `29717064180` passed. Manual main watch run `29717078040` also passed. Dependabot,
      code-scanning, and secret-scanning alerts were all zero; issue `#86` remains open until a
      fixed image passes both native architectures. No deployment or provider mutation ran.

## Completed seven-step work cycle — privacy-safe observability evidence

- [x] Reconcile protected `main`, draft PR `#119`, the owner roadmap, and the current API-image
      exception schedule. Starting `main` was
      `127841eeb34134a4d32cdbb4853852486ec6b4c5`; Python `3.13.14` remains the current stable
      `3.13` image target and the bounded issue `#86` review is not yet due. Production and
      provider state remained untouched.
- [x] Audit the offline incident drill and activation verifier against their exact public claims.
      The prior draft accepted a completion before later request events, a terminal operation
      before its start, equal timestamps, and a reviewed commit asserted only inside the private
      manifest. Green tests for that head therefore did not prove chronology or independent
      release binding.
- [x] Make reconstruction fail closed: timestamps must increase strictly within every correlation
      identity, request completion must be last, operation start/terminal events must be first and
      last, and every terminal event must contain its bounded duration. Adversarial tests cover
      late request events, terminal-before-start operations, and equal timestamps.
- [x] Bind activation evidence to an independently supplied full Git commit, refuse missing,
      malformed, mismatched, or widened evaluation options, expose the reviewed commit in the
      public-safe receipt, and continue excluding private evidence hashes, provider identifiers,
      saved-view names, actor pseudonyms, and raw payloads. Every boolean is validated even when
      an earlier gate is false, so malformed later claims cannot hide behind short-circuit logic.
- [x] Verify exact implementation head `986271b9bed89a1adc5c977ec2037383c5f5f19f`
      locally: 15/15 focused observability tests, the deterministic 10-event/2-request/3-operation
      drill receipt `97ad05561b2221b816d7cd01091d752458de7a3903698ce44726680835c81a94`,
      Cloudflare build and 425/425 Node tests, ESLint, TypeScript, every offline security gate,
      both SBOMs, five Python lock graphs, and both npm audits with zero vulnerabilities passed.
- [x] Publish only that accepted head and merge after every hosted gate passed. PR `#119` CI
      `29713750801` and `29713751946`, release provenance `29713750823` and `29713751885`, and
      CodeQL `29713750743` passed; 13 checks succeeded, five event-appropriate jobs skipped, and
      none failed. No workflow deployed or queried Cloudflare.
- [x] Reconcile protected `main` after the merge. PR `#119` merged normally as
      `d71f17cad8642c09c8f64460ce3c8ef1cba55555`; main CI `29714019076`, release provenance
      `29714019090`, and CodeQL `29714018857` passed that exact commit, including the hosted
      Chromium/WebKit mobile matrix and dependency submission. Dependabot, code-scanning, and
      secret-scanning alerts are all zero. The provider dashboard, IAM/retention/cost evidence,
      uptime checks, delivered alerts, preview/production reconstruction, and production release
      remain open; this repository receipt does not authorize them.

## Completed seven-step work cycle — SEO language and provider evidence

- [x] Reconcile protected `main` and the existing crawl contract. Starting `main` was
      `6aaad6e4252fa7f873ac0f95196cb61281fd89bb`; the intended public set remains exactly `/`,
      `/privacy`, `/terms`, and `/ai-disclosure`, while `/profile` remains crawlable but
      `noindex, nofollow` and absent from the sitemap. Production is active, drifted, and untouched.
- [x] Recheck current official Google and Bing guidance and freeze the truthful boundary. Titles
      and descriptions are search-result preferences, not guaranteed output; a sitemap or URL
      request does not prove crawling, indexing, ranking, or traffic; and dashboard creation does
      not prove ownership. Candidate phrases are audience-research prompts, not keyword-stuffing
      instructions or performance predictions.
- [x] Create the four-page language sheet and prohibited-claim matrix. Every page has an honest
      purpose, audience questions, candidate phrases, current title/description, desired snippet,
      and useful next action. The strategy rejects catch-probability, outcome/superiority,
      validation/training, freshness/regulation/access/safety, agency-endorsement, search-status,
      and production-parity overclaims while preserving the narrower heuristic relative-ranking
      truth.
- [x] Create the private Google/Bing evidence workflow. It separates dashboard creation,
      ownership, sitemap submission/processing, live URL testing, indexing request, observed
      indexing, and performance; permits only secret-free operational fields; and keeps raw and
      redacted screenshots outside Git. DNS/HTML verification values, account identifiers,
      credentials, recovery codes, billing details, and user/trip data are prohibited.
- [x] Add the fail-closed machine policy and tests. `seo/language-policy.json` binds the exact
      four-page set and metadata, keeps `/profile` excluded, rejects prohibited strategy phrases
      and token-shaped material, and fixes every Google/Bing action to `false`. The goal dashboard
      closes only the language-sheet task; dashboard ownership/verification and all provider,
      deployment, indexing, coverage, performance, and Core Web Vitals work remain open.
- [x] Publish the exact accepted head without a provider or production action. Local Cloudflare
      build plus 400/400 Node tests, ESLint, TypeScript, secrets, the exact npm 10.9.8 integrated
      security/SBOM/provenance chain, and both npm audits with zero vulnerabilities passed.
      Protected PR `#113` at exact head `0b514951effd066d9b4cbef90ac767cac8baded2` passed PR CI
      `29697668825`, release provenance `29697668861`, and CodeQL `29697667897`, including
      dependency review, hosted API and pipeline suites, and 140/140 Chromium/WebKit browser
      cases. Duplicate branch-push CI `29697667318` and release provenance `29697667340` also
      passed on their original attempts.
- [x] Merge only the accepted head and add the immutable protected-`main` receipt. PR `#113`
      merged normally as `f362707f68dd77b243a0b9b8863b8240a0073e2c` without admin bypass,
      squash, rebase, provider mutation, or production change. Its tree
      `e75a7d2d57a2cf909a36df50bf91cdc76c58d3e5` exactly equals the fully green accepted-head
      tree. As of `2026-07-19T18:04:27Z`, GitHub had created zero push check suites for that merge
      commit despite accepting it on protected `main`; this receipt therefore makes no claim of
      exact-merge CI, CodeQL, release, SBOM-attestation, or deployment evidence. The identical
      protected PR tree evidence above remains the acceptance evidence. Open PRs and open
      Dependabot, code-scanning, and secret-scanning alerts were all zero; issue `#86` remains
      open by design. Production remains active, drifted, and untouched. The broader SEO parent
      remains open for reviewed deployment, Google/Bing verification and provider operations,
      observed indexing/coverage, Core Web Vitals, and privacy-reviewed measurement.

      Follow-up PR `#115` added the machine-bound public all-zero validation status and passed
      exact-head CI `29699233614`, release provenance `29699233623`, and CodeQL
      `29699534489` at `9c6d491824aeed04feba6c768a272e2325579b9c`. It merged as
      `7f84cd19ec0e8742d55d6483d14c82b7f42a567d`; the merge tree
      `6f5e12b859d64a8b5607347ad4818ebc7979466e` exactly equals the accepted-head tree.
      Main CI `29701986309`, release provenance `29701986318`, and CodeQL `29701986114`
      passed that exact merge, including 140/140 browser cases, hosted API and pipeline suites,
      dependency submission, release/SBOM attestations, and all three CodeQL languages.
      Production and provider configuration remain untouched; this is code and evidence receipt,
      not deployment or validation evidence.

## Completed seven-step work cycle — production change authorization

- [x] Reconcile exact protected `main` and inventory every production mutation entry point.
      Starting `main` is `41e83dff77b8bcca9e42a4ef2f4cdf9e7b58f1d8`; the active, drifted Worker
      and all provider resources remain untouched.
- [x] Freeze the authorization boundary. Each Worker deploy, `0007` reconciliation, and exact
      `0009`–`0018` migration requires its own canonical private packet outside every checkout,
      full reviewed release and gate commits, a window no longer than six hours, distinct operator
      and independent-reviewer evidence, and the action-specific phase evidence fixed by locked
      policy. The two commits must match except for the pinned historical safety-floor target.
- [x] Implement the fail-closed verifier. It rejects fork origins, abbreviated or unreviewed
      commits, dirty trees, local overrides, missing/expired/future/wrong-action packets, broad
      permissions, symlinks, duplicate-key JSON, missing or reused evidence hashes, and unsafe
      public receipt fields.
- [x] Route every mutable path through the gate before Wrangler. The no-shell Worker wrapper
      authorizes first, verifies exact npm 10.9.8 and Wrangler 4.112.0, performs a fresh
      zero-script install and Cloudflare build, and supports the pinned historical safety worktree
      without asking that old commit to contain the new gate. The staged D1 wrapper maps every
      mutation to one exact authorization action; both paths reauthorize immediately before the
      provider write, while read-only preflight/postflight remain separate.
- [x] Add adversarial authorization, checkout, wrapper-order, environment-sanitization, migration-
      mapping, policy-lock, and redaction tests; update the authoritative release, moderation,
      deployment, and incident-maintenance runbooks. A valid packet remains only an authorization
      boundary, never provider success, deployed-source, live-host, migration, or release evidence.
- [x] Complete the full clean repository verification and publish the exact head through a
      protected draft PR without running a production command.
      Local verification is green on exact Node 22.23.1/npm 10.9.8, including a fresh
      `npm ci --ignore-scripts`, Cloudflare build, 395/395 Node tests, 48/48 focused authorization
      and release tests, 140/140 Chromium/WebKit mobile tests, lint, TypeScript, full security
      policy/SBOM/provenance checks, and two zero-vulnerability npm audits. Python evidence is
      29/29 API tests on local 3.13.12 plus 18 migrations, 14 critical query plans, and every
      foreign-key child path indexed; Ruff; 81/81 pipeline tests on exact 3.12.13 with one
      documented optional-raster skip; and deterministic smoke. Hosted API CI remains the exact
      Python 3.13.14 authority. Protected draft PR `#111` at exact head
      `ec543d9be52d4b18fb88f588683df0547f53e9c2` passed PR CI `29695839861`, release
      provenance `29695839860`, and CodeQL `29695839366`, including 140/140 browser cases.
      Duplicate branch-push release provenance `29695817251` also passed. Branch-push CI
      `29695817225` initially passed 139/140 browser cases after one WebKit recovery-state flake;
      the unchanged head passed the complete PR browser matrix, the isolated case 10/10 locally,
      and branch-push attempt 2. No source weakening, production command, deployment, D1
      mutation, or Cloudflare change was used.
- [x] Merge only the accepted exact head and add the immutable protected-`main` receipt. PR
      `#111` merged as `3b44c5bc57d30a64c6576be99ebdb85182052013`. Main release provenance
      `29696345556` and CodeQL `29696345381` passed on their original attempts, including the
      deterministic release bundle plus release and CycloneDX SBOM attestations. Main CI
      `29696345544` attempt 1 passed 139/140 browser cases after hosted WebKit returned `NaN` for
      one computed `paddingTop` read rather than reporting a failed layout boundary; the exact
      case then passed 30/30 in a local WebKit stress repeat, and unchanged-main attempt 2 passed
      140/140 browser cases plus API, pipeline, dependency submission, security, lint,
      TypeScript, and unit gates. Open PRs and Dependabot, code-scanning, and secret-scanning
      alerts are all zero; issue `#86` remains open by design. Production remains active,
      drifted, and untouched. The broader P0 provider gate stays open for separately authorized
      migrations, bindings and feature flags, maintenance mode, source binding, live-host
      verification, and guarded release acceptance.

## Completed seven-step work cycle — Cloudflare provider-state hold

- [x] Reconcile exact protected `main` and the provider state without mutation. Starting `main`
      is `c9bc1d839bbd8783fc77afba9af6f0f5054d8a45`; read-only Wrangler and dashboard evidence found
      one active version at all traffic, five domains, one cron trigger, maintenance mode off,
      and recent invocations.
- [x] Freeze the no-mutation, redaction, and hold contract. A disconnected Git build integration
      is not a paused Worker; public evidence cannot contain provider, account, author, database,
      namespace, etag, secret, or token identifiers; source binding and live-host verification
      remain private external gates.
- [x] Add the locked offline policy verifier and the separately confirmed live analyzer. It can
      execute only the exact deployment-status and active-version read commands, uses no shell,
      bounds and validates JSON, and cannot deploy, change traffic/routes/domains/secrets, or
      mutate D1.
- [x] Add adversarial coverage for weakened policy, missing confirmation, command widening,
      malformed and oversized output, split traffic, ambiguous identities, duplicate bindings,
      current drift, and receipt redaction. CI and release provenance run only the offline gate.
- [x] Complete local verification and capture the current fail-closed redacted audit receipt.
      At `2026-07-19T15:26:01.050Z` the read-only audit confirmed single-version traffic and
      compatibility parity, then correctly refused the hold/release claim because maintenance is
      off, two variables and six rate-limit bindings are missing, live-host proof is absent, and
      the reviewed commit is unbound. No private provider identifier or mutation entered the
      receipt. Evidence: exact Node 22.23.1/npm 10.9.8 Cloudflare build and 382/382 Node tests;
      140/140 Chromium/WebKit mobile, offline, recovery, 404, and safe-area cases; ESLint;
      TypeScript; the integrated security/SBOM gate and both npm audits with zero vulnerabilities;
      29/29 API tests on the locally available Python 3.13.12 compatible runtime; 18 migrations,
      14 critical query plans, and every foreign-key child path indexed; Ruff; 81/81 pipeline
      tests with one documented optional-raster skip; and deterministic smoke. Exact Python
      3.13.14 execution remains a hosted-CI gate because that local Homebrew interpreter is
      damaged, not because of a repository failure.
- [x] Publish protected draft PR `#108` from exact clean implementation head
      `32583bd7c21431d5ea772850e35d55d60eb595b4`. PR CI `29692895468`, release provenance
      `29692895484`, and CodeQL `29692894421` passed on their original attempts, including exact
      hosted Python 3.13.14, the new offline policy gate, the release bundle, and 140/140 browser
      cases. Duplicate branch-push CI `29692868584` and release provenance `29692868625` also
      passed, including a second 140/140 browser matrix. No retry, policy weakening, deployment,
      provider mutation, or Cloudflare change was used.
- [x] Merge only the accepted head and reconcile protected `main`. Final acceptance head
      `357571d2d638d733efea06a5addc2c1e6767180b` passed PR CI `29693134885`, release
      provenance `29693134884`, and CodeQL `29693133711` on their original attempts; duplicate
      branch-push CI `29693133460` and release provenance `29693133434` also passed without a
      retry. PR `#108` merged as `2ae4857a498afa525ecbcaf5bfa2fa53c199a647`; main CI
      `29693385952`, release provenance `29693385934`, and CodeQL `29693385780` passed that exact
      commit on their original attempts, including the 140-case browser matrix, hosted Python
      3.13.14 API and pipeline suites, dependency submission, release-bundle provenance, and
      release/SBOM attestations. Open PRs and Dependabot, code-scanning, and secret-scanning
      alerts are all zero; issue `#86` remains open by design. Production remains active,
      drifted, and untouched. The broader P0 provider deployment gate stays open for ordered
      migrations, bindings and feature flags, maintenance mode, source binding, live-host
      verification, and guarded release acceptance.

## Completed seven-step work cycle — deterministic mobile map readiness

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
- [x] Publish protected PR `#106` from exact clean head
      `76e08f78fe891d3815a0762e0e152a53cf8fb099` after the complete local evidence above passed.
      Exact-head CI `29690657750`, release provenance `29690657737`, and CodeQL `29690656673`
      passed; the PR and duplicate branch-push web jobs both passed the full browser matrix on
      their original attempts. No retry, longer timeout, global retry, weakened assertion,
      deployment, provider mutation, or Cloudflare change was used.
- [x] Merge only the accepted exact head and reconcile protected `main`. PR `#106` merged as
      `172a13b52c2600c4c7d70e6cf18e86f61d6766c9`; main CI `29690916163`, release provenance
      `29690916184`, and CodeQL `29690916170` passed that exact commit on their original
      attempts, including the 140-case browser matrix, API and pipeline suites, dependency
      submission, release-bundle provenance, and release/SBOM attestations. Open PRs and
      Dependabot, code-scanning, and secret-scanning alerts are all zero; issue `#86` remains
      open by design. Cloudflare and production remain paused. The broader mobile parent stays
      open for native PKCE/token work, isolated staging, provider bindings, physical-device
      acceptance, deployment, and production-scale evidence.

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
      logging schema/runbook and fail-closed offline request/Queue/scheduled reconstruction drill
      plus the source-bound activation-evidence verifier are complete;** the incident receipt
      omits actor pseudonyms and raw payloads, while the public-safe activation receipt exposes
      only its independently expected reviewed commit and aggregate gate results—never evidence
      hashes, saved-view names, provider identifiers, or raw payloads. The activation verifier
      refuses a missing or mismatched expected commit and requires structured-only logs, access
      review, retention/cost ownership, delivered/acknowledged/closed/redaction-tested alerts, uptime,
      preview/production reconstruction, and pseudonym-key separation within 72 hours; it neither
      queries a provider nor authorizes production. A guarded owner-only writer and hardened
      no-follow reader now prepare the complete unfilled private manifest without overwrite or
      path disclosure. Preview/production evidence, provider
      dashboard, access, retention, cost, uptime, and delivered-alert evidence remain. PostHog
      remains deferred pending privacy review.
- [ ] Make data and execution paths measurably scalable: query plans/indexes, bounded access,
      cache matrix, justified asynchronous work, D1-managed connections, optional API pooling,
      and isolated load/soak/spike/failure tests. **A complete static inventory now covers all 254
      Worker prepare sites, and exact 100-item saved-location/gear-preset account ceilings now
      fail closed on overflow without truncating rights exports, while local query/index/cache/
      connection contracts, production-refusing harness, the default-off advisory Queue adapter,
      and a default-off complete privacy-export adapter with an opaque message, owner-bound D1
      lease ledger, private 24-hour object, progress UI, bounded expiry/retries, and account-delete
      race adoption are complete;** migrations, provider Queue/DLQ/R2 bindings, IAM/alerts,
      export activation, staging measurements,
      bounded-retention and migration cost evidence, failure injection,
      rollback evidence, and authorized penetration testing remain.
      Local acceptance for the default-off export adapter passed the Cloudflare build and
      456/456 Node tests, 140/140 Chromium/WebKit mobile cases, ESLint, TypeScript, the complete
      security/SBOM/query-inventory chain and both zero-vulnerability npm audits, 29/29 API tests,
      the 19-plan D1/index contract, Ruff, 81/81 pipeline tests with one documented optional-
      raster skip, and deterministic pipeline smoke. This is repository evidence only; no
      migration, Queue, R2, variable, deployment, or production request was made.
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
      **Public all-zero status locally complete:** the machine-bound disclosure states that no
      prospective study is activated, eligible prospective/confirmatory attempts, encounters,
      non-encounters, preregistered baseline comparisons, and probability-calibration runs are
      all zero, and the non-promoted terrain-probe result is explicitly not live-score evidence.
      Guarded deployment remains open, and actual performance validation cannot begin until a
      separately preregistered confirmatory study has eligible locked evidence.
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

- [ ] Add pollution and water-quality conditions to a separately versioned score component only
      after its meaning, official/licensed sources, spatial and temporal support, freshness,
      uncertainty, missing-data behavior, and validation gates are frozen. Agency advisories stay
      authoritative; the product must not turn a fishing score into a water-contact or seafood-
      consumption safety claim. **First local advisory slice complete:** the versioned SFPUC
      policy maps six exact San Francisco sites, binds its policy/collector/catalog hashes,
      fails stale, incomplete, unmonitored, unavailable, and unmapped status to unknown, gives
      no score credit for a no-posting result, and suppresses recommendations under an active
      official status without rewriting the attested fishing score. Broader Bay Area and
      remaining launch-catalog source coverage, rainfall semantics, numeric-contribution
      validation, independent review, deployment, and post-deployment freshness evidence remain
      open.
      **Second local advisory slice implemented:** the fixed California State Water Resources
      Control Board BeachWatch action table covers all 14 South Coast sites for explicit
      countywide actions and 11 through direct station mappings. Only active closures, postings,
      or rain actions suppress; absence stays unknown, every `scoreDelta` remains null, and the
      live adapter check is time-bound repository evidence. Independent mapping/source-latency
      review, remaining launch-catalog coverage, full local/hosted acceptance, guarded deployment,
      and every numeric-score gate remain open.
      **San Francisco gap audit locally complete:** a fixed-endpoint receipt records the four
      nearest official station candidates for each still-unmapped waterfront site but deliberately
      creates no mappings. Candidate distances range from 792 m to 2,520 m and station identities
      differ, so all four sites stay `not-covered`, unknown, and null-score pending separately
      documented spatial authority and independent review.
      **Third local advisory slice implemented:** a strict San Mateo County Health action-only
      adapter provisionally maps 11 catalog sites to 17 stable official station IDs. Exact current
      listings suppress; absence stays unknown; Poplar and Seal Point remain uncovered after the
      fixed registry shows no exact identity for either; historical registry coordinates are
      identity/spatial support only; independent mapping review is still required; and every
      numeric `scoreDelta` remains null. Full local/hosted acceptance, guarded
      deployment, post-deployment freshness, and every numeric-score gate remain open.
      **Fourth local advisory slice implemented:** a fixed Marin BeachWatch action request maps
      six catalog sites only through exact official station identities and leaves four ambiguous
      or missing identities uncovered. A current open-ended Bolinas posting suppresses Bolinas;
      absence remains unknown, all numeric `scoreDelta` values stay null, and the registry audit
      cannot infer mappings or establish current status. Full local/hosted acceptance, independent
      mapping review, guarded deployment, and every numeric-score gate remain open.
      **Fifth local advisory slice implemented:** a fixed East Bay Parks District BeachWatch
      action request maps Keller and Crown Memorial only through exact official station
      identities and preserves 11 negative mapping results. Current open-ended Keller North and
      Crown Crab Cove postings suppress both catalog sites; the registry exposes no explicit
      districtwide action identity, absence remains unknown, and every numeric `scoreDelta` stays
      null. Full local/hosted acceptance, independent mapping review, guarded deployment, and
      every numeric-score gate remain open.
      **Launch-catalog negative-evidence inventory locally complete:** 39 of 61 catalog sites have
      provisional official-source mappings; all 22 not-covered sites now bind to an explicit
      hash-checked review receipt. The final Dumbarton review found no Alameda County program or
      Dumbarton station identity in the relevant State directory scope, so it remains unknown and
      null-score. This inventory does not expand current-status coverage or close independent,
      deployment, freshness, or numeric-validation gates.
- [ ] Enrich the map one available location at a time with reviewed notable structure and useful
      depth levels. Every feature needs reproducible official/licensed source provenance, units,
      vertical datum, resolution, retrieval date, checksum, uncertainty, allowed use, sensitive-
      habitat review, and per-location visual/data acceptance; unmapped locations remain clearly
      incomplete instead of receiving invented detail.
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

## Product-owner work that is safe while production changes remain on hold

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
- [x] Prepare an SEO language sheet: all four public pages now have machine-checked audience
      questions, honest purpose, candidate phrases, current titles/descriptions, desired snippets,
      useful next actions, and prohibited-claim groups in `seo/language-policy.json`, with the
      owner workflow in `docs/SEO_LANGUAGE_AND_EVIDENCE.md`. Provider actions remain fail closed;
      no DNS, dashboard, submission, inspection, indexing, or production change was made.
- [ ] Record current Google/Bing dashboard ownership and verification status with screenshots
      that contain no secrets. Leave sitemap submission and live URL inspection for deployment.
- [x] Build the official-data source register for CDFW/CRFS/RecFIN: dataset name, official URL,
      owner, retrieval method, license/terms, dictionary, update cadence, and intended use. Do
      not ingest private/social data. The register and exact ds3185/ds3186 receipts are in
      `docs/OFFICIAL-FISHERIES-DATA.md` and `pipeline/sources/receipts/`; neither aggregate is
      approved for training, validation, scoring, or point labels.
- [x] Draft five short user-interview scripts focused on whether people understand the
      heuristic ranking, freshness labels, limitations, and trip-report privacy. The fictional,
      machine-checked scripts in `docs/USER-INTERVIEWS.md` require no account or real trip,
      prohibit recordings and participant-level notes, and permit only aggregate non-identifying
      comprehension tallies. Execution remains unauthorized, and the work is explicitly not
      model-validation, catch-outcome, safety, access, legality, freshness, or accuracy evidence.
      Local acceptance passed the Cloudflare build and 406/406 Node tests, 140/140 Chromium/WebKit
      browser cases, ESLint, TypeScript, the locked security/SBOM/provenance chain and both zero-
      vulnerability npm audits, 29/29 API tests plus the D1 query/index contract, Ruff, 81/81
      pipeline tests with one documented optional-raster skip, and deterministic smoke.
- [ ] Track operating costs and receipts by provider in a simple accounting ledger. Keep this
      separate from application logs and analytics; a financial dashboard comes later.
      **Local workbook control complete:** the blank six-sheet XLSX template and machine-checked
      boundary reserve 200 formula-driven ledger rows, controlled provider/category/status fields,
      opaque private receipt references, monthly reconciliation checks, and explicit repository
      exclusions for filled ledgers and financial documents. The item stays open until the owner
      copies the template outside Git, records every current provider cost or explicit zero-cost
      confirmation, associates privately stored receipts, and completes the first reconciliation.
      No actual financial record, dashboard integration, billing action, provider mutation, or
      production change is included. Local acceptance passed formula inspection with zero errors,
      visual QA of all six sheets, the hash-bound workbook check, the Cloudflare build and 410/410
      Node tests, 140/140 Chromium/WebKit browser cases, ESLint, TypeScript, the locked
      security/SBOM/provenance chain and both zero-vulnerability npm audits, 29/29 API tests plus
      the D1 query/index contract, Ruff, 81/81 pipeline tests with one documented optional-raster
      skip, and deterministic smoke.

## Do not do yet

- Do not reconnect Git deployments, change production DNS, deploy, change Worker traffic,
      routes, domains, triggers, or variables, migrate D1, provision production secrets, enable
      Turnstile, or submit the sitemap until the guarded release checklist reaches those steps.
- Do not enable photos, public discussions, AI auto-publication, the validation pilot, or
      PostHog/session replay.
- Do not run load, stress, vulnerability scanning, or penetration testing against
      `castingcompass.com` or any production data. Use only an explicitly authorized isolated
      staging target later.
- Do not paste passwords, tokens, cookies, key material, recovery codes, private exports,
      user data, or unredacted provider screenshots into Codex, GitHub, logs, or PRs.
