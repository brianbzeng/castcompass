# Model governance

## Current truth

CastingCompass does not currently serve or authorize a trained fishing model. The public 0–100
output remains a relative `heuristic-configuration` rank, not a catch probability or validated
accuracy claim. The checked-in v1 policy therefore fails closed on any trained model it sees in
serving evidence.

The language-neutral policy is
[`model/governance/california-halibut-v1.json`](../model/governance/california-halibut-v1.json),
validated structurally by
[`contracts/model-governance.schema.json`](../contracts/model-governance.schema.json) and
semantically by `pipeline.contourcast.model_governance`. Its content is canonically hashed into
every decision. No automatic promotion or serving mutation exists.

Verify the policy without reading observations or changing state:

```bash
python -m pipeline.contourcast.model_governance verify-policy
```

## Promotion boundary

The promotion order is development, candidate, shadow, limited, then production; promotion stages
cannot be skipped. Suppression may interrupt any trained-model stage, while retirement is terminal.
A future candidate must be target-specific, content-addressed, bound to the exact
run/checkpoint/metrics bytes, and independently reproduced.

Promotion eligibility additionally requires a separate confirmatory protocol and activation that
were externally timestamped before enrollment. The candidate and best baseline must be frozen;
development and locked-test sources must be separated; pilot rows must be excluded; geographic
and temporal holdouts plus participant-clustered uncertainty must be used; every primary and
required slice metric must be estimable with preregistered support.

The candidate must satisfy all of these outcome-blind decision rules:

- its primary lower confidence bound beats the best preregistered baseline;
- its paired-improvement lower confidence bound is above zero;
- calibration clears the preregistered ceiling and is not worse than the baseline;
- no required geography, season, mode, or taxon slice falls below its preregistered floor;
- minimum positive, negative, participant, and slice support is met; and
- negative and inconclusive results remain publishable under the frozen protocol.

Numeric thresholds are intentionally not chosen from current or future locked-test outcomes.
They must be sealed in the separate confirmatory protocol before the first eligible row. Passing
repository evidence can produce only `eligible-for-human-review` or
`eligible-for-policy-update`; it cannot deploy or silently authorize a trained model.

## Monitoring and actions

The operator decision order is intentionally asymmetric:

| Evidence | Required action |
| --- | --- |
| Model/policy digest, target/contract, CRS/channel/source/coverage, feature validity, missingness, or validated-support failure | Suppress trained output immediately |
| Primary performance, calibration, required slice, drift, support, or evidence-age gate fails | Roll back and revalidate |
| Material candidate, feature, target, source, geography, calibration, regulation, product, or ranking-semantics change | Revalidate before restoration or promotion |
| Every frozen gate passes | Human review and a new protected policy/release change; never automatic promotion |

Integrity is checked per request and release. Distribution, missingness, and support use a rolling
seven-day view reviewed weekly. Delayed performance and calibration are evaluated only after the
preregistered minimum-support window is met; insufficient support is not converted into a pass.
A full revalidation is required at least every 180 days and sooner after any material trigger.

Monitoring is privacy-minimized: no precise coordinates or raw labels belong in the decision
record, and published aggregates require groups of at least 20. Provider logging, alert delivery,
and deployed dashboards remain separate production gates.

## Rollback and restoration

Safety suppression may be automatic; restoration and promotion may not. The fallback order is:

1. a fresh, compatible, immutable last-known-good trained release whose artifacts rehash;
2. the reviewed heuristic configuration; then
3. an honest feature-unavailable state.

Every rollback requires an incident record and revalidation. A restored model must re-enter the
shadow stage; an exposed locked test cannot be reused to approve a new candidate.

## Decision evidence

The evaluator accepts a strict, target-bound evidence document and writes a new decision record
containing the policy hash; protocol and activation hashes when they exist; candidate model-run,
checkpoint, and metrics hashes when a candidate exists; exact source release and serving version;
timestamp, action, reasons, and owner. It refuses to overwrite an existing output path, does not
log raw observations, and never applies the recommendation:

```bash
python -m pipeline.contourcast.model_governance evaluate \
  --evidence /private/path/model-governance-evidence.json \
  --output /private/path/model-governance-decision.json
```

Store real evidence outside the public repository. Before any trained-model launch, separately
preregister and activate the confirmatory protocol, collect eligible locked-test rows, obtain the
required human and independent reviews, exercise shadow/limited rollback in isolated staging,
and bind the approved decision to the exact deployed release. None of those production gates is
claimed complete here.
