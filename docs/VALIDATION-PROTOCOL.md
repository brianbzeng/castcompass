# CastingCompass California-halibut validation protocol

**Protocol:** `california-halibut-site-window-v1`

**Machine contract:** `castingcompass.validation-preregistration/1.0.0`

**Status:** frozen locally on 2026-07-16, based on commit
`13e71bb312bd0c1ac008246240cf7f884d21ac01`

**Production status:** not activated

**Successor decision (2026-07-17):** do not activate v1. The locally frozen
`california-halibut-collection-feasibility-v2` protocol supersedes it for any
future activation. V2 is an operational collection pilot, makes no model-
performance claim, and requires a later, separately preregistered confirmatory
study. See `docs/VALIDATION-SUCCESSOR.md`.

The machine-readable preregistration is
`validation/protocols/california-halibut-site-window-v1.json`. Its byte hash is
anchored by the later Git commit that contains it; the file does not contain a
self-referential digest. A frozen design is not evidence that its production
collection, legal, privacy, or storage controls are live.

## Question and claim boundary

The confirmatory question is narrow: within eligible complete California-
halibut-targeted efforts, does one fixed CastingCompass 0–100 score rank
curated public sites and authoritative two-hour windows better than the
strongest preregistered development baseline?

The outcome is a **self-reported California-halibut target encounter**. The
unit is one complete, unexpanded whole-trip group attempt at one curated site,
entirely inside one authoritative two-hour window; rows are never expanded per
angler or per segment. Promotion-bearing primary evidence is restricted to
`angler_count = 1`. Multi-angler whole-trip attempts may appear only in the
descriptive observational-secondary cohort. A skunk is a valid and necessary
outcome.

The protocol can support only an ordinal site × window ranking claim for the
frozen population. It cannot establish biological presence or absence, exact
casting-zone or point skill, catch probability or calibration, a causal benefit
from using the score, safety, navigation, access, regulations, or another
species' performance. Target-positive rows remain self-reported; a photo or
other outcome-dependent verification step is not an eligibility gate.

The candidate is one fixed `heuristic-configuration` scoring identity and its
ordinal 0–100 score. Its exact version and SHA-256 must be sealed in the
production activation manifest and repeated by every authoritative pre-outcome
impression or assignment. The locked test cannot train or tune that candidate.

## Activation and enrollment

The planned enrollment interval is the half-open UTC range
`[2026-08-01T00:00:00Z, 2027-08-01T00:00:00Z)`. The start is inclusive and
the end is exclusive, including for timestamps with fractional seconds. The
stop is the fixed interval end and is independent of outcomes; there is no
early success or capacity stop. The analysis set is a census of every eligible
accepted row in that interval. The operational planning target cannot close
enrollment, cap the analysis, authorize post-hoc subsampling, or exclude rows by
arrival order.

No row is eligible until a private activation manifest conforming to
`castingcompass.validation-split-manifest/1.0.0` is sealed and deployed. It
must bind the containing protocol hash, site-catalog hash, immutable release,
one scoring-system version/hash, and opportunity contract before the first
eligible row. If that does not happen before collection begins, this protocol
must be superseded. It cannot be activated retroactively.

Activation and every later seal use the trusted service clock; callers cannot
supply `created_at`, `activated_at`, or label-open times. The activation pins
both the exporter Ed25519 identity and a different external-log anchor provider,
key ID, and public key. Equal exporter/anchor IDs or key bytes are rejected. A
locally generated signature or a signature made after the outcome is not proof
of prospective issuance. The external proof verifier is not implemented, so
production activation and publication remain blocked.

All pre-freeze, pre-activation, past-report, `legacy_unverified`, official
aggregate/context, and non-issued deviation rows remain exploratory only. A
deviation after prospective issuance remains an issued-but-unsealed terminal
reconciliation record; it is never recast as an exploratory row.

## Cohorts and selection

Primary evidence must be prospective and use one of two designs:

- a site/window plan committed before the participant sees the score; or
- a safely randomized assignment among options the participant has already
declared feasible.

The randomization branch is fully frozen: before any score is exposed, the
participant declares at least two feasible site/window options; the server
canonicalizes and hashes that set, then chooses one option uniformly with
unbiased rejection sampling from a server CSPRNG. Exactly one durable draw is
allowed. The manifest records feasible-set hash/count, the assigned probability
`1 / count`, zero-based draw index, and a private audit-record hash. A redraw is
not allowed. Safe refusal or cancellation is retained as an issued-but-unsealed
`safe-canceled` terminal disposition and is never encoded as a non-encounter.
Any different allocation or audit mechanism requires a new protocol version
and activation, not an activation-time choice.

The server must issue a full signed impression/assignment envelope before the
outcome is known. The exact contract is
`castingcompass.validation-impression-attestation/1.0.0`. Its five envelope
fields are `schema_version`, `signing_key_id`, `payload_base64`,
`payload_sha256`, and `signature_ed25519`. The decoded payload must be canonical
UTF-8 JSON under `castingcompass-canonical-json/1.0.0`: object keys are sorted
lexicographically by Unicode code point, comma/colon separators are compact,
non-ASCII text is unescaped, duplicate keys are rejected, and floating-point
or non-finite numbers are rejected. Base64 must be canonical. The SHA-256 is
over the decoded canonical payload bytes, and the Ed25519 signature must verify
against the key pinned in the root activation.

The exact signed payload fields are:

`protocol_id`, `protocol_version`, `activation_manifest_sha256`,
`assignment_id`, `source_record_sha256`, `participant_group_id`,
`activation_activated_at`, `intended_cohort_role`, `intended_source_role`,
`selection_design`, `selection_method`, `intended_cohort_id`, `target_taxon_id`,
`recruitment_frame_id`, `recruitment_source_id`,
`recruitment_event_contract_version`, `recruitment_event_at`,
`recruitment_event_sha256`, `community_approval_sha256`,
`incentive_policy_id`, `score_influenced_choice_at_assignment`,
`study_consent_version`, `study_consent_at`, `target_intent_confirmed_at`,
`precommitment_event_sha256`, `feasible_set_sha256`,
`feasible_option_count`, `assignment_probability_numerator`,
`assignment_probability_denominator`, `randomization_draw_index`,
`randomization_audit_sha256`, `forecast_impression_id`,
`opportunity_window_id`, `site_id`, `window_start_at`, `window_end_at`,
`opportunity_score`, `snapshot_sha256`, `site_catalog_sha256`,
`scoring_system_kind`, `scoring_system_version`, `scoring_system_sha256`,
`opportunity_contract_version`, `impression_or_assignment_at`,
`score_exposure_state_at_attestation`,
`score_first_exposed_at_if_already_exposed`, and `attested_at`.

The evaluator reconstructs that payload from the exact row and requires full
equality, canonical envelope hashing, `attested_at ==
impression_or_assignment_at < segment_start_at`, and a valid signature before
prospective admission. An arbitrary digest plus regenerated unsigned ledger or
prediction files is rejected. Python and Worker share the frozen vector at
`contracts/fixtures/impression-attestation-vector.json` (file SHA-256
`8ef6ec7b001d0a9a84d554b6327f711274e0af992081f342aa6b8392894c173c`).
Safety always wins: assignment does not require fishing or remaining on the
water, and safe cancellation is not treated as a catch failure.

Score exposure is a separate two-phase event. A primary assignment envelope
must say the score has not yet been exposed. If the interface later displays
the score, the signer creates a second envelope linked to the assignment
attestation at the actual first-exposure time. A label-free prospective row may
include that exposure only when both exposure and attestation are strictly
before effort starts. Exposure at effort start, during effort, at completion,
or afterward is preserved only in terminal reconciliation; it is never
backfilled into a sealed prospective row. A secondary assignment instead binds
the already-observed prior exposure in its assignment envelope and does not
invent a signed-primary exposure-stream event.

The prospective primary cohort spans all four blocks. Its blocks 1–2 rows are
development-only and may select the baseline; only blocks 3–4 rows enter the
locked confirmatory comparison.

Organic trips selected while the score is visible are secondary observational
evidence regardless of how the participant answers `scoreInfluencedChoice`.
That answer is still preserved, but it cannot make a score-visible trip
independent. Past reports cannot enter the primary gate.

Version 1 offers no incentive. Any later incentive must be offered before the
outcome, be independent of catch and score, preserve safe cancellation, and be
introduced through a versioned amendment and new activation evidence.

### Frozen recruitment frame

The exact v1 frame is `california-halibut-site-window-recruitment-v1`. It allows
only these immutable pre-outcome source IDs:

- `castingcompass-organic-product`;
- `direct-opt-in-research-invite`; and
- `admin-approved-community-prospective`.

The first eligible pre-outcome recruitment event wins and cannot be relabeled.
Its SHA-256 over the frozen `castingcompass-canonical-json/1.0.0` encoding binds
the privacy-safe participant group, recruitment frame, source ID, event time,
and community-approval hash.
Community recruitment requires the SHA-256 of its prior admin approval; the
approval field must be null for the other two sources. Every eligible accepted
row is included consecutively through the fixed interval, and outcome-adaptive
source or selection-design quotas are prohibited.

The preregistered primary analysis remains pooled across all allowed recruitment
sources and both primary selection designs. Reports must also show support and
results by recruitment source, by selection design, and by their cross-tab so a
changing source/design mix cannot be hidden.

## Eligibility

An accepted row must satisfy every condition below:

- valid `castingcompass.observation/2.0.0` complete attempt, not an expanded
  estimate;
- California halibut declared as the target for the whole effort segment;
- mode exactly `shore`, `beach`, `pier`, or `jetty`;
- one curated site from the frozen 46-site map;
- the entire effort segment falls inside exactly one authoritative 120-minute
  opportunity window;
- server-bound window, opportunity-contract, scoring kind/version/hash,
  snapshot hash, and site-catalog hash;
- the canonical activation-key-signed full pre-outcome envelope above, whose
  score, recruitment, consent/intent, selection audit, cohort, and activation
  identities exactly match the exported row and prediction ledger;
- selection design, target-intent time, `scoreInfluencedChoice`, study-consent
  version/time, and impression/assignment time captured immutably before the
  outcome;
- for score-blind precommitment, a durable server-event hash that binds the
  chosen site/window plan and whose `impression_or_assignment_at` precedes any
  recorded score exposure; for randomization, the frozen feasible-set,
  probability, draw-index, and audit hashes described above;
- no exact coordinates and no required photo; and
- no unresolved deletion, withdrawal, attribution-changing edit, duplicate,
  or other protocol deviation.

Before sealing, an edit fails closed: it must be revalidated without changing
the signed pre-outcome evidence, or the issued assignment remains unsealed with
an exhaustive terminal disposition. It cannot be laundered into an unsigned
context row. Conversely, genuine context rows may not carry prospective
assignment, completion-identity, or completion-consent fields. After sealing, a
post-completion profile edit or trusted review exclusion is appended to the
signed post-seal ledger; the sealed row is not mutated or relabeled exploratory.
Exclusion, withdrawal, and deletion remove a sealed row from future runs. They
do not silently rewrite an already published aggregate result.

## Frozen geography

The frozen input is `public/data/sites.json` with SHA-256
`b0378742f40cca598c57d845fb683ab9b36068cdd69de541aeb3e45d93c31860`.
`pacifica-municipal-pier` is excluded because it has no emitted opportunity
windows. Each of the remaining 46 sites appears exactly once:

- **north-coast:** `limantour-beach`, `drakes-beach`,
  `point-reyes-south-beach`, `bolinas-beach`, `stinson-beach`, `muir-beach`,
  `rodeo-beach`.
- **golden-gate-sf-coast:** `fort-baker-pier`, `torpedo-wharf`,
  `crissy-field-east-beach`, `baker-beach`, `china-beach`,
  `ocean-beach-north`, `ocean-beach-south`.
- **north-east-bay:** `mcnears-beach-pier`, `paradise-beach-pier`,
  `ferry-point-pier`, `keller-beach`, `point-isabel-shoreline`, `albany-bulb`,
  `berkeley-marina-north-basin`, `cesar-chavez-park`,
  `emeryville-marina-pier`.
- **central-south-bay:** `pier-7`, `pier-14`, `crane-cove-park`,
  `herons-head-park-pier`, `port-view-park-pier`,
  `middle-harbor-shoreline`, `alameda-south-shore-rockwall`,
  `crown-memorial-state-beach`, `oyster-bay-shoreline`,
  `san-leandro-marina-shore`, `dumbarton-pier`, `coyote-point-jetty`,
  `seal-point-park`, `oyster-point-fishing-pier`.
- **san-mateo-coast:** `sharp-park-beach`, `rockaway-beach`,
  `pacifica-state-beach`, `montara-state-beach`, `pillar-point-west-jetty`,
  `pillar-point-east-jetty`, `surfers-beach`, `francis-state-beach`,
  `poplar-beach`.

These are evaluation panels, not ecological management areas and not exact
catch locations.

## Frozen time blocks and holdout

All intervals are half-open UTC ranges: start inclusive, end exclusive.

| Block | UTC interval | Role |
| --- | --- | --- |
| 1 | `[2026-08-01, 2026-11-01)` | baseline development |
| 2 | `[2026-11-01, 2027-02-01)` | baseline development |
| 3 | `[2027-02-01, 2027-05-01)` | locked primary test |
| 4 | `[2027-05-01, 2027-08-01)` | locked primary test |

For each geographic panel, the selected baseline is fitted only on the other
four panels in blocks 1–2. Candidate and baseline predictions are then pooled
for that held panel in blocks 3–4. The primary test is therefore later in time
and geographically unseen. Participant-group identity is privacy-safe and is
used for dependence-aware analysis; raw account or reporter identifiers are
not evaluation fields.

## Frozen baselines

Baseline choice uses development outcomes only. Mean leave-one-panel-out AUROC
in blocks 1–2 selects the strongest of:

1. **Prevalence only:** Beta(1,1)-smoothed training-fold prevalence.
2. **Calendar + mode + effort logistic:** L2 logistic regression using UTC
   day-of-year sine/cosine, UTC window-start-hour sine/cosine, one-hot mode,
   and `log1p(angler-hours)`.
3. **Site + calendar + mode + effort logistic:** the same model plus one-hot
   site ID.

The logistic models use training-only numeric standardization, categorical
one-hot encoding with unknown values ignored, and a UTC day-of-year cycle of
365.2425 days. Numeric standardization uses the training-fold population
standard deviation (`ddof=0`). Scikit-learn `LogisticRegression` is frozen at
`penalty="l2"`, `C=1`, `solver="liblinear"`, `class_weight=None`,
`fit_intercept=True`, `intercept_scaling=1`, `tol=0.0001`, `max_iter=2000`, and
random state `20260716`. A one-class training fold falls back to the smoothed
prevalence. Exact ties use the listed simpler-to-more-complex order. No locked-
test outcome can affect baseline selection.

## Metrics, uncertainty, and decision

The primary metric is AUROC/concordance. The single confirmatory comparison is
candidate AUROC minus the strongest development baseline.

Uncertainty uses 2,000 paired percentile-bootstrap resamples with random state
`20260716`, NumPy `PCG64`, and linear percentiles. Privacy-safe participant
groups are the global clusters: every row for a participant stays together
across all panels and temporal blocks, with no panel/block stratification. The
same global resample is used for candidate and baseline. One-class replicates
are discarded and redrawn, with a 20,000-draw ceiling; failure to obtain the
required valid replicates is inconclusive.

Secondary outputs are average precision, effort-normalized rank summaries,
score-stratum target-encounter rates, and support by geography, temporal block,
mode, recruitment source, selection design, and their cross-tab. Source/design
results are descriptive only and are null when unestimable; they cannot promote
the candidate. There are no secondary hypothesis tests and therefore no Holm
adjustment. Brier score, log loss, expected calibration error, and probability-
calibration claims are prohibited for this heuristic percentile.

Promotion requires all of the following:

- candidate AUROC lower 95% bound greater than 0.50;
- paired point improvement at least 0.05;
- paired improvement lower 95% bound greater than zero; and
- no geography has candidate AUROC below 0.45 when AUROC is estimable.

These are conservative design gates, not a statistical-power guarantee.

## Sample and evaluability gates

The operational planning target is 800 accepted primary attempts. It is not a
cap or a stopping rule: every eligible accepted row of every cohort in the
fixed interval enters the census, while attempt-count promotion gates use only
primary rows. There is no post-hoc subsample or arrival-order exclusion.
Evaluation requires all attempt and participant-support gates below:

- at least 500 accepted primary attempts overall;
- in development blocks 1–2, at least 20 attempts, 5 target encounters, and 10
  non-encounters per geography, with all five leave-one-panel-out AUROCs
  estimable;
- at least 200 locked-test attempts, 40 target encounters, and 80
  non-encounters overall; at least 20 attempts, 5 target encounters, and 10
  non-encounters per locked geography; all five locked-geography AUROCs must be
  estimable;
- at least 75 attempts in each locked temporal block;
- overall primary: at least 250 unique participant groups and Kish effective
  group count at least 200;
- development and locked primary separately: at least 100 unique and 75 Kish-
  effective groups; each target-encounter class needs at least 20 unique and 15
  effective groups, and each non-encounter class needs at least 40 unique and
  30 effective groups;
- each development and locked geography: at least 15 unique and 12 effective
  groups; its target class needs at least 5 unique/effective groups and its
  non-encounter class at least 10 unique/effective groups; and
- each development and locked temporal block: at least 50 unique and 40
  effective groups.

Kish support is checked exactly as `(sum attempts)^2 / sum(participant
attempts^2)` using integer cross-multiplication. No one participant may supply
more than 10% of attempts in the overall, phase, phase-outcome, phase-geography,
or phase-block cells where the concentration gate applies. Every accepted row
is retained; a concentration failure is inconclusive, never permission to drop
clusters.

Any unmet gate produces an **inconclusive** result, not a relaxed analysis.
All-zero or one-class locked outcomes are also inconclusive.

## Private manifests and label access

The split/activation manifest is private, outcome-blind, and an append-only
hash chain. It binds protocol, site-catalog, data-snapshot, prediction-snapshot,
the canonical full label-free row hash, the exact candidate-prediction hash,
and the ordinal score for every assignment. Every cumulative batch must
preserve each prior assignment object exactly; neither a score nor any signed
row field may be rewritten while changing the cumulative snapshot hashes.
Assignments are never regenerated after label access.

After the half-open interval, a signed terminal census freezes every accepted
row at one consecutive `export_ordinal` and binds each accepted completion
event, plus a gapless reconciliation of every issued assignment, every signed
primary first-exposure event, and every terminal disposition. Each disposition record uses
`reconciliation_watermark_at` only as the exact millisecond-aligned snapshot
watermark, equal to the census `reconciled_through_at`; it is not presented as
the time the disposition occurred. Assignment, exposure, completion, and
disposition event identities remain separate. Missing issued assignments and
unmatched exposure events must both be exactly zero.

The local terminal export is a signed exporter assertion and contains no raw
append-only-log proof. Production evidence would additionally need the actual
inclusion and consistency proof arrays, checkpoint roots and sizes, independently
anchored receipts, and exact server-authoritative effort-boundary events. Every
assignment and signed exposure must be anchored within 300 seconds. An exposure
admitted into a sealed label-free row must also be anchored before effort
starts; terminal-only during- or post-effort exposures retain only the
300-second deadline. Consistency must be gapless through a terminal checkpoint
that covers every issuance and exposure through `reconciled_through_at`, is
anchored at or after that watermark, and is anchored no more than 300 seconds
later. Even a zero-event stream requires that independently signed and anchored
zero-size checkpoint with verified genesis consistency; a caller-supplied
digest is not enough.

The census also freezes the final data/prediction snapshot and exact Python
3.12 evaluator identity. A genuinely empty interval closes through the same
signed census and a direct activation → finalization → label-lock chain; it
reports inconclusive and produces no fabricated assignment batch. The label
lock must be the exact next chain link, is sealed with the trusted clock, and
revalidates the evaluator identity before labels are released. The labeled
export is separately signed, binds that exact lock and deletion high-water
mark, and must be generated after the lock. Its active assignment IDs and each
full labeled assignment projection must exactly match finalization.

Only opaque assignment IDs, content-derived source lineage, and privacy-safe
participant groups are allowed. Raw email, account ID, resettable reporter
hash, notes, photos, or coordinates are prohibited. Signed post-seal ledgers
cover exclusion, participant withdrawal, and account deletion and must carry
the complete manifest chain. Their creation and reconciliation timestamps
strictly advance, every predecessor hash and cumulative assignment prefix is
revalidated, and new events must occur after the predecessor watermark.
Lifecycle transitions are monotone: exclusion may advance to withdrawal or
deletion, withdrawal may advance only to deletion, and deletion is terminal.
Reporting retains the immutable first removal and reason for analytical
accounting while also reporting the latest privacy state for current counts;
any row ever excluded remains visible in exclusion diagnostics. All private
directories/files require modes 0700/0600 and encrypted storage.

Every prospective assignment also carries the immutable recruitment frame/source,
pre-outcome event time and event hash, plus the prior community-approval hash
only when that source is `admin-approved-community-prospective`.

## Reporting

If the production authorization gate is ever satisfied, every published result
must include negative and inconclusive outcomes, every geography and temporal
block, recruitment source, selection design, source-by-design cross-tab,
participant-support count, deviation, and limitation. The pooled primary
comparison remains the single preregistered confirmatory analysis. A passing
result must repeat the narrow claim boundary. It does not automatically deploy
or promote a model.

With the current local assertion-only census, the evaluator writes only a
nonpublishable unpublished draft, returns
`withheld-pending-independent-append-only-log-proof`, and creates no publication
request or publication receipt. It cannot authorize publication. Only after an
independent proof verifier exists could a separately operated pinned-runtime
service recompute the analysis, reconcile the latest removal watermark, issue
and consume a single-use server nonce, and publish atomically. A signed receipt
could then be archived locally, but the local archive would remain
`publishable: false`. A same-key signature alone is not proof of independent
execution, log anchoring, or key custody.

## Change control

Never edit a frozen machine artifact in place. Any semantic change to
eligibility, cohort role, enrollment/stopping, geography, time blocks,
baseline/features, metrics/bootstrap, sample or promotion gates, claims,
privacy/location practices, or incentives requires a new version and new
activation evidence. After labels have been accessed, a semantic protocol
change can govern only newly activated prospective evidence. An already sealed
row may be removed only through the signed post-seal ledger; it is never
retroactively relabeled exploratory and cannot repair the confirmatory result.

## Local and production acceptance

Local completion requires strict schema compilation, structural and semantic
tests, exact site/hash/date verification, placeholder rejection, and a clean
review of the frozen files. It proves only that the design is internally
specified.

Production activation additionally requires:

- species migration applied and audited;
- a real at-impression signer using the activation-pinned exporter key plus a
  distinct activation-pinned external anchor provider/key whose identity is
  externally allowlisted and independently custodied;
- independently verified, gapless append-only inclusion and consistency proofs
  over actual proof arrays, checkpoint roots, and tree sizes for every issued
  assignment and signed primary exposure, within the 300-second deadlines;
- independently verified server-authoritative segment-start and completion
  boundary events, plus an anchored terminal checkpoint—including an anchored
  zero-size checkpoint for a zero-event stream; a terminal after-outcome census
  or arbitrary digest is insufficient;
- a trusted exporter that verifies and exports that full score/site/window,
  snapshot/scoring, recruitment/consent/selection payload and issuance timing;
- the precommit or safe-randomization flow;
- a deletion-linked, server-authoritative participant token stable across
  sessions and devices (the current resettable public secondary token is not
  eligible for primary concentration gates);
- legal notice, study consent, retention, and withdrawal alignment;
- encrypted private storage, least-privilege access, deletion reconciliation,
  and restore verification;
- an externally allowlisted signing key and tamper-evident pre-enrollment
  activation commitment;
- exact Python 3.12 dependencies—including transitive `cffi` and `pycparser`—
  and a root-owned immutable runtime-image digest;
- independently operated labeled-export/recomputation and atomic publication
  services with externally anchored execution and key custody; and
- an outcome-blind sealed manifest deployed before the first eligible row.

The real externally anchored signer/exporter and at-impression append-only
issuance proof do not exist yet. Until every check has evidence, no prospective
primary cohort is active and the production roadmap subcheck remains open.
