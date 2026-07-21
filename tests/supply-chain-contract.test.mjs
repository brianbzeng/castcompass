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
  assert.equal(manifest.engines.npm, "10.9.8");
  assert.equal(manifest.packageManager, "npm@10.9.8");
  assert.equal(await readFile(new URL(".node-version", root), "utf8"), "22.23.1\n");
  assert.equal(await readFile(new URL(".python-version", root), "utf8"), "3.12.13\n");
  assert.equal(await readFile(new URL("services/api/.python-version", root), "utf8"), "3.13.14\n");
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
  const tailwindToolchain = {
    "@tailwindcss/postcss": "4.3.3",
    tailwindcss: "4.3.3",
  };
  for (const [name, version] of Object.entries(tailwindToolchain)) {
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

test("npm installs execute no dependency lifecycle scripts and fail on lock drift", async () => {
  assert.equal(
    await readFile(new URL(".npmrc", root), "utf8"),
    "engine-strict=true\nignore-scripts=true\n",
  );
  const policy = JSON.parse(await readFile(
    new URL("security/npm-install-policy.json", root),
    "utf8",
  ));
  assert.equal(policy.packageManager.version, "10.9.8");
  assert.equal(policy.packageManager.nodeVersion, "22.23.1");
  assert.equal(policy.installScripts.default, "disabled");
  assert.equal(policy.installScripts.reviewedScriptBearingPackages.length, 8);
  assert.equal(
    policy.installScripts.reviewedScriptBearingPackages.every(
      (entry) => entry.execution === "disabled" && entry.integrity.startsWith("sha512-"),
    ),
    true,
  );

  const verifier = spawnSync(process.execPath, ["scripts/verify-npm-install-policy.mjs"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(verifier.status, 0, verifier.stderr);
  assert.match(verifier.stdout, /npm 10\.9\.8 install policy verified \(8 reviewed hooks, 0 executed\)/);

  const ci = await readFile(new URL(".github/workflows/ci.yml", root), "utf8");
  const release = await readFile(new URL(".github/workflows/release-provenance.yml", root), "utf8");
  for (const workflow of [ci, release]) {
    assert.match(
      workflow,
      /node scripts\/verify-npm-install-policy\.mjs[\s\S]+npm ci --ignore-scripts/,
    );
    assert.doesNotMatch(workflow, /--ignore-scripts(?:=|\s+)false/);
  }
});

test("CI fixes runner versions and enforces dependency review, audits, and SBOM verification", async () => {
  const ci = await readFile(new URL(".github/workflows/ci.yml", root), "utf8");
  const refresh = await readFile(new URL(".github/workflows/refresh-snapshot.yml", root), "utf8");
  const optional = await readFile(new URL(".github/workflows/optional-python.yml", root), "utf8");
  assert.doesNotMatch(`${ci}\n${refresh}\n${optional}`, /(?:ubuntu|macos)-latest|node-version:\s*22\s*$|python-version:\s*["']?3\.12["']?\s*$/m);
  assert.equal((`${ci}\n${refresh}`.match(/node-version:\s*22\.23\.1/g) ?? []).length, 3);
  assert.equal((`${ci}\n${refresh}\n${optional}`.match(/python-version:\s*["']3\.12\.13["']/g) ?? []).length, 4);
  assert.equal((ci.match(/python-version:\s*["']3\.13\.14["']/g) ?? []).length, 1);
  assert.match(ci, /actions\/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294/);
  assert.match(ci, /fail-on-severity:\s*high/);
  assert.match(ci, /github\.base_ref\s*==\s*github\.event\.repository\.default_branch/);
  assert.match(ci, /npm run security:secrets[\s\S]+verify-npm-install-policy[\s\S]+npm ci --ignore-scripts[\s\S]+npm run security:dependencies[\s\S]+npm run security:sbom[\s\S]+npm run security:release-sbom/);
  assert.equal((ci.match(/--only-binary=:all: --require-hashes/g) ?? []).length, 2);
  assert.match(ci, /services\/api\/requirements-test\.lock/);
  assert.match(ci, /pipeline\/requirements-ci\.lock/);
  assert.match(
    ci,
    /python -W error::FutureWarning -W error::DeprecationWarning -m unittest discover -s pipeline\/tests -v/,
  );
  assert.doesNotMatch(ci, /pip install ruff|pip install -r .*requirements-(?:smoke|ci)\.txt/);

  const generator = await readFile(new URL("scripts/generate-sbom.mjs", root), "utf8");
  assert.equal((generator.match(/--package-lock-only/g) ?? []).length, 1);
  assert.match(generator, /package_\?\.dev !== true[\s\S]+cdx:npm:package:path/);
});

test("Python API and pipeline installs use exact source-bound wheel hashes", async () => {
  const verifier = spawnSync(process.execPath, ["scripts/generate-python-locks.mjs", "--check"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(verifier.status, 0, verifier.stderr);
  assert.match(verifier.stdout, /FastAPI runtime Python lock verified \(\d+ exact hashed packages\)/);
  assert.match(verifier.stdout, /FastAPI test Python lock verified \(32 exact hashed packages\)/);
  assert.match(verifier.stdout, /pipeline CI Python lock verified \(14 exact hashed packages\)/);
  assert.match(verifier.stdout, /Geo\/deep macOS ARM64 Python lock verified \(31 exact hashed packages\)/);
  assert.match(verifier.stdout, /Geo\/deep Linux x86-64 CPU Python lock verified \(31 exact hashed packages\)/);

  const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.match(manifest.scripts.security, /security:python-locks/);
  assert.match(manifest.scripts["security:python-locks"], /generate-python-locks\.mjs --check/);

  const dockerfile = await readFile(new URL("services/api/Dockerfile", root), "utf8");
  assert.match(
    dockerfile,
    /^FROM python:3\.13\.14-alpine3\.24@sha256:399babc8b49529dabfd9c922f2b5eea81d611e4512e3ed250d75bd2e7683f4b0 AS runtime$/m,
  );
  assert.match(dockerfile, /--only-binary=:all: --require-hashes/);
  assert.match(dockerfile, /services\/api\/requirements-runtime\.lock/);
  assert.match(dockerfile, /python -m pip check/);
  assert.match(dockerfile, /\/usr\/local\/bin\/pip\*/);
  assert.match(dockerfile, /\/usr\/local\/lib\/python3\.13\/tarfile\.py/);
  assert.match(dockerfile, /\/usr\/local\/lib\/python3\.13\/html\/parser\.py/);
  assert.match(dockerfile, /^CMD \["python", "-m", "app\.server"\]$/m);
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
  const pipelineRanges = await readFile(new URL("pipeline/requirements-smoke.txt", root), "utf8");
  assert.match(pipelineRanges, /^scipy>=1\.18,<2$/m);
  assert.match(pipelineRanges, /^pandas>=3\.0\.3,<4$/m);
  const pipelineInput = await readFile(new URL("pipeline/requirements-ci.in", root), "utf8");
  assert.match(pipelineInput, /^-c requirements-validation\.txt$/m);
  assert.match(pipelineInput, /^pandas==3\.0\.3$/m);
  assert.doesNotMatch(pipelineInput, /^-c .*\.lock$/m);
  const pipelineLock = await readFile(new URL("pipeline/requirements-ci.lock", root), "utf8");
  assert.match(pipelineLock, /^pandas==3\.0\.3\s+\\$/m);
  assert.doesNotMatch(pipelineLock, /^pytz==/m);
  assert.match(dependabot, /scientific-runtime:[\s\S]+numpy[\s\S]+scipy[\s\S]+scikit-learn[\s\S]+pandas/);
  assert.match(dependabot, /geo-deep-runtime:[\s\S]+pyproj[\s\S]+rasterio[\s\S]+torch/);

  const geoInput = await readFile(new URL("pipeline/requirements-geo-deep.in", root), "utf8");
  assert.match(geoInput, /^pyproj==3\.7\.2$/m);
  assert.match(geoInput, /^rasterio==1\.5\.0$/m);
  assert.match(geoInput, /^torch==2\.13\.0$/m);
  const macLock = await readFile(new URL("pipeline/requirements-geo-deep-macos-arm64.lock", root), "utf8");
  const linuxLock = await readFile(new URL("pipeline/requirements-geo-deep-linux-cpu.lock", root), "utf8");
  assert.match(macLock, /^torch==2\.13\.0\s+\\$/m);
  assert.match(linuxLock, /^torch==2\.13\.0\+cpu\s+\\$/m);
  assert.doesNotMatch(`${macLock}\n${linuxLock}`, /^(?:nvidia-|triton==)/m);

  const optionalWorkflow = await readFile(new URL(".github/workflows/optional-python.yml", root), "utf8");
  assert.match(optionalWorkflow, /schedule:[\s\S]+cron:/);
  assert.match(optionalWorkflow, /runs-on: ubuntu-24\.04[\s\S]+requirements-geo-deep-linux-cpu\.lock/);
  assert.match(optionalWorkflow, /download\.pytorch\.org\/whl\/cpu/);
  assert.match(optionalWorkflow, /runs-on: macos-15[\s\S]+requirements-geo-deep-macos-arm64\.lock/);
  assert.match(optionalWorkflow, /astral-sh\/setup-uv@11f9893b081a58869d3b5fccaea48c9e9e46f990[\s\S]+version: "0\.10\.11"[\s\S]+uv python install 3\.12\.13/);
  assert.equal((optionalWorkflow.match(/--require-hashes/g) ?? []).length, 2);
  assert.equal((optionalWorkflow.match(/--only-binary=:all:/g) ?? []).length, 2);
  assert.equal((optionalWorkflow.match(/check_geo_deep_environment\.py/g) ?? []).length, 4);
});

test("the deterministic production SBOM is bound to the lock and direct runtime packages", async () => {
  const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const lockBytes = await readFile(new URL("package-lock.json", root));
  const sbom = JSON.parse(await readFile(new URL("security/sbom.cdx.json", root), "utf8"));
  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.equal(sbom.specVersion, "1.5");
  assert.match(sbom.serialNumber, /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.equal(sbom.serialNumber, "urn:uuid:cc74a717-57f7-5810-8a55-bd802494e72c");
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
  assert.equal(new Set(references).size, references.length);
  const dependencyReferences = sbom.dependencies.map((dependency) => dependency.ref);
  assert.equal(new Set(dependencyReferences).size, dependencyReferences.length);
  const allowedReferences = new Set([sbom.metadata.component["bom-ref"], ...references]);
  for (const dependency of sbom.dependencies) {
    assert.equal(allowedReferences.has(dependency.ref), true);
    assert.equal(dependency.dependsOn.every((reference) => allowedReferences.has(reference)), true);
  }
  assert.equal(sbom.components.some((component) => component.properties?.some((property) =>
    property.name === "cdx:npm:package:development" && property.value === "true")), false);
});

test("the supply-chain runbook scopes optional locks and keeps deployment provenance open", async () => {
  const policy = await readFile(new URL("docs/SECURITY-SUPPLY-CHAIN.md", root), "utf8");
  assert.match(policy, /npm `10\.9\.8`[\s\S]+all eight exact[\s\S]+0 hooks executed/i);
  assert.match(policy, /exact lockfile package paths[\s\S]+lock-derived UUIDv5[\s\S]+development-only package/i);
  assert.match(policy, /FastAPI runtime\/test and pipeline CI[\s\S]+exact transitive versions[\s\S]+SHA-256/i);
  assert.match(policy, /approved optional Geo\/PyTorch environments[\s\S]+macOS 15\+ ARM64[\s\S]+manylinux_2_28 x86-64 CPU/i);
  assert.match(policy, /CUDA, ROCm, Windows[\s\S]+remain open/i);
  assert.match(
    policy,
    /PR `#72`[\s\S]+0433cb6e67acdee5a6891ddce2cc57e3b46dc2d7[\s\S]+29628030773[\s\S]+83450872[\s\S]+29628030735[\s\S]+29628030502[\s\S]+zero\s+open Dependabot, code-scanning, or secret-scanning alerts/i,
  );
  assert.match(policy, /GitHub workflow produces a deterministic release candidate from `main`/i);
  assert.match(policy, /separate main-only job[\s\S]+runs no repository or dependency code/i);
  assert.match(policy, /not Cloudflare deployment provenance/i);
  assert.match(policy, /prove[\s\S]+digest is the digest actually deployed[\s\S]+before marking end-to-end provenance complete/i);
  assert.match(
    policy,
    /combined release (?:SBOM|inventory)[\s\S]+production npm graph[\s\S]+Python graphs[\s\S]+API-(?:image|container)\/Alpine identities[\s\S]+Worker\/D1\/assets service contract/i,
  );
  assert.match(policy, /package-level contents[\s\S]+per-architecture Syft\/Grype[\s\S]+do not identify deployed\s+bytes/i);
  assert.match(
    policy,
    /native API image evidence[\s\S]+AMD64 and ARM64[\s\S]+Syft 1\.42\.3[\s\S]+Grype 0\.110\.0[\s\S]+expires? 2026-08-08/i,
  );
  assert.match(policy, /Main-branch signing acceptance is recorded below[\s\S]+rather than deployed-version evidence/i);
  assert.match(
    policy,
    /PR `#77`[\s\S]+fa73c4dd4162b6834113f40a6f77be6907bdd202[\s\S]+29629689167[\s\S]+8425041514[\s\S]+e2d8b79a39a28c9ae97ba1c384e1f8eacffe95275ea6b7eaf79d3baee8f12ad0[\s\S]+35935237[\s\S]+35935240[\s\S]+29629689192[\s\S]+83454900[\s\S]+29629688765[\s\S]+zero open Dependabot,[\s\S]+code-scanning,[\s\S]+secret-scanning alerts[\s\S]+None of this proves a Cloudflare deployment/i,
  );
  assert.match(
    policy,
    /PR[\s\S]+`#79`[\s\S]+d98d947360df4845901ca95c921b9e10733f6aaa[\s\S]+29630783417[\s\S]+8425375002[\s\S]+5a106e016c15ae269a7dc1b28ebdb04f281e125dfb63456b03f20b2b43938805[\s\S]+35937141[\s\S]+35937144[\s\S]+2193447569[\s\S]+2193447815[\s\S]+29630783432[\s\S]+83457741[\s\S]+29630783254[\s\S]+zero open Dependabot,[\s\S]+code-scanning,[\s\S]+secret-scanning alerts[\s\S]+source-bound combined inventory[\s\S]+deployed Worker digest proof/i,
  );
  assert.match(policy, /stacked successor PRs[\s\S]+do not falsely report a dependency-review pass/i);
  assert.match(policy, /directory-local `services\/api\/\.python-version`[\s\S]+Python 3\.13\.14[\s\S]+not a[\s\S]+control over GitHub's hosted resolver/i);
  assert.match(policy, /byte-identical transport mirror[\s\S]+managed parser/i);
  assert.match(
    policy,
    /Pipeline Dependabot proposals are advisory inputs[\s\S]+mirror-only[\s\S]+failed[\s\S]+byte-identity contract/i,
  );
  assert.match(
    policy,
    /NumPy 2\.0\.2 to[\s\S]+2\.5\.1[\s\S]+SciPy 1\.13\.1 to[\s\S]+1\.18\.0[\s\S]+maximum aggregate delta of `0\.000000357`/i,
  );
  assert.match(
    policy,
    /PR `#68`[\s\S]+29626219455[\s\S]+snapshot `83445590`[\s\S]+29626220947[\s\S]+29626219486[\s\S]+zero\s+open dependency, code-scanning, or secret-scanning alerts/i,
  );
  assert.match(
    policy,
    /pandas 2\.2\.3[\s\S]+2\.3\.3[\s\S]+3\.0\.3[\s\S]+3\.0\.4[\s\S]+yanked[\s\S]+byte-identical seed-12 and seed-42/i,
  );
  assert.match(
    policy,
    /PR `#70`[\s\S]+29626959333[\s\S]+snapshot `83447588`[\s\S]+29626961391[\s\S]+29626959344[\s\S]+zero open\s+dependency, code-scanning, or secret-scanning alerts/i,
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
