# CastingCompass software supply-chain policy

Status: locally verified repository baseline; production provenance evidence remains open

This policy covers source dependencies, build runtimes, CI actions, dependency review,
software bills of materials, advisory response, and updates. Exact pins reduce unexpected
change; they do not make a component trustworthy forever. Every pin needs a reviewed update
path so security fixes are not frozen out.

## Locked repository baseline

| Boundary | Repository control | Remaining external dependency |
| --- | --- | --- |
| Node build runtime | `.node-version`, GitHub CI, and snapshot automation select Node `22.23.1`; `engines.node` accepts only that patched 22.x floor through the next major boundary | Cloudflare must be verified to honor the file on the exact build; GitHub/Cloudflare host images are mutable services |
| Python test runtime | `.python-version` and every checked-in GitHub test workflow select Python `3.12.13` | GitHub's separate hosted Dependabot resolver used Python 3.14.5; Python 3.12 is security-fixes-only, so a tested feature-series upgrade is still required before its support ends |
| API container runtime | The API Dockerfile selects the official `python:3.12.13-slim-bookworm` multi-platform image by immutable index digest | The pinned OS/Python image needs weekly reviewed Docker updates; the container is not the current Cloudflare Worker production path |
| Exercised Python graphs | FastAPI runtime/test and pipeline CI use exact transitive versions from source-bound locks with committed SHA-256 distribution hashes; CI and the API image require hashes and reject source distributions | The package index, pip implementation, host kernel/libc, and wheel contents remain external; optional Geo/PyTorch platforms need separate locks |
| GitHub Python dependency graph | A main-only job waits for the tested API/pipeline locks, then submits exact versioned PyPI package URLs for all three exercised graphs; user submissions take precedence over incomplete managed/static parses | GitHub owns storage, precedence, and alert refresh; verify the accepted snapshot and alert state after each relevant merge rather than treating a successful upload as the final receipt |
| Worker runtime contract | `wrangler.jsonc` fixes `compatibility_date` and the reviewed compatibility flags | Cloudflare implements the runtime; a date pin needs deliberate compatibility review and periodic advancement |
| Direct npm packages | Every direct production and development dependency uses an exact version in `package.json` | A package version can still be malicious or vulnerable; review source/provenance, advisories, licenses, and install scripts |
| Transitive npm tree | `package-lock.json` records exact versions, registry locations, and integrity hashes; CI and release use `npm ci` | Registry availability and npm/client behavior remain external; the hosted runner itself is not bit-for-bit pinned |
| Known npm advisories | Compatible Babel and YAML fixes are forced; the deprecated Drizzle loader's vulnerable esbuild is overridden to tested `0.25.12`; the resulting complete npm tree currently audits clean | Replace the deprecated `@esbuild-kit` loader path when Drizzle removes it; do not leave the override indefinitely without tests |
| GitHub Actions | Every `uses:` reference is a full immutable commit SHA; runner labels are fixed to `ubuntu-24.04` rather than `ubuntu-latest` | GitHub updates the image behind that label; a release still records the workflow run and source commit |
| Default-branch integrity | Live `main` protection requires pull requests, strict successful `api`, `pipeline`, `web`, and `dependency-review` checks from the GitHub Actions app plus the `CodeQL` result from the GitHub Advanced Security app, resolved review conversations, and applies to the owner; force-pushes and branch deletion are disabled | This is provider-side configuration rather than source code; verify it again for the exact release and preserve a separate emergency-access procedure |
| Pull-request dependency changes | The SHA-pinned GitHub dependency-review action rejects newly introduced high/critical runtime or development advisories on release PRs targeting the default branch, and the live `main` protection requires that check | GitHub builds the graph from the default branch, so stacked PRs cannot supply this evidence; the complete-tree audit and SBOM remain mandatory |
| Static analysis | GitHub-managed CodeQL default setup scans Actions, JavaScript/TypeScript, and Python; the Advanced Security `CodeQL` merge result is required on `main`, and findings are reviewed individually rather than bulk-dismissed | GitHub controls the analyzer/runtime and its default query updates; release evidence still records the alert state and each dismissal rationale |
| Production npm SBOM | `security/sbom.cdx.json` is a deterministic CycloneDX 1.5 inventory of the lock-resolved production graph, including cross-platform optional variants, and embeds the SHA-256 of `package-lock.json` | It is repository evidence, not a signed deployment attestation or proof of the platform-specific bytes Cloudflare actually ran |
| Secrets and private reporting | Repository secret scanning and provider-pattern tests run before dependency installation in CI; GitHub secret scanning, push protection, and private vulnerability reporting are enabled | GitHub's extra non-provider-pattern and validity-check options were unavailable in the current account configuration; rotation, IAM, and incident drills still require provider evidence |

The exact Node release is the current patched release selected for the maintained 22.x line,
not a claim that Node 22 should remain forever. Python 3.12.13 is a security-only source
release and is pinned here because the existing API/pipeline contract is on 3.12; plan and test
an upgrade instead of waiting for end of support.

## CI security gates

The web job deliberately orders its gates as follows:

1. scan the checked-out repository for committed credentials before running dependency code;
2. install only the committed npm tree with `npm ci`;
3. reject high/critical advisories anywhere in the npm tree and moderate-or-higher advisories
   in the production tree;
4. regenerate the production CycloneDX document in memory and require an exact match with the
   committed SBOM and lockfile hash;
5. lint, typecheck, build, run all runtime/attack tests, and exercise the mobile browser suite.

The API and pipeline jobs install only the committed CPython 3.12 locks with pip's
all-or-nothing `--require-hashes` mode and `--only-binary=:all:`. The API job runs its tests;
the pipeline lock also pins Ruff and the validation-compatible numerical/cryptographic graph
before lint, unit tests, and the deterministic smoke workflow. The pip caches are keyed to the
lock files rather than the range/source inputs. The API Dockerfile uses the runtime-only lock,
excluding pytest/httpx, plus the exact Python patch/image digest. Hash checking proves that
downloaded bytes match a committed distribution hash; it does not prove that a package or wheel
is benign.

The dependency-review job separately compares the base and head dependency graphs on pull
requests targeting the default branch. GitHub builds that graph from the default branch, so
stacked successor PRs rely on the mandatory complete-tree/production audits and SBOM gate;
they do not falsely report a dependency-review pass. The release check must block newly
introduced high/critical advisories in runtime or development scope. Live `main` protection
requires dependency review plus the API, pipeline, web, and Advanced Security `CodeQL` results,
uses strict up-to-date branch checks, applies to administrators, requires pull requests and
resolved conversations, and blocks force-pushes/deletion. GitHub-managed CodeQL runs across
Actions, JavaScript/TypeScript, and Python. Its required merge result and alert list must both be
reviewed. The release runbook repeats all repository security checks from the immutable checkout
and re-verifies the provider-side settings.

## Deterministic SBOM workflow

Run the generator only after `npm ci`:

```sh
npm run security:sbom:write
npm run security:sbom
```

The generator takes npm's complete lockfile-only CycloneDX graph, independently resolves the
lockfile-only production tree with `npm ls --package-lock-only --omit=dev`, intersects the two
graphs, removes random/time/local-path metadata, sorts components and dependency edges,
normalizes the root component name, and embeds the current `package-lock.json` SHA-256. Using
the lock rather than the host installation keeps optional native variants deterministic across
macOS and Linux. The intersection avoids relying on npm SBOM's version-dependent omit behavior;
tests also require every direct runtime package. Review both the lock diff and SBOM diff in the
same pull request. CI rejects a stale SBOM.

The SBOM intentionally covers the production npm tree only. Development tools remain visible
in `package-lock.json`, the complete-tree audit, and dependency review. Python and external
build/service components are not yet represented in one combined signed SBOM; that is an open
gate below.

## Python lock workflow

`services/api/requirements.txt` is the runtime update input, while
`services/api/requirements-test.in` adds the exact test-only dependencies without putting them
in the API image.
`pipeline/requirements-ci.in` composes the smoke ranges with the validation protocol's exact
overlap constraints, fixes the reviewed pandas behavior, and pins the CI-only Ruff version.
The generated FastAPI runtime/test locks and `pipeline/requirements-ci.lock` contain exact
transitive versions and SHA-256 hashes for universal CPython 3.12 wheel resolution.

The directory-local `services/api/.python-version` and `pipeline/.python-version` files mirror
the canonical root `.python-version` for local tools started inside those directories; the
generator rejects any byte or version drift between them. They are not a control over GitHub's
hosted resolver: the post-merge managed job log showed Python 3.14.5 even with those files
present. The validation protocol remains canonically frozen in
`pipeline/requirements-validation.lock`, while `pipeline/requirements-validation.txt` is a
byte-identical transport mirror because the managed parser follows `.in` and `.txt` constraint
files but not a `.lock` constraint suffix. `pipeline/requirements-ci.in` points to that mirror,
and the generator both compares the two files byte-for-byte and binds both hashes into the CI
lock. The mirror does not create a second editable source of truth.

The repository checker binds each generated lock to SHA-256 digests of every source/constraint
file, rejects non-exact or unhashed requirements, and runs before dependency audits in the main
security command. To update intentionally, use exactly the generator version enforced by the
script, inspect the source, resolved-version, marker, and hash changes, then run both isolated
pip installs and their test suites:

```sh
node scripts/generate-python-locks.mjs --write
npm run security:python-locks
python -m pip install --only-binary=:all: --require-hashes -r services/api/requirements-test.lock
python -m pip install --only-binary=:all: --require-hashes -r pipeline/requirements-ci.lock
```

The generator uses `uv 0.10.11` only to resolve and record the reviewed lock update; CI and the
API image install with pip and do not trust or execute uv. Re-running the generator with
unchanged inputs must be byte-identical. Dependabot monitors the API and pipeline source files,
and Docker updates monitor the API image, but every generated change still needs the review and
tests above. The managed version-update job is useful advisory evidence but is not the tested
Python runtime contract and may use a newer hosted interpreter. Never manually dismiss a stale
alert merely to make the dashboard appear green.

The exact graph exposed Starlette 0.47.3 under both API manifests with six distinct advisories,
duplicated into 12 alerts. The reviewed remediation pairs FastAPI 0.139.2 with an explicit
Starlette 1.3.1 direct pin, the first Starlette version above every affected range, and groups
the pair for future Dependabot proposals. The API does not mount `StaticFiles`, return
`FileResponse`, parse forms, or define `HTTPEndpoint` subclasses, and it allows only GET/OPTIONS;
those facts reduce reachability but do not justify retaining a vulnerable framework. Isolated
tests must also exercise the patched malformed-Host/path URL boundaries and reject unsupported
methods before this change is merged. The test-only graph uses exact `httpx2` 2.7.0, Starlette's
preferred test-client backend, instead of relying on its deprecated `httpx` compatibility path.

The 2026-07-18 provider evidence is complete at merge commit
`8d130c47c7cd708eefc47bdbfd83e391ce4b08c7`: main CI run `29622373929` passed the hash-required
API and pipeline jobs before accepting dependency snapshot `83408257`; configured graph run
`29622376160` succeeded; and the repository SPDX graph recorded exact FastAPI 0.139.2,
Starlette 1.3.1, and httpx2 2.7.0 package URLs. Dependabot alerts `#3` through `#14` then changed
to fixed at `2026-07-18T00:08:27Z`–`00:08:28Z` with no dismissal. Main CodeQL run `29622373824`
also passed its Actions, JavaScript/TypeScript, and Python analyses. Repeat the same receipt and
automatic-closure checks for future framework updates.

The frozen validation runtime separately advances scikit-learn from 1.6.1 to 1.9.0 and records
its new narwhals 2.24.0 dependency in the exact runtime identity and source-bound CI lock. That
release intentionally left NumPy 2.0.2, SciPy 1.13.1, and pandas 2.2.3 unchanged so their
behavior could be reviewed independently. Isolated seed-12 and seed-42 comparisons preserve the
spatial folds and all naive/boosted aggregate outputs exactly; the maximum linear aggregate
change is `0.000150451`, below the committed `0.001` canary. CI treats future deprecation
warnings as errors, and the habitat probe normalizes clipped multiclass probabilities before
log-loss calculation. PR `#64` passed dependency review, API, warning-strict pipeline/smoke,
web/mobile, and all CodeQL analyses. At merge commit
`9a66eb65f8222fce6338d2518371ea8d6d413b09`, main CI run `29625410418` passed all jobs and
submitted exact dependency snapshot `83443013`; managed graph run `29625412040` and main
CodeQL run `29625410265` succeeded; the SPDX graph records scikit-learn 1.9.0 and narwhals
2.24.0; and the post-merge audit found zero open dependency, code-scanning, or secret-scanning
alerts. Future optional-platform locks remain open.

The next coupled review advances NumPy 2.0.2 to
[2.5.1](https://github.com/numpy/numpy/releases/tag/v2.5.1) and SciPy 1.13.1 to
[1.18.0](https://docs.scipy.org/doc/scipy/release/1.18.0-notes.html), while retaining pandas
2.2.3. SciPy is now an explicit direct runtime dependency because the structure pipeline imports
its deterministic neighborhood filters. The exact relief-filter canary, byte-identical seed-42
fixtures, unchanged seed-12/seed-42 folds, and a maximum aggregate delta of `0.000000357` bound
the observed behavior. A clean Python 3.12.13 binary-only, hash-required install passed `pip
check`, Ruff, 62 tests, and the deterministic smoke workflow with both `FutureWarning` and
`DeprecationWarning` treated as errors. Hosted and merged-main evidence remain required before
this paired release is complete.

Pipeline Dependabot proposals are advisory inputs, not mergeable lock updates. The provider
parses and edits `pipeline/requirements-validation.txt`, but that file is only a transport mirror;
it cannot replace the canonical validation lock or regenerate the hash-required CI lock. Generated
PR `#66` demonstrated the fail-closed boundary: its mirror-only NumPy/SciPy/pandas edits failed
the byte-identity contract and were closed with the evidence recorded, without ignoring any
candidate version or dismissing an alert. Recreate such candidates in an owner branch, update the
canonical lock first, regenerate every source-bound hash, compare old/new behavior, and run all
required checks before merge.

## Exact GitHub Python dependency snapshot

GitHub's configured graph updates completed after the Psycopg and constraint fixes and recorded
exact package URLs including `pytest` 9.0.3 and `psycopg` 3.3.4. The repository SBOM expresses
those versions in the SPDX `versionInfo` field; a missing, non-SPDX `version` property must not
be misreported as a null package version. Dependabot alert `#2` automatically changed to fixed
from that refreshed managed evidence without dismissal.

The CI `dependency-submission` job adds independent build-tested evidence only after the
hash-required API and pipeline jobs pass on a push to `main`. It parses the committed locks
without importing package code and submits three exact versioned manifests: API runtime, API
tests, and pipeline CI. The runtime manifest is scoped as runtime; test and pipeline packages
are scoped as development; direct relationships come from the reviewed source inputs and every
other locked package is marked indirect. It supplements the successful configured graph rather
than repairing a versionless graph.

That job alone receives `contents: write`, the permission GitHub requires for dependency
snapshot creation. It checks out without persisted credentials, runs only repository-owned code
from the already-merged commit, accepts only the canonical repository and `refs/heads/main`,
uses a bounded HTTPS response, and never prints the token. GitHub documents user submissions as
the highest-priority dependency evidence for a manifest, ahead of Dependabot graph jobs,
automatic submissions, and static parsing. After every relevant merge, require all of:

1. the API and pipeline tests passed for the exact commit;
2. the dependency-submission job returned a successful snapshot receipt for that commit;
3. the repository dependency graph shows exact, non-null versions from that detector; and
4. affected Dependabot alerts closed automatically from the refreshed evidence.

The 2026-07-17 evidence is complete: configured graph runs `29621047113` (pipeline) and
`29621047299` (API) succeeded for commit `0f6e5181b36784239544545f701dda03a8b8d0c7`;
the repository SBOM exposed the exact `pytest` 9.0.3 and Psycopg 3.3.4 package URLs; alert `#2`
was fixed automatically at `2026-07-17T23:36:35Z`; and main CI run `29621586247` accepted
snapshot `83398229` for commit `716c3ecef29af7a85791972593ee96fca0c7f8af`. Repeat the four
receipts for future dependency changes.

Primary references:

- [npm SBOM command](https://docs.npmjs.com/cli/commands/npm-sbom/)
- [npm clean-install behavior](https://docs.npmjs.com/cli/commands/npm-ci/)
- [GitHub dependency review](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependency-review)
- [GitHub dependency graph evidence priority](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependency-graph-data)
- [GitHub dependency submission endpoint](https://docs.github.com/en/rest/dependency-graph/dependency-submission)
- [GitHub artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)

## Reviewed dependency update procedure

Dependabot proposes npm, Python, and GitHub Action updates weekly. For every update:

1. Confirm the package/repository identity, exact old/new versions, release date, changelog,
   advisory/CVE, integrity/provenance evidence, license, maintainers, and newly added install
   scripts. A familiar name or green bot label is not approval.
2. For npm, change the direct pin/override deliberately, regenerate `package-lock.json` with
   the reviewed npm toolchain, run `npm ci`, regenerate the SBOM, and inspect unexpected
   transitive additions/removals. Do not run an unreviewed blanket force-fix.
3. For Python, update the direct source or constraint deliberately, regenerate with the exact
   checked generator, inspect every resolved version/hash/marker, install into fresh CPython
   3.12 environments using pip hash and binary-only mode, and run the complete API/pipeline
   suites. Never hand-edit a hash to make a failed install pass.
4. For the API base image, verify the official image identity, exact Python patch, multi-platform
   index digest, upstream source revision, OS advisories, and both amd64/arm64 manifests before
   updating the digest. Build and smoke the image; a tag alone is not immutable.
5. For GitHub Actions, resolve the reviewed release tag to its commit, use the full commit SHA,
   and preserve the human-readable version comment.
6. Run secret scanning, Python lock verification, both npm audits, SBOM verification, lint,
   typecheck, all tests, build, mobile tests, Python tests, release verifiers, and the Wrangler
   dry-run as applicable.
7. Release from the immutable reviewed commit through the guarded workflow. Keep migrations,
   runtime-config activation, and dependency publication separate when rollback boundaries
   differ.
8. Record the owner and next review date for any accepted advisory or deprecated component.
   An acceptance needs scope/exploitability evidence, compensating controls, a deadline, and a
   retest—not merely the label “development only.”

Suggested maximum response targets from triage, shortened when exploitation or exposure
demands it:

| Severity/context | Owner action target |
| --- | --- |
| Known exploitation, leaked key, or critical reachable issue | Enable maintenance/kill switch as needed, revoke/contain immediately, and begin a guarded fix or rollback the same day |
| High reachable production issue | Triage immediately and ship/retest within 72 hours unless an earlier incident deadline applies |
| Moderate production or high development/build issue | Assign within one business day and remediate/retest within 14 days |
| Low or unreachable development issue | Document evidence and resolve in the next scheduled monthly security update, no later than 30 days |

## Install-script boundary

The current npm tree contains install hooks for esbuild binaries, optional `fsevents`, Sharp,
`unrs-resolver`, and the local Cloudflare `workerd` runtime. Those hooks execute third-party
code during installation. The repository currently relies on exact lock integrity, review,
and clean ephemeral CI; it does **not** yet claim a cross-version enforced npm install-script
allowlist. Before enabling strict allowlisting, pin one npm CLI version across local, CI, and
Cloudflare builds, approve only exact reviewed package versions, prove the required native
binaries still install on Linux and macOS, and fail on every newly introduced hook.

Python CI and the API image reject source distributions, preventing package build backends and
arbitrary source-build hooks from running during those installs. Wheels can still contain
malicious code and startup behavior; exact hashes and binary-only policy are integrity and
surface-reduction controls, not a sandbox or trust guarantee.

## Optional Python and artifact-provenance open gates

- The exercised FastAPI runtime/test and pipeline CI paths now use exact transitive versions and
  SHA-256 hashes, but the optional Geo/PyTorch research stack remains open. It spans large,
  platform/backend-specific rasterio, pyproj, Torch CPU/CUDA/MPS, and system-library builds;
  create separately tested locks for each approved platform/backend before treating those
  research environments as reproducible. Do not force one misleading universal lock onto them.
- The committed npm SBOM is not a combined Python/OS/Worker inventory. Produce those additional
  inventories, bind them to the release commit, and reconcile license/advisory ownership.
- GitHub and Cloudflare builds are not yet signed deployment provenance. Generate and verify an
  artifact attestation for the actual release bundle, retain the Worker version/deployment ID,
  and prove the attested digest is the deployed digest before marking provenance complete.
- The deprecated Drizzle loader override is tested but remains technical debt. Replace it when
  a reviewed Drizzle release removes the dependency; do not delete the override while the
  vulnerable nested esbuild would return.
- Preserve and re-verify the live `main` required checks, secret-scanning/push-protection,
  private-reporting, Dependabot-security-update, and CodeQL settings; retain the reviewed
  sole-owner emergency-access procedure without weakening ordinary merges.

Until those gates pass, the parent roadmap item covering all-platform reproducible builds,
complete version locks, signed SBOM/provenance, key custody, and restore-tested backups remains
open.

Additional primary references:

- [pip secure installs and hash-checking mode](https://pip.pypa.io/en/stable/topics/secure-installs/)
- [Node.js 22.23.1 release](https://nodejs.org/en/blog/release/v22.23.1)
- [Python 3.12.13 security release](https://www.python.org/downloads/release/python-31213/)
