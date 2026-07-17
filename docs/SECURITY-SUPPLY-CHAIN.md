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
| Python test runtime | `.python-version` and every GitHub workflow select Python `3.12.13` | Python 3.12 is security-fixes-only; a tested feature-series upgrade is still required before its support ends |
| API container runtime | The API Dockerfile selects the official `python:3.12.13-slim-bookworm` multi-platform image by immutable index digest | The pinned OS/Python image needs weekly reviewed Docker updates; the container is not the current Cloudflare Worker production path |
| Exercised Python graphs | FastAPI runtime/test and pipeline CI use exact transitive versions from source-bound locks with committed SHA-256 distribution hashes; CI and the API image require hashes and reject source distributions | The package index, pip implementation, host kernel/libc, and wheel contents remain external; optional Geo/PyTorch platforms need separate locks |
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
tests above.

Primary references:

- [npm SBOM command](https://docs.npmjs.com/cli/commands/npm-sbom/)
- [npm clean-install behavior](https://docs.npmjs.com/cli/commands/npm-ci/)
- [GitHub dependency review](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependency-review)
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
