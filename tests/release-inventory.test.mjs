import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const inputPaths = [
  ".node-version",
  ".python-version",
  "package-lock.json",
  "package.json",
  "pipeline/.python-version",
  "pipeline/requirements-ci.lock",
  "security/api-image-policy.json",
  "security/ai-review-queue-policy.json",
  "security/cloudflare-provider-state-policy.json",
  "security/observability-activation-policy.json",
  "security/production-change-authorization-policy.json",
  "security/sbom.cdx.json",
  "services/api/.python-version",
  "services/api/Dockerfile",
  "services/api/requirements-runtime.lock",
  "wrangler.jsonc",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function pythonIdentities(lock) {
  return [...lock.matchAll(/^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s;\\]+)/gmu)]
    .map((match) => `pypi:${match[1].toLowerCase().replace(/[_.]+/gu, "-")}@${match[2]}`);
}

test("the combined release SBOM is deterministic, input-bound, complete, and explicit about limits", async () => {
  const [inventoryText, npmSbomText, dockerfile, wranglerText, ...inputBytes] = await Promise.all([
    readFile(new URL("security/release-sbom.cdx.json", root), "utf8"),
    readFile(new URL("security/sbom.cdx.json", root), "utf8"),
    readFile(new URL("services/api/Dockerfile", root), "utf8"),
    readFile(new URL("wrangler.jsonc", root), "utf8"),
    ...inputPaths.map((path) => readFile(new URL(path, root))),
  ]);
  const inventory = JSON.parse(inventoryText);
  const npmSbom = JSON.parse(npmSbomText);
  const wrangler = JSON.parse(wranglerText);

  assert.equal(inventory.bomFormat, "CycloneDX");
  assert.equal(inventory.specVersion, "1.5");
  assert.match(inventory.serialNumber, /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.equal("timestamp" in inventory.metadata, false);
  assert.equal(inventory.metadata.component.name, "castingcompass-release");
  assert.equal(inventory.metadata.component.properties.some(({ name, value }) =>
    name === "castingcompass:claim-scope"
      && value === "source-bound release inventory; not Cloudflare deployment provenance"), true);

  const inputBindings = new Set(inventory.metadata.component.properties
    .filter(({ name }) => name === "castingcompass:input-sha256")
    .map(({ value }) => value));
  for (let index = 0; index < inputPaths.length; index += 1) {
    assert.equal(inputBindings.has(`${inputPaths[index]}:${sha256(inputBytes[index])}`), true);
  }

  const componentReferences = inventory.components.map((component) => component["bom-ref"]);
  const serviceReferences = inventory.services.map((service) => service["bom-ref"]);
  assert.deepEqual(componentReferences, [...componentReferences].sort());
  assert.deepEqual(serviceReferences, [...serviceReferences].sort());
  assert.equal(new Set(componentReferences).size, componentReferences.length);
  assert.equal(new Set(serviceReferences).size, serviceReferences.length);

  const componentSet = new Set(componentReferences);
  for (const npmComponent of npmSbom.components) {
    assert.equal(componentSet.has(npmComponent["bom-ref"]), true, `missing npm component ${npmComponent["bom-ref"]}`);
  }
  for (const path of ["services/api/requirements-runtime.lock", "pipeline/requirements-ci.lock"]) {
    const lock = await readFile(new URL(path, root), "utf8");
    for (const reference of pythonIdentities(lock)) {
      assert.equal(componentSet.has(reference), true, `missing Python component ${reference}`);
    }
  }

  const imageMatch = dockerfile.match(/^FROM python:([^@\s]+)@(sha256:[a-f0-9]{64}) AS runtime$/mu);
  assert.ok(imageMatch);
  const container = inventory.components.find(({ type }) => type === "container");
  assert.equal(container.version, imageMatch[1]);
  assert.equal(container.hashes[0].content, imageMatch[2].slice("sha256:".length));
  const operatingSystem = inventory.components.find(({ type }) => type === "operating-system");
  assert.equal(operatingSystem.name, "Alpine Linux");
  assert.equal(operatingSystem.properties.some(({ value }) =>
    value === "identity-level; no installed APK package claim"), true);

  const worker = inventory.services.find(({ name }) => name === "Cloudflare Workers Runtime");
  assert.equal(worker.version, wrangler.compatibility_date);
  assert.equal(worker.properties.some(({ name, value }) =>
    name === "castingcompass:inventory-limit"
      && value === "runtime contract only; not deployed-version evidence"), true);

  const allowedReferences = new Set([
    inventory.metadata.component["bom-ref"],
    ...componentReferences,
    ...serviceReferences,
  ]);
  const dependencyReferences = inventory.dependencies.map(({ ref }) => ref);
  assert.equal(new Set(dependencyReferences).size, dependencyReferences.length);
  assert.equal(dependencyReferences.includes(inventory.metadata.component["bom-ref"]), true);
  for (const dependency of inventory.dependencies) {
    assert.equal(allowedReferences.has(dependency.ref), true);
    assert.equal(dependency.dependsOn.every((reference) => allowedReferences.has(reference)), true);
  }
});

test("CI verifies the combined inventory and the signer rejects a narrowed handoff", async () => {
  const [manifest, ci, release] = await Promise.all([
    readFile(new URL("package.json", root), "utf8"),
    readFile(new URL(".github/workflows/ci.yml", root), "utf8"),
    readFile(new URL(".github/workflows/release-provenance.yml", root), "utf8"),
  ]);
  assert.match(manifest, /"security:release-sbom": "node scripts\/generate-release-sbom\.mjs --check"/u);
  assert.match(ci, /npm run security:sbom\n\s+- run: npm run security:release-sbom/u);
  assert.match(release, /npm run security:sbom\n\s+- run: npm run security:release-sbom/u);
  const signingJob = release.slice(release.indexOf("  attest-release:"));
  assert.match(signingJob, /castingcompass-release[\s\S]+not Cloudflare deployment provenance/u);
  assert.match(signingJob, /\.type == "container"[\s\S]+\.type == "operating-system"[\s\S]+pkg:pypi\//u);
  assert.match(signingJob, /Cloudflare Workers Runtime/u);
  assert.doesNotMatch(signingJob, /actions\/checkout|actions\/setup-node|npm (?:ci|run)|node scripts\//u);
});
