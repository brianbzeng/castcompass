#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(root, "security/release-sbom.cdx.json");
const mode = process.argv[2] ?? "--stdout";
if (!["--stdout", "--check", "--write"].includes(mode) || process.argv.length > 3) {
  console.error("Usage: node scripts/generate-release-sbom.mjs [--stdout|--check|--write]");
  process.exit(2);
}

const inputPaths = [
  ".node-version",
  ".npmrc",
  ".python-version",
  "package-lock.json",
  "package.json",
  "pipeline/requirements-ci.lock",
  "security/api-image-policy.json",
  "security/ai-review-queue-policy.json",
  "security/cloudflare-provider-state-policy.json",
  "security/observability-activation-policy.json",
  "security/operational-restore-review-policy.json",
  "security/production-change-authorization-policy.json",
  "security/npm-install-policy.json",
  "security/sbom.cdx.json",
  "services/api/.python-version",
  "services/api/Dockerfile",
  "services/api/requirements-runtime.lock",
  "pipeline/.python-version",
  "wrangler.jsonc",
];
const inputs = new Map(inputPaths.map((path) => [path, readFileSync(resolve(root, path))]));
const inputHashes = new Map([...inputs].map(([path, bytes]) => [path, sha256(bytes)]));
const packageManifest = JSON.parse(inputs.get("package.json").toString("utf8"));
const npmSbom = JSON.parse(inputs.get("security/sbom.cdx.json").toString("utf8"));
const wrangler = JSON.parse(inputs.get("wrangler.jsonc").toString("utf8"));
const nodeVersion = exactVersion(inputs.get(".node-version").toString("utf8").trim(), "Node version");
const rootPythonVersion = exactVersion(inputs.get(".python-version").toString("utf8").trim(), "root Python version");
const apiPythonVersion = exactVersion(inputs.get("services/api/.python-version").toString("utf8").trim(), "API Python version");
const pipelinePythonVersion = exactVersion(inputs.get("pipeline/.python-version").toString("utf8").trim(), "pipeline Python version");
if (rootPythonVersion !== pipelinePythonVersion) {
  throw new Error("The root Python selection must match the pipeline runtime");
}

assertNpmSbom(npmSbom, inputHashes.get("package-lock.json"));
const container = parseContainerIdentity(inputs.get("services/api/Dockerfile").toString("utf8"), apiPythonVersion);
const worker = parseWorkerIdentity(wrangler, packageManifest);
const pythonGraphs = [
  parsePythonLock("services/api/requirements-runtime.lock", "api-runtime"),
  parsePythonLock("pipeline/requirements-ci.lock", "pipeline-ci"),
];

const releaseReference = `castingcompass-release@${packageManifest.version}`;
const npmRootReference = npmSbom.metadata.component["bom-ref"];
const apiReference = `castingcompass-api@${packageManifest.version}`;
const pipelineReference = `castingcompass-pipeline@${packageManifest.version}`;
const nodeReference = `runtime:node@${nodeVersion}`;
const apiPythonReference = `runtime:python@${apiPythonVersion}`;
const pipelinePythonReference = `runtime:python@${pipelinePythonVersion}`;
const containerReference = `container:python@${container.digest}`;
const osReference = container.operatingSystem.reference;
const workerServiceReference = `service:cloudflare-workers@${worker.compatibilityDate}`;
const d1ServiceReference = "service:cloudflare-d1";
const assetsServiceReference = "service:cloudflare-workers-assets";

const npmRoot = structuredClone(npmSbom.metadata.component);
npmRoot.type = "application";
npmRoot.properties = mergeProperties(npmRoot.properties, [{
  name: "castingcompass:inventory-role",
  value: "cloudflare-worker-application",
}]);

const pythonComponents = mergePythonComponents(pythonGraphs);
const components = [
  ...structuredClone(npmSbom.components),
  npmRoot,
  ...pythonComponents,
  component(apiReference, "application", "castingcompass-api", packageManifest.version, [
    property("castingcompass:inventory-role", "api-runtime"),
    property("castingcompass:source-lock", "services/api/requirements-runtime.lock"),
  ]),
  component(pipelineReference, "application", "castingcompass-pipeline", packageManifest.version, [
    property("castingcompass:inventory-role", "data-pipeline-ci"),
    property("castingcompass:source-lock", "pipeline/requirements-ci.lock"),
  ]),
  component(nodeReference, "application", "Node.js", nodeVersion, [
    property("castingcompass:inventory-role", "worker-build-runtime"),
  ], `pkg:generic/node@${nodeVersion}`),
  component(apiPythonReference, "application", "Python", apiPythonVersion, [
    property("castingcompass:inventory-role", "api-runtime"),
  ], `pkg:generic/python@${apiPythonVersion}`),
  component(pipelinePythonReference, "application", "Python", pipelinePythonVersion, [
    property("castingcompass:inventory-role", "pipeline-runtime"),
  ], `pkg:generic/python@${pipelinePythonVersion}`),
  {
    ...component(containerReference, "container", container.image, container.tag, [
      property("castingcompass:inventory-role", "api-base-image-index"),
      property("castingcompass:image-reference", container.reference),
      property("castingcompass:inventory-limit", "identity-level; APK package contents are not enumerated"),
    ]),
    hashes: [{ alg: "SHA-256", content: container.digest.slice("sha256:".length) }],
    externalReferences: [{
      type: "distribution",
      url: `https://hub.docker.com/_/python/tags?name=${encodeURIComponent(container.tag)}`,
    }],
  },
  component(osReference, "operating-system", container.operatingSystem.name, container.operatingSystem.version, [
    property("castingcompass:inventory-role", "api-base-operating-system-identity"),
    property("castingcompass:identity-source", "official Python Alpine image tag plus pinned image-index digest"),
    property("castingcompass:inventory-limit", "identity-level; no installed APK package claim"),
  ]),
];

const services = [
  service(workerServiceReference, "Cloudflare Workers Runtime", worker.compatibilityDate, [
    property("castingcompass:worker-name", worker.name),
    property("castingcompass:worker-main", worker.main),
    property("castingcompass:compatibility-flags", worker.compatibilityFlags.join(",")),
    property("castingcompass:wrangler-version", worker.wranglerVersion),
    property("castingcompass:wrangler-sha256", inputHashes.get("wrangler.jsonc")),
    property("castingcompass:version-metadata-binding", worker.versionMetadataBinding),
    property("castingcompass:inventory-limit", "runtime contract only; not deployed-version evidence"),
  ]),
  service(d1ServiceReference, "Cloudflare D1", "repository-contract", [
    property("castingcompass:binding", worker.d1Binding),
    property("castingcompass:inventory-limit", "binding contract only; not production database evidence"),
  ]),
  service(assetsServiceReference, "Cloudflare Workers Static Assets", "repository-contract", [
    property("castingcompass:binding", worker.assetsBinding),
    property("castingcompass:directory", worker.assetsDirectory),
    property("castingcompass:inventory-limit", "binding contract only; not deployed-asset evidence"),
  ]),
];

const dependencies = mergeDependencies([
  ...structuredClone(npmSbom.dependencies),
  {
    ref: releaseReference,
    dependsOn: [
      npmRootReference,
      apiReference,
      pipelineReference,
      nodeReference,
      apiPythonReference,
      pipelinePythonReference,
      containerReference,
      workerServiceReference,
      d1ServiceReference,
      assetsServiceReference,
    ],
  },
  {
    ref: npmRootReference,
    dependsOn: [nodeReference, workerServiceReference],
  },
  {
    ref: apiReference,
    dependsOn: [containerReference, ...pythonGraphs[0].components.map(({ reference }) => reference)],
  },
  {
    ref: pipelineReference,
    dependsOn: [pipelinePythonReference, ...pythonGraphs[1].components.map(({ reference }) => reference)],
  },
  { ref: containerReference, dependsOn: [osReference, apiPythonReference] },
  { ref: workerServiceReference, dependsOn: [d1ServiceReference, assetsServiceReference] },
]);

for (const entry of components) normalizeComponent(entry);
components.sort((left, right) => compare(left["bom-ref"], right["bom-ref"]));
services.sort((left, right) => compare(left["bom-ref"], right["bom-ref"]));
for (const dependency of dependencies) dependency.dependsOn.sort(compare);
dependencies.sort((left, right) => compare(left.ref, right.ref));

const aggregateIdentity = [...inputHashes]
  .sort(([left], [right]) => compare(left, right))
  .map(([path, hash]) => `${path}:${hash}`)
  .join("\n");
const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: deterministicSerialNumber(sha256(aggregateIdentity)),
  version: 1,
  metadata: {
    component: component(releaseReference, "application", "castingcompass-release", packageManifest.version, [
      property("castingcompass:claim-scope", "source-bound release inventory; not Cloudflare deployment provenance"),
      ...[...inputHashes]
        .sort(([left], [right]) => compare(left, right))
        .map(([path, hash]) => property("castingcompass:input-sha256", `${path}:${hash}`)),
    ], `pkg:generic/castingcompass-release@${packageManifest.version}`),
  },
  components,
  services,
  dependencies,
};

assertInventory(bom, {
  releaseReference,
  requiredInputPaths: inputPaths,
  requiredPythonGraphs: pythonGraphs,
});

const output = `${JSON.stringify(bom, null, 2)}\n`;
if (mode === "--write") {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, output, { encoding: "utf8", mode: 0o644 });
} else if (mode === "--check") {
  let committed = "";
  try {
    committed = readFileSync(outputPath, "utf8");
  } catch {
    console.error("The committed combined release SBOM is missing");
    process.exit(1);
  }
  if (committed !== output) {
    console.error("The committed combined release SBOM does not match its locked inputs");
    console.error("Run npm run security:release-sbom:write and review the inventory diff");
    process.exit(1);
  }
} else {
  process.stdout.write(output);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactVersion(value, label) {
  if (!/^\d+(?:\.\d+)+(?:[+.][A-Za-z0-9.-]+)?$/u.test(value)) {
    throw new Error(`${label} is not an exact version`);
  }
  return value;
}

function property(name, value) {
  return { name, value };
}

function component(reference, type, name, version, properties = [], purl) {
  const value = {
    "bom-ref": reference,
    type,
    name,
    version,
    scope: "required",
    properties,
  };
  if (purl) value.purl = purl;
  return value;
}

function service(reference, name, version, properties) {
  return {
    "bom-ref": reference,
    provider: { name: "Cloudflare, Inc." },
    name,
    version,
    description: "Repository-declared external service contract; verify the deployed provider state separately.",
    properties,
    externalReferences: [{ type: "website", url: "https://www.cloudflare.com/" }],
  };
}

function normalizePythonName(name) {
  return name.toLowerCase().replace(/[_.]+/gu, "-");
}

function parsePythonLock(path, graph) {
  const bytes = inputs.get(path);
  const text = bytes.toString("utf8");
  const pattern = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s;\\]+)(?:\s*;\s*([^\\\n]+?))?\s*\\?\s*$/gmu;
  const matches = [...text.matchAll(pattern)];
  if (matches.length === 0) throw new Error(`${path} contains no exact Python requirements`);
  const components_ = matches.map((match, index) => {
    const name = normalizePythonName(match[1]);
    const version = exactVersion(match[2], `${path} ${name}`);
    const marker = match[3]?.trim() ?? "";
    const end = matches[index + 1]?.index ?? text.length;
    const block = text.slice(match.index, end);
    const hashes = [...new Set([...block.matchAll(/--hash=sha256:([a-f0-9]{64})/gu)]
      .map((hashMatch) => hashMatch[1]))].sort(compare);
    if (hashes.length === 0) throw new Error(`${path} ${name}==${version} is missing distribution hashes`);
    const reference = `pypi:${name}@${version}`;
    return { name, version, marker, hashes, reference, path, graph };
  });
  if (new Set(components_.map(({ reference }) => reference)).size !== components_.length) {
    throw new Error(`${path} contains duplicate Python package identities`);
  }
  return { path, graph, sha256: inputHashes.get(path), components: components_ };
}

function mergePythonComponents(graphs) {
  const merged = new Map();
  for (const graph of graphs) {
    for (const entry of graph.components) {
      const current = merged.get(entry.reference) ?? component(
        entry.reference,
        "library",
        entry.name,
        entry.version,
        [],
        `pkg:pypi/${entry.name}@${encodeURIComponent(entry.version)}`,
      );
      current.properties = mergeProperties(current.properties, [
        property("castingcompass:python-graph", entry.graph),
        property("castingcompass:python-lock", entry.path),
        property("castingcompass:python-lock-sha256", graph.sha256),
        ...entry.hashes.map((hash) => property("castingcompass:locked-distribution-sha256", hash)),
        ...(entry.marker ? [property("castingcompass:environment-marker", entry.marker)] : []),
      ]);
      merged.set(entry.reference, current);
    }
  }
  return [...merged.values()];
}

function mergeProperties(existing = [], additions = []) {
  return [...new Map([...existing, ...additions].map((entry) => [JSON.stringify(entry), entry])).values()]
    .sort((left, right) => compare(JSON.stringify(left), JSON.stringify(right)));
}

function mergeDependencies(values) {
  const merged = new Map();
  for (const entry of values) {
    if (typeof entry?.ref !== "string" || !entry.ref) throw new Error("Dependency references must be non-empty");
    const targets = merged.get(entry.ref) ?? new Set();
    for (const target of entry.dependsOn ?? []) targets.add(target);
    merged.set(entry.ref, targets);
  }
  return [...merged].map(([ref, targets]) => ({ ref, dependsOn: [...targets] }));
}

function normalizeComponent(entry) {
  entry.properties = mergeProperties(entry.properties);
  for (const field of ["externalReferences", "hashes", "licenses"]) {
    entry[field]?.sort((left, right) => compare(JSON.stringify(left), JSON.stringify(right)));
  }
}

function parseContainerIdentity(dockerfile, expectedPythonVersion) {
  const match = dockerfile.match(/^FROM python:([^@\s]+)@(sha256:[a-f0-9]{64}) AS runtime$/mu);
  if (!match) throw new Error("API Dockerfile must use one exact official Python image index");
  const tag = match[1];
  if (tag !== `${expectedPythonVersion}-alpine3.24`) {
    throw new Error("API container tag must match the reviewed Python and Alpine runtime");
  }
  return {
    image: "python",
    tag,
    digest: match[2],
    reference: `python:${tag}@${match[2]}`,
    operatingSystem: {
      reference: "operating-system:alpine@3.24",
      name: "Alpine Linux",
      version: "3.24",
    },
  };
}

function parseWorkerIdentity(configuration, manifest) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(configuration.compatibility_date ?? "")
    || !Array.isArray(configuration.compatibility_flags)
    || configuration.compatibility_flags.length === 0
    || configuration.no_bundle !== true
    || configuration.assets?.binding !== "ASSETS"
    || configuration.d1_databases?.length !== 1
    || configuration.d1_databases[0]?.binding !== "DB"
    || configuration.version_metadata?.binding !== "CF_VERSION_METADATA") {
    throw new Error("Wrangler runtime identity is incomplete or ambiguous");
  }
  const wranglerVersion = exactVersion(manifest.devDependencies?.wrangler, "Wrangler version");
  return {
    name: configuration.name,
    main: configuration.main,
    compatibilityDate: configuration.compatibility_date,
    compatibilityFlags: [...configuration.compatibility_flags].sort(compare),
    wranglerVersion,
    versionMetadataBinding: configuration.version_metadata.binding,
    d1Binding: configuration.d1_databases[0].binding,
    assetsBinding: configuration.assets.binding,
    assetsDirectory: configuration.assets.directory,
  };
}

function assertNpmSbom(sbom, packageLockHash) {
  const property_ = sbom?.metadata?.properties?.find((entry) =>
    entry?.name === "castingcompass:package-lock-sha256");
  if (sbom?.bomFormat !== "CycloneDX"
    || sbom?.specVersion !== "1.5"
    || property_?.value !== packageLockHash
    || !Array.isArray(sbom.components)
    || !Array.isArray(sbom.dependencies)
    || typeof sbom.metadata?.component?.["bom-ref"] !== "string") {
    throw new Error("The production npm SBOM is invalid or stale");
  }
}

function assertInventory(sbom, { releaseReference: rootReference, requiredInputPaths, requiredPythonGraphs }) {
  const componentReferences = new Set();
  for (const entry of sbom.components) {
    const reference = entry?.["bom-ref"];
    if (typeof reference !== "string" || !reference || componentReferences.has(reference)) {
      throw new Error("Combined SBOM component references must be non-empty and unique");
    }
    componentReferences.add(reference);
  }
  const serviceReferences = new Set();
  for (const entry of sbom.services) {
    const reference = entry?.["bom-ref"];
    if (typeof reference !== "string" || !reference || serviceReferences.has(reference)
      || componentReferences.has(reference)) {
      throw new Error("Combined SBOM service references must be non-empty and unique");
    }
    serviceReferences.add(reference);
  }
  const allowed = new Set([rootReference, ...componentReferences, ...serviceReferences]);
  const dependencyReferences = new Set();
  for (const dependency of sbom.dependencies) {
    if (!allowed.has(dependency.ref) || dependencyReferences.has(dependency.ref)
      || dependency.dependsOn.some((reference) => !allowed.has(reference))) {
      throw new Error("Combined SBOM dependency graph is duplicate or contains a dangling reference");
    }
    dependencyReferences.add(dependency.ref);
  }
  if (!dependencyReferences.has(rootReference)) throw new Error("Combined SBOM root dependency is missing");
  const inputValues = new Set(sbom.metadata.component.properties
    .filter(({ name }) => name === "castingcompass:input-sha256")
    .map(({ value }) => value));
  for (const path of requiredInputPaths) {
    if (!inputValues.has(`${path}:${inputHashes.get(path)}`)) {
      throw new Error(`Combined SBOM is not bound to ${path}`);
    }
  }
  for (const graph of requiredPythonGraphs) {
    for (const entry of graph.components) {
      if (!componentReferences.has(entry.reference)) {
        throw new Error(`Combined SBOM is missing ${entry.reference}`);
      }
    }
  }
  if (!sbom.components.some(({ type }) => type === "container")
    || !sbom.components.some(({ type }) => type === "operating-system")
    || !sbom.services.some(({ name }) => name === "Cloudflare Workers Runtime")) {
    throw new Error("Combined SBOM is missing its container, OS, or Worker identity");
  }
}

function deterministicSerialNumber(identityHash) {
  const urlNamespace = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
  const name = `https://castingcompass.com/sbom/release/${identityHash}`;
  const bytes = Buffer.from(createHash("sha1").update(urlNamespace).update(name).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = bytes.toString("hex");
  return `urn:uuid:${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
