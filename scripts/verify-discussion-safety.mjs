import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function requirePattern(source, pattern, label) {
  if (!pattern.test(source)) throw new Error(`Source preflight failed: ${label}`);
  return label;
}

function forbidPattern(source, pattern, label) {
  if (pattern.test(source)) throw new Error(`Source preflight failed: ${label}`);
  return label;
}

const PUBLIC_DISCUSSION_WRITER_PATTERN = /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?)\s+(?:(?:[`"']?main[`"']?|\[main\])\s*\.\s*)?(?:[`"']?site_discussion_posts[`"']?|\[site_discussion_posts\])(?!\w)/iu;

async function readTypeScriptTree(directory) {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const sources = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      sources.push(await readTypeScriptTree(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      sources.push(await readFile(path, "utf8"));
    }
  }
  return sources.join("\n");
}

export function verifyRuntimeDiscussionWriterSource(source) {
  return forbidPattern(
    source,
    PUBLIC_DISCUSSION_WRITER_PATTERN,
    "runtime Worker has no public discussion writer",
  );
}

export async function verifySourceSafety(root = DEFAULT_ROOT) {
  const read = (path) => readFile(resolve(root, path), "utf8");
  const [
    wrangler,
    review,
    discussions,
    security,
    worker,
    migration,
    runbook,
    integratedRunbook,
    integratedRelease,
    integratedPreflight,
    reconciliation,
    deployment,
    postMigrationAudit,
    packageJson,
    releaseWrapper,
    workerRuntime,
  ] = await Promise.all([
    read("wrangler.jsonc"),
    read("worker/trip-review.ts"),
    read("worker/discussions.ts"),
    read("worker/security.ts"),
    read("worker/index.ts"),
    read("drizzle/0009_human_discussion_approval.sql"),
    read("docs/DISCUSSION-MODERATION.md"),
    read("docs/INTEGRATED-RELEASE.md"),
    read("scripts/integrated-release.mjs"),
    read("scripts/integrated-release-preflight.sql"),
    read("scripts/reconcile-0007-legal-migration.sql"),
    read("docs/CLOUDFLARE_DEPLOYMENT.md"),
    read("scripts/discussion-post-migration-audit.sql"),
    read("package.json"),
    read("scripts/release-cloudflare.mjs"),
    readTypeScriptTree(resolve(root, "worker")),
  ]);
  return [
    requirePattern(wrangler, /"PUBLIC_DISCUSSIONS_ENABLED"\s*:\s*"false"/, "public discussions default off"),
    requirePattern(wrangler, /"version_metadata"[\s\S]*"CF_VERSION_METADATA"/, "Worker version metadata is bound"),
    forbidPattern(review, /publishTripDiscussion|site_discussion_posts/, "AI review must not reference the public table or writer"),
    verifyRuntimeDiscussionWriterSource(workerRuntime),
    requirePattern(review, /You cannot publish or approve it/, "AI prompt denies publication authority"),
    requirePattern(discussions, /!publicDiscussionsEnabled\(env\).*posts:\s*\[\]/s, "disabled endpoint returns no posts"),
    requirePattern(discussions, /post\.site_id = trip\.site_id/, "post site must match the reviewed trip"),
    requirePattern(discussions, /post\.source_ai_reviewed_at = trip\.ai_reviewed_at/, "approval binds to the reviewed version"),
    requirePattern(discussions, /trip\.ai_review_status = 'reviewed'/, "only currently reviewed trips are readable"),
    requirePattern(discussions, /trip\.moderation_status = 'approved'/, "trip requires human approval"),
    requirePattern(discussions, /Cache-Control"\)\) headers\.set\("Cache-Control", "no-store"\)/, "discussion responses are not cached"),
    requirePattern(security, /workerVersionId/, "health response exposes the active Worker version"),
    requirePattern(migration, /ADD COLUMN `approved_at` text/, "approval timestamp migration exists"),
    requirePattern(migration, /ADD COLUMN `approved_by` text/, "approver migration exists"),
    requirePattern(migration, /ADD COLUMN `source_ai_reviewed_at` text/, "review-version migration exists"),
    requirePattern(runbook, /oldest permitted rollback target/, "safe rollback floor is documented"),
    requirePattern(runbook, /e2c612246fadfdb231e481c405fa72e502458ed1/, "patched safety-floor commit is pinned"),
    requirePattern(runbook, /moderation_status = 'pending'/, "approval occurs while the trip remains hidden"),
    requirePattern(integratedRunbook, /d1 time-travel info/, "pre-migration Time Travel bookmark is recorded"),
    requirePattern(integratedRunbook, /exactly one version[\s\S]*100%/i, "deployed Worker version must receive all traffic"),
    requirePattern(integratedRunbook, /Disable Cloudflare Git-connected automatic deployments/i, "automatic deployment is paused before rollout"),
    requirePattern(integratedRunbook, /export RELEASE_COMMIT=FULL_40_CHARACTER_RELEASE_COMMIT[\s\S]*npm ci --ignore-scripts[\s\S]*verify:release-checkout/, "full release provenance precedes D1 work"),
    requirePattern(runbook, /real containment smoke test[\s\S]*total public-row count is unchanged/i, "synthetic AI containment is verified"),
    requirePattern(runbook, /expected-worker-version-id FULL_VERSION_ID/, "live checks bind the full release version"),
    requirePattern(wrangler, /"RELEASE_MAINTENANCE_MODE"\s*:\s*"false"/, "release maintenance defaults off"),
    requirePattern(worker, /releaseMaintenanceResponse\(request, env\)/, "maintenance blocks APIs before routing"),
    requirePattern(worker, /if \(releaseMaintenanceEnabled\(env\)\) return;/, "maintenance suppresses scheduled work"),
    requirePattern(integratedRelease, /migrations_pattern:\s*`drizzle\/\$\{targetMigration\}`/, "staged config exposes one exact migration"),
    requirePattern(integratedRelease, /verifyReleaseCheckout/, "integrated migration wrapper verifies release provenance"),
    requirePattern(integratedRelease, /verifyProductionChangeAuthorization/, "integrated mutations require private authorization"),
    requirePattern(integratedPreflight, /legal_columns_exact/, "integrated preflight verifies legal-column drift"),
    requirePattern(reconciliation, /INSERT INTO d1_migrations\(name\)/, "0007 ledger reconciliation is explicit"),
    requirePattern(deployment, /must not run migrations automatically/i, "production deployment guidance separates schema changes"),
    requirePattern(packageJson, /"release:cloudflare"\s*:\s*"[^"]*release-cloudflare\.mjs[^"]*--mode normal/, "release uses the guarded wrapper"),
    requirePattern(releaseWrapper, /await authorizationVerifier\([\s\S]+npmPath, "ci", "--ignore-scripts"[\s\S]+npmPath, "run", "build:cloudflare"[\s\S]+await authorizationVerifier\([\s\S]+wranglerPath, "deploy"/, "release rebuilds before deployment"),
    requirePattern(packageJson, /"migrate:cloudflare:remote"\s*:\s*"[^"]*integrated-release\.mjs apply/, "migration uses the guarded staged wrapper"),
    requirePattern(postMigrationAudit, /approval_columns_found/, "post-migration approval schema is audited"),
    requirePattern(postMigrationAudit, /rows_with_any_approval_metadata/, "legacy approval metadata is audited"),
  ];
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol)) throw new Error(`Unsupported base URL protocol: ${url.protocol}`);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

async function responseJson(response, label) {
  try {
    return await response.json();
  } catch {
    throw new Error(`${label}: expected a JSON response`);
  }
}

export async function verifyLiveSafety({
  baseUrls,
  redirectBaseUrls = [],
  canonicalBaseUrl,
  expectedWorkerVersionId,
  siteIds,
  fetchImpl = globalThis.fetch,
}) {
  if (!Array.isArray(baseUrls) || baseUrls.length === 0) throw new Error("At least one --base-url is required for live verification.");
  if (!Array.isArray(redirectBaseUrls)) throw new Error("redirectBaseUrls must be an array.");
  if (redirectBaseUrls.length > 0 && !canonicalBaseUrl) {
    throw new Error("--canonical-base-url is required when redirect hosts are verified.");
  }
  if (expectedWorkerVersionId !== undefined && !/^[A-Za-z0-9-]{1,128}$/.test(expectedWorkerVersionId)) {
    throw new Error("--expected-worker-version-id must be a nonempty Worker version ID.");
  }
  if (!Array.isArray(siteIds) || siteIds.length === 0) throw new Error("At least one curated site is required for live verification.");
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");

  let requests = 0;
  for (const rawBaseUrl of baseUrls) {
    const baseUrl = normalizeBaseUrl(rawBaseUrl);
    if (expectedWorkerVersionId) {
      const healthLabel = `${baseUrl}/api/health`;
      const health = await fetchImpl(healthLabel, {
        redirect: "manual",
        headers: { "Cache-Control": "no-cache" },
      });
      requests += 1;
      if (health.status !== 200) {
        throw new Error(`${healthLabel}: expected 200, received ${health.status}`);
      }
      const healthCacheControl = health.headers.get("Cache-Control") ?? "";
      if (!/\bno-store\b/i.test(healthCacheControl)) {
        throw new Error(`${healthLabel}: expected Cache-Control no-store, received ${healthCacheControl || "none"}`);
      }
      const healthPayload = await responseJson(health, healthLabel);
      if (healthPayload.status !== "ok") {
        throw new Error(`${healthLabel}: expected health status ok, received ${healthPayload.status ?? "none"}`);
      }
      if (healthPayload.workerVersionId !== expectedWorkerVersionId) {
        throw new Error(
          `${healthLabel}: expected Worker version ${expectedWorkerVersionId}, received ${healthPayload.workerVersionId ?? "none"}`,
        );
      }
      if (healthPayload.releaseMaintenance !== false) {
        throw new Error(`${healthLabel}: expected release maintenance to be off`);
      }
    }
    await Promise.all(siteIds.map(async (siteId) => {
      const label = `${baseUrl}/api/discussions/${siteId}`;
      const response = await fetchImpl(label, {
        redirect: "manual",
        headers: { "Cache-Control": "no-cache" },
      });
      requests += 1;
      if (response.status !== 200) throw new Error(`${label}: expected 200, received ${response.status}`);
      const cacheControl = response.headers.get("Cache-Control") ?? "";
      if (!/\bno-store\b/i.test(cacheControl)) throw new Error(`${label}: expected Cache-Control no-store, received ${cacheControl || "none"}`);
      const payload = await responseJson(response, label);
      if (!Array.isArray(payload.posts)) throw new Error(`${label}: response is missing a posts array`);
      if (payload.posts.length !== 0) throw new Error(`${label}: expected zero public posts, received ${payload.posts.length}`);
    }));

    const sampleSite = siteIds[0];
    const mutationLabel = `${baseUrl}/api/discussions/${sampleSite}`;
    const mutation = await fetchImpl(mutationLabel, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
      body: "{}",
    });
    requests += 1;
    if (mutation.status !== 405 || mutation.headers.get("Allow") !== "GET") {
      throw new Error(`${mutationLabel}: POST must return 405 with Allow: GET`);
    }

    const invalidLabel = `${baseUrl}/api/discussions/not-a-curated-site`;
    const invalid = await fetchImpl(invalidLabel, { redirect: "manual", headers: { "Cache-Control": "no-cache" } });
    requests += 1;
    if (invalid.status !== 404) throw new Error(`${invalidLabel}: expected 404, received ${invalid.status}`);
  }

  const normalizedCanonicalBaseUrl = canonicalBaseUrl ? normalizeBaseUrl(canonicalBaseUrl) : null;
  for (const rawRedirectBaseUrl of redirectBaseUrls) {
    const redirectBaseUrl = normalizeBaseUrl(rawRedirectBaseUrl);
    const probePath = `/api/discussions/${encodeURIComponent(siteIds[0])}?release-check=canonical-redirect`;
    const label = `${redirectBaseUrl}${probePath}`;
    const expectedLocation = `${normalizedCanonicalBaseUrl}${probePath}`;
    const response = await fetchImpl(label, {
      redirect: "manual",
      headers: { "Cache-Control": "no-cache" },
    });
    requests += 1;
    if (response.status !== 308) {
      throw new Error(`${label}: expected an un-followed 308 redirect, received ${response.status}`);
    }
    const location = response.headers.get("Location") ?? "";
    if (location !== expectedLocation) {
      throw new Error(`${label}: expected Location ${expectedLocation}, received ${location || "none"}`);
    }
  }

  return {
    baseUrls: baseUrls.map(normalizeBaseUrl),
    redirectBaseUrls: redirectBaseUrls.map(normalizeBaseUrl),
    canonicalBaseUrl: normalizedCanonicalBaseUrl,
    expectedWorkerVersionId: expectedWorkerVersionId ?? null,
    siteCount: siteIds.length,
    requests,
  };
}

function parseArguments(args) {
  const baseUrls = [];
  const redirectBaseUrls = [];
  let canonicalBaseUrl;
  let expectedWorkerVersionId;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--base-url") {
      const next = args[index + 1];
      if (!next) throw new Error("--base-url requires a URL");
      baseUrls.push(next);
      index += 1;
    } else if (value === "--redirect-base-url") {
      const next = args[index + 1];
      if (!next) throw new Error("--redirect-base-url requires a URL");
      redirectBaseUrls.push(next);
      index += 1;
    } else if (value === "--canonical-base-url") {
      const next = args[index + 1];
      if (!next) throw new Error("--canonical-base-url requires a URL");
      canonicalBaseUrl = next;
      index += 1;
    } else if (value === "--expected-worker-version-id") {
      const next = args[index + 1];
      if (!next) throw new Error("--expected-worker-version-id requires a version ID");
      expectedWorkerVersionId = next;
      index += 1;
    } else if (value === "--help") {
      return { help: true, baseUrls: [], redirectBaseUrls: [] };
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return { help: false, baseUrls, redirectBaseUrls, canonicalBaseUrl, expectedWorkerVersionId };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: npm run verify:discussion-safety -- [--base-url https://direct-host]... " +
      "[--expected-worker-version-id VERSION_ID] " +
      "[--canonical-base-url https://canonical-host --redirect-base-url https://redirect-host]...\n",
    );
    return;
  }
  const sourceChecks = await verifySourceSafety();
  const result = { sourceChecks };
  if (options.baseUrls.length > 0) {
    const sites = JSON.parse(await readFile(resolve(DEFAULT_ROOT, "public/data/sites.json"), "utf8"));
    result.live = await verifyLiveSafety({
      baseUrls: options.baseUrls,
      redirectBaseUrls: options.redirectBaseUrls,
      canonicalBaseUrl: options.canonicalBaseUrl,
      expectedWorkerVersionId: options.expectedWorkerVersionId,
      siteIds: sites.map((site) => site.id),
    });
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
