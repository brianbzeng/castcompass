import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

test("direct npm packages and build runtimes are exact reviewed versions", async () => {
  const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const lock = JSON.parse(await readFile(new URL("package-lock.json", root), "utf8"));
  for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
    assert.match(version, exactVersion, `${name} must use an exact direct version`);
    const scope = Object.hasOwn(manifest.dependencies, name) ? "dependencies" : "devDependencies";
    assert.equal(lock.packages[""][scope][name], version);
  }
  assert.equal(manifest.engines.node, ">=22.23.1 <23");
  assert.equal(await readFile(new URL(".node-version", root), "utf8"), "22.23.1\n");
  assert.equal(await readFile(new URL(".python-version", root), "utf8"), "3.12.13\n");
  assert.equal(await readFile(new URL("services/api/.python-version", root), "utf8"), "3.12.13\n");
  assert.equal(await readFile(new URL("pipeline/.python-version", root), "utf8"), "3.12.13\n");

  const reactFramework = {
    next: "16.2.10",
    react: "19.2.7",
    "react-dom": "19.2.7",
    "eslint-config-next": "16.2.10",
    "react-server-dom-webpack": "19.2.7",
  };
  for (const [name, version] of Object.entries(reactFramework)) {
    assert.equal(manifest.dependencies[name] ?? manifest.devDependencies[name], version);
    assert.equal(lock.packages[`node_modules/${name}`].version, version);
  }
  const buildToolchain = {
    "@cloudflare/vite-plugin": "1.45.1",
    "@vitejs/plugin-react": "6.0.3",
    wrangler: "4.112.0",
  };
  for (const [name, version] of Object.entries(buildToolchain)) {
    assert.equal(manifest.devDependencies[name], version);
    assert.equal(lock.packages[`node_modules/${name}`].version, version);
  }
  assert.equal(
    lock.packages["node_modules/@cloudflare/vite-plugin"].peerDependencies.wrangler,
    "^4.112.0",
  );
  assert.equal(manifest.devDependencies.ajv, "8.20.0");
  assert.equal(manifest.devDependencies["ajv-formats"], "3.0.1");
  assert.equal(lock.packages["node_modules/ajv-formats"].peerDependencies.ajv, "^8.0.0");
  const dependabot = await readFile(new URL(".github/dependabot.yml", root), "utf8");
  assert.match(
    dependabot,
    /react-framework:[\s\S]+next[\s\S]+eslint-config-next[\s\S]+react[\s\S]+react-dom[\s\S]+react-server-dom-webpack/,
  );
  assert.match(dependabot, /cloudflare-toolchain:[\s\S]+@cloudflare\/vite-plugin[\s\S]+wrangler/);
  assert.match(dependabot, /tailwind-toolchain:[\s\S]+@tailwindcss\/postcss[\s\S]+tailwindcss/);
  assert.match(dependabot, /dependency-name: eslint[\s\S]+version-update:semver-major/);

  assert.equal(lock.packages["node_modules/@babel/core"].version, "7.29.7");
  assert.equal(lock.packages["node_modules/js-yaml"].version, "4.3.0");
  assert.equal(
    lock.packages["node_modules/@esbuild-kit/core-utils/node_modules/esbuild"].version,
    "0.25.12",
  );
});

test("CI fixes runner versions and enforces dependency review, audits, and SBOM verification", async () => {
  const ci = await readFile(new URL(".github/workflows/ci.yml", root), "utf8");
  const refresh = await readFile(new URL(".github/workflows/refresh-snapshot.yml", root), "utf8");
  assert.doesNotMatch(`${ci}\n${refresh}`, /ubuntu-latest|node-version:\s*22\s*$|python-version:\s*["']?3\.12["']?\s*$/m);
  assert.equal((`${ci}\n${refresh}`.match(/node-version:\s*22\.23\.1/g) ?? []).length, 3);
  assert.equal((`${ci}\n${refresh}`.match(/python-version:\s*["']3\.12\.13["']/g) ?? []).length, 3);
  assert.match(ci, /actions\/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294/);
  assert.match(ci, /fail-on-severity:\s*high/);
  assert.match(ci, /github\.base_ref\s*==\s*github\.event\.repository\.default_branch/);
  assert.match(ci, /npm run security:secrets[\s\S]+npm ci[\s\S]+npm run security:dependencies[\s\S]+npm run security:sbom/);
  assert.equal((ci.match(/--only-binary=:all: --require-hashes/g) ?? []).length, 2);
  assert.match(ci, /services\/api\/requirements-test\.lock/);
  assert.match(ci, /pipeline\/requirements-ci\.lock/);
  assert.match(
    ci,
    /python -W error::FutureWarning -W error::DeprecationWarning -m unittest discover -s pipeline\/tests -v/,
  );
  assert.doesNotMatch(ci, /pip install ruff|pip install -r .*requirements-(?:smoke|ci)\.txt/);

  const generator = await readFile(new URL("scripts/generate-sbom.mjs", root), "utf8");
  assert.equal((generator.match(/--package-lock-only/g) ?? []).length, 2);
});

test("Python API and pipeline installs use exact source-bound wheel hashes", async () => {
  const verifier = spawnSync(process.execPath, ["scripts/generate-python-locks.mjs", "--check"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(verifier.status, 0, verifier.stderr);
  assert.match(verifier.stdout, /FastAPI runtime Python lock verified \(\d+ exact hashed packages\)/);
  assert.match(verifier.stdout, /FastAPI test Python lock verified \(32 exact hashed packages\)/);
  assert.match(verifier.stdout, /pipeline CI Python lock verified \(15 exact hashed packages\)/);

  const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.match(manifest.scripts.security, /security:python-locks/);
  assert.match(manifest.scripts["security:python-locks"], /generate-python-locks\.mjs --check/);

  const dockerfile = await readFile(new URL("services/api/Dockerfile", root), "utf8");
  assert.match(dockerfile, /^FROM python:3\.12\.13-slim-bookworm@sha256:[a-f0-9]{64} AS runtime$/m);
  assert.match(dockerfile, /--only-binary=:all: --require-hashes/);
  assert.match(dockerfile, /services\/api\/requirements-runtime\.lock/);
  assert.doesNotMatch(dockerfile, /requirements\.txt|\bRUN pip\b/);
  assert.doesNotMatch(dockerfile, /requirements-test|pytest|httpx/);

  const dependabot = await readFile(new URL(".github/dependabot.yml", root), "utf8");
  assert.match(dependabot, /package-ecosystem: docker[\s\S]+directory: \/services\/api/);
  assert.match(dependabot, /fastapi-stack:[\s\S]+fastapi[\s\S]+starlette/);
  assert.match(dependabot, /psycopg-family:[\s\S]+psycopg-binary[\s\S]+psycopg-pool/);

  const apiRequirements = await readFile(new URL("services/api/requirements.txt", root), "utf8");
  assert.match(apiRequirements, /^fastapi==0\.139\.2$/m);
  assert.match(apiRequirements, /^psycopg\[binary\]==3\.3\.4$/m);
  assert.match(apiRequirements, /^psycopg-pool==3\.3\.1$/m);
  assert.match(apiRequirements, /^starlette==1\.3\.1$/m);
  const apiTestRequirements = await readFile(
    new URL("services/api/requirements-test.in", root),
    "utf8",
  );
  assert.match(apiTestRequirements, /^httpx2==2\.7\.0$/m);
  assert.doesNotMatch(apiTestRequirements, /^httpx==/m);

  const validationLock = await readFile(new URL("pipeline/requirements-validation.lock", root));
  const validationConstraints = await readFile(new URL("pipeline/requirements-validation.txt", root));
  assert.deepEqual(validationConstraints, validationLock);
  assert.match(validationLock.toString(), /^narwhals==2\.24\.0$/m);
  assert.match(validationLock.toString(), /^numpy==2\.5\.1$/m);
  assert.match(validationLock.toString(), /^scikit-learn==1\.9\.0$/m);
  assert.match(validationLock.toString(), /^scipy==1\.18\.0$/m);
  assert.match(await readFile(new URL("pipeline/requirements-smoke.txt", root), "utf8"), /^scipy>=1\.18,<2$/m);
  const pipelineInput = await readFile(new URL("pipeline/requirements-ci.in", root), "utf8");
  assert.match(pipelineInput, /^-c requirements-validation\.txt$/m);
  assert.doesNotMatch(pipelineInput, /^-c .*\.lock$/m);
  assert.match(dependabot, /scientific-runtime:[\s\S]+numpy[\s\S]+scipy[\s\S]+scikit-learn[\s\S]+pandas/);
});

test("the deterministic production SBOM is bound to the lock and direct runtime packages", async () => {
  const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const lockBytes = await readFile(new URL("package-lock.json", root));
  const sbom = JSON.parse(await readFile(new URL("security/sbom.cdx.json", root), "utf8"));
  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.equal(sbom.specVersion, "1.5");
  assert.equal("serialNumber" in sbom, false);
  assert.equal("timestamp" in sbom.metadata, false);
  assert.equal(sbom.metadata.component.name, manifest.name);
  assert.deepEqual(sbom.metadata.properties, [{
    name: "castingcompass:package-lock-sha256",
    value: createHash("sha256").update(lockBytes).digest("hex"),
  }]);

  const components = new Map(sbom.components.map((component) => [component.name, component.version]));
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    assert.equal(components.get(name), version, `production SBOM is missing ${name}@${version}`);
  }
  const references = sbom.components.map((component) => component["bom-ref"]);
  assert.deepEqual(references, [...references].sort((left, right) => left.localeCompare(right)));
});

test("the supply-chain runbook closes exercised Python locks but keeps optional and provenance gates open", async () => {
  const policy = await readFile(new URL("docs/SECURITY-SUPPLY-CHAIN.md", root), "utf8");
  assert.match(policy, /does? \*\*not\*\* yet claim a cross-version enforced npm install-script/i);
  assert.match(policy, /FastAPI runtime\/test and pipeline CI[\s\S]+exact transitive versions[\s\S]+SHA-256/i);
  assert.match(policy, /optional Geo\/PyTorch[\s\S]+remains open/i);
  assert.match(policy, /not yet signed deployment provenance/i);
  assert.match(policy, /stacked successor PRs[\s\S]+do not falsely report a dependency-review pass/i);
  assert.match(policy, /directory-local `services\/api\/\.python-version`[\s\S]+not a control over GitHub's[\s\S]+hosted resolver/i);
  assert.match(policy, /byte-identical transport mirror[\s\S]+managed parser/i);
  assert.match(
    policy,
    /Pipeline Dependabot proposals are advisory inputs[\s\S]+mirror-only[\s\S]+failed[\s\S]+byte-identity contract/i,
  );
  assert.match(
    policy,
    /NumPy 2\.0\.2 to[\s\S]+2\.5\.1[\s\S]+SciPy 1\.13\.1 to[\s\S]+1\.18\.0[\s\S]+maximum aggregate delta of `0\.000000357`/i,
  );
  assert.match(policy, /exact GitHub Python dependency snapshot[\s\S]+SPDX `versionInfo`/i);
  assert.match(policy, /alert `#2`[\s\S]+changed to fixed[\s\S]+without dismissal/i);
  assert.match(
    policy,
    /29622373929[\s\S]+snapshot `83408257`[\s\S]+29622376160[\s\S]+alerts `#3` through `#14`[\s\S]+fixed[\s\S]+no dismissal/i,
  );
  assert.doesNotMatch(policy, /SBOM[^\n]+null (?:package )?version/i);
  assert.match(policy, /user submissions[\s\S]+highest-priority dependency evidence/i);
  assert.match(policy, /parent roadmap item[\s\S]+remains\s+open/i);
});
