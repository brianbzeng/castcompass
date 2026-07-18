#!/usr/bin/env node

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXACT_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+._][0-9A-Za-z.-]+)?$/u;
const EXACT_APK_VERSION = /^\d[0-9A-Za-z._+~-]*$/u;
const EXACT_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const SEVERITY = new Map([
  ["Unknown", 0],
  ["Negligible", 1],
  ["Low", 2],
  ["Medium", 3],
  ["High", 4],
  ["Critical", 5],
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function isExactVersion(value) {
  return EXACT_VERSION.test(value);
}

function exactDate(value, boundary = "start") {
  invariant(EXACT_DATE.test(value ?? ""), `Policy ${boundary} date is invalid`);
  const suffix = boundary === "end" ? "T23:59:59Z" : "T00:00:00Z";
  const date = new Date(`${value}${suffix}`);
  invariant(Number.isFinite(date.valueOf()), `Policy ${boundary} date is invalid`);
  invariant(date.toISOString().slice(0, 10) === value, `Policy ${boundary} date is invalid`);
  return date;
}

function versionParts(value) {
  invariant(/^\d+\.\d+\.\d+$/u.test(value ?? ""), `Policy Python version ${value} is invalid`);
  return value.split(".").map(Number);
}

function normalizeName(value) {
  return value.toLowerCase().replace(/[._-]+/gu, "-");
}

function packageType(component) {
  if (component.purl?.startsWith("pkg:apk/")) return "apk";
  if (component.purl?.startsWith("pkg:pypi/")) return "python";
  return null;
}

function packageKey({ name, package: packageName, version, type }) {
  return `${type}:${normalizeName(name ?? packageName)}@${version}`;
}

function vulnerabilityKey({ vulnerability, namespace, package: name, version, type, severity }) {
  return [vulnerability, namespace, normalizeName(name), version, type, severity].join("|");
}

function componentLicenses(component) {
  return (component.licenses ?? []).flatMap((entry) => {
    const value = entry.expression ?? entry.license?.id ?? entry.license?.name;
    return typeof value === "string" && value ? [value] : [];
  });
}

function pythonLockPackages(root) {
  const text = readFileSync(resolve(root, "services/api/requirements-runtime.lock"), "utf8");
  const packages = new Map();
  for (const match of text.matchAll(
    /^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s;\\]+)(?:\s*;([^\\]+))?/gmu,
  )) {
    const marker = match[3]?.trim() ?? "";
    if (/sys_platform\s*==\s*["']win32["']/u.test(marker)) continue;
    const name = normalizeName(match[1]);
    invariant(!packages.has(name), `API runtime lock resolves ${name} more than once`);
    packages.set(name, match[2]);
  }
  invariant(packages.size >= 20, "API runtime lock has no complete Linux dependency graph");
  return packages;
}

function sourceFiles(path) {
  const files = [];
  for (const name of readdirSync(path).sort()) {
    const child = join(path, name);
    if (statSync(child).isDirectory()) files.push(...sourceFiles(child));
    else if (name.endsWith(".py")) files.push(child);
  }
  return files;
}

export function sourceImportsMitigatedModule(source, module) {
  const escaped = module.replaceAll(".", "\\.");
  const directImport = new RegExp(
    `(?:^|\\n)\\s*(?:from\\s+${escaped}(?:\\s+|\\.)|import\\s+[^\\n]*\\b${escaped}\\b)`,
    "u",
  );
  if (directImport.test(source)) return true;

  const separator = module.lastIndexOf(".");
  if (separator === -1) return false;
  const parent = module.slice(0, separator).replaceAll(".", "\\.");
  const child = module.slice(separator + 1).replaceAll(".", "\\.");
  return new RegExp(
    `(?:^|\\n)\\s*from\\s+${parent}\\s+import\\s+(?:[^\\n#]*,\\s*)?${child}(?:\\s|,|#|$)`,
    "u",
  ).test(source);
}

function assertModuleMitigations(root, policy, dockerfile) {
  const mitigated = new Set(policy.mitigatedModules.map(({ module }) => module));
  for (const exception of policy.highSeverityExceptions) {
    invariant(mitigated.has(exception.module), `${exception.vulnerability} has no runtime module mitigation`);
  }

  for (const { module, removedPath } of policy.mitigatedModules) {
    invariant(removedPath.startsWith("/usr/local/lib/python3.13/"), `${module} removal path is not runtime-bound`);
    invariant(dockerfile.includes(removedPath), `Dockerfile does not remove ${module}`);
    for (const directory of ["services/api/app", "shared"]) {
      for (const path of sourceFiles(resolve(root, directory))) {
        invariant(
          !sourceImportsMitigatedModule(readFileSync(path, "utf8"), module),
          `${module} is imported by ${path}`,
        );
      }
    }
  }
}

function assertExceptionReview(policy, now) {
  const review = policy.exceptionReview;
  invariant(review && typeof review === "object", "High-severity exceptions lack an owner-bound review");
  invariant(/^[a-z0-9][a-z0-9._/-]{2,63}$/u.test(review.owner ?? ""), "Exception review owner is invalid");
  invariant(review.decision === "bounded-renewal-pending-stable-release",
    "Exception review decision is unsupported");
  invariant(review.observedStableVersion === policy.runtime.python,
    "Exception review does not bind the observed stable runtime");
  const current = versionParts(policy.runtime.python);
  const expected = versionParts(review.expectedNextVersion);
  invariant(expected[0] === current[0] && expected[1] === current[1] && expected[2] === current[2] + 1,
    "Exception review does not name a later stable-series release");

  const reviewedAt = exactDate(policy.reviewedAt);
  invariant(reviewedAt <= now, "Exception policy review date is in the future");
  const nextReview = exactDate(review.nextReviewOn, "end");
  const deadline = exactDate(review.renewalDeadline, "end");
  invariant(reviewedAt <= nextReview, "Exception re-review precedes the policy review");
  invariant(nextReview <= deadline, "Exception deadline precedes the required re-review");
  invariant(Number.isInteger(review.maximumPostReleaseGraceDays)
    && review.maximumPostReleaseGraceDays >= 1
    && review.maximumPostReleaseGraceDays <= 7,
  "Exception post-release grace must be between one and seven days");
  invariant(
    deadline.valueOf() - nextReview.valueOf()
      <= review.maximumPostReleaseGraceDays * 86_400_000,
    "Exception renewal exceeds the bounded post-release grace",
  );
  invariant(typeof review.reason === "string" && review.reason.length >= 80,
    "Exception review reason is incomplete");
  invariant(Array.isArray(review.sources) && review.sources.length >= 4,
    "Exception review lacks primary sources");
  const sources = new Set(review.sources);
  invariant(sources.size === review.sources.length, "Exception review sources contain duplicates");
  invariant([...sources].every((source) => /^https:\/\/(?:www\.python\.org|peps\.python\.org|github\.com\/docker-library)\//u.test(source)),
    "Exception review includes a non-primary source");
  invariant([...sources].some((source) => source.startsWith("https://www.python.org/downloads/release/")),
    "Exception review lacks the current Python release");
  invariant(sources.has("https://peps.python.org/pep-0719/"),
    "Exception review lacks the Python 3.13 release schedule");
  invariant(sources.has("https://github.com/docker-library/official-images/blob/master/library/python"),
    "Exception review lacks the Docker Official Image source");
  return review;
}

function assertPolicy(policy, now) {
  invariant(policy.schemaVersion === 2, "API image policy schema is unsupported");
  exactDate(policy.reviewedAt);
  invariant(isExactVersion(policy.runtime.python), "Policy Python version is not exact");
  invariant(EXACT_DIGEST.test(policy.baseImage.indexDigest), "Base image index digest is invalid");
  invariant(/^[a-f0-9]{40}$/u.test(policy.baseImage.sourceRevision), "Base image source revision is invalid");
  invariant(isExactVersion(policy.scanners.syft), "Syft version is not exact");
  invariant(isExactVersion(policy.scanners.grype), "Grype version is not exact");
  invariant(policy.scanners.maximumDatabaseAgeDays >= 1, "Grype database age policy is invalid");
  invariant(new Set(policy.allowedLicenseExpressions).size === policy.allowedLicenseExpressions.length,
    "Allowed license expressions contain duplicates");
  const commonApk = new Map(policy.runtime.commonApkPackages.map((entry) => [normalizeName(entry.package), entry.version]));
  invariant(commonApk.size === policy.runtime.commonApkPackages.length, "Common APK policy contains duplicates");
  for (const platform of Object.keys(policy.baseImage.platforms)) {
    const platformApk = policy.runtime.platformApkPackages[platform];
    invariant(Array.isArray(platformApk), `APK policy is missing ${platform}`);
    const expected = new Map([...commonApk, ...platformApk.map((entry) => [normalizeName(entry.package), entry.version])]);
    invariant(expected.size === policy.runtime.expectedApkPackageCount,
      `APK policy for ${platform} does not contain exactly ${policy.runtime.expectedApkPackageCount} packages`);
    for (const version of expected.values()) {
      invariant(EXACT_APK_VERSION.test(version), `APK policy for ${platform} contains an inexact version`);
    }
  }
  for (const review of policy.missingLicenseReviews) {
    invariant(
      !review.platform || policy.baseImage.platforms[review.platform],
      `${review.package} license review names an unsupported platform`,
    );
  }

  const exceptions = new Set();
  const review = policy.highSeverityExceptions.length > 0 ? assertExceptionReview(policy, now) : null;
  for (const exception of policy.highSeverityExceptions) {
    invariant(exception.severity === "High", `${exception.vulnerability} may not exempt Critical severity`);
    invariant(/^CVE-\d{4}-\d+$/u.test(exception.vulnerability), "Exception CVE is invalid");
    invariant(/^https:\/\/(?:github\.com\/python\/cpython|mail\.python\.org)\//u.test(exception.source),
      `${exception.vulnerability} lacks a primary CPython source`);
    invariant(exception.expires === review.renewalDeadline,
      `${exception.vulnerability} expiration is not review-bound`);
    const expires = exactDate(exception.expires, "end");
    invariant(now <= expires, `${exception.vulnerability} exception expired on ${exception.expires}`);
    const key = vulnerabilityKey(exception);
    invariant(!exceptions.has(key), `${exception.vulnerability} exception is duplicated`);
    exceptions.add(key);
  }
  return exceptions;
}

function assertContainerContract(root, policy) {
  const dockerfile = readFileSync(resolve(root, "services/api/Dockerfile"), "utf8");
  const reference = `${policy.baseImage.repository}:${policy.baseImage.tag}@${policy.baseImage.indexDigest}`;
  invariant(dockerfile.startsWith(`FROM ${reference} AS runtime\n`), "Dockerfile base image is not policy-bound");
  invariant(readFileSync(resolve(root, "services/api/.python-version"), "utf8") === `${policy.runtime.python}\n`,
    "API Python selector does not match image policy");
  invariant(/^USER contourcast$/mu.test(dockerfile), "API image must run as contourcast");
  invariant(/python -m pip check/u.test(dockerfile), "API image does not validate installed requirements");
  invariant(/\/usr\/local\/bin\/pip\*/u.test(dockerfile), "API image does not remove pip executables");
  invariant(/^CMD \["python", "-m", "app\.server"\]$/mu.test(dockerfile), "API startup must not use a shell");
  invariant(/^\s+CMD \["python", "-c",/mu.test(dockerfile), "API health check must use exec form");
  assertModuleMitigations(root, policy, dockerfile);
  return reference;
}

function assertSbom(root, policy, sbom, platform) {
  invariant(sbom.bomFormat === "CycloneDX", "API image SBOM is not CycloneDX");
  invariant(["1.5", "1.6"].includes(sbom.specVersion), "API image SBOM version is unsupported");
  const syft = sbom.metadata?.tools?.components?.find(({ name }) => name === "syft");
  invariant(syft?.version === policy.scanners.syft, "API image SBOM used an unexpected Syft version");
  invariant(Array.isArray(sbom.components), "API image SBOM has no components");

  const packageComponents = sbom.components.filter((component) => packageType(component));
  const seen = new Set();
  for (const component of packageComponents) {
    const key = packageKey({ ...component, type: packageType(component) });
    invariant(!seen.has(key), `API image SBOM duplicates ${key}`);
    seen.add(key);
  }

  const expectedPython = pythonLockPackages(root);
  const observedPython = new Map(packageComponents
    .filter((component) => packageType(component) === "python")
    .map((component) => [normalizeName(component.name), component.version]));
  invariant(observedPython.size === expectedPython.size, "API image Python packages do not exactly match the Linux lock");
  for (const [name, version] of expectedPython) {
    invariant(observedPython.get(name) === version, `API image is missing locked ${name}@${version}`);
  }

  const apk = packageComponents.filter((component) => packageType(component) === "apk");
  const expectedApk = new Map([
    ...policy.runtime.commonApkPackages,
    ...policy.runtime.platformApkPackages[platform],
  ].map(({ package: name, version }) => [normalizeName(name), version]));
  const observedApk = new Map(apk.map(({ name, version }) => [normalizeName(name), version]));
  invariant(observedApk.size === apk.length, `API image ${platform} duplicates an APK package name`);
  invariant(observedApk.size === expectedApk.size,
    `API image ${platform} does not contain exactly ${expectedApk.size} reviewed APK packages`);
  for (const [name, version] of expectedApk) {
    invariant(observedApk.get(name) === version, `API image ${platform} has unexpected APK ${name}@${observedApk.get(name)}`);
  }
  const packageNames = new Set(packageComponents.map(({ name }) => normalizeName(name)));
  for (const name of policy.runtime.forbiddenPackages) {
    invariant(!packageNames.has(normalizeName(name)), `API image contains forbidden runtime package ${name}`);
  }

  const allowedLicenses = new Set(policy.allowedLicenseExpressions);
  const applicableLicenseReviews = policy.missingLicenseReviews
    .filter((review) => !review.platform || review.platform === platform);
  const licenseReviews = new Map(applicableLicenseReviews.map((review) => [packageKey(review), review]));
  invariant(licenseReviews.size === applicableLicenseReviews.length,
    `API image ${platform} has duplicate missing-license reviews`);
  const usedReviews = new Set();
  const licenses = new Set();
  for (const component of packageComponents) {
    const expressions = componentLicenses(component);
    if (expressions.length === 0) {
      const key = packageKey({ ...component, type: packageType(component) });
      invariant(licenseReviews.has(key), `API image package ${key} has no reviewed license evidence`);
      const review = licenseReviews.get(key);
      invariant(/^https:\/\//u.test(review.source) && review.classification.length >= 20,
        `${key} license review is incomplete`);
      usedReviews.add(key);
      continue;
    }
    for (const expression of expressions) {
      invariant(allowedLicenses.has(expression), `API image introduces unreviewed license ${expression}`);
      licenses.add(expression);
    }
  }
  invariant(usedReviews.size === licenseReviews.size, `API image ${platform} has stale missing-license reviews`);

  return {
    components: sbom.components.length,
    apkPackages: apk.length,
    pythonPackages: observedPython.size,
    licenses: [...licenses].sort(),
    missingLicenseReviews: [...usedReviews].sort(),
  };
}

function assertScan(policy, scan, platform, now, expectedExceptionKeys) {
  invariant(scan.descriptor?.name === "grype", "API image vulnerability report is not from Grype");
  invariant(scan.descriptor.version === policy.scanners.grype, "API image used an unexpected Grype version");
  invariant(scan.descriptor.configuration?.["only-fixed"] === false,
    "API scan omitted vulnerabilities without fixes");
  invariant(scan.descriptor.db?.status?.valid === true, "Grype vulnerability database is invalid");
  const databaseBuilt = new Date(scan.descriptor.db.status.built);
  invariant(Number.isFinite(databaseBuilt.valueOf()), "Grype database build time is invalid");
  const age = now.valueOf() - databaseBuilt.valueOf();
  invariant(age >= -86_400_000, "Grype database build time is implausibly in the future");
  invariant(age <= policy.scanners.maximumDatabaseAgeDays * 86_400_000,
    "Grype vulnerability database is older than policy permits");
  invariant(scan.source?.type === "image", "Grype did not scan a container image");
  const architecture = platform.split("/")[1];
  invariant(scan.source.target?.architecture === architecture, `Grype report is not for ${platform}`);
  invariant(Array.isArray(scan.matches), "Grype report has no matches array");

  const observedExceptions = new Set();
  const severityCounts = Object.fromEntries([...SEVERITY.keys()].map((severity) => [severity, 0]));
  const highSeverity = [];
  const currentSeries = policy.runtime.python.split(".").slice(0, 2).join(".");
  for (const match of scan.matches) {
    const severity = match.vulnerability?.severity ?? "Unknown";
    invariant(SEVERITY.has(severity), `Grype emitted unknown severity ${severity}`);
    severityCounts[severity] += 1;
    if (SEVERITY.get(severity) < SEVERITY.get("High")) continue;
    const finding = {
      vulnerability: match.vulnerability.id,
      namespace: match.vulnerability.namespace,
      package: match.artifact.name,
      version: match.artifact.version,
      type: match.artifact.type,
      severity,
    };
    invariant(severity !== "Critical", `${finding.vulnerability} is an unshippable Critical finding`);
    const key = vulnerabilityKey(finding);
    invariant(expectedExceptionKeys.has(key), `${finding.vulnerability} has no exact reviewed exception`);
    const stableFix = (match.vulnerability.fix?.versions ?? [])
      .find((version) => version.startsWith(`${currentSeries}.`));
    invariant(!stableFix, `${finding.vulnerability} is fixed by stable Python ${stableFix}`);
    observedExceptions.add(key);
    highSeverity.push({ ...finding, fix: match.vulnerability.fix ?? { versions: [], state: "" } });
  }
  invariant(observedExceptions.size === expectedExceptionKeys.size, "API scan policy contains stale vulnerability exceptions");
  return {
    matches: scan.matches.length,
    severityCounts,
    highSeverity: highSeverity.sort((left, right) => left.vulnerability.localeCompare(right.vulnerability)),
    database: {
      schemaVersion: scan.descriptor.db.status.schemaVersion,
      built: scan.descriptor.db.status.built,
      source: scan.descriptor.db.status.from,
    },
  };
}

export function verifyApiImageEvidence({
  sbom,
  scan,
  policy,
  platform,
  sourceCommit,
  now = new Date(),
  root = ROOT,
}) {
  invariant(policy.baseImage.platforms[platform], `Platform ${platform} is not policy-bound`);
  invariant(/^[a-f0-9]{40}$/u.test(sourceCommit), "API image evidence source commit is invalid");
  const exceptionKeys = assertPolicy(policy, now);
  const imageReference = assertContainerContract(root, policy);
  const inventory = assertSbom(root, policy, sbom, platform);
  const vulnerabilities = assertScan(policy, scan, platform, now, exceptionKeys);
  return {
    schemaVersion: 1,
    platform,
    sourceCommit,
    imageReference,
    platformManifestDigest: policy.baseImage.platforms[platform].manifestDigest,
    operatingSystemBaseDigest: policy.baseImage.platforms[platform].operatingSystemBaseDigest,
    sourceRevision: policy.baseImage.sourceRevision,
    scanners: { syft: policy.scanners.syft, grype: policy.scanners.grype },
    inventory,
    vulnerabilities,
    policyReview: {
      reviewedAt: policy.reviewedAt,
      owner: policy.exceptionReview?.owner,
      nextReviewOn: policy.exceptionReview?.nextReviewOn,
      exceptionsExpire: policy.highSeverityExceptions[0]?.expires,
    },
  };
}

function cliArguments(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    invariant(/^--(?:policy|sbom|scan|platform|source-commit|output)$/u.test(name ?? "") && value,
      "Usage: verify-api-image-evidence.mjs --policy FILE --sbom FILE --scan FILE --platform OS/ARCH --source-commit SHA --output FILE");
    parsed[name.slice(2)] = value;
  }
  for (const name of ["policy", "sbom", "scan", "platform", "source-commit", "output"]) {
    invariant(parsed[name], `Missing --${name}`);
  }
  return parsed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const paths = cliArguments(process.argv.slice(2));
  const result = verifyApiImageEvidence({
    policy: JSON.parse(readFileSync(resolve(paths.policy), "utf8")),
    sbom: JSON.parse(readFileSync(resolve(paths.sbom), "utf8")),
    scan: JSON.parse(readFileSync(resolve(paths.scan), "utf8")),
    platform: paths.platform,
    sourceCommit: paths["source-commit"],
  });
  writeFileSync(resolve(paths.output), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
