#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

export async function verifyPrivacyExportQueuePolicy({ projectRoot = root } = {}) {
  const [policy, schema, wrangler, worker, auth, routes, migration] = await Promise.all([
    readJson(projectRoot, "security/privacy-export-queue-policy.json"),
    readJson(projectRoot, "contracts/privacy-export-queue-message.schema.json"),
    readJson(projectRoot, "wrangler.jsonc"),
    readFile(resolve(projectRoot, "worker/privacy-export.ts"), "utf8"),
    readFile(resolve(projectRoot, "worker/auth.ts"), "utf8"),
    readFile(resolve(projectRoot, "worker/route-policy.ts"), "utf8"),
    readFile(resolve(projectRoot, "drizzle/0019_async_privacy_exports.sql"), "utf8"),
  ]);

  exactKeys(policy, [
    "schemaVersion", "messageContract", "featureFlag", "productionDefault",
    "producerBinding", "privateObjectBinding", "consumer", "application",
  ], "Privacy export queue policy");
  exactKeys(policy.consumer, [
    "maxBatchSize", "maxBatchTimeoutSeconds", "maxRetries", "maxConcurrency",
    "deadLetterQueueRequired",
  ], "Privacy export consumer policy");
  exactKeys(policy.application, [
    "maximumAttempts", "leaseSeconds", "redispatchAfterSeconds", "maximumRetryDelaySeconds",
    "retentionSeconds", "expiryBatchSize", "photoManifestConcurrency", "messageContainsOnly",
    "authoritativeState", "objectVisibility", "downloadIntegrityBindings",
  ], "Privacy export application policy");
  if (policy.schemaVersion !== "castingcompass.privacy-export-queue-policy/1.0.0"
    || policy.messageContract !== "castingcompass.privacy-export-queue/1.0.0"
    || policy.featureFlag !== "PRIVACY_EXPORT_QUEUE_ENABLED"
    || policy.productionDefault !== "false"
    || policy.producerBinding !== "PRIVACY_EXPORT_QUEUE"
    || policy.privateObjectBinding !== "PRIVACY_EXPORTS") {
    throw new Error("Privacy export queue identity or default-off binding contract changed");
  }
  if (policy.consumer.maxBatchSize !== 5
    || policy.consumer.maxBatchTimeoutSeconds !== 10
    || policy.consumer.maxRetries !== 8
    || policy.consumer.maxConcurrency !== 1
    || policy.consumer.deadLetterQueueRequired !== true) {
    throw new Error("Privacy export provider retry/DLQ policy changed");
  }
  if (policy.application.maximumAttempts !== 5
    || policy.application.leaseSeconds !== 300
    || policy.application.redispatchAfterSeconds !== 900
    || policy.application.maximumRetryDelaySeconds !== 3600
    || policy.application.retentionSeconds !== 86400
    || policy.application.expiryBatchSize !== 50
    || policy.application.photoManifestConcurrency !== 4
    || JSON.stringify(policy.application.messageContainsOnly) !== JSON.stringify(["version", "jobId"])
    || policy.application.authoritativeState !== "D1 privacy_export_jobs ledger"
    || policy.application.objectVisibility !== "private owner-authenticated download only"
    || JSON.stringify(policy.application.downloadIntegrityBindings) !== JSON.stringify([
      "D1 object-key hash",
      "D1 byte size",
      "D1 SHA-256 metadata",
      "object contract version",
    ])) {
    throw new Error("Privacy export application safety policy changed");
  }

  if (wrangler.vars?.PRIVACY_EXPORT_QUEUE_ENABLED !== "false") {
    throw new Error("Privacy export queue must remain default-off in the production config");
  }
  if ((wrangler.queues?.producers ?? []).some((binding) => binding.binding === "PRIVACY_EXPORT_QUEUE")
    || (wrangler.r2_buckets ?? []).some((binding) => binding.binding === "PRIVACY_EXPORTS")) {
    throw new Error("Privacy export provider bindings require a separate reviewed activation change");
  }
  if (schema.additionalProperties !== false
    || JSON.stringify(schema.required) !== JSON.stringify(["version", "jobId"])
    || schema.properties?.version?.const !== policy.messageContract
    || schema.properties?.jobId?.pattern !== "^pexj_[a-f0-9]{32}$") {
    throw new Error("Privacy export message schema is not the exact minimal identity contract");
  }
  if (/user|account|email|notes|content|payload|object/i.test(Object.keys(schema.properties).join(" "))) {
    throw new Error("Privacy export message schema contains a private or authoritative field");
  }

  for (const required of [
    "PRIVACY_EXPORT_QUEUE_MESSAGE_VERSION",
    "MAX_BATCH_MESSAGES = 5",
    "MAX_ATTEMPTS = 5",
    "LEASE_SECONDS = 5 * 60",
    "REDISPATCH_SECONDS = 15 * 60",
    "PRIVACY_EXPORT_RETENTION_SECONDS = 24 * 60 * 60",
    "EXPIRY_BATCH_SIZE = 50",
    "PHOTO_MANIFEST_CONCURRENCY = 4",
    "message.ack()",
    "message.retry({ delaySeconds",
    "releaseMaintenanceEnabled",
    "user_id = NULL",
    "uncommitted_object_delete_failed",
    "export_lease_abandoned",
    "privacy_export_completion_not_confirmed",
    "AND state = 'queued' AND lease_token = ?",
    "AND state = 'processing' AND lease_token = ?",
    "AND state = 'completed' AND lease_token IS NULL",
    "privacy_export.download.integrity_rejected",
    "privacy_export_integrity_mismatch",
    "PRIVACY_EXPORT_OBJECT_CONTRACT_VERSION = \"castingcompass.privacy-export/1.0.0\"",
    "job.object_key_hash !== expectedObjectKeyHash",
    "object.size !== expectedSize",
    "object.customMetadata?.contentSha256 !== job.content_sha256",
    "object.customMetadata?.contractVersion !== PRIVACY_EXPORT_OBJECT_CONTRACT_VERSION",
  ]) {
    if (!worker.includes(required)) throw new Error(`Privacy export runtime is missing ${required}`);
  }
  for (const required of [
    "object_store",
    "privacy_exports",
    "UPDATE privacy_export_jobs",
    "state = 'canceled'",
    "processExpiredPrivacyExports",
  ]) {
    if (!auth.includes(required)) throw new Error(`Account deletion/export integration is missing ${required}`);
  }
  for (const required of [
    "profile.export_request",
    "profile.export_status",
    "profile.export_download",
    "sameOriginRequired: true",
    "rateLimitTags: [\"sensitive\"]",
  ]) {
    if (!routes.includes(required)) throw new Error(`Privacy export route policy is missing ${required}`);
  }
  for (const required of [
    "CREATE TABLE `privacy_export_jobs`",
    "privacy_export_jobs_active_user_unique",
    "privacy_export_jobs_object_key_unique",
    "privacy_export_jobs_dispatch_idx",
    "privacy_export_jobs_expiry_idx",
    "privacy_export_jobs_owner_idx",
    "privacy_deletion_tasks_object_store_check",
    "attempts` <= 5",
  ]) {
    if (!migration.includes(required)) throw new Error(`Privacy export migration is missing ${required}`);
  }

  return {
    schemaVersion: policy.schemaVersion,
    messageContract: policy.messageContract,
    productionDefault: policy.productionDefault,
    providerBindingsPresent: false,
    retentionSeconds: policy.application.retentionSeconds,
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
  verifyPrivacyExportQueuePolicy().then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
