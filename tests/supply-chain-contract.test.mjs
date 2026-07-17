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
  assert.equal((`${ci}\n${refresh}`.match(/node-version:\s*22\.23\.1/g) ?? []).length, 2);
  assert.equal((`${ci}\n${refresh}`.match(/python-version:\s*["']3\.12\.13["']/g) ?? []).length, 3);
  assert.match(ci, /actions\/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294/);
  assert.match(ci, /fail-on-severity:\s*high/);
  assert.match(ci, /github\.base_ref\s*==\s*github\.event\.repository\.default_branch/);
  assert.match(ci, /npm run security:secrets[\s\S]+npm ci[\s\S]+npm run security:dependencies[\s\S]+npm run security:sbom/);
  assert.equal((ci.match(/--only-binary=:all: --require-hashes/g) ?? []).length, 2);
  assert.match(ci, /services\/api\/requirements-test\.lock/);
  assert.match(ci, /pipeline\/requirements-ci\.lock/);
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
  assert.match(verifier.stdout, /FastAPI test Python lock verified \(31 exact hashed packages\)/);
  assert.match(verifier.stdout, /pipeline CI Python lock verified \(14 exact hashed packages\)/);

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
  assert.match(policy, /parent roadmap item[\s\S]+remains\s+open/i);
});
