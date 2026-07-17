# CastingCompass validation successor

**Protocol:** `california-halibut-collection-feasibility-v2`

**Machine contract:** `castingcompass.validation-feasibility-pilot/2.0.0`

**Status:** frozen locally on 2026-07-17; not activated

**Supersedes for activation:** `california-halibut-site-window-v1`

The frozen machine artifact is
`validation/protocols/california-halibut-collection-feasibility-v2.json`. The
v1 artifact remains immutable historical design evidence, but it must not be
activated. V2 replaces its unavailable bespoke transparency-log and independent
publication infrastructure with an achievable two-stage program. This change
does not weaken a model-validation claim because the pilot is prohibited from
making one.

## Decision

Run a prospective **collection-feasibility pilot** before designing a new
confirmatory ranking study.

The pilot answers one operational question: can CastingCompass collect a
complete, reconciled, privacy-minimized, and source-labeled set of targeted
attempts—including skunks—from enough independent anglers to justify a later
confirmatory design?

The pilot does not evaluate candidate discrimination, compare the score with a
baseline, calibrate probability, establish causality, or authorize promotion.
Candidate score/outcome associations and score-stratified outcomes are not
computed. Pilot rows are permanently excluded from a future confirmatory test.
Those constraints let the pilot estimate collection completeness, support, and
unstratified encounter prevalence without spending the future locked test set.

## Why v1 is not the launch path

V1 requires an independent per-event append-only transparency log, external
inclusion and consistency proofs, separately custodied signing keys, a trusted
exporter, and an independently operated atomic publication service. None exists
in production, and a local signature cannot prove independent issuance timing.
Retrofitting those systems would be disproportionate before CastingCompass has
shown that it can recruit and retain a sufficiently complete cohort.

V2 keeps the controls that matter for an operational pilot:

- a read-only, externally timestamped OSF registration of the exact activation
  commitment bundle before enrollment;
- an immutable release commit, Worker version, scoring identity, site-catalog
  hash, contracts, exact start, and exact end sealed in an activation manifest;
- trusted server start/completion timestamps, unique event IDs, an append-only
  correction ledger, daily encrypted checksummed snapshots, and a tested restore;
- complete attempts including non-encounters, reconciliation of every start,
  source labeling, and outcome-independent recruitment/incentives; and
- deletion-linked privacy-safe participant groups without emails, account IDs,
  coordinates, notes, photos, IP addresses, or user agents in the study export.

OSF describes preregistration as a time-stamped, read-only plan submitted before
data collection and states that submitted registration contents cannot be
edited. A public registration receives a DOI; an embargo is also available.
See [OSF Registrations](https://help.osf.io/article/330-welcome-to-registrations).

## Frozen feasibility gates

The pilot runs to the exact end fixed in its activation manifest. There is no
early-success or outcome-adaptive stop. The planning target and minimum complete
attempt count are 100. Feasibility additionally requires:

- at least 50 privacy-safe participant groups;
- at least 10 target encounters and 50 non-encounters, assessed without score
  stratification;
- at least 80% completion among starts that were not safely canceled, and 100%
  reconciliation of every start including safe cancellations;
- no more than 2% required-field missingness;
- no participant contributing more than 10% of complete attempts;
- attempts from at least three geographic panels and two recruitment sources;
- successful withdrawal/deletion reconciliation; and
- successful daily snapshot and restore evidence.

An unmet gate means `collection-feasibility-not-demonstrated`. It does not allow
row deletion, a relaxed threshold, a model-performance analysis, or a success
claim. Safe cancellation is always allowed, retained, reported separately, and
excluded from the completion-rate denominator so participant safety is never
penalized.

## Activation is still closed

Do not collect v2-eligible rows until every item below has evidence:

- [x] Freeze and test the local protocol and activation schemas.
- [x] Add an operator verifier for exact hashes, duration, prerequisite timing,
      immutable release identity, and activation chronology.
- [x] Implement the server-authoritative start, completion, cancellation,
      correction, and recruitment-source capture contract.
- [x] Implement the privacy-safe deletion-linked participant token.
- [x] Implement the append-only event ledger and exact started-attempt
      reconciliation export.
- [ ] Configure encrypted daily snapshots, checksums, least-privilege access,
      retention, and complete a restore/deletion-replay test.
  - [x] Implement and locally verify a separate 730-day validation-only technical candidate
        with privacy-minimized projections, immutable opaque suppression capture, cumulative
        aggregate removal evidence, strict artifact-class checks, and no candidate-performance
        computation.
  - [ ] Obtain privacy/legal/data-steward approval, configure production key custody/access and
        daily schedules, retention-test real artifacts, and complete a witnessed
        production-shaped restore/deletion-replay drill. The 89-day full-D1 operational path
        remains separate and cannot satisfy this gate.
- [ ] Complete legal, privacy, study-consent, and data-steward review.
- [ ] Submit the exact protocol artifact to OSF and retain the read-only receipt,
      registration timestamp, URL/DOI or embargo identifier, and protocol hash;
      after deployment acceptance, submit the exact canonical activation
      commitment containing the fixed interval, release/Worker/scoring identity,
      approvals, contracts, site hash, and storage evidence. Download it back,
      verify its hash, and archive the artifact and receipt under the data
      steward's review before enrollment.
- [ ] Seal a valid `castingcompass.validation-feasibility-activation/2.0.0`
      manifest with an exact 90–365 day interval before the first eligible row.
- [ ] Deploy the immutable release and record the Worker version before the
      interval begins.
- [ ] Pass runtime acceptance with synthetic start, completion, safe
      cancellation, withdrawal, deletion, snapshot, and restore fixtures.

Pre-activation product reports remain observational product data. They are not
pilot rows and cannot be imported retroactively.

The activation wrapper is not self-referential: its OSF receipt fields are
excluded from the canonical commitment. The verifier hashes every other
activation field, requires that hash to equal the OSF-registered artifact hash,
requires the downloaded registered artifact to match, and requires the sequence
`deploy → runtime acceptance → prepare commitment → OSF registration → receipt/
artifact verification → enrollment`. Changing the dates or any bound identity
after registration invalidates activation. The local verifier checks the
recorded evidence and hashes; the data steward must still inspect the external
OSF receipt and archived bytes rather than trusting caller-supplied fields.

## Confirmatory handoff

If and only if the pilot passes, freeze a separate confirmatory protocol before
its enrollment. Pilot designers may use completion, missingness, reconciliation,
participant concentration, unstratified encounter prevalence, geography/mode/
season/source support, and privacy-removal rates. They may not inspect pilot
candidate performance or score-stratified outcomes.

The new confirmatory protocol must freeze a candidate and baselines, independent
development and locked test data, geographic and temporal holdouts,
participant-clustered uncertainty, complete-attempt inclusion, score-influence
stratification, minimum positive/negative/participant support, negative and
inconclusive reporting, and model promotion/drift/rollback gates. It requires
its own externally timestamped preregistration and activation. Until that study
passes, the live 0–100 output remains an explainable relative heuristic ranking,
not a validated prediction or catch probability.

## Change control

Never edit either frozen protocol in place. A semantic change requires a new
version. An activation manifest may supply only deployment-specific identities,
approvals, and dates allowed by its schema; it cannot alter study semantics.
No post-outcome change may reclassify pilot rows as confirmatory evidence.
