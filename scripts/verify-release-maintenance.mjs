import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`Maintenance verification requires HTTPS: ${value}`);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

async function json(response, label) {
  try {
    return await response.json();
  } catch {
    throw new Error(`${label}: expected JSON`);
  }
}

function requireNoStore(response, label) {
  const value = response.headers.get("Cache-Control") ?? "";
  if (!/\bno-store\b/i.test(value)) throw new Error(`${label}: expected Cache-Control no-store`);
}

export async function verifyReleaseMaintenance({
  baseUrls,
  expectedWorkerVersionId,
  fetchImpl = globalThis.fetch,
}) {
  if (!Array.isArray(baseUrls) || baseUrls.length === 0) throw new Error("At least one --base-url is required.");
  if (!/^[A-Za-z0-9-]{1,128}$/.test(expectedWorkerVersionId ?? "")) {
    throw new Error("--expected-worker-version-id must be an exact Worker version ID.");
  }
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");

  const normalized = baseUrls.map(normalizeBaseUrl);
  let requests = 0;
  for (const baseUrl of normalized) {
    const healthLabel = `${baseUrl}/api/health`;
    const health = await fetchImpl(healthLabel, {
      redirect: "manual",
      headers: { "Cache-Control": "no-cache" },
    });
    requests += 1;
    if (health.status !== 200) throw new Error(`${healthLabel}: expected 200, received ${health.status}`);
    requireNoStore(health, healthLabel);
    const healthPayload = await json(health, healthLabel);
    if (healthPayload.status !== "ok") throw new Error(`${healthLabel}: database health is not ok`);
    if (healthPayload.workerVersionId !== expectedWorkerVersionId) {
      throw new Error(`${healthLabel}: expected Worker version ${expectedWorkerVersionId}, received ${healthPayload.workerVersionId ?? "none"}`);
    }
    if (healthPayload.releaseMaintenance !== true) {
      throw new Error(`${healthLabel}: release maintenance is not active`);
    }

    for (const probe of [
      { path: "/api/trips/summary", method: "GET" },
      { path: "/api/auth/login", method: "POST", body: "{}" },
    ]) {
      const label = `${baseUrl}${probe.path}`;
      const response = await fetchImpl(label, {
        method: probe.method,
        body: probe.body,
        redirect: "manual",
        headers: { "Cache-Control": "no-cache", ...(probe.body ? { "Content-Type": "application/json" } : {}) },
      });
      requests += 1;
      if (response.status !== 503) throw new Error(`${label}: expected 503, received ${response.status}`);
      requireNoStore(response, label);
      if (!/^\d+$/.test(response.headers.get("Retry-After") ?? "")) {
        throw new Error(`${label}: expected a numeric Retry-After`);
      }
      const payload = await json(response, label);
      if (payload?.error?.code !== "release_maintenance") {
        throw new Error(`${label}: expected release_maintenance error`);
      }
    }
  }
  return { baseUrls: normalized, expectedWorkerVersionId, requests };
}

function parseArguments(args) {
  const baseUrls = [];
  let expectedWorkerVersionId;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--base-url") {
      const next = args[index + 1];
      if (!next) throw new Error("--base-url requires a URL");
      baseUrls.push(next);
      index += 1;
    } else if (value === "--expected-worker-version-id") {
      expectedWorkerVersionId = args[index + 1];
      if (!expectedWorkerVersionId) throw new Error("--expected-worker-version-id requires a value");
      index += 1;
    } else if (value === "--help") {
      return { help: true, baseUrls, expectedWorkerVersionId };
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return { help: false, baseUrls, expectedWorkerVersionId };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: node scripts/verify-release-maintenance.mjs --base-url URL [--base-url URL] " +
      "--expected-worker-version-id VERSION\n",
    );
    return;
  }
  process.stdout.write(`${JSON.stringify(await verifyReleaseMaintenance(options), null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
