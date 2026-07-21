# Santa Barbara local access review packet

**Status:** blank review packet; no review has been conducted or accepted

Use this packet to check whether CastingCompass describes practical public
access accurately before the Santa Barbara South Coast catalog is considered
release-ready. This is an access-description review only. It is not a request
for fishing results, a safety certification, legal advice, or model validation.

The machine-readable boundary is
[`field-review/santa-barbara-access-review-policy.json`](../field-review/santa-barbara-access-review-policy.json).
The committed policy contains no responses and every site remains `pending`.

## What to send a local reviewer

Send only the relevant site entries below plus this response block. A reviewer
does not need an account and should not provide a name, contact information, an
exact visit date or time, a precise fishing spot, private-access directions,
photos, catches, or trip notes.

```text
Site ID:
Reviewer key (owner-assigned random UUID; reuse for this reviewer only):
Response ID (owner-assigned random UUID; unique for this site response):
Observed month (YYYY-MM, or not_observed):
public_entry_route: matches_catalog | correction_needed | not_observed | uncertain
access_status: matches_catalog | correction_needed | not_observed | uncertain
parking_walk: matches_catalog | correction_needed | not_observed | uncertain
posted_restrictions: matches_catalog | correction_needed | not_observed | uncertain
boundary_clarity: matches_catalog | correction_needed | not_observed | uncertain
Correction category (only if needed): access | status | parking_walk | restriction | boundary
General correction (one sentence; no personal, trip, catch, or precise-location detail):
```

One reviewer may cover multiple locations, but use one block per site. The
owner should assign a random response ID and a random pseudonymous reviewer key.
Reuse that reviewer key only to count the same reviewer across sites; it must
not be a name, contact detail, account ID, or other identifier. Keep both UUIDs
and the raw response outside Git and outside Codex. Delete the private evidence
within 30 days after accepting or rejecting the review. Only the evaluator's
aggregate, non-identifying receipt and private-evidence digest may enter the
repository.

## Offline evaluator

The evaluator is read-only and makes no provider or network requests. Create a
private owner-only directory outside the checkout, then use the guarded writer
to create a blank manifest bound to the reviewed catalog commit:

```sh
mkdir -p /absolute/private/path
chmod 700 /absolute/private/path
npm run write:santa-barbara-access-review-template -- --output-file /absolute/private/path/access-review.json --expected-commit 377dec41c9fc1842c682b7556f2b0a8b1b83e87c
```

The writer creates a new `0600` regular file exclusively and refuses relative
paths, symlinked or broadly accessible directories, locations inside the
checkout, and any destination that already exists. It prints only a minimized,
non-authorizing write receipt. The older
`template:santa-barbara-access-review` command is for terminal inspection only;
do not redirect it into a review file.

Fill that private file without adding fields. Record a current official-source
recheck for every location after comparing the linked access and regulation
pages to the catalog. Then evaluate it against the same reviewed checkout:

```sh
npm run evaluate:santa-barbara-access-review -- --evidence-file /absolute/private/path/access-review.json --expected-commit <full-commit-sha>
```

The evidence file must be a current-user-owned regular non-symlink file outside
the repository, no larger than 256 KiB, with exactly one hard link and
permissions exactly `0600`. The reader checks ownership, link count, size, and
identity both before and after a no-follow open, before reading any bytes.
Observations older than six calendar months, uncertain or unobserved answers,
missing or stale official checks, insufficient distinct reviewers, and
unresolved corrections all fail closed. Generalized correction text is limited
to one short line and rejects contact details, links, coordinates, phone-like
strings, and common credential formats.

## Locations to review

- `gaviota-state-park-beach` — **Gaviota State Park Beach** (`open`): confirm
  beach/day-use access while keeping the separately closed pier out of scope.
- `refugio-state-beach` — **Refugio State Beach** (`open`): confirm the public
  park access description and whether current notices change it.
- `el-capitan-state-beach` — **El Capitán State Beach** (`limited`): confirm
  reopened day use and any construction or facility restrictions. Two local
  reviews are required.
- `haskells-beach` — **Haskell's Beach** (`open`): confirm the documented public
  coastal route, parking, and walk.
- `goleta-beach` — **Goleta Beach** (`limited`): confirm ocean-beach access and
  whether the slough/pier boundary warning is clear. Two local reviews are
  required.
- `arroyo-burro-beach` — **Arroyo Burro Beach** (`open`): confirm public park
  access and whether the water-quality/surf caveat is appropriately worded.
- `mesa-lane-beach` — **Mesa Lane Steps Beach** (`limited`): confirm the public
  stairs and whether the high-tide impassability warning is clear. Two local
  reviews are required.
- `leadbetter-beach` — **Leadbetter Beach** (`open`): confirm public access and
  whether swim/lifeguard-zone constraints are appropriately described.
- `santa-barbara-harbor-breakwater` — **Santa Barbara Harbor Breakwater**
  (`limited`): confirm public fishing access and whether the standing-area and
  harbor-operations caveats are clear. Two local reviews are required.
- `stearns-wharf` — **Stearns Wharf** (`open`): confirm public access and whether
  posted wharf rules or temporary closures require a correction.
- `east-beach-santa-barbara` — **East Beach (Santa Barbara)** (`open`): confirm
  public access and whether seasonal recreation-zone constraints are clear.
- `summerland-beach-lookout-park` — **Summerland Beach (Lookout Park)**
  (`limited`): confirm the public pedestrian route from the park, posted hours,
  bluff conditions, and whether the tide-limited return warning is clear. Two
  local reviews are required.
- `carpinteria-state-beach` — **Carpinteria State Beach** (`open`): confirm park
  access and whether wildlife/tide-pool restrictions need clearer wording.
- `rincon-beach-park` — **Rincon Beach Park** (`open`): confirm public access and
  whether tide and surf-crowding constraints are appropriately described.

The linked official access and CDFW regulation sources in the product catalog
remain authoritative. A local observation can identify a discrepancy; it cannot
override a posted closure, official regulation, or marine protected-area map.

## Acceptance boundary

An `open` site needs at least one local review. A `limited` site needs at least
two. The region also needs at least two distinct reviewers overall. After the
threshold is met, the owner must recheck each official source within seven days,
resolve every correction, and preserve only an aggregate receipt plus a digest
of the private evidence.

Passing this review does not authorize a deployment, make access complete or
guaranteed, establish safety or legality, or turn any Santa Barbara observation
into model-training, calibration, or validation evidence. Those gates remain
separate and open.
