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
const bom = JSON.parse(runNpm(["sbom", "--package-lock-only", "--sbom-format=cyclonedx"]));
const productionTree = JSON.parse(runNpm([
  "ls",
  "--package-lock-only",
  "--omit=dev",
  "--all",
  "--json",
]));
const productionReferences = new Set();
collectProductionReferences(productionTree.dependencies ?? {}, productionReferences);
bom.components = (bom.components ?? []).filter((component) => productionReferences.has(component["bom-ref"]));
bom.dependencies = (bom.dependencies ?? [])
  .filter((dependency) => dependency.ref === `${manifest.name}@${manifest.version}`
    || productionReferences.has(dependency.ref))
  .map((dependency) => ({
    ...dependency,
    dependsOn: dependency.dependsOn?.filter((reference) => productionReferences.has(reference)) ?? [],
  }));
delete bom.serialNumber;
delete bom.metadata.timestamp;
delete bom.metadata.tools;
bom.metadata.component.name = manifest.name;
bom.metadata.properties = [{
  name: "castingcompass:package-lock-sha256",
  value: createHash("sha256").update(lockBytes).digest("hex"),
}];

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

function collectProductionReferences(dependencies, references) {
  for (const [name, dependency] of Object.entries(dependencies)) {
    if (!dependency?.version) continue;
    references.add(`${name}@${dependency.version}`);
    collectProductionReferences(dependency.dependencies ?? {}, references);
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
