#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sbomPath = resolve(root, "security/sbom.cdx.json");
const mode = process.argv[2] ?? "--stdout";
if (!["--stdout", "--check", "--write"].includes(mode) || process.argv.length > 3) {
  console.error("Usage: node scripts/generate-sbom.mjs [--stdout|--check|--write]");
  process.exit(2);
}

const npmCli = process.env.npm_execpath;

const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const lockBytes = readFileSync(resolve(root, "package-lock.json"));
const lock = JSON.parse(lockBytes.toString("utf8"));
const packageLockSha256 = createHash("sha256").update(lockBytes).digest("hex");
const bom = JSON.parse(runNpm(["sbom", "--package-lock-only", "--sbom-format=cyclonedx"]));
const productionPaths = new Set(Object.entries(lock.packages ?? {})
  .filter(([path, package_]) => path && package_?.dev !== true)
  .map(([path]) => path));
bom.components = mergeComponents((bom.components ?? []).filter((component) =>
  component.properties?.some((property) =>
    property.name === "cdx:npm:package:path" && productionPaths.has(property.value))));
const productionReferences = new Set(bom.components.map((component) => component["bom-ref"]));
bom.dependencies = mergeDependencies((bom.dependencies ?? [])
  .filter((dependency) => dependency.ref === `${manifest.name}@${manifest.version}`
    || productionReferences.has(dependency.ref))
  .map((dependency) => ({
    ...dependency,
    dependsOn: dependency.dependsOn?.filter((reference) => productionReferences.has(reference)) ?? [],
  })));
bom.serialNumber = deterministicSerialNumber(packageLockSha256);
delete bom.metadata.timestamp;
delete bom.metadata.tools;
bom.metadata.component.name = manifest.name;
bom.metadata.properties = [{
  name: "castingcompass:package-lock-sha256",
  value: packageLockSha256,
}];

assertUniqueReferences(bom.components ?? [], "bom-ref", "CycloneDX component");
assertUniqueReferences(bom.dependencies ?? [], "ref", "CycloneDX dependency");
assertClosedDependencyGraph(bom, `${manifest.name}@${manifest.version}`);
if ((bom.components ?? []).some((component) => component.properties?.some((property) =>
  property.name === "cdx:npm:package:development" && property.value === "true"))) {
  throw new Error("The production SBOM contains a development-only component");
}

for (const component of bom.components ?? []) {
  sortByJson(component.externalReferences);
  sortByJson(component.hashes);
  sortByJson(component.licenses);
  sortByJson(component.properties);
}
(bom.components ?? []).sort((left, right) => left["bom-ref"].localeCompare(right["bom-ref"]));
for (const dependency of bom.dependencies ?? []) dependency.dependsOn?.sort();
(bom.dependencies ?? []).sort((left, right) => left.ref.localeCompare(right.ref));

const output = `${JSON.stringify(bom, null, 2)}\n`;
if (mode === "--write") {
  mkdirSync(dirname(sbomPath), { recursive: true });
  writeFileSync(sbomPath, output, { encoding: "utf8", mode: 0o644 });
} else if (mode === "--check") {
  let committed = "";
  try {
    committed = readFileSync(sbomPath, "utf8");
  } catch {
    console.error("The committed production dependency SBOM is missing");
    process.exit(1);
  }
  if (committed !== output) {
    console.error("The committed production dependency SBOM does not match package-lock.json");
    console.error("Run npm run security:sbom:write and review the dependency diff");
    process.exit(1);
  }
} else {
  process.stdout.write(output);
}

function sortByJson(values) {
  values?.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function deterministicSerialNumber(packageLockSha256) {
  const urlNamespace = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
  const name = `https://castingcompass.com/sbom/npm/${packageLockSha256}`;
  const bytes = Buffer.from(createHash("sha1").update(urlNamespace).update(name).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = bytes.toString("hex");
  return `urn:uuid:${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function mergeComponents(components) {
  const merged = new Map();
  for (const component of components) {
    const reference = component?.["bom-ref"];
    if (typeof reference !== "string" || !reference) {
      throw new Error("CycloneDX component references must be non-empty");
    }
    const existing = merged.get(reference);
    if (!existing) {
      merged.set(reference, structuredClone(component));
      continue;
    }
    for (const field of ["type", "name", "version", "purl"]) {
      if (existing[field] !== component[field]) {
        throw new Error(`CycloneDX component ${reference} has conflicting ${field}`);
      }
    }
    existing.scope = [existing.scope, component.scope].includes("required") ? "required" : "optional";
    for (const field of ["externalReferences", "hashes", "licenses", "properties"]) {
      const values = new Map([...(existing[field] ?? []), ...(component[field] ?? [])]
        .map((value) => [JSON.stringify(value), value]));
      existing[field] = [...values.values()];
    }
  }
  return [...merged.values()];
}

function mergeDependencies(dependencies) {
  const merged = new Map();
  for (const dependency of dependencies) {
    const existing = merged.get(dependency.ref) ?? new Set();
    for (const reference of dependency.dependsOn ?? []) existing.add(reference);
    merged.set(dependency.ref, existing);
  }
  return [...merged.entries()].map(([ref, dependsOn]) => ({ ref, dependsOn: [...dependsOn] }));
}

function assertUniqueReferences(entries, field, label) {
  const references = new Set();
  for (const entry of entries) {
    const reference = entry?.[field];
    if (typeof reference !== "string" || !reference || references.has(reference)) {
      throw new Error(`${label} references must be non-empty and unique`);
    }
    references.add(reference);
  }
}

function assertClosedDependencyGraph(bom, rootReference) {
  const componentReferences = new Set((bom.components ?? []).map((component) => component["bom-ref"]));
  const allowed = new Set([rootReference, ...componentReferences]);
  const dependencies = new Map((bom.dependencies ?? []).map((dependency) => [dependency.ref, dependency]));
  if (!dependencies.has(rootReference)) throw new Error("The production SBOM root dependency is missing");
  for (const dependency of dependencies.values()) {
    if (!allowed.has(dependency.ref)
      || dependency.dependsOn?.some((reference) => !componentReferences.has(reference))) {
      throw new Error("The production SBOM dependency graph contains a dangling reference");
    }
  }
}

function runNpm(arguments_) {
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, ...arguments_], commandOptions())
    : spawnSync("npm", arguments_, commandOptions());
  if (result.error || result.status !== 0) {
    console.error("Unable to resolve the production dependency SBOM");
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status || 1);
  }
  return result.stdout;
}

function commandOptions() {
  return {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1" },
  };
}
