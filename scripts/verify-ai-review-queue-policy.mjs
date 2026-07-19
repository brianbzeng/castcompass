#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

export async function verifyAiReviewQueuePolicy({ projectRoot = root } = {}) {
  const [policy, schema, wrangler, worker, migration] = await Promise.all([
    readJson(projectRoot, "security/ai-review-queue-policy.json"),
    readJson(projectRoot, "contracts/ai-review-queue-message.schema.json"),
    readJson(projectRoot, "wrangler.jsonc"),
    readFile(resolve(projectRoot, "worker/trip-review-queue.ts"), "utf8"),
    readFile(resolve(projectRoot, "drizzle/0018_ai_review_queue.sql"), "utf8"),
  ]);

  exactKeys(policy, [
    "schemaVersion", "messageContract", "featureFlag", "productionDefault",
    "producerBinding", "consumer", "application",
  ], "Queue policy");
  exactKeys(policy.consumer, [
    "maxBatchSize", "maxBatchTimeoutSeconds", "maxRetries", "maxConcurrency",
    "deadLetterQueueRequired",
  ], "Queue consumer policy");
  exactKeys(policy.application, [
    "maximumAttempts", "leaseSeconds", "redispatchAfterSeconds", "maximumRetryDelaySeconds",
    "messageContainsOnly", "authoritativeState",
  ], "Queue application policy");
  if (policy.schemaVersion !== "castingcompass.ai-review-queue-policy/1.0.0"
    || policy.messageContract !== "castingcompass.ai-review-queue/1.0.0"
    || policy.featureFlag !== "AI_REVIEW_QUEUE_ENABLED"
    || policy.productionDefault !== "false"
    || policy.producerBinding !== "AI_REVIEW_QUEUE") {
    throw new Error("Queue policy identity or default-off binding contract changed");
  }
  if (policy.consumer.maxBatchSize !== 5
    || policy.consumer.maxBatchTimeoutSeconds !== 10
    || policy.consumer.maxRetries !== 8
    || policy.consumer.maxConcurrency !== 1
    || policy.consumer.deadLetterQueueRequired !== true) {
    throw new Error("Queue consumer cost/retry/DLQ policy changed");
  }
  if (policy.application.maximumAttempts !== 5
    || policy.application.leaseSeconds !== 60
    || policy.application.redispatchAfterSeconds !== 900
    || policy.application.maximumRetryDelaySeconds !== 3600
    || JSON.stringify(policy.application.messageContainsOnly) !== JSON.stringify(["version", "jobId"])
    || policy.application.authoritativeState !== "D1 ai_review_jobs ledger") {
    throw new Error("Queue application safety policy changed");
  }

  if (wrangler.vars?.AI_REVIEW_QUEUE_ENABLED !== "false") {
    throw new Error("AI review queue must remain default-off in the production config");
  }
  if (Object.hasOwn(wrangler, "queues")) {
    throw new Error("Production queue bindings require a separate reviewed provider-activation change");
  }
  if (schema.additionalProperties !== false
    || JSON.stringify(schema.required) !== JSON.stringify(["version", "jobId"])
    || schema.properties?.version?.const !== policy.messageContract
    || schema.properties?.jobId?.pattern !== "^airj_[a-f0-9]{32}$") {
    throw new Error("Queue message schema is not the exact minimal identity contract");
  }
  if (/trip|user|account|email|notes|content|payload/i.test(Object.keys(schema.properties).join(" "))) {
    throw new Error("Queue message schema contains a private or authoritative field");
  }

  for (const required of [
    "AI_REVIEW_QUEUE_MESSAGE_VERSION",
    "MAX_BATCH_MESSAGES = 5",
    "MAX_ATTEMPTS = 5",
    "LEASE_SECONDS = 60",
    "REDISPATCH_SECONDS = 15 * 60",
    "message.ack()",
    "message.retry({ delaySeconds",
    "needs_attention",
    "releaseMaintenanceEnabled",
  ]) {
    if (!worker.includes(required)) throw new Error(`Queue runtime is missing ${required}`);
  }
  for (const required of [
    "CREATE TABLE `ai_review_jobs`",
    "ON DELETE cascade",
    "ai_review_jobs_trip_unique",
    "ai_review_jobs_dispatch_idx",
    "needs_attention",
    "attempts` <= 5",
  ]) {
    if (!migration.includes(required)) throw new Error(`Queue migration is missing ${required}`);
  }

  return {
    schemaVersion: policy.schemaVersion,
    messageContract: policy.messageContract,
    productionDefault: policy.productionDefault,
    providerBindingsPresent: false,
    maximumAttempts: policy.application.maximumAttempts,
    deadLetterQueueRequired: policy.consumer.deadLetterQueueRequired,
  };
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${label} has unexpected fields`);
}

async function readJson(projectRoot, path) {
  return JSON.parse(await readFile(resolve(projectRoot, path), "utf8"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyAiReviewQueuePolicy().then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
