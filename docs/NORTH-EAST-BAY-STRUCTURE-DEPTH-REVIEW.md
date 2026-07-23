# North and East Bay structure and depth review packet

**Status:** blank review packet; no review has been conducted or accepted

Use this packet to review the display-only NOAA chart context already prepared
for the ten North and East Bay catalog locations. It does not ask anyone to
reveal a fishing spot or catch history, and it is not navigation advice, access
approval, a safety certification, or model validation.

The machine-readable boundary is
[`field-review/north-east-bay-structure-depth-review-policy.json`](../field-review/north-east-bay-structure-depth-review-policy.json).
Every committed site remains `pending`. Raw answers must stay outside Git,
outside Codex, and outside public issue or pull-request comments.

McNears Beach Pier and Ferry Point Fishing Pier remain `partial`: no reviewed
NOAA ENC depth-area record intersected either configured offshore sector.
Nearby point soundings, shoreline-construction records, catalog clues, or a
human review cannot be used to invent the missing bands or promote either site
to `charted-context`. This evidence gap is not proof that water is shallow,
deep, reachable, fishable, or safe.

## Local-angler response

Send a reviewer only the public location name, the site's displayed chart
context, and this response block. Do not request a name, contact detail, account
ID, exact visit time, precise coordinates, private directions, catches, trip
notes, photos, video, credentials, or tokens.

```text
Site ID:
Reviewer key (owner-assigned random UUID; reuse for this reviewer only):
Response ID (owner-assigned random UUID; unique for this site response):
Observed month (YYYY-MM, or not_observed):
sector_direction: matches_context | correction_needed | not_observed | uncertain
depth_band_usefulness: matches_context | correction_needed | not_observed | uncertain
charted_feature_usefulness: matches_context | correction_needed | not_observed | uncertain
catalog_clue_fit: matches_context | correction_needed | not_observed | uncertain
display_limitations: matches_context | correction_needed | not_observed | uncertain
Correction category (only if needed): sector | depth | feature | clue | disclosure
General correction (one sentence; no identity, trip, catch, or precise-location detail):
```

A local reviewer confirms only whether the generalized display is useful and
not misleading. They do not confirm the exact depth at a cast, the presence or
absence of fish, safe wading, public access, or every underwater feature. A
review cannot fill either partial site's missing chart area-band evidence.

## Independent chart or marine-GIS response

The chart-method reviewer must be a different person from every local reviewer.
They review the source, geometry, datum, date handling, uncertainty disclosure,
and feature-class meaning—not fishing quality.

```text
Site ID:
Reviewer key (owner-assigned random UUID; reuse for this reviewer only):
Response ID (owner-assigned random UUID; unique for this site response):
Reviewed at (canonical UTC timestamp):
Role attestation: independent_nautical_chart_or_marine_gis_reviewer
Conflict-free attestation: true
source_product_fit: accepted | changes_required | unable_to_assess
sector_reproducibility: accepted | changes_required | unable_to_assess
units_and_datum: accepted | changes_required | unable_to_assess
source_dates: accepted | changes_required | unable_to_assess
uncertainty_disclosure: accepted | changes_required | unable_to_assess
feature_class_claim: accepted | changes_required | unable_to_assess
Correction category (only if needed): source | geometry | datum | date | uncertainty | classification | disclosure
General correction (one sentence; no identity or precise feature location):
```

The same chart reviewer may cover multiple sites. Role keys must never overlap
with local-reviewer keys. A UUID is only a pseudonymous counting key; preserve
qualification/conflict evidence privately and do not publish identity.

## Source-identity recheck

One qualifying chart reviewer must also recheck the fixed NOAA program and
service identity within seven days of evaluation. The private manifest records
their reviewer key, the canonical UTC check time, and four booleans confirming
that the program was reachable, the fixed `Approach` service identity matched,
the checked-in artifact/source hashes matched, and the documented limitations
were acknowledged. This is a manual evidence statement; the evaluator makes no
network or provider request.

## Guarded private template and evaluator

Create a private owner-only directory outside the checkout and write a blank
manifest bound to the exact reviewed commit:

```sh
mkdir -p /absolute/private/path
chmod 700 /absolute/private/path
npm run write:north-east-bay-structure-depth-review-template -- --output-file /absolute/private/path/structure-depth-review.json --expected-commit <full-commit-sha>
```

The writer creates one new `0600` regular file and refuses relative paths,
symlinked or broadly accessible directories, checkout paths, and existing
destinations. Fill the arrays without adding fields, then evaluate the same
exact checkout:

```sh
npm run evaluate:north-east-bay-structure-depth-review -- --evidence-file /absolute/private/path/structure-depth-review.json --expected-commit <full-commit-sha>
```

The reader requires a current-user-owned, one-link, non-symlink `0600` file no
larger than 256 KiB and rechecks its identity after a no-follow open.
Corrections, uncertain/unobserved answers, stale observations, stale chart
review, missing or stale source recheck, incomplete site coverage, insufficient
distinct reviewers, role overlap, digest drift, extra fields, and any artifact
status drift all fail closed. Only an aggregate, non-identifying receipt and
the private-file digest may enter the repository. Delete raw responses within
30 days after the review decision.

## Locations

- `mcnears-beach-pier` — **McNears Beach Pier** (`partial`)
- `paradise-beach-pier` — **Paradise Beach Pier**
- `fort-baker-pier` — **Fort Baker Fishing Pier**
- `ferry-point-pier` — **Ferry Point Fishing Pier** (`partial`)
- `keller-beach` — **Keller Beach**
- `point-isabel-shoreline` — **Point Isabel Shoreline**
- `albany-bulb` — **Albany Bulb Shoreline**
- `berkeley-marina-north-basin` — **Berkeley Marina North Basin Shore**
- `cesar-chavez-park` — **Cesar Chavez Park Shoreline**
- `emeryville-marina-pier` — **Emeryville Marina Fishing Pier**

## Acceptance boundary

Each site needs one qualifying local-angler response and one qualifying chart
response. The region needs at least two distinct local reviewers and at least
one chart reviewer, with no role-key overlap. Every correction must be resolved
before a new exact artifact is reviewed.

Passing this packet does not authorize a score change, catalog mutation,
navigation use, model training/validation, deployment, provider change, access
claim, recommendation, partial-to-charted promotion, or safety claim. Those
gates remain separate and open.
