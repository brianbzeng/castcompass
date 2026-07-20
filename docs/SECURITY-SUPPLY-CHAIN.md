# CastingCompass software supply-chain policy

Status: GitHub release-candidate provenance verified; Cloudflare deployment provenance remains open

This policy covers source dependencies, build runtimes, CI actions, dependency review,
software bills of materials, advisory response, and updates. Exact pins reduce unexpected
change; they do not make a component trustworthy forever. Every pin needs a reviewed update
path so security fixes are not frozen out.

## Locked repository baseline

| Boundary | Repository control | Remaining external dependency |
| --- | --- | --- |
| Node build runtime | `.node-version`, GitHub CI, and snapshot automation select Node `22.23.1`; `engines.node` accepts only that patched 22.x floor through the next major boundary | Cloudflare must be verified to honor the file on the exact build; GitHub/Cloudflare host images are mutable services |
| Python test runtimes | The API selector and API CI use exact Python `3.13.14`; the root/pipeline selectors and pipeline workflows retain exact Python `3.12.13` while the larger scientific-platform migration is reviewed separately | GitHub's separate hosted Dependabot resolver is not controlled by these files; Python 3.12 is security-fixes-only, so the remaining pipeline upgrade must finish before support ends |
| API container runtime | The API Dockerfile selects official `python:3.13.14-alpine3.24` by immutable multi-platform index digest, installs only hash-locked wheels, runs non-root, removes pip/ensurepip and the unused vulnerable `tarfile`/`html.parser` modules, and starts without a shell | The exact image still needs weekly re-scanning and prompt adoption of the next stable CPython security release; the container is not the current Cloudflare Worker production path |
| Exercised Python graphs | FastAPI runtime/test and pipeline CI use exact transitive versions from source-bound locks with committed SHA-256 distribution hashes; CI and the API image require hashes and reject source distributions | The package index, pip implementation, host kernel/libc, and wheel contents remain external |
| Approved optional Geo/PyTorch graphs | Separate source-bound, exact, hashed, binary-only locks cover CPython 3.12 on macOS 15+ ARM64 with an MPS-capable Torch wheel and manylinux_2_28 x86-64 with the official CPU-only Torch wheel; a scheduled workflow tests both platform identities, GeoTIFF/CRS behavior, the pipeline suite, and deep smoke | GitHub runner images and package indexes remain external; CUDA, ROCm, Windows, Intel macOS, and other unlisted platforms are not approved or claimed reproducible |
| GitHub Python dependency graph | A main-only job waits for the tested API/pipeline locks, then submits exact versioned PyPI package URLs for all three exercised graphs; user submissions take precedence over incomplete managed/static parses | GitHub owns storage, precedence, and alert refresh; verify the accepted snapshot and alert state after each relevant merge rather than treating a successful upload as the final receipt |
| Worker runtime contract | `wrangler.jsonc` fixes `compatibility_date` and the reviewed compatibility flags | Cloudflare implements the runtime; a date pin needs deliberate compatibility review and periodic advancement |
| Direct npm packages | Every direct production and development dependency uses an exact version in `package.json` | A package version can still be malicious or vulnerable; review source/provenance, advisories, licenses, and install scripts |
| Transitive npm tree | `package-lock.json` records exact versions, registry locations, and integrity hashes; npm `10.9.8` is selected with an exact engine gate, `.npmrc` disables lifecycle scripts, CI/release also pass `--ignore-scripts`, and the exact eight script-bearing lock paths are reviewed in a fail-closed policy | Registry availability, npm implementation integrity, and preinstalled optional native binaries remain external; the hosted runner itself is not bit-for-bit pinned |
| Known npm advisories | Compatible Babel and YAML fixes are forced; the deprecated Drizzle loader's vulnerable esbuild is overridden to tested `0.25.12`; the resulting complete npm tree currently audits clean | Replace the deprecated `@esbuild-kit` loader path when Drizzle removes it; do not leave the override indefinitely without tests |
| GitHub Actions | Every `uses:` reference is a full immutable commit SHA; runner labels are fixed to `ubuntu-24.04` and `macos-15` rather than mutable `-latest` aliases | GitHub updates the images behind those labels; a release still records the workflow run and source commit |
| Default-branch integrity | Live `main` protection requires pull requests, strict successful `api`, `pipeline`, `web`, and `dependency-review` checks from the GitHub Actions app plus the `CodeQL` result from the GitHub Advanced Security app, resolved review conversations, and applies to the owner; force-pushes and branch deletion are disabled | This is provider-side configuration rather than source code; verify it again for the exact release and preserve a separate emergency-access procedure |
| Pull-request dependency changes | The SHA-pinned GitHub dependency-review action rejects newly introduced high/critical runtime or development advisories on release PRs targeting the default branch, and the live `main` protection requires that check | GitHub builds the graph from the default branch, so stacked PRs cannot supply this evidence; the complete-tree audit and SBOM remain mandatory |
| Static analysis | GitHub-managed CodeQL default setup scans Actions, JavaScript/TypeScript, and Python; the Advanced Security `CodeQL` merge result is required on `main`, and findings are reviewed individually rather than bulk-dismissed | GitHub controls the analyzer/runtime and its default query updates; release evidence still records the alert state and each dismissal rationale |
| Production npm SBOM | `security/sbom.cdx.json` is a deterministic CycloneDX 1.5 inventory of the lock-resolved production graph, including cross-platform optional variants, and embeds the SHA-256 of `package-lock.json` | It remains the focused npm input to the combined release inventory; neither document proves the bytes Cloudflare actually ran |
| Combined release inventory | `security/release-sbom.cdx.json` deterministically combines the production npm graph, exact hashed API-runtime and pipeline-CI Python graphs, their distinct Python runtimes, pinned Node/API-image/Alpine identities, the image-security policy, and the repository-declared Worker/D1/assets service contract; every source file is SHA-256-bound and CI rejects drift | Main-branch signing acceptance is recorded below; the OS entry remains identity-level while native package reports are separate workflow evidence, and the Worker entries remain repository contracts rather than deployed-version evidence |
| Native API image evidence | A read-only weekly/change-triggered workflow builds the exact image natively on GitHub's fixed Ubuntu 24.04 AMD64 and ARM64 runners, verifies non-root/minimized runtime behavior and live health, then uses SHA-pinned Syft 1.42.3 and Grype 0.110.0 actions to preserve source-commit-bound raw CycloneDX, vulnerability, and normalized policy reports. A separate dependency-free daily watch compares the reviewed Python version, checksum, source revision, and AMD64/ARM64 publication against Docker Library's primary sources | PR `#81` and the merged `main` run are accepted below. A 2026-07-18 primary-source re-review found no stable 3.13 fix; the owner-bound renewal requires re-review on 2026-08-04 and expires 2026-08-08 while preserving the affected-module removal/import guards. The lightweight watch detects drift but cannot replace the two-architecture native scan required for acceptance |
| Secrets and private reporting | Repository secret scanning and provider-pattern tests run before dependency installation in CI; GitHub secret scanning, push protection, and private vulnerability reporting are enabled | GitHub's extra non-provider-pattern and validity-check options were unavailable in the current account configuration; rotation, IAM, and incident drills still require provider evidence |

The exact Node release is the current patched release selected for the maintained 22.x line,
not a claim that Node 22 should remain forever. The API has moved to maintained Python 3.13.14;
Python 3.12.13 remains only for the scientific pipeline while its broader binary/platform
compatibility is reviewed. Do not let that bounded split turn into an indefinite support gap.

## CI security gates

The web job deliberately orders its gates as follows:

1. scan the checked-out repository for committed credentials before running dependency code;
2. verify the exact npm/install-script policy, then install only the committed npm tree with
   `npm ci --ignore-scripts` so dependency lifecycle code is never executed;
3. reject high/critical advisories anywhere in the npm tree and moderate-or-higher advisories
   in the production tree;
4. regenerate the production CycloneDX document in memory and require an exact match with the
   committed SBOM and lockfile hash;
5. lint, typecheck, build, run all runtime/attack tests, and exercise the mobile browser suite.

The API job installs its CPython 3.13 lock and the pipeline/optional-platform jobs install their
CPython 3.12 locks with pip's all-or-nothing `--require-hashes` mode and
`--only-binary=:all:`. The API job runs its tests;
the pipeline lock also pins Ruff and the validation-compatible numerical/cryptographic graph
before lint, unit tests, and the deterministic smoke workflow. The pip caches are keyed to the
lock files rather than the range/source inputs. The API Dockerfile uses the runtime-only lock,
excluding pytest/httpx, plus the exact Python patch/image digest. Hash checking proves that
downloaded bytes match a committed distribution hash; it does not prove that a package or wheel
is benign. The optional workflow uses distinct macOS ARM64/MPS and Linux x86-64 CPU locks,
validates exact package and platform identity, and runs weekly as well as on relevant changes.
The Linux job's second index is the official PyTorch CPU repository; exact versions and committed
hashes fail closed against unreviewed bytes from either index.
The macOS ARM runner does not provide the exact security-only CPython 3.12.13 release through
`actions/setup-python`, so its job uses immutable `astral-sh/setup-uv` v8.3.2 with exact uv
0.10.11 to install that same Python patch before creating the isolated environment. The action,
uv version, Python version, lock, and hosted execution are all independently pinned; the runner
image, release download services, and Python standalone build remain external dependencies.

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

Run the generator only after `npm ci --ignore-scripts`:

```sh
npm run security:sbom:write
npm run security:sbom
```

The generator takes npm's complete lockfile-only CycloneDX graph and selects component instances
by their exact lockfile package paths, excluding only paths marked strictly development-only by
npm. It merges duplicate package identities and dependency edges, replaces npm's random serial
number with a lock-derived UUIDv5, removes time/tool metadata, sorts components and dependency
edges, normalizes the root component name, and embeds the current `package-lock.json` SHA-256.
Using lockfile path flags rather than the host installation keeps production-optional native
variants deterministic across macOS and Linux without admitting a development-only package that
happens to share a name/version with production. Tests also require every direct runtime package,
unique graph references, and the signer-required deterministic serial number. Review both the
lock diff and SBOM diff in the same pull request. CI rejects a stale SBOM.

The focused npm SBOM intentionally covers the production npm tree only. Development tools remain
visible in `package-lock.json`, the complete-tree audit, and dependency review. The deterministic
combined release SBOM then embeds that npm graph alongside both exercised exact Python graphs,
the pinned Node/distinct-Python/API-container/Alpine identities, and the Worker/D1/assets service
contract. It binds `.node-version`, all three Python selectors, both selected Python locks, the
API Dockerfile, the API image policy,
`package.json`, `package-lock.json`, the focused npm SBOM, and `wrangler.jsonc` by SHA-256. Python
distribution hashes and environment markers remain attached to their package identities. The
release builder archives those inputs and exports the combined document as the SBOM predicate;
the isolated signer rejects a narrowed predicate that lacks Python, container, OS, Worker, or the
explicit non-deployment claim.

This is a source-bound release inventory. The Alpine entry identifies the pinned multi-platform
image index and OS family; package-level contents live in separate per-architecture Syft/Grype
workflow artifacts and are not copied into this deterministic source inventory. The Cloudflare
service entries describe reviewed bindings and compatibility settings but do not identify deployed
bytes, traffic allocation, or provider state. Preserve these limits until deployed-digest evidence
exists.

The image policy's license allowlist is a technical drift-control record of licenses observed and
reviewed for this exact runtime, not legal advice or a conclusion that every distribution obligation
has been fulfilled. Preserve the raw per-package evidence and obtain legal review before making a
commercial licensing or redistribution claim.

## Python lock workflow

`services/api/requirements.txt` is the runtime update input, while
`services/api/requirements-test.in` adds the exact test-only dependencies without putting them
in the API image.
`pipeline/requirements-ci.in` composes the smoke ranges with the validation protocol's exact
overlap constraints, fixes the reviewed pandas behavior, and pins the CI-only Ruff version.
The generated FastAPI runtime/test locks contain exact transitive versions and SHA-256 hashes for
universal CPython 3.13 wheel resolution. `pipeline/requirements-ci.lock` retains the corresponding
CPython 3.12 contract.

The directory-local `services/api/.python-version` deliberately selects Python 3.13.14 while the
root and `pipeline/.python-version` remain byte-identical at Python 3.12.13. The generator enforces
that exact split and resolves each lock for its selected feature series. These files are not a
control over GitHub's hosted resolver: an earlier managed job selected Python 3.14.5 even with a
directory-local file present. The validation protocol remains canonically frozen in
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

The paired numerical review advances NumPy 2.0.2 to
[2.5.1](https://github.com/numpy/numpy/releases/tag/v2.5.1) and SciPy 1.13.1 to
[1.18.0](https://docs.scipy.org/doc/scipy/release/1.18.0-notes.html), while retaining pandas
2.2.3. SciPy is now an explicit direct runtime dependency because the structure pipeline imports
its deterministic neighborhood filters. The exact relief-filter canary, byte-identical seed-42
fixtures, unchanged seed-12/seed-42 folds, and a maximum aggregate delta of `0.000000357` bound
the observed behavior. A clean Python 3.12.13 binary-only, hash-required install passed `pip
check`, Ruff, 62 tests, and the deterministic smoke workflow with both `FutureWarning` and
`DeprecationWarning` treated as errors. PR `#68` then passed hosted dependency review, API,
warning-strict pipeline/smoke, web/mobile, and all CodeQL analyses before merge commit
`6ce2ec37de9f6cbe22f85cae05baff256adb3a51`. Main CI run `29626219455` passed all jobs and
submitted exact dependency snapshot `83445590`; managed graph run `29626220947` and main CodeQL
run `29626219486` succeeded. The SPDX graph contains exact entries for NumPy 2.5.1, SciPy 1.18.0,
scikit-learn 1.9.0, narwhals 2.24.0, and retained pandas 2.2.3. The post-merge audit found zero
open dependency, code-scanning, or secret-scanning alerts. The separate pandas 3 behavior review
remains open.

The pandas review follows the upstream major-upgrade guidance by testing a warning-clean 2.3.3
bridge before advancing 2.2.3 to
[3.0.3](https://pandas.pydata.org/docs/whatsnew/v3.0.3.html). It intentionally rejects
[3.0.4](https://pypi.org/project/pandas/3.0.4/) because PyPI yanked that release for reported
datetime-related segmentation faults. The repository has no chained-assignment dependency, and
an explicit canary binds pandas 3's dedicated string dtype and copy-on-write behavior. Under
Python 3.12.13 with the retained NumPy 2.5.1, SciPy 1.18.0, and scikit-learn 1.9.0 runtime,
pandas 2.2.3, 2.3.3, and 3.0.3 produced byte-identical seed-12 and seed-42 synthetic observation
fixtures and metric artifacts. Both the 2.3.3 bridge and 3.0.3 candidate passed `pip check`, Ruff,
62 tests, and deterministic smoke workflows with `FutureWarning` and `DeprecationWarning` treated
as errors. The regenerated 14-package source-bound lock then passed a clean binary-only,
hash-required install, `pip check`, Ruff, 63 warning-strict tests including the new canary, and
both deterministic seeds. PR `#70` then passed hosted dependency review, API, warning-strict
pipeline/smoke, web/mobile, and all CodeQL analyses before merge commit
`3d5751b3ec8ce0f263fd9afebe4a6018315a63c3`. Main CI run `29626959333` passed every job and
submitted exact dependency snapshot `83447588`; managed graph run `29626961391` and main CodeQL
run `29626959344` succeeded. The SPDX graph contains exact entries for pandas 3.0.3, NumPy 2.5.1,
SciPy 1.18.0, scikit-learn 1.9.0, and narwhals 2.24.0. The post-merge audit found zero open
dependency, code-scanning, or secret-scanning alerts. Future optional-platform locks remain open.

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
   the reviewed npm toolchain, run `npm ci --ignore-scripts`, regenerate the SBOM, and inspect unexpected
   transitive additions/removals. Do not run an unreviewed blanket force-fix.
3. For Python, update the direct source or constraint deliberately, regenerate with the exact
   checked generator, inspect every resolved version/hash/marker, install into fresh environments
   matching the selected CPython 3.13 API and CPython 3.12 pipeline runtimes using pip hash and
   binary-only mode, and run the complete API/pipeline suites. Never hand-edit a hash to make a
   failed install pass.
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

The current npm tree declares install hooks for esbuild binaries, optional `fsevents`, Sharp,
`unrs-resolver`, and the local Cloudflare `workerd` runtime. CastingCompass pins npm `10.9.8`,
sets `engine-strict=true` and `ignore-scripts=true`, passes `--ignore-scripts` explicitly in CI
and release jobs, and binds all eight exact script-bearing lock paths, versions, integrity
digests, development/optional flags, and a `disabled` disposition in
`security/npm-install-policy.json`. The pre-install verifier rejects npm/Node drift, root
install lifecycle hooks, workflow overrides, a newly introduced hook, or stale policy. A fresh
macOS ARM64 install with hooks disabled completed the Cloudflare build; hosted Linux CI must
repeat the same proof before merge. This is a no-execution boundary (0 hooks executed), not a
claim that optional native binaries or npm itself are trustworthy or sandboxed.

Python CI and the API image reject source distributions, preventing package build backends and
arbitrary source-build hooks from running during those installs. Wheels can still contain
malicious code and startup behavior; exact hashes and binary-only policy are integrity and
surface-reduction controls, not a sandbox or trust guarantee.

## Optional Python and artifact-provenance gates

- The approved optional Geo/PyTorch environments now have separate, source-bound locks for
  macOS 15+ ARM64 with an MPS-capable Torch wheel and manylinux_2_28 x86-64 CPU. Both use exact
  transitive versions, committed SHA-256 distribution hashes, binary-only installs, platform
  identity checks, GeoTIFF/CRS canaries, pipeline tests, and deep smoke. This closes only those
  two named environments. CUDA, ROCm, Windows, Intel macOS, other Linux ABIs/architectures, and
  unlisted system-library combinations remain open and must receive their own reviewed locks
  and execution evidence before anyone calls them reproducible. Do not force one misleading
  universal lock onto platform-specific research stacks.
  Immutable acceptance evidence is PR `#72`, merged as
  `0433cb6e67acdee5a6891ddce2cc57e3b46dc2d7`. Its final head passed protected CI run
  `29627906264`, optional-platform run `29627906268`, and CodeQL run `29627905185`.
  The merged commit then passed main CI run `29628030773`, submitted exact Python dependency
  snapshot `83450872`, passed optional-platform run `29628030735` on both macOS ARM64 and Linux
  x86-64 CPU, and passed CodeQL run `29628030502`. After those receipts, GitHub reported zero
  open Dependabot, code-scanning, or secret-scanning alerts. This evidence covers only the two
  named platform/backend combinations and does not broaden the exclusions above.
- The deterministic combined release SBOM covers the selected npm/Python graphs plus
  identity-level API image/OS and Worker service contracts. Immutable acceptance evidence is PR
  `#79`, merged as `d98d947360df4845901ca95c921b9e10733f6aaa`. Main release-provenance run
  `29630783417` passed both isolated jobs; GitHub artifact `8425375002` retains the exact
  four-file candidate through 2026-10-16 with artifact-record SHA-256
  `ba2b91b263e4697ac379da74a04cd52022fa3cd62b10a22edfaac64b0d42b1c9`.
  A fresh download passed every strict `SHA256SUMS` entry and the independent verifier. Its
  124-file bundle SHA-256 is
  `5a106e016c15ae269a7dc1b28ebdb04f281e125dfb63456b03f20b2b43938805`; its external
  combined-SBOM SHA-256 is
  `bccfc8e094de5fe3783d8c834ae9782ef70c9354999956c562454588eae57d0a`.
  The verified CycloneDX 1.5 document has deterministic serial
  `urn:uuid:e5a7eff3-a84d-5cb3-acf9-46bf3009efdd`, 127 components, 37 unique PyPI
  components, three services, and the exact claim `source-bound release inventory; not
  Cloudflare deployment provenance`. Identity-constrained `gh attestation verify` accepted SLSA
  attestation `35937141` and CycloneDX attestation `35937144` only for the exact repository,
  signer workflow, `main` ref, source/signer commit, and GitHub-hosted runner; their Rekor indexes
  are `2193447569` and `2193447815`. Main CI `29630783432` passed web/mobile, API, pipeline,
  and exact Python dependency snapshot `83457741`; CodeQL `29630783254` passed Actions,
  JavaScript/TypeScript, and Python. GitHub then reported zero open Dependabot, code-scanning,
  or secret-scanning alerts. At that immutable `#79` receipt, this closed only the
  source-bound combined inventory; package-level Debian image scanning, deployed Worker digest proof, and
  license/advisory reconciliation were still open. PR `#81`, accepted separately below, closes
  that package/license/advisory image gate with a pinned, minimized Alpine image. Deployed Worker
  digest proof remains separate open work.
- The native package-level API image gate is accepted at PR `#81`, whose exact final head
  `7de5d51c3e8b7d02faff242ad2acc33d6e04441a` merged as
  `73d0e3ca879a609673ba57188f59b37f541083a5`. Exact-head run `29632875263` passed native AMD64
  and ARM64 jobs. GitHub artifacts `8426086733` and `8426089424` retain each raw CycloneDX SBOM,
  raw Grype report, and normalized policy summary through 2026-08-17 with artifact-record SHA-256
  digests `4331f2e2cb42ce8f8dcb9b87db7c6226232e3920cc292091d803807cc93a9926` and
  `8da2626488dd82db553465300b9117d6d3e0da6c7aa2e0d4e2b5de7544ac8875`. Fresh downloads bound
  the exact head and independently confirmed, per architecture, the exact 29-package APK graph,
  22 applicable hash-locked Python packages, 19 observed license expressions plus two explicit
  missing-metadata reviews, and 11 vulnerability matches: 8 medium, 3 reviewed high, and 0
  critical. The three high exceptions remain bounded by removed/import-guarded modules. Their
  original acceptance expired 2026-08-01.

  A fresh 2026-07-18 primary-source review found Python 3.13.14 still the latest stable 3.13
  release and the Docker Official Image still bound to the same exact source revision and
  multi-platform digest. Backport pull requests exist upstream for all three fixes, but PEP 719
  schedules Python 3.13.15 for 2026-08-04. The policy therefore permits only an owner-bound renewal through
  2026-08-08: re-review is mandatory on the scheduled release date, stable-series fixes are
  rejected immediately when Grype reports them, and the four-day grace is only for Docker
  Official Image publication plus native AMD64/ARM64 verification. The verifier rejects a
  missing owner, non-primary sources, a mismatched runtime, a later-series gap, an unbound
  exception date, or more than seven days of post-release grace.

  The heavy native workflow runs on Monday. Because the scheduled 3.13.15 release is Tuesday
  and the four-day adoption boundary ends Saturday, a separate daily watch closes that cadence
  gap. It fetches only the reviewed raw Docker Library `versions.json`, exact-variant Dockerfile,
  and Official Images manifest with time and response-size bounds; installs no dependencies,
  pulls no image, grants no write authority, and fails immediately if the maintained version,
  source checksum, source revision, publication directory, required aliases, or AMD64/ARM64
  coverage drifts. A passing watch means only that the pinned upstream identity is unchanged.
  A fixed image still requires policy replacement plus fresh native evidence on both
  architectures, so issue `#86` remains open through that acceptance.

  The bounded renewal is accepted at PR `#90`, whose exact final head
  `f20c210bb8014baee62c9bf09010a3d5a99c5d97` merged as
  `f1a6579ca97fa509b0b1ac1367c6fa7e4c644104`. Exact-head image-security run `29652969712`
  passed both architectures; AMD64 artifact `8432023776` and ARM64 artifact `8432025040`
  preserve the raw SBOM, Grype report, and normalized policy summary with artifact-record
  SHA-256 digests `a972eeb814fcdb28a56ca20b676645b0ba5c58d50a9fd3f19a9b34075cf77320` and
  `cfdd3f5a3d8ccea37ce051a1ded26474c96010434814da4e02759161423621de`. Exact-head CI
  `29652969717`, release-provenance `29652969706`, and CodeQL `29652968953` also passed.

  Main image-security run `29653146520` repeated the proof for the merge commit. AMD64 artifact
  `8432074834` and ARM64 artifact `8432075433`, retained through 2026-08-17, have artifact-record
  SHA-256 digests `a82c248231ddf83164aad84563b3c5703951f6c39c409b2b71885daa7757b060` and
  `c9eaa3426e90188c0db8015a06018c0fffd20d072b71b4f77a7590ca0b0b2591`. Each architecture
  contains 29 APK packages and 22 applicable locked Python packages, with 11 matches: 8 medium,
  3 reviewed high, and 0 critical. Both used Grype database v6.1.9 built
  2026-07-18T06:48:35Z and enforced the named owner plus 2026-08-08 expiry. Main CI
  `29653146497`, release-provenance `29653146479`, and CodeQL `29653146307` passed; GitHub then
  reported zero open Dependabot, code-scanning, or secret-scanning alerts. Issue `#86` remains
  open for the mandatory 2026-08-04 re-review, and the production/Cloudflare hold is unchanged.

  The original acceptance's main image-security run `29633038674` repeated the proof for its
  merge commit. Artifacts
  `8426143583` and `8426146269`, with artifact-record SHA-256 digests
  `c5a00cea9e2780dccfb08a59d740f348d945b48706c53ef670efe5d2e36c741e` and
  `8a74ca502ee57568e11a71b60291c7252a557a13b8cdb74b09784288a81199b0`, preserve matching
  source-bound summaries through 2026-08-17. Main CI `29633038669` passed web/mobile, API, and
  pipeline and submitted exact Python dependency snapshot `83465511`; release-provenance run
  `29633038673`, optional-platform run `29633038688`, and CodeQL run `29633038335` passed.
  CodeQL alert `#4` was remediated in source and became fixed without dismissal before merge;
  GitHub then reported zero open Dependabot, code-scanning, or secret-scanning alerts. These
  receipts cover the repository's API container image, not the Cloudflare Worker production path
  or deployed bytes.
- The checked-in GitHub workflow produces a deterministic release candidate from `main`
  containing the built Worker, static assets, reviewed Wrangler configuration, migrations,
  exact lock, and committed CycloneDX SBOM. The bundle embeds the repository, full commit,
  exact Node/npm toolchain, and production-build switches; its external manifest binds the
  bundle, lock, and SBOM hashes. A read-only build job
  uploads the four-file candidate. A separate main-only job receives `id-token` and `attestations`
  write access, runs no repository or dependency code, verifies the exact file set and checksums,
  and uses immutable GitHub-owned `actions/attest` code to generate both SLSA provenance and SBOM
  attestations. Pull requests exercise bundle determinism and the signing isolation contract but
  cannot sign. This is GitHub release-candidate provenance, not Cloudflare deployment provenance.
  Retain the Worker version/deployment ID, download and verify the exact attested subject, and prove
  its digest is the digest actually deployed before marking end-to-end provenance complete.
  Immutable acceptance evidence is corrective PR `#77`, merged as
  `fa73c4dd4162b6834113f40a6f77be6907bdd202`. The earlier main run `29629257653`
  successfully created build-provenance attestation `35934303` but rejected the CycloneDX
  predicate because npm's random serial had been removed; that partial failure was not counted
  as acceptance. PR `#77` added a lock-derived UUIDv5, exact lock-path production filtering,
  unique/closed graph checks, and signer-side serial validation. Main release-provenance run
  `29629689167` then passed both isolated jobs. GitHub artifact `8425041514` retains the exact
  four-file candidate through 2026-10-16 with artifact-record SHA-256
  `4b6fc55cda0ce11d130bf991db01d880c3753e1fc53a8e8af824fb6f4508525a`.
  Its 118-file bundle SHA-256 is
  `e2d8b79a39a28c9ae97ba1c384e1f8eacffe95275ea6b7eaf79d3baee8f12ad0`, and its
  external SBOM SHA-256 is
  `f912bd94f5b8c158f8cf198097ef9ce2bee11770f462786478e05a38aa167a0f`.
  A fresh download passed all three `SHA256SUMS` entries and the independent archive/manifest
  verifier. `gh attestation verify` accepted build-provenance attestation `35935237` and
  CycloneDX attestation `35935240` only with the exact repository, signer workflow, `main`
  source ref, source/signer commit, and GitHub-hosted-runner constraints; their Rekor indexes
  are `2193382355` and `2193382365`. Main CI run `29629689192` passed web/mobile, API,
  pipeline, and exact Python dependency snapshot `83454900`; CodeQL run `29629688765` passed
  Actions, JavaScript/TypeScript, and Python. GitHub then reported zero open Dependabot,
  code-scanning, or secret-scanning alerts. None of this proves a Cloudflare deployment.
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
- [Python 3.13.14 security release](https://www.python.org/downloads/release/python-31314/)
- [Python 3.13 release schedule](https://peps.python.org/pep-0719/)
- [Docker Official Image source of truth](https://github.com/docker-library/official-images/blob/master/library/python)
- [Syft SBOM action](https://github.com/anchore/sbom-action)
- [Grype scan action](https://github.com/anchore/scan-action)
- [CPython CVE-2026-11940 tracking](https://github.com/python/cpython/issues/151558)
- [CPython CVE-2026-11972 tracking](https://github.com/python/cpython/issues/151981)
- [CPython CVE-2026-15308 tracking](https://github.com/python/cpython/issues/153030)
