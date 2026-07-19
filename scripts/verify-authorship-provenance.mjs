#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POLICY_PATH = "security/authorship-provenance-policy.json";

function invariant(value, message) {
  if (!value) throw new Error(message);
}

function exactKeys(value, expected, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  invariant(JSON.stringify(actual) === JSON.stringify(wanted), `${label} keys are not the locked contract`);
}

function sortedUnique(values, label) {
  const sorted = [...values].sort();
  invariant(JSON.stringify(values) === JSON.stringify(sorted), `${label} must be sorted`);
  invariant(new Set(values).size === values.length, `${label} must not contain duplicates`);
}

function safePath(root, repositoryPath) {
  invariant(typeof repositoryPath === "string" && repositoryPath.length > 0, "Repository path is missing");
  invariant(!isAbsolute(repositoryPath) && !repositoryPath.includes("\\"), `Unsafe repository path: ${repositoryPath}`);
  invariant(posix.normalize(repositoryPath) === repositoryPath && !repositoryPath.startsWith("../"), `Unsafe repository path: ${repositoryPath}`);
  const absolute = resolve(root, repositoryPath);
  const fromRoot = relative(root, absolute);
  invariant(fromRoot !== "" && !fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot), `Path escapes repository root: ${repositoryPath}`);
  return absolute;
}

function readBounded(root, repositoryPath, maximumBytes, label = repositoryPath) {
  const absolute = safePath(root, repositoryPath);
  const metadata = lstatSync(absolute);
  invariant(metadata.isFile() && !metadata.isSymbolicLink(), `${label} must be a regular non-symlink file`);
  invariant(metadata.size <= maximumBytes, `${label} exceeds the ${maximumBytes}-byte limit`);
  const canonicalRoot = `${realpathSync(root)}${sep}`;
  invariant(realpathSync(absolute).startsWith(canonicalRoot), `${label} resolves outside the repository`);
  return readFileSync(absolute);
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function discoverVisualAssets(root, policy) {
  const found = [];
  const allowedExtensions = new Set(policy.assetDiscovery.extensions);
  const canonicalRoot = `${realpathSync(root)}${sep}`;

  function visit(repositoryDirectory) {
    const absoluteDirectory = safePath(root, repositoryDirectory);
    const directoryMetadata = lstatSync(absoluteDirectory);
    invariant(directoryMetadata.isDirectory() && !directoryMetadata.isSymbolicLink(), `${repositoryDirectory} must be a regular directory`);
    invariant(realpathSync(absoluteDirectory).startsWith(canonicalRoot), `${repositoryDirectory} resolves outside the repository`);
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const repositoryPath = `${repositoryDirectory}/${entry.name}`;
      invariant(!entry.isSymbolicLink(), `Public asset tree contains a symlink: ${repositoryPath}`);
      if (entry.isDirectory()) visit(repositoryPath);
      else if (entry.isFile() && allowedExtensions.has(extname(entry.name).toLowerCase())) found.push(repositoryPath);
    }
  }

  for (const rootPath of policy.assetDiscovery.roots) visit(rootPath);
  return found.sort();
}

function validatePolicy(policy) {
  exactKeys(policy, [
    "assetDiscovery",
    "legacyBoundary",
    "licenses",
    "liveAttribution",
    "privacy",
    "productionReadiness",
    "registerPath",
    "reportPath",
    "schemaPath",
    "schemaVersion",
  ], "Authorship policy");
  invariant(policy.schemaVersion === "castingcompass.authorship-provenance-policy/1.0.0", "Unsupported authorship policy schema");
  invariant(policy.productionReadiness === false, "Repository provenance evidence cannot claim production readiness");
  exactKeys(policy.assetDiscovery, ["extensions", "maximumFileBytes", "roots"], "Asset discovery policy");
  exactKeys(policy.legacyBoundary, ["effectiveCommit", "exactUnresolvedPaths"], "Legacy boundary policy");
  exactKeys(policy.liveAttribution, ["dataPath", "documentationPaths"], "Live attribution policy");
  exactKeys(policy.privacy, ["forbiddenRecordValuePatterns", "maximumJsonBytes"], "Provenance privacy policy");
  invariant(policy.registerPath === "governance/authorship-provenance.json", "Register path is not locked");
  invariant(policy.schemaPath === "contracts/authorship-provenance.schema.json", "Schema path is not locked");
  invariant(policy.reportPath === "security/authorship-provenance-report.json", "Report path is not locked");
  invariant(/^[a-f0-9]{40}$/u.test(policy.legacyBoundary.effectiveCommit), "Legacy effective commit is invalid");
  invariant(Number.isSafeInteger(policy.assetDiscovery.maximumFileBytes) && policy.assetDiscovery.maximumFileBytes > 0, "Asset byte ceiling is invalid");
  invariant(Number.isSafeInteger(policy.privacy.maximumJsonBytes) && policy.privacy.maximumJsonBytes > 0, "JSON byte ceiling is invalid");
  sortedUnique(policy.assetDiscovery.extensions, "Visual extensions");
  sortedUnique(policy.assetDiscovery.roots, "Visual roots");
  sortedUnique(policy.legacyBoundary.exactUnresolvedPaths, "Legacy unresolved paths");
  invariant(policy.assetDiscovery.roots.length === 1 && policy.assetDiscovery.roots[0] === "public", "Visual discovery must cover the public tree");
  invariant(JSON.stringify(policy.assetDiscovery.extensions) === JSON.stringify([".jpg", ".png", ".svg", ".webp"]), "Visual extension inventory changed without policy review");
  for (const [licenseId, licenseUrl] of Object.entries(policy.licenses)) {
    invariant(/^(?:CC|LicenseRef-)/u.test(licenseId), `Invalid license ID: ${licenseId}`);
    invariant(typeof licenseUrl === "string" && licenseUrl.startsWith("https://"), `License URL must be HTTPS: ${licenseId}`);
  }
  for (const pattern of policy.privacy.forbiddenRecordValuePatterns) new RegExp(pattern, "iu");
}

function validateSchema(schema, register) {
  invariant(schema.$id === "https://castingcompass.com/contracts/authorship-provenance/1.0.0", "Authorship schema identity is invalid");
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(register)) {
    const detail = (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
    throw new Error(`Authorship register schema validation failed: ${detail}`);
  }
}

function validateRecordSemantics(register, policy, discovered, root) {
  invariant(register.policy_effective_commit === policy.legacyBoundary.effectiveCommit, "Register and legacy-boundary commits differ");
  const ids = register.records.map((record) => record.id);
  sortedUnique(ids, "Provenance record IDs");
  const recordsById = new Map(register.records.map((record) => [record.id, record]));
  const pathOwners = new Map();
  const legacyPaths = [];

  for (const record of register.records) {
    const recordPaths = record.paths.map((entry) => entry.path);
    sortedUnique(recordPaths, `Paths for ${record.id}`);
    const serialized = JSON.stringify(record);
    for (const source of policy.privacy.forbiddenRecordValuePatterns) {
      invariant(!new RegExp(source, "iu").test(serialized), `Record ${record.id} contains forbidden private or secret-shaped data`);
    }

    for (const asset of record.paths) {
      invariant(!pathOwners.has(asset.path), `${asset.path} is registered more than once`);
      pathOwners.set(asset.path, record.id);
      const bytes = readBounded(root, asset.path, policy.assetDiscovery.maximumFileBytes, asset.path);
      invariant(sha256(bytes) === asset.sha256, `${asset.path} does not match its registered SHA-256`);
      if (record.release_state === "legacy_review_required") legacyPaths.push(asset.path);
    }

    if (record.kind === "third_party_reference") {
      invariant(record.release_state === "approved_existing_use", `${record.id} cannot use a legacy release state`);
      invariant(record.source_url && record.source_remote_sha1 && record.source_reviewed_at, `${record.id} lacks reviewed source evidence`);
      invariant(record.license_id && record.license_label && record.license_url, `${record.id} lacks a direct license record`);
      invariant(policy.licenses[record.license_id] === record.license_url, `${record.id} license URL is not canonical`);
      invariant(record.upstream_record_id === null, `${record.id} cannot inherit a first-party upstream record`);
      invariant(record.ai_assistance !== "unknown_legacy", `${record.id} cannot use the first-party legacy AI state`);
      const expected = {
        cc0: [false, false, "verified_source_license"],
        cc_by: [true, false, "verified_source_license"],
        cc_by_sa: [true, true, "verified_source_license"],
        source_public_domain_assertion: [false, false, "source_public_domain_assertion"],
      }[record.rights_basis];
      invariant(expected, `${record.id} has an invalid third-party rights basis`);
      invariant(record.attribution_required === expected[0] && record.share_alike === expected[1] && record.rights_review === expected[2], `${record.id} rights flags disagree with its rights basis`);
    } else {
      invariant(record.release_state === "legacy_review_required", `${record.id} is unresolved but not marked legacy review required`);
      invariant(record.source_url === null && record.source_remote_sha1 === null && record.source_reviewed_at === null, `${record.id} invents source evidence for an unresolved legacy asset`);
      invariant(record.license_id === null && record.license_label === null && record.license_url === null, `${record.id} invents license evidence for an unresolved legacy asset`);
      invariant(record.ai_assistance === "unknown_legacy", `${record.id} must preserve unknown legacy AI status`);
      if (record.kind === "derived_legacy") {
        invariant(record.rights_basis === "derived_from_registered_legacy" && record.rights_review === "derived_from_registered_legacy", `${record.id} derived legacy boundary is invalid`);
        invariant(record.upstream_record_id && recordsById.has(record.upstream_record_id), `${record.id} upstream record is missing`);
        invariant(recordsById.get(record.upstream_record_id).release_state === "legacy_review_required", `${record.id} upstream record is not an unresolved legacy record`);
      } else {
        invariant(record.rights_basis === "owner_confirmation_required" && record.rights_review === "owner_confirmation_required", `${record.id} owner-confirmation boundary is invalid`);
        invariant(record.upstream_record_id === null, `${record.id} cannot declare an upstream record`);
      }
    }
  }

  const registered = [...pathOwners.keys()].sort();
  invariant(JSON.stringify(registered) === JSON.stringify(discovered), `Visual asset inventory differs from the register (discovered ${discovered.length}, registered ${registered.length})`);
  legacyPaths.sort();
  invariant(JSON.stringify(legacyPaths) === JSON.stringify(policy.legacyBoundary.exactUnresolvedPaths), "Legacy exceptions differ from the pre-policy exact allowlist");
  return recordsById;
}

function validateLiveAttribution(root, policy, recordsById) {
  const maximum = policy.privacy.maximumJsonBytes;
  const data = parseJson(readBounded(root, policy.liveAttribution.dataPath, maximum), policy.liveAttribution.dataPath);
  invariant(data && typeof data === "object" && !Array.isArray(data), "Live structure attribution must be an object");
  const usedRecordIds = [];

  for (const [key, image] of Object.entries(data)) {
    exactKeys(image, ["alt", "credit", "license", "licenseUrl", "modifications", "provenanceRecordId", "sourceUrl", "src"], `Live attribution ${key}`);
    invariant(/^\/[A-Za-z0-9._/-]+\.(?:jpg|png|svg|webp)$/u.test(image.src), `Live attribution ${key} has an invalid asset path`);
    invariant(typeof image.alt === "string" && image.alt.length >= 12, `Live attribution ${key} has inadequate alt text`);
    const record = recordsById.get(image.provenanceRecordId);
    invariant(record?.kind === "third_party_reference", `Live attribution ${key} lacks a third-party provenance record`);
    invariant(record.paths.length === 1 && record.paths[0].path === `public${image.src}`, `Live attribution ${key} points at the wrong local asset`);
    invariant(image.credit === record.attribution_text, `Live attribution ${key} credit drifted from the register`);
    invariant(image.sourceUrl === record.source_url, `Live attribution ${key} source drifted from the register`);
    invariant(image.license === record.license_label, `Live attribution ${key} license label drifted from the register`);
    invariant(image.licenseUrl === record.license_url, `Live attribution ${key} license URL drifted from the register`);
    invariant(image.modifications === record.modifications, `Live attribution ${key} change disclosure drifted from the register`);
    usedRecordIds.push(record.id);
  }

  sortedUnique(usedRecordIds.sort(), "Live attribution provenance IDs");
  const thirdPartyRecordIds = [...recordsById.values()]
    .filter((record) => record.kind === "third_party_reference")
    .map((record) => record.id)
    .sort();
  invariant(JSON.stringify(usedRecordIds) === JSON.stringify(thirdPartyRecordIds), "Live structure attribution does not cover every third-party reference record exactly once");

  const documentation = policy.liveAttribution.documentationPaths
    .map((path) => readBounded(root, path, maximum, path).toString("utf8"))
    .join("\n");
  for (const recordId of thirdPartyRecordIds) {
    const record = recordsById.get(recordId);
    for (const value of [record.attribution_text, record.source_url, record.license_label, record.license_url, record.modifications]) {
      invariant(documentation.includes(value), `Public structure documentation is missing ${recordId} evidence: ${value}`);
    }
  }
  invariant(!/U\.S\. Geological Survey \/ Wikimedia Commons|Hotel Pier site visit/iu.test(documentation), "Stale structure-image attribution remains in documentation");
}

function buildReport(register, policy, discovered, inputs) {
  const rightsBasisCounts = {};
  for (const record of register.records) rightsBasisCounts[record.rights_basis] = (rightsBasisCounts[record.rights_basis] ?? 0) + 1;
  const legacyReviewRequiredPaths = register.records
    .filter((record) => record.release_state === "legacy_review_required")
    .flatMap((record) => record.paths.map((asset) => asset.path))
    .sort();
  const licenseIds = [...new Set(register.records.map((record) => record.license_id).filter(Boolean))].sort();
  return {
    schemaVersion: "castingcompass.authorship-provenance-report/1.0.0",
    registerSchemaVersion: register.schema_version,
    policyEffectiveCommit: register.policy_effective_commit,
    reviewedAt: register.reviewed_at,
    recordCount: register.records.length,
    visualAssetCount: discovered.length,
    thirdPartyRecordCount: register.records.filter((record) => record.kind === "third_party_reference").length,
    legacyReviewRequiredRecordCount: register.records.filter((record) => record.release_state === "legacy_review_required").length,
    legacyReviewRequiredPaths,
    rightsBasisCounts: Object.fromEntries(Object.entries(rightsBasisCounts).sort(([left], [right]) => left.localeCompare(right))),
    licenseIds,
    allVisualAssetsRegistered: true,
    liveAttributionVerified: true,
    privateEvidenceIncluded: false,
    productionReadiness: policy.productionReadiness,
    limitations: [
      "Repository and Git evidence do not independently prove copyright ownership or legal clearance.",
      "Legacy brand, icon, social-card, and topography assets remain subject to owner confirmation.",
      "Private agreements, privileged advice, identities, personal data, and secret material are intentionally excluded.",
      "This source-bound report is not deployment evidence and does not authorize production release."
    ],
    inputSha256: Object.fromEntries([...inputs.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([path, bytes]) => [path, sha256(bytes)]))
  };
}

export function verifyProject(projectRoot = SCRIPT_ROOT, { reportMode = "check" } = {}) {
  const root = realpathSync(resolve(projectRoot));
  const policyBytes = readBounded(root, POLICY_PATH, 512 * 1024, POLICY_PATH);
  const policy = parseJson(policyBytes, POLICY_PATH);
  validatePolicy(policy);
  const schemaBytes = readBounded(root, policy.schemaPath, policy.privacy.maximumJsonBytes, policy.schemaPath);
  const registerBytes = readBounded(root, policy.registerPath, policy.privacy.maximumJsonBytes, policy.registerPath);
  const liveDataBytes = readBounded(root, policy.liveAttribution.dataPath, policy.privacy.maximumJsonBytes, policy.liveAttribution.dataPath);
  const schema = parseJson(schemaBytes, policy.schemaPath);
  const register = parseJson(registerBytes, policy.registerPath);
  validateSchema(schema, register);
  const discovered = discoverVisualAssets(root, policy);
  const recordsById = validateRecordSemantics(register, policy, discovered, root);
  validateLiveAttribution(root, policy, recordsById);
  const report = buildReport(register, policy, discovered, new Map([
    [POLICY_PATH, policyBytes],
    [policy.schemaPath, schemaBytes],
    [policy.registerPath, registerBytes],
    [policy.liveAttribution.dataPath, liveDataBytes],
  ]));
  const output = `${JSON.stringify(report, null, 2)}\n`;

  invariant(["check", "write", "none"].includes(reportMode), `Invalid report mode: ${reportMode}`);
  if (reportMode === "write") {
    writeFileSync(safePath(root, policy.reportPath), output, { encoding: "utf8", mode: 0o644 });
  } else if (reportMode === "check") {
    const committed = readBounded(root, policy.reportPath, policy.privacy.maximumJsonBytes, policy.reportPath).toString("utf8");
    invariant(committed === output, "Committed authorship/provenance report is stale; run npm run security:authorship-provenance:write and review the diff");
  }
  return report;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const argument = process.argv[2] ?? "--check";
  if (!new Set(["--check", "--write"]).has(argument) || process.argv.length > 3) {
    process.stderr.write("Usage: node scripts/verify-authorship-provenance.mjs [--check|--write]\n");
    process.exitCode = 2;
  } else {
    try {
      const report = verifyProject(SCRIPT_ROOT, { reportMode: argument.slice(2) });
      process.stdout.write(`Authorship/provenance verified (${report.visualAssetCount} public visual assets, ${report.thirdPartyRecordCount} reviewed third-party records, ${report.legacyReviewRequiredPaths.length} exact legacy paths pending owner confirmation).\n`);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
