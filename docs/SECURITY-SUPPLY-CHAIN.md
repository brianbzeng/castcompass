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
| Worker runtime contract | `wrangler.jsonc` fixes `compatibility_date` and the reviewed compatibility flags | Cloudflare implements the runtime; a date pin needs deliberate compatibility review and periodic advancement |
| Direct npm packages | Every direct production and development dependency uses an exact version in `package.json` | A package version can still be malicious or vulnerable; review source/provenance, advisories, licenses, and install scripts |
| Transitive npm tree | `package-lock.json` records exact versions, registry locations, and integrity hashes; CI and release use `npm ci` | Registry availability and npm/client behavior remain external; the hosted runner itself is not bit-for-bit pinned |
| Known npm advisories | Compatible Babel and YAML fixes are forced; the deprecated Drizzle loader's vulnerable esbuild is overridden to tested `0.25.12`; the resulting complete npm tree currently audits clean | Replace the deprecated `@esbuild-kit` loader path when Drizzle removes it; do not leave the override indefinitely without tests |
| GitHub Actions | Every `uses:` reference is a full immutable commit SHA; runner labels are fixed to `ubuntu-24.04` rather than `ubuntu-latest` | GitHub updates the image behind that label; a release still records the workflow run and source commit |
| Pull-request dependency changes | The SHA-pinned GitHub dependency-review action rejects newly introduced high/critical runtime or development advisories on release PRs targeting the default branch | GitHub builds the graph from the default branch, so stacked PRs cannot supply this evidence; make the release check required in repository rules |
| Production npm SBOM | `security/sbom.cdx.json` is a deterministic CycloneDX 1.5 inventory of the lock-resolved production graph, including cross-platform optional variants, and embeds the SHA-256 of `package-lock.json` | It is repository evidence, not a signed deployment attestation or proof of the platform-specific bytes Cloudflare actually ran |
| Secrets | Repository secret scanning and provider-pattern tests run before dependency installation in CI | Provider-side secret scanning, rotation, IAM, and incident drills require account evidence |

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

The dependency-review job separately compares the base and head dependency graphs on pull
requests targeting the default branch. GitHub builds that graph from the default branch, so
stacked successor PRs rely on the mandatory complete-tree/production audits and SBOM gate;
they do not falsely report a dependency-review pass. The release check must block newly
introduced high/critical advisories in runtime or development scope. Both jobs need to be
required in GitHub repository rules before they are production evidence. The release runbook
repeats all repository security checks from the immutable checkout.

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
3. For GitHub Actions, resolve the reviewed release tag to its commit, use the full commit SHA,
   and preserve the human-readable version comment.
4. Run secret scanning, both audits, SBOM verification, lint, typecheck, all tests, build,
   mobile tests, Python tests, release verifiers, and the Wrangler dry-run as applicable.
5. Release from the immutable reviewed commit through the guarded workflow. Keep migrations,
   runtime-config activation, and dependency publication separate when rollback boundaries
   differ.
6. Record the owner and next review date for any accepted advisory or deprecated component.
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

## Python and artifact-provenance open gates

- The API's direct Python dependencies are exact pins, but their transitive wheels are not yet
  locked with local SHA-256 hashes. Pipeline requirements deliberately use compatible ranges
  and are also not a reproducible lock. Build reviewed per-platform lock files and enforce
  pip `--require-hashes`/binary policy before calling Python builds reproducible. Pip documents
  that hash checking is all-or-nothing and requires every transitive dependency to be pinned.
- The committed npm SBOM is not a combined Python/OS/Worker inventory. Produce those additional
  inventories, bind them to the release commit, and reconcile license/advisory ownership.
- GitHub and Cloudflare builds are not yet signed deployment provenance. Generate and verify an
  artifact attestation for the actual release bundle, retain the Worker version/deployment ID,
  and prove the attested digest is the deployed digest before marking provenance complete.
- The deprecated Drizzle loader override is tested but remains technical debt. Replace it when
  a reviewed Drizzle release removes the dependency; do not delete the override while the
  vulnerable nested esbuild would return.
- Make dependency review, secret scanning, audit, SBOM verification, and full CI required checks
  in repository rules and capture production evidence.

Until those gates pass, the parent roadmap item covering reproducible builds, complete version
locks, signed SBOM/provenance, key custody, and restore-tested backups remains open.

Additional primary references:

- [pip secure installs and hash-checking mode](https://pip.pypa.io/en/stable/topics/secure-installs/)
- [Node.js 22.23.1 release](https://nodejs.org/en/blog/release/v22.23.1)
- [Python 3.12.13 security release](https://www.python.org/downloads/release/python-31213/)
