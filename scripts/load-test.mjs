#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const PRODUCTION_HOSTS = new Set([
  "castingcompass.com",
  "www.castingcompass.com",
  "castcompass.brianbzeng.com",
  "contourcast.brianbzeng.com",
]);
const REMOTE_AUTHORIZATION = "I_HAVE_AUTHORIZATION_FOR_THIS_STAGING_TARGET";
const CONFIG_URL = new URL("../config/performance-budgets.json", import.meta.url);

export function validateTarget(value, remoteAuthorization = "") {
  let target;
  try {
    target = new URL(value);
  } catch {
    throw new Error("--target must be an absolute http(s) URL");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("load targets must use http or https");
  }
  if (target.username || target.password || target.search || target.hash || target.pathname !== "/") {
    throw new Error("--target must contain only scheme, hostname, and optional port");
  }
  const hostname = target.hostname.toLowerCase();
  if (PRODUCTION_HOSTS.has(hostname) || hostname.endsWith(".castingcompass.com")) {
    throw new Error("production CastingCompass hostnames are permanently blocked by this harness");
  }
  const local =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]";
  if (!local && remoteAuthorization !== REMOTE_AUTHORIZATION) {
    throw new Error(
      `remote staging requires CASTINGCOMPASS_LOAD_AUTHORIZATION=${REMOTE_AUTHORIZATION}`,
    );
  }
  return target;
}

export function percentile(values, quantile) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index];
}

export function evaluateResults(latencies, failures, budgets) {
  const total = latencies.length;
  const errorRatePercent = total === 0 ? 100 : (failures / total) * 100;
  const summary = {
    requests: total,
    failures,
    errorRatePercent,
    p50Milliseconds: percentile(latencies, 0.5),
    p95Milliseconds: percentile(latencies, 0.95),
    p99Milliseconds: percentile(latencies, 0.99),
  };
  return {
    summary,
    passed: total > 0 &&
      summary.p95Milliseconds <= budgets.p95Milliseconds &&
      summary.p99Milliseconds <= budgets.p99Milliseconds &&
      summary.errorRatePercent <= budgets.errorRatePercent,
  };
}

function parseArguments(arguments_) {
  const parsed = { target: "", profile: "smoke" };
  for (let index = 0; index < arguments_.length; index += 1) {
    const value = arguments_[index];
    if (value === "--target") parsed.target = arguments_[++index] ?? "";
    else if (value === "--profile") parsed.profile = arguments_[++index] ?? "";
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!parsed.target) throw new Error("--target is required; no production default exists");
  return parsed;
}

async function runWorker(workerId, target, configuration, profile, deadline, results) {
  let sequence = workerId;
  while (performance.now() < deadline) {
    const route = configuration.routes[sequence % configuration.routes.length];
    sequence += profile.concurrency;
    const url = new URL(route.path, target);
    const started = performance.now();
    let failed = false;
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "manual",
        cache: "no-store",
        headers: { Accept: route.path.startsWith("/data/") || route.path.startsWith("/api/")
          ? "application/json"
          : "text/html" },
        signal: AbortSignal.timeout(configuration.requestTimeoutMilliseconds),
      });
      if (!route.expectedStatuses.includes(response.status)) failed = true;
      await response.body?.cancel();
    } catch {
      failed = true;
    }
    results.latencies.push(performance.now() - started);
    if (failed) results.failures += 1;
  }
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  const configuration = JSON.parse(await readFile(CONFIG_URL, "utf8"));
  const profile = configuration.profiles[arguments_.profile];
  if (!profile) throw new Error(`unknown profile: ${arguments_.profile}`);
  if (
    profile.durationSeconds < 1 ||
    profile.durationSeconds > configuration.limits.maximumDurationSeconds ||
    profile.concurrency < 1 ||
    profile.concurrency > configuration.limits.maximumConcurrency
  ) {
    throw new Error("selected profile exceeds the repository safety limits");
  }
  const target = validateTarget(
    arguments_.target,
    process.env.CASTINGCOMPASS_LOAD_AUTHORIZATION ?? "",
  );
  const results = { latencies: [], failures: 0 };
  const deadline = performance.now() + profile.durationSeconds * 1000;
  await Promise.all(Array.from(
    { length: profile.concurrency },
    (_, workerId) => runWorker(workerId, target, configuration, profile, deadline, results),
  ));
  const evaluation = evaluateResults(results.latencies, results.failures, configuration.budgets);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: configuration.schemaVersion,
    target: target.origin,
    profile: arguments_.profile,
    ...evaluation.summary,
    passed: evaluation.passed,
  }, null, 2)}\n`);
  if (!evaluation.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`Load test refused or failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
