#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXACT_VERSION = /^\d+\.\d+\.\d+$/u;
const EXACT_SHA256 = /^[a-f0-9]{64}$/u;
const EXACT_REVISION = /^[a-f0-9]{40}$/u;
const TRUSTED_SOURCES = Object.freeze({
  versions: "https://raw.githubusercontent.com/docker-library/python/master/versions.json",
  dockerfile: "https://raw.githubusercontent.com/docker-library/python/master/3.13/alpine3.24/Dockerfile",
  officialImages: "https://raw.githubusercontent.com/docker-library/official-images/master/library/python",
});

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function plainObject(value, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function versionParts(value, label = "version") {
  invariant(EXACT_VERSION.test(value ?? ""), `${label} must be an exact three-part version`);
  return value.split(".").map(Number);
}

function exactMatches(text, pattern, label) {
  const matches = [...text.matchAll(pattern)];
  invariant(matches.length === 1, `${label} must appear exactly once`);
  return matches[0][1];
}

function parseOfficialImageEntry(text, exactTag) {
  const entries = text.split(/\n\s*\n/gu).filter(Boolean).map((block) => {
    const fields = new Map();
    for (const line of block.split("\n")) {
      const separator = line.indexOf(":");
      if (separator < 1) continue;
      const name = line.slice(0, separator);
      const value = line.slice(separator + 1).trim();
      invariant(!fields.has(name), `Docker Official Image entry duplicates ${name}`);
      fields.set(name, value);
    }
    return fields;
  });
  const matches = entries.filter((entry) => (entry.get("Tags") ?? "")
    .split(",").map((tag) => tag.trim()).includes(exactTag));
  invariant(matches.length === 1, `Docker Official Image tag ${exactTag} must appear exactly once`);
  return matches[0];
}

export function verifyApiImageUpstreamPolicy(policy, workflowText) {
  plainObject(policy, "API image policy");
  invariant(policy.schemaVersion === 2, "API image policy schema is unsupported");
  const watch = plainObject(policy.upstreamWatch, "API image upstream watch");
  invariant(watch.schemaVersion === 1, "API image upstream-watch schema is unsupported");
  invariant(/^\d+\.\d+$/u.test(watch.series ?? ""), "API image upstream series is invalid");
  invariant(/^[a-z0-9][a-z0-9.-]{2,31}$/u.test(watch.variant ?? ""), "API image upstream variant is invalid");
  const runtimeParts = versionParts(policy.runtime?.python, "Policy Python version");
  invariant(watch.series === runtimeParts.slice(0, 2).join("."), "API image upstream series does not match the runtime");
  invariant(policy.baseImage?.tag === `${policy.runtime.python}-${watch.variant}`,
    "API image tag does not match the watched runtime and variant");
  invariant(EXACT_REVISION.test(policy.baseImage?.sourceRevision ?? ""), "API image source revision is invalid");
  invariant(Number.isInteger(watch.maximumScheduleIntervalHours)
    && watch.maximumScheduleIntervalHours === 24,
  "API image upstream watch must run at least daily");
  invariant(Number.isInteger(watch.requestTimeoutMilliseconds)
    && watch.requestTimeoutMilliseconds >= 1_000
    && watch.requestTimeoutMilliseconds <= 30_000,
  "API image upstream request timeout is invalid");
  invariant(Number.isInteger(watch.maximumResponseBytes)
    && watch.maximumResponseBytes >= 65_536
    && watch.maximumResponseBytes <= 2_097_152,
  "API image upstream response bound is invalid");
  const sources = plainObject(watch.sources, "API image upstream sources");
  invariant(Object.keys(sources).sort().join(",") === Object.keys(TRUSTED_SOURCES).sort().join(","),
    "API image upstream source inventory is incomplete");
  for (const [name, url] of Object.entries(TRUSTED_SOURCES)) {
    invariant(sources[name] === url, `API image upstream ${name} source is not the reviewed primary source`);
  }
  const expected = versionParts(policy.exceptionReview?.expectedNextVersion, "Expected next Python version");
  invariant(expected[0] === runtimeParts[0]
    && expected[1] === runtimeParts[1]
    && expected[2] === runtimeParts[2] + 1,
  "API image upstream watch is not bound to the next patch release");

  if (workflowText !== undefined) {
    invariant(typeof workflowText === "string" && workflowText.length > 0,
      "API image upstream workflow is missing");
    invariant(/on:\n\s+schedule:\n\s+- cron: "\d{1,2} \d{1,2} \* \* \*"\n\s+workflow_dispatch:/u.test(workflowText),
      "API image upstream workflow is not scheduled daily and manually dispatchable");
    invariant(/permissions:\n\s+contents: read/u.test(workflowText),
      "API image upstream workflow lacks read-only contents permission");
    invariant(/actions\/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0/u.test(workflowText),
      "API image upstream workflow checkout action is not pinned");
    invariant(/actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/u.test(workflowText),
      "API image upstream workflow Node action is not pinned");
    invariant(/node scripts\/audit-api-image-upstream\.mjs audit-live/u.test(workflowText),
      "API image upstream workflow does not execute the live audit");
    invariant(!/(?:contents|id-token|packages|attestations|issues|pull-requests): write/u.test(workflowText),
      "API image upstream workflow grants write permission");
    invariant(!/\b(?:npm|pnpm|yarn)\s+(?:ci|install|run)\b/u.test(workflowText),
      "API image upstream workflow executes dependency code");
  }

  return {
    schemaVersion: "castingcompass.api-image-upstream-watch-policy/1.0.0",
    policyValid: true,
    series: watch.series,
    variant: watch.variant,
    maximumScheduleIntervalHours: watch.maximumScheduleIntervalHours,
    expectedNextVersion: policy.exceptionReview.expectedNextVersion,
    expectedReleaseOn: policy.exceptionReview.nextReviewOn,
    exceptionsExpire: policy.exceptionReview.renewalDeadline,
    liveQueryPerformed: false,
  };
}

export function evaluateApiImageUpstream({
  policy,
  versionsText,
  dockerfileText,
  officialImagesText,
  checkedAt = new Date(),
}) {
  verifyApiImageUpstreamPolicy(policy);
  invariant(checkedAt instanceof Date && Number.isFinite(checkedAt.valueOf()), "Upstream check time is invalid");
  invariant(typeof versionsText === "string" && typeof dockerfileText === "string"
    && typeof officialImagesText === "string", "Upstream source payload is invalid");
  const watch = policy.upstreamWatch;
  let versions;
  try {
    versions = JSON.parse(versionsText);
  } catch {
    throw new Error("Docker Library versions source is not valid JSON");
  }
  plainObject(versions, "Docker Library versions source");
  const seriesEntry = plainObject(versions[watch.series], `Docker Library Python ${watch.series} entry`);
  const upstreamVersion = seriesEntry.version;
  const upstreamParts = versionParts(upstreamVersion, "Docker Library Python version");
  const currentParts = versionParts(policy.runtime.python, "Policy Python version");
  invariant(upstreamParts[0] === currentParts[0] && upstreamParts[1] === currentParts[1],
    "Docker Library Python release escaped the watched series");
  if (upstreamVersion !== policy.runtime.python) {
    const direction = upstreamParts[2] > currentParts[2] ? "advanced" : "regressed";
    throw new Error(`Docker Official Image ${watch.series} ${direction} from ${policy.runtime.python} to ${upstreamVersion}; replace or re-review the pinned API image`);
  }
  invariant(Array.isArray(seriesEntry.variants)
    && new Set(seriesEntry.variants).size === seriesEntry.variants.length
    && seriesEntry.variants.includes(watch.variant),
  "Docker Library Python entry does not contain the reviewed variant exactly once");
  const sourceSha256 = seriesEntry.checksums?.source?.sha256;
  invariant(EXACT_SHA256.test(sourceSha256 ?? ""), "Docker Library Python source checksum is invalid");
  const dockerfileVersion = exactMatches(
    dockerfileText,
    /^ENV PYTHON_VERSION (\d+\.\d+\.\d+)$/gmu,
    "Docker Library Dockerfile Python version",
  );
  const dockerfileSha256 = exactMatches(
    dockerfileText,
    /^ENV PYTHON_SHA256 ([a-f0-9]{64})$/gmu,
    "Docker Library Dockerfile source checksum",
  );
  invariant(dockerfileVersion === upstreamVersion, "Docker Library Dockerfile version disagrees with versions.json");
  invariant(dockerfileSha256 === sourceSha256, "Docker Library Dockerfile checksum disagrees with versions.json");

  const exactTag = `${upstreamVersion}-${watch.variant}`;
  const imageEntry = parseOfficialImageEntry(officialImagesText, exactTag);
  const tags = (imageEntry.get("Tags") ?? "").split(",").map((tag) => tag.trim());
  for (const requiredTag of [
    exactTag,
    `${watch.series}-${watch.variant}`,
    `${upstreamVersion}-alpine`,
    `${watch.series}-alpine`,
  ]) {
    invariant(tags.includes(requiredTag), `Docker Official Image entry is missing tag ${requiredTag}`);
  }
  const architectures = (imageEntry.get("Architectures") ?? "").split(",").map((value) => value.trim());
  invariant(architectures.includes("amd64") && architectures.includes("arm64v8"),
    "Docker Official Image entry lacks reviewed AMD64/ARM64 coverage");
  invariant(imageEntry.get("Directory") === `${watch.series}/${watch.variant}`,
    "Docker Official Image entry points at the wrong source directory");
  const sourceRevision = imageEntry.get("GitCommit");
  invariant(EXACT_REVISION.test(sourceRevision ?? ""), "Docker Official Image source revision is invalid");
  invariant(sourceRevision === policy.baseImage.sourceRevision,
    "Docker Official Image source revision drifted from the pinned API policy");

  return {
    schemaVersion: "castingcompass.api-image-upstream-watch/1.0.0",
    checkedAt: checkedAt.toISOString(),
    status: "current",
    currentVersion: policy.runtime.python,
    upstreamVersion,
    expectedNextVersion: policy.exceptionReview.expectedNextVersion,
    expectedReleaseOn: policy.exceptionReview.nextReviewOn,
    exceptionsExpire: policy.exceptionReview.renewalDeadline,
    variant: watch.variant,
    sourceSha256,
    sourceRevision,
    architectures: ["linux/amd64", "linux/arm64"],
    liveQueryPerformed: true,
  };
}

async function fetchBoundedText(url, watch) {
  const response = await fetch(url, {
    headers: {
      accept: "text/plain, application/json;q=0.9",
      "user-agent": "CastingCompass-API-image-upstream-watch/1.0",
    },
    redirect: "error",
    signal: AbortSignal.timeout(watch.requestTimeoutMilliseconds),
  });
  invariant(response.ok, `Official upstream source returned HTTP ${response.status}`);
  invariant(response.url === url, "Official upstream source redirected unexpectedly");
  const declaredHeader = response.headers.get("content-length");
  if (declaredHeader !== null) {
    const declaredLength = Number(declaredHeader);
    invariant(Number.isFinite(declaredLength) && declaredLength >= 0
      && declaredLength <= watch.maximumResponseBytes,
    "Official upstream source has an invalid or excessive response length");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  invariant(bytes.length > 0 && bytes.length <= watch.maximumResponseBytes,
    "Official upstream source is empty or exceeds the response bound");
  return bytes.toString("utf8");
}

export async function auditApiImageUpstream({ policy, checkedAt = new Date() }) {
  verifyApiImageUpstreamPolicy(policy);
  const watch = policy.upstreamWatch;
  const [versionsText, dockerfileText, officialImagesText] = await Promise.all([
    fetchBoundedText(watch.sources.versions, watch),
    fetchBoundedText(watch.sources.dockerfile, watch),
    fetchBoundedText(watch.sources.officialImages, watch),
  ]);
  return evaluateApiImageUpstream({ policy, versionsText, dockerfileText, officialImagesText, checkedAt });
}

async function main() {
  const mode = process.argv[2];
  invariant(["verify-policy", "audit-live"].includes(mode) && process.argv.length === 3,
    "Usage: node scripts/audit-api-image-upstream.mjs <verify-policy|audit-live>");
  const policy = JSON.parse(readFileSync(resolve(ROOT, "security/api-image-policy.json"), "utf8"));
  const result = mode === "verify-policy"
    ? verifyApiImageUpstreamPolicy(
      policy,
      readFileSync(resolve(ROOT, ".github/workflows/api-image-upstream-watch.yml"), "utf8"),
    )
    : await auditApiImageUpstream({ policy });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "API image upstream audit failed"}\n`);
    process.exitCode = 1;
  });
}
