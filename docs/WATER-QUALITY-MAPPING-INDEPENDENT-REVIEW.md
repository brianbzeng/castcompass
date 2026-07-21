# Independent review of launch-catalog water-quality mappings

**Status:** handoff prepared; no independent review has been conducted or accepted

This runbook lets two qualified people review the proposed water-quality mapping outcome for all 61 launch-catalog sites.
Thirty-nine sites are provisionally mapped to an official source and 22
remain deliberately `not-covered`. The review covers source identity, spatial support, action-only
semantics, missing-data behavior, and risk communication. It never authorizes a mapping change,
runtime activation, numeric scoring, a clean-water or seafood-safety claim, merge, deployment,
provider mutation, or production use.

The first person must be an official-source mapping reviewer qualified to assess public program
directories, station identity, geographic support, and source scope. The second must be a
public-health risk-communication reviewer qualified to assess suppression, unknown/missing-data
language, and the boundary between water-contact actions and fishing-quality claims. They must be
different people, independent of the implementation, and able to preserve private evidence of
their competence and substantive work. The verifier enforces separate pseudonymous IDs, roles,
files, and evidence digests; it cannot prove real identity, qualifications, or independence. The
owner must verify those facts outside Git.

## Private storage boundary

Both reviewer records and all supporting notes must remain outside every repository checkout on
an encrypted, access-restricted volume. Each record must be a separate regular file owned by the
current user, no larger than 128 KiB, mode `0600`, and neither symbolically nor hard linked. Store
competence evidence and the substantive signed/dated review note separately; only their SHA-256
digests enter the JSON record.

Never put reviewer names, employers, contact details, credentials, signatures, findings, notes,
private file paths, or private reviewer records in Git, a PR, an issue, Codex, analytics, or a
public receipt. The random UUID exists only to enforce separation and is not a public identity.

## Fixed object under review

Both reviews bind to the exact consolidated draft integration receipt:

- source commit: `377dec41c9fc1842c682b7556f2b0a8b1b83e87c`
- policy version: `castingcompass.water-quality-advisory/official-programs-0.5.0`
- aggregate review-target SHA-256: `6cb921149782483338f602b5b3df09ae41243e6a05743ae1534a0fe6892d3346`
- catalog outcomes: 61 total, 39 mapped, 22 `not-covered`

The aggregate digest binds the exact site catalog, water-quality policy, public advisory artifact,
complete negative-evidence inventory, and the four source-specific audit receipts. Obtain the full
source commit through a channel independent of the template and confirm it against the protected
repository history. Any later catalog, policy, public artifact, mapping, station set, source audit,
or negative-evidence change invalidates this target and requires a fresh protected review.

## What each reviewer must inspect

1. Read [`WATER-QUALITY-ADVISORY.md`](WATER-QUALITY-ADVISORY.md),
   [`water-quality/policy.json`](../water-quality/policy.json), and the official agency sources it
   cites. Treat a registry or directory as identity evidence only unless the policy separately
   defines current-action semantics.
2. Inspect the four source-specific audit receipts and
   [`water-quality/audits/launch-catalog-coverage.json`](../water-quality/audits/launch-catalog-coverage.json).
   Confirm that every mapped site has adequate exact-location and spatial support and that a nearby
   or similarly named station is never inherited by a different public location.
3. Review every generated `site_reviews` entry. The static fields are machine-filled from the
   locked target and must not be edited. Set the three acceptance booleans only after reviewing the
   official identity/spatial support, action-only/missing-data behavior, and absence of safety or
   scoring authority for that site.
4. Confirm that only an exact, current official action may suppress a recommendation. Absence,
   stale evidence, an unavailable source, and an unmapped site must remain unknown. No site may
   receive a positive or negative numeric `scoreDelta`.
5. Preserve private competence and substantive review evidence, compute distinct SHA-256 digests,
   and replace the two template placeholders. An honest rejection is valid: keep
   `changes_required`, set a positive `blocking_finding_count` or leave at least one check false,
   and preserve the finding details privately.
6. Use `accepted_inventory` only when all ten inventory checks and all 183 site checks are true and
   the blocking-finding count is zero. Acceptance says only that both reviewers accept the fixed
   repository inventory; it creates no release or runtime authority.

## Generate the private templates

Create a dedicated directory on the encrypted private volume, make the directory owner-only, and
use the guarded writer. The directory must already exist, must not itself be a symlink, must be
owned by the current user, and must grant no group or other permissions. The writer resolves the
directory's canonical parent path before creating either file.

```sh
mkdir -p /PRIVATE/PATH
chmod 700 /PRIVATE/PATH
npm run write:water-quality-mapping-review-template -- --output-file /PRIVATE/PATH/mapping-review.json
npm run write:water-quality-public-health-review-template -- --output-file /PRIVATE/PATH/public-health-review.json
```

Templates deliberately start with `changes_required`, one blocking finding, and every check false.
They contain all 61 locked site outcomes in deterministic order, so omission, duplication,
reordering, station substitution, remapping, or source drift fails verification. The guarded writer
uses exclusive creation, refuses an existing destination instead of overwriting it, writes
canonical JSON with mode `0600`, synchronizes the file before reporting success, and returns only a
minimized non-authorizing receipt without the private path. The older `template:*` commands remain
available for read-only inspection, but shell redirection is not the approved private-record path.

## Verify the private reviews

```sh
export WATER_QUALITY_MAPPING_REVIEW_FILE=/PRIVATE/PATH/mapping-review.json
export WATER_QUALITY_PUBLIC_HEALTH_REVIEW_FILE=/PRIVATE/PATH/public-health-review.json
export WATER_QUALITY_REVIEW_EXPECTED_SOURCE_COMMIT=377dec41c9fc1842c682b7556f2b0a8b1b83e87c
npm run verify:water-quality-mapping-independent-review
```

The verifier makes no network, provider, model, database, or write request. It validates canonical
JSON, the strict schema, private-file protections, the independently supplied commit, every locked
input digest, all 61 exact site outcomes, reviewer/role/evidence separation, time and disposition
semantics, and every inventory and site check. A valid `changes_required` review produces a
truthful incomplete receipt rather than being discarded.

The minimized receipt includes only fixed target identity, aggregate counts, role-level outcomes,
completion state, and false authority boundaries. It excludes reviewer IDs, evidence digests,
identity, qualifications, findings, paths, and notes. Even after two accepted reviews, all of these
remain false:

- mapping-change and runtime-activation authorization
- numeric-score authorization
- clean-water, seafood-safety, and catch-probability claim authorization
- merge, deployment, and production authorization

## Work that remains after accepted reviews

Accepted reviews close only the two-role independent review of this exact 61-site mapping
inventory. Protected-branch review, guarded release approval, source-freshness and latency checks,
provider/database controls, staged and production verification, and rollback evidence remain
separate gates. Any future numeric fishing-quality contribution requires its own frozen target,
mechanism, preregistered validation, uncertainty analysis, and independent methods review. Official
agency pages and posted signs remain authoritative for water-contact decisions.
