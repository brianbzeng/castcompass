import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  isExactVersion,
  sourceImportsMitigatedModule,
  verifyApiImageEvidence,
} from "../scripts/verify-api-image-evidence.mjs";

const root = new URL("../", import.meta.url);
const policy = JSON.parse(await readFile(new URL("security/api-image-policy.json", root), "utf8"));

async function lockedLinuxPackages() {
  const lock = await readFile(new URL("services/api/requirements-runtime.lock", root), "utf8");
  return [...lock.matchAll(
    /^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s;\\]+)(?:\s*;([^\\]+))?/gmu,
  )]
    .filter((match) => !/sys_platform\s*==\s*["']win32["']/u.test(match[3] ?? ""))
    .map((match) => ({ name: match[1], version: match[2] }));
}

async function acceptedEvidence(platform = "linux/arm64") {
  const python = (await lockedLinuxPackages()).map(({ name, version }) => ({
    type: "library",
    name,
    version,
    purl: `pkg:pypi/${name}@${version}`,
    licenses: name === "annotated-types" ? [] : [{ license: { id: "MIT" } }],
  }));
  const runtimeMarker = policy.missingLicenseReviews
    .find((review) => review.package === ".python-rundeps" && review.platform === platform);
  assert.ok(runtimeMarker);
  const apkNames = [
    ...policy.runtime.commonApkPackages,
    ...policy.runtime.platformApkPackages[platform],
  ].map(({ package: name, version }) => ({
    type: "library",
    name,
    version,
      purl: `pkg:apk/alpine/${name}@${version}?arch=${platform === "linux/arm64" ? "aarch64" : "x86_64"}&distro=alpine-3.24.1`,
    licenses: name === ".python-rundeps" ? [] : [{ license: { id: "MIT" } }],
  }));
  const matches = policy.highSeverityExceptions.map((exception) => ({
    artifact: {
      name: exception.package,
      version: exception.version,
      type: exception.type,
    },
    vulnerability: {
      id: exception.vulnerability,
      namespace: exception.namespace,
      severity: exception.severity,
      fix: {
        versions: exception.vulnerability === "CVE-2026-15308" ? ["3.15.0"] : [],
        state: exception.vulnerability === "CVE-2026-15308" ? "fixed" : "",
      },
    },
  }));
  return {
    sourceCommit: "a".repeat(40),
    sbom: {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      metadata: {
        tools: { components: [{ name: "syft", version: policy.scanners.syft }] },
      },
      components: [...apkNames, ...python],
    },
    scan: {
      descriptor: {
        name: "grype",
        version: policy.scanners.grype,
        configuration: { "only-fixed": false },
        db: {
          status: {
            valid: true,
            built: "2026-07-17T06:57:18Z",
            schemaVersion: "v6.1.9",
            from: "https://grype.anchore.io/databases/test.tar.zst?checksum=sha256:test",
          },
        },
      },
      source: { type: "image", target: { architecture: platform.split("/")[1] } },
      matches,
    },
  };
}

test("native image workflow pins scanners and fails closed on full findings", async () => {
  const workflow = await readFile(new URL(".github/workflows/api-image-security.yml", root), "utf8");
  assert.match(workflow, /runner: ubuntu-24\.04\n\s+platform: linux\/amd64/);
  assert.match(workflow, /runner: ubuntu-24\.04-arm\n\s+platform: linux\/arm64/);
  assert.match(workflow, /SOURCE_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
  assert.match(workflow, /ref: \$\{\{ env\.SOURCE_SHA \}\}/);
  assert.match(workflow, /--source-commit "\$SOURCE_SHA"/);
  assert.match(workflow, /name: api-image-security-\$\{\{ matrix\.architecture \}\}-\$\{\{ env\.SOURCE_SHA \}\}/);
  assert.match(workflow, /anchore\/sbom-action@e22c389904149dbc22b58101806040fa8d37a610/);
  assert.match(workflow, /anchore\/scan-action@e1165082ffb1fe366ebaf02d8526e7c4989ea9d2/);
  assert.match(workflow, /syft-version: v1\.42\.3/);
  assert.match(workflow, /grype-version: v0\.110\.0/);
  assert.match(workflow, /fail-build: false\n\s+only-fixed: false/);
  assert.match(workflow, /importlib\.util\.find_spec\(module\) is None/);
  assert.match(workflow, /steps\.policy\.outcome != 'success'[\s\S]+run: exit 1/);
});

test("module mitigation guard rejects direct and parent imports", () => {
  assert.equal(sourceImportsMitigatedModule("import html.parser\n", "html.parser"), true);
  assert.equal(sourceImportsMitigatedModule("from html.parser import HTMLParser\n", "html.parser"), true);
  assert.equal(sourceImportsMitigatedModule("from html import parser\n", "html.parser"), true);
  assert.equal(sourceImportsMitigatedModule("from html import escape, parser\n", "html.parser"), true);
  assert.equal(sourceImportsMitigatedModule("from html import escape\n", "html.parser"), false);
});

test("exact version validation rejects ranges and long hostile suffixes", () => {
  assert.equal(isExactVersion("3.13.14"), true);
  assert.equal(isExactVersion("1.42.3-rc.1"), true);
  assert.equal(isExactVersion(">=3.13.14"), false);
  assert.equal(isExactVersion(`9.9.9+${"--".repeat(20_000)}!`), false);
});

test("API image evidence binds packages, licenses, mitigations and reviewed findings", async () => {
  const evidence = await acceptedEvidence();
  const summary = verifyApiImageEvidence({
    ...evidence,
    policy,
    platform: "linux/arm64",
    now: new Date("2026-07-18T12:00:00Z"),
  });
  assert.equal(summary.inventory.apkPackages, 29);
  assert.equal(summary.sourceCommit, "a".repeat(40));
  assert.equal(summary.inventory.pythonPackages, 22);
  assert.deepEqual(summary.vulnerabilities.severityCounts, {
    Unknown: 0,
    Negligible: 0,
    Low: 0,
    Medium: 0,
    High: 3,
    Critical: 0,
  });
  assert.equal(summary.vulnerabilities.highSeverity.length, 3);
});

test("API image evidence binds the architecture-specific runtime marker", async () => {
  const evidence = await acceptedEvidence("linux/amd64");
  const summary = verifyApiImageEvidence({
    ...evidence,
    policy,
    platform: "linux/amd64",
    now: new Date("2026-07-18T12:00:00Z"),
  });
  assert.deepEqual(summary.inventory.missingLicenseReviews, [
    "apk:-python-rundeps@20260616.002554",
    "python:annotated-types@0.7.0",
  ]);
});

test("API image evidence rejects unreviewed Critical findings", async () => {
  const evidence = await acceptedEvidence();
  evidence.scan.matches.push({
    artifact: { name: "musl", version: "1.2.6-r2", type: "apk" },
    vulnerability: {
      id: "CVE-2026-99999",
      namespace: "alpine:distro:alpine:3.24",
      severity: "Critical",
      fix: { versions: [], state: "not-fixed" },
    },
  });
  assert.throws(() => verifyApiImageEvidence({
    ...evidence,
    policy,
    platform: "linux/arm64",
    now: new Date("2026-07-18T12:00:00Z"),
  }), /unshippable Critical finding/);
});

test("API image evidence rejects expired exceptions and stable-series fixes", async () => {
  const evidence = await acceptedEvidence();
  assert.throws(() => verifyApiImageEvidence({
    ...evidence,
    policy,
    platform: "linux/arm64",
    now: new Date("2026-08-09T00:00:00Z"),
  }), /exception expired/);

  evidence.scan.matches[0].vulnerability.fix.versions = ["3.13.15"];
  assert.throws(() => verifyApiImageEvidence({
    ...evidence,
    policy,
    platform: "linux/arm64",
    now: new Date("2026-07-18T12:00:00Z"),
  }), /fixed by stable Python 3\.13\.15/);
});

test("API image evidence rejects unowned or overlong exception renewals", async () => {
  const evidence = await acceptedEvidence();
  const unowned = structuredClone(policy);
  unowned.exceptionReview.owner = "";
  assert.throws(() => verifyApiImageEvidence({
    ...evidence,
    policy: unowned,
    platform: "linux/arm64",
    now: new Date("2026-07-18T12:00:00Z"),
  }), /review owner is invalid/);

  const overlong = structuredClone(policy);
  overlong.exceptionReview.renewalDeadline = "2026-08-20";
  for (const exception of overlong.highSeverityExceptions) exception.expires = "2026-08-20";
  assert.throws(() => verifyApiImageEvidence({
    ...evidence,
    policy: overlong,
    platform: "linux/arm64",
    now: new Date("2026-07-18T12:00:00Z"),
  }), /exceeds the bounded post-release grace/);

  const futureReview = structuredClone(policy);
  futureReview.reviewedAt = "2026-07-19";
  assert.throws(() => verifyApiImageEvidence({
    ...evidence,
    policy: futureReview,
    platform: "linux/arm64",
    now: new Date("2026-07-18T12:00:00Z"),
  }), /review date is in the future/);
});

test("API image evidence rejects packages without license reconciliation", async () => {
  const evidence = await acceptedEvidence();
  const zlib = evidence.sbom.components.find(({ name }) => name === "zlib");
  assert.ok(zlib);
  zlib.licenses = [];
  assert.throws(() => verifyApiImageEvidence({
    ...evidence,
    policy,
    platform: "linux/arm64",
    now: new Date("2026-07-18T12:00:00Z"),
  }), /has no reviewed license evidence/);
});

test("API image evidence rejects an additional otherwise-allowed APK package", async () => {
  const evidence = await acceptedEvidence();
  evidence.sbom.components.push({
    type: "library",
    name: "mystery-runtime",
    version: "1-r0",
    purl: "pkg:apk/alpine/mystery-runtime@1-r0?arch=aarch64&distro=alpine-3.24.1",
    licenses: [{ license: { id: "MIT" } }],
  });
  assert.throws(() => verifyApiImageEvidence({
    ...evidence,
    policy,
    platform: "linux/arm64",
    now: new Date("2026-07-18T12:00:00Z"),
  }), /does not contain exactly 29 reviewed APK packages/);
});
