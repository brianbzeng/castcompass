import { logEvent } from "./observability.ts";
import { releaseMaintenanceEnabled } from "./security.ts";
import type { QueueBatchLike, QueueBindingLike, QueueMessageLike } from "./trip-review-queue.ts";
import type { D1DatabaseLike, R2BucketLike } from "./trips.ts";

export const PRIVACY_EXPORT_QUEUE_MESSAGE_VERSION = "castingcompass.privacy-export-queue/1.0.0";
export const PRIVACY_EXPORT_RETENTION_SECONDS = 24 * 60 * 60;
const PRIVACY_EXPORT_OBJECT_CONTRACT_VERSION = "castingcompass.privacy-export/1.0.0";

const JOB_ID_PATTERN = /^pexj_[a-f0-9]{32}$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const MAX_ATTEMPTS = 5;
const MAX_BATCH_MESSAGES = 5;
const LEASE_SECONDS = 5 * 60;
const REDISPATCH_SECONDS = 15 * 60;
const MAINTENANCE_DELAY_SECONDS = 5 * 60;
const RETRY_DELAYS_SECONDS = [60, 5 * 60, 15 * 60, 60 * 60] as const;
const EXPIRY_BATCH_SIZE = 50;
const PHOTO_MANIFEST_CONCURRENCY = 4;

interface StoredObjectLike {
  body?: ReadableStream<Uint8Array>;
  arrayBuffer?(): Promise<ArrayBuffer>;
  size?: number;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

export interface PrivateObjectBucketLike {
  put(
    key: string,
    value: ArrayBuffer,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
  get?(key: string): Promise<StoredObjectLike | null>;
  delete(key: string): Promise<void>;
}

export interface PrivacyExportEnv {
  DB?: D1DatabaseLike;
  TRIP_PHOTOS?: R2BucketLike;
  PRIVACY_EXPORTS?: PrivateObjectBucketLike;
  PRIVACY_EXPORT_QUEUE_ENABLED?: string;
  PRIVACY_EXPORT_QUEUE?: QueueBindingLike;
  RELEASE_MAINTENANCE_MODE?: string;
}

export type PrivacyExportJobState =
  | "pending"
  | "queued"
  | "processing"
  | "retry"
  | "completed"
  | "canceled"
  | "expired"
  | "needs_attention";

export interface PrivacyExportJobRow {
  id: string;
  user_id: string | null;
  owner_subject_hash: string;
  state: PrivacyExportJobState;
  attempts: number;
  available_at: string;
  lease_expires_at: string | null;
  lease_token: string | null;
  object_key: string | null;
  object_key_hash: string | null;
  content_sha256: string | null;
  size_bytes: number | null;
  record_count: number | null;
  last_error_code: string | null;
  requested_at: string;
  updated_at: string;
  completed_at: string | null;
  expires_at: string | null;
}

export interface PrivacyExportPublicStatus {
  id: string;
  status: "pending" | "processing" | "ready" | "needs_attention" | "expired";
  attempts: number;
  requestedAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  sizeBytes: number | null;
  recordCount: number | null;
  downloadPath: string | null;
}

interface QueueMessageBody {
  version: typeof PRIVACY_EXPORT_QUEUE_MESSAGE_VERSION;
  jobId: string;
}

export function privacyExportQueueMode(env: PrivacyExportEnv) {
  if (env.PRIVACY_EXPORT_QUEUE_ENABLED === undefined || env.PRIVACY_EXPORT_QUEUE_ENABLED === "false") {
    return "disabled" as const;
  }
  return env.PRIVACY_EXPORT_QUEUE_ENABLED === "true" ? "enabled" as const : "invalid" as const;
}

export function privacyExportConfigurationError(env: PrivacyExportEnv) {
  const mode = privacyExportQueueMode(env);
  if (mode === "disabled") return "feature_disabled" as const;
  if (mode === "invalid") return "invalid_feature_flag" as const;
  if (!env.DB) return "database_binding_missing" as const;
  if (!env.PRIVACY_EXPORT_QUEUE) return "producer_binding_missing" as const;
  if (!env.PRIVACY_EXPORTS) return "object_storage_binding_missing" as const;
  return null;
}

export async function requestPrivacyExport(env: PrivacyExportEnv, userId: string) {
  const configurationError = privacyExportConfigurationError(env);
  if (configurationError) return { configurationError, job: null } as const;
  const db = env.DB!;
  const now = new Date();
  const nowIso = now.toISOString();

  // Revoke an expired download before trying the one-active-job guard. The
  // object remains on the durable cleanup ledger until storage deletion wins.
  await db.prepare(`UPDATE privacy_export_jobs
    SET state = 'canceled', user_id = NULL, lease_expires_at = NULL, lease_token = NULL,
      last_error_code = 'export_expired', updated_at = ?
    WHERE user_id = ? AND state = 'completed' AND expires_at <= ?`)
    .bind(nowIso, userId, nowIso)
    .run();

  let job = await activeJobForUser(db, userId);
  if (!job) {
    const id = `pexj_${crypto.randomUUID().replaceAll("-", "")}`;
    const ownerSubjectHash = await sha256Text(`account:${userId}`);
    try {
      await db.prepare(`INSERT INTO privacy_export_jobs (
          id, user_id, owner_subject_hash, state, attempts, available_at,
          lease_expires_at, lease_token, object_key, object_key_hash, content_sha256,
          size_bytes, record_count, last_error_code, requested_at, updated_at,
          completed_at, expires_at)
        SELECT ?, id, ?, 'pending', 0, ?, NULL, NULL, NULL, NULL, NULL,
          NULL, NULL, NULL, ?, ?, NULL, NULL
        FROM users WHERE id = ?`)
        .bind(id, ownerSubjectHash, nowIso, nowIso, nowIso, userId)
        .run();
    } catch {
      // A concurrent request may have satisfied the partial unique index.
    }
    job = await activeJobForUser(db, userId);
  }
  if (!job) return { configurationError: "owner_not_found" as const, job: null };
  await dispatchPrivacyExportJob(env, job);
  return {
    configurationError: null,
    job: await privacyExportJobForOwner(db, userId, job.id) ?? job,
  } as const;
}

export async function privacyExportJobForOwner(db: D1DatabaseLike, userId: string, jobId: string) {
  if (!JOB_ID_PATTERN.test(jobId)) return null;
  return db.prepare(`SELECT id, user_id, owner_subject_hash, state, attempts, available_at,
      lease_expires_at, lease_token, object_key, object_key_hash, content_sha256,
      size_bytes, record_count, last_error_code, requested_at, updated_at,
      completed_at, expires_at
    FROM privacy_export_jobs WHERE id = ? AND user_id = ? LIMIT 1`)
    .bind(jobId, userId)
    .first<PrivacyExportJobRow>();
}

export function publicPrivacyExportStatus(job: PrivacyExportJobRow, now = new Date()): PrivacyExportPublicStatus {
  const expired = job.expires_at !== null && job.expires_at <= now.toISOString();
  let status: PrivacyExportPublicStatus["status"];
  if (expired || job.state === "expired" || job.state === "canceled") status = "expired";
  else if (job.state === "completed") status = "ready";
  else if (job.state === "processing") status = "processing";
  else if (job.state === "needs_attention") status = "needs_attention";
  else status = "pending";
  return {
    id: job.id,
    status,
    attempts: Number(job.attempts),
    requestedAt: job.requested_at,
    completedAt: job.completed_at,
    expiresAt: job.expires_at,
    sizeBytes: job.size_bytes === null ? null : Number(job.size_bytes),
    recordCount: job.record_count === null ? null : Number(job.record_count),
    downloadPath: status === "ready" ? `/api/profile/exports/${job.id}/download` : null,
  };
}

export async function downloadPrivacyExport(
  env: PrivacyExportEnv,
  userId: string,
  jobId: string,
): Promise<Response | null> {
  if (!env.DB || !JOB_ID_PATTERN.test(jobId)) return null;
  const job = await privacyExportJobForOwner(env.DB, userId, jobId);
  if (!job) return null;
  if (job.state !== "completed" || !job.object_key || !job.expires_at || job.expires_at <= new Date().toISOString()) {
    return jsonError(410, "privacy_export_unavailable", "This export is not available for download.");
  }
  if (!env.PRIVACY_EXPORTS?.get) {
    return jsonError(503, "privacy_export_storage_unavailable", "The export file cannot be downloaded right now.", 60);
  }
  try {
    const expectedObjectKeyHash = await sha256Text(`privacy_exports\u0000${job.object_key}`);
    if (job.object_key_hash !== expectedObjectKeyHash) {
      return privacyExportIntegrityError("export_locator_hash_mismatch");
    }
    const object = await env.PRIVACY_EXPORTS.get(job.object_key);
    if (!object) return jsonError(503, "privacy_export_object_missing", "The export file cannot be downloaded right now.", 60);
    const expectedSize = Number(job.size_bytes);
    if (job.size_bytes === null
      || !Number.isSafeInteger(expectedSize)
      || expectedSize < 0
      || !Number.isSafeInteger(object.size)
      || object.size !== expectedSize
      || !job.content_sha256
      || !SHA256_HEX_PATTERN.test(job.content_sha256)
      || object.customMetadata?.contentSha256 !== job.content_sha256
      || object.customMetadata?.contractVersion !== PRIVACY_EXPORT_OBJECT_CONTRACT_VERSION) {
      return privacyExportIntegrityError("export_object_metadata_mismatch");
    }
    const body = object.body ?? (object.arrayBuffer ? await object.arrayBuffer() : null);
    if (!body) return jsonError(503, "privacy_export_storage_unavailable", "The export file cannot be downloaded right now.", 60);
    const headers = new Headers({
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="castingcompass-data-${job.completed_at!.slice(0, 10)}.json"`,
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    });
    headers.set("Content-Length", String(object.size));
    return new Response(body, { status: 200, headers });
  } catch {
    return jsonError(503, "privacy_export_storage_unavailable", "The export file cannot be downloaded right now.", 60);
  }
}

export async function dispatchPrivacyExportBacklog(env: PrivacyExportEnv, limit = 10) {
  if (privacyExportQueueMode(env) !== "enabled" || !env.DB || !env.PRIVACY_EXPORT_QUEUE || !env.PRIVACY_EXPORTS) {
    return 0;
  }
  const now = new Date().toISOString();
  const rows = await env.DB.prepare(`SELECT id, user_id, owner_subject_hash, state, attempts, available_at,
      lease_expires_at, lease_token, object_key, object_key_hash, content_sha256,
      size_bytes, record_count, last_error_code, requested_at, updated_at, completed_at, expires_at
    FROM privacy_export_jobs
    WHERE (((state = 'pending' OR state = 'retry' OR state = 'queued') AND available_at <= ?)
      OR (state = 'processing' AND object_key IS NULL
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))
      AND user_id IS NOT NULL
    ORDER BY available_at, requested_at LIMIT ?`)
    .bind(now, now, Math.max(1, Math.min(50, Math.trunc(limit))))
    .all<PrivacyExportJobRow>();
  for (const job of rows.results ?? []) await dispatchPrivacyExportJob(env, job);
  return (rows.results ?? []).length;
}

async function dispatchPrivacyExportJob(env: PrivacyExportEnv, job: PrivacyExportJobRow) {
  if (!env.DB || !env.PRIVACY_EXPORT_QUEUE || !env.PRIVACY_EXPORTS) return;
  const now = new Date();
  const nowIso = now.toISOString();
  if (!job.user_id || job.attempts >= MAX_ATTEMPTS || job.available_at > nowIso ||
      job.state === "completed" || job.state === "canceled" || job.state === "expired" || job.state === "needs_attention") return;
  const redispatchAt = new Date(now.getTime() + REDISPATCH_SECONDS * 1000).toISOString();
  const staged = await env.DB.prepare(`UPDATE privacy_export_jobs
    SET state = 'queued', available_at = ?, lease_expires_at = NULL, lease_token = NULL,
      last_error_code = NULL, updated_at = ?
    WHERE id = ? AND user_id IS NOT NULL AND attempts < ?
      AND (((state = 'pending' OR state = 'retry' OR state = 'queued') AND available_at <= ?)
        OR (state = 'processing' AND object_key IS NULL
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))`)
    .bind(redispatchAt, nowIso, job.id, MAX_ATTEMPTS, nowIso, nowIso)
    .run();
  if (mutationChanges(staged) !== 1) return;
  const body: QueueMessageBody = { version: PRIVACY_EXPORT_QUEUE_MESSAGE_VERSION, jobId: job.id };
  try {
    await env.PRIVACY_EXPORT_QUEUE.send(body);
  } catch {
    const retryAt = new Date(Date.now() + RETRY_DELAYS_SECONDS[0] * 1000).toISOString();
    await env.DB.prepare(`UPDATE privacy_export_jobs SET state = 'pending', available_at = ?,
        last_error_code = 'queue_publish_failed', updated_at = ?
      WHERE id = ? AND state = 'queued'`)
      .bind(retryAt, new Date().toISOString(), job.id)
      .run();
    logEvent("error", "privacy_export.queue.publish_failed", { error_code: "queue_publish_failed" });
  }
}

export async function consumePrivacyExportQueue(batch: QueueBatchLike, env: PrivacyExportEnv) {
  const mode = privacyExportQueueMode(env);
  if (mode !== "enabled" || !env.DB || !env.PRIVACY_EXPORTS) {
    const errorCode = mode === "invalid" ? "invalid_feature_flag"
      : mode === "disabled" ? "consumer_disabled"
        : !env.DB ? "database_binding_missing" : "object_storage_binding_missing";
    logEvent("error", "privacy_export.queue.configuration_rejected", { error_code: errorCode });
    for (const message of batch.messages) message.retry({ delaySeconds: MAINTENANCE_DELAY_SECONDS });
    return;
  }
  if (releaseMaintenanceEnabled(env)) {
    for (const message of batch.messages) message.retry({ delaySeconds: MAINTENANCE_DELAY_SECONDS });
    return;
  }
  for (const [index, message] of batch.messages.entries()) {
    if (index >= MAX_BATCH_MESSAGES) {
      message.retry({ delaySeconds: RETRY_DELAYS_SECONDS[0] });
      continue;
    }
    const body = parseQueueMessage(message.body);
    if (!body) {
      logEvent("warn", "privacy_export.queue.message_rejected", { error_code: "invalid_queue_message" });
      message.ack();
      continue;
    }
    await consumePrivacyExportMessage(env, message, body);
  }
}

async function consumePrivacyExportMessage(
  env: PrivacyExportEnv,
  message: QueueMessageLike,
  body: QueueMessageBody,
) {
  const db = env.DB!;
  const exportBucket = env.PRIVACY_EXPORTS!;
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseToken = randomToken();
  const leaseExpiresAt = new Date(now.getTime() + LEASE_SECONDS * 1000).toISOString();
  const claimed = await db.prepare(`UPDATE privacy_export_jobs
    SET state = 'processing', attempts = attempts + 1, lease_expires_at = ?, lease_token = ?, updated_at = ?
    WHERE id = ? AND user_id IS NOT NULL AND attempts < ?
      AND object_key IS NULL
      AND (state = 'queued'
        OR ((state = 'pending' OR state = 'retry') AND available_at <= ?)
        OR (state = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))`)
    .bind(leaseExpiresAt, leaseToken, nowIso, body.jobId, MAX_ATTEMPTS, nowIso, nowIso)
    .run();
  if (mutationChanges(claimed) !== 1) {
    await settleUnclaimedMessage(db, message, body.jobId);
    return;
  }
  const job = await db.prepare(`SELECT id, user_id, owner_subject_hash, state, attempts, available_at,
      lease_expires_at, lease_token, object_key, object_key_hash, content_sha256,
      size_bytes, record_count, last_error_code, requested_at, updated_at, completed_at, expires_at
    FROM privacy_export_jobs WHERE id = ? LIMIT 1`)
    .bind(body.jobId)
    .first<PrivacyExportJobRow>();
  if (!job?.user_id) {
    message.ack();
    return;
  }

  const objectKey = `privacy-exports/${job.id}/${leaseToken}.json`;
  let objectReserved = false;
  let objectMetadata: { objectKeyHash: string; contentSha256: string; sizeBytes: number; recordCount: number } | null = null;
  try {
    const built = await buildPrivacyExportPayload(env, job.user_id, new Date().toISOString());
    if (!built.payload.account) throw new Error("privacy_export_owner_missing");
    const serialized = JSON.stringify(built.payload);
    const bytes = new TextEncoder().encode(serialized);
    const contentSha256 = await sha256Bytes(bytes);
    const objectKeyHash = await sha256Text(`privacy_exports\u0000${objectKey}`);
    objectMetadata = { objectKeyHash, contentSha256, sizeBytes: bytes.byteLength, recordCount: built.recordCount };
    const refreshedLeaseExpiresAt = new Date(Date.now() + LEASE_SECONDS * 1000).toISOString();
    const reserved = await db.prepare(`UPDATE privacy_export_jobs
      SET object_key = ?, object_key_hash = ?, content_sha256 = ?, size_bytes = ?, record_count = ?,
        lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND user_id = ? AND state = 'processing' AND lease_token = ?
        AND object_key IS NULL`)
      .bind(
        objectKey,
        objectKeyHash,
        contentSha256,
        bytes.byteLength,
        built.recordCount,
        refreshedLeaseExpiresAt,
        new Date().toISOString(),
        job.id,
        job.user_id,
        leaseToken,
      )
      .run();
    if (mutationChanges(reserved) !== 1) throw new Error("privacy_export_lease_lost_before_write");
    objectReserved = true;
    await exportBucket.put(objectKey, bytes.buffer as ArrayBuffer, {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: { contentSha256, contractVersion: PRIVACY_EXPORT_OBJECT_CONTRACT_VERSION },
    });
    const completedAt = new Date();
    const completedAtIso = completedAt.toISOString();
    const expiresAt = new Date(completedAt.getTime() + PRIVACY_EXPORT_RETENTION_SECONDS * 1000).toISOString();
    const finalized = await db.prepare(`UPDATE privacy_export_jobs
      SET state = 'completed', object_key = ?, object_key_hash = ?, content_sha256 = ?,
        size_bytes = ?, record_count = ?, last_error_code = NULL, lease_expires_at = NULL,
        lease_token = NULL, completed_at = ?, expires_at = ?, updated_at = ?
      WHERE id = ? AND user_id = ? AND state = 'processing' AND lease_token = ?
        AND object_key = ?`)
      .bind(
        objectKey,
        objectKeyHash,
        contentSha256,
        bytes.byteLength,
        built.recordCount,
        completedAtIso,
        expiresAt,
        completedAtIso,
        job.id,
        job.user_id,
        leaseToken,
        objectKey,
      )
      .run();
    if (mutationChanges(finalized) !== 1) {
      await removeUncommittedObject(
        { ...env, PRIVACY_EXPORTS: exportBucket },
        db,
        job.id,
        job.owner_subject_hash,
        objectKey,
        objectMetadata,
      );
    }
    message.ack();
  } catch {
    if (objectReserved && objectMetadata) {
      await removeUncommittedObject(
        { ...env, PRIVACY_EXPORTS: exportBucket },
        db,
        job.id,
        job.owner_subject_hash,
        objectKey,
        objectMetadata,
      );
    }
    const current = await db.prepare("SELECT state, attempts FROM privacy_export_jobs WHERE id = ? LIMIT 1")
      .bind(job.id)
      .first<{ state: PrivacyExportJobState; attempts: number }>();
    if (!current || current.state === "canceled" || current.state === "expired" ||
        current.state === "completed" || current.state === "needs_attention") {
      message.ack();
      return;
    }
    const exhausted = Number(current.attempts) >= MAX_ATTEMPTS;
    const delay = RETRY_DELAYS_SECONDS[Math.min(Math.max(Number(current.attempts) - 1, 0), RETRY_DELAYS_SECONDS.length - 1)];
    const retryAt = new Date(Date.now() + delay * 1000).toISOString();
    await db.prepare(`UPDATE privacy_export_jobs
      SET state = CASE WHEN attempts >= ? THEN 'needs_attention' ELSE 'retry' END,
        available_at = ?, lease_expires_at = NULL, lease_token = NULL,
        last_error_code = 'export_packaging_failed', updated_at = ?
      WHERE id = ? AND state = 'processing' AND lease_token = ?`)
      .bind(MAX_ATTEMPTS, retryAt, new Date().toISOString(), job.id, leaseToken)
      .run();
    logEvent("error", "privacy_export.queue.packaging_failed", { error_code: "export_packaging_failed" });
    if (exhausted) message.ack();
    else message.retry({ delaySeconds: delay });
  }
}

async function removeUncommittedObject(
  env: PrivacyExportEnv & { PRIVACY_EXPORTS: PrivateObjectBucketLike },
  db: D1DatabaseLike,
  jobId: string,
  ownerSubjectHash: string,
  objectKey: string,
  metadata: { objectKeyHash: string; contentSha256: string; sizeBytes: number; recordCount: number },
) {
  try {
    await env.PRIVACY_EXPORTS.delete(objectKey);
    await db.prepare(`UPDATE privacy_export_jobs
      SET object_key = NULL, object_key_hash = NULL, content_sha256 = NULL,
        size_bytes = NULL, record_count = NULL, updated_at = ?
      WHERE id = ? AND object_key = ? AND state != 'completed'`)
      .bind(new Date().toISOString(), jobId, objectKey)
      .run();
  } catch {
    // Account deletion can cancel a job after the object write but before the
    // D1 completion commit. Preserve the locator so scheduled cleanup can
    // prove and retry removal instead of losing track of the object.
    const updatedAt = new Date().toISOString();
    const retained = await db.prepare(`UPDATE privacy_export_jobs
      SET state = 'needs_attention', object_key = ?, object_key_hash = ?,
        content_sha256 = ?, size_bytes = ?, record_count = ?, lease_expires_at = NULL,
        lease_token = NULL, last_error_code = 'uncommitted_object_delete_failed', updated_at = ?
      WHERE id = ? AND state != 'completed' AND (object_key IS NULL OR object_key = ?)`)
      .bind(
        objectKey,
        metadata.objectKeyHash,
        metadata.contentSha256,
        metadata.sizeBytes,
        metadata.recordCount,
        updatedAt,
        jobId,
        objectKey,
      )
      .run();
    if (mutationChanges(retained) !== 1) {
      const cleanupJobId = `pexj_${crypto.randomUUID().replaceAll("-", "")}`;
      try {
        await db.prepare(`INSERT INTO privacy_export_jobs (
            id, user_id, owner_subject_hash, state, attempts, available_at,
            lease_expires_at, lease_token, object_key, object_key_hash, content_sha256,
            size_bytes, record_count, last_error_code, requested_at, updated_at,
            completed_at, expires_at)
          VALUES (?, NULL, ?, 'needs_attention', ?, ?, NULL, NULL, ?, ?, ?, ?, ?,
            'uncommitted_object_delete_failed', ?, ?, NULL, NULL)`)
          .bind(
            cleanupJobId,
            ownerSubjectHash,
            MAX_ATTEMPTS,
            updatedAt,
            objectKey,
            metadata.objectKeyHash,
            metadata.contentSha256,
            metadata.sizeBytes,
            metadata.recordCount,
            updatedAt,
            updatedAt,
          )
          .run();
      } catch {
        logEvent("error", "privacy_export.object_cleanup_tracking_failed", {
          error_code: "object_cleanup_tracking_failed",
        });
      }
    }
  }
}

async function settleUnclaimedMessage(db: D1DatabaseLike, message: QueueMessageLike, jobId: string) {
  const row = await db.prepare("SELECT state, attempts, available_at, object_key FROM privacy_export_jobs WHERE id = ? LIMIT 1")
    .bind(jobId)
    .first<{ state: PrivacyExportJobState; attempts: number; available_at: string; object_key: string | null }>();
  if (!row || row.state === "completed" || row.state === "canceled" || row.state === "expired" || row.state === "needs_attention") {
    message.ack();
    return;
  }
  if (row.object_key) {
    message.ack();
    return;
  }
  const delay = Math.max(1, Math.ceil((Date.parse(row.available_at) - Date.now()) / 1000));
  message.retry({ delaySeconds: Math.min(REDISPATCH_SECONDS, delay) });
}

export async function processExpiredPrivacyExports(env: PrivacyExportEnv) {
  if (!env.DB) return 0;
  const db = env.DB;
  const now = new Date();
  const nowIso = now.toISOString();
  const rows = await db.prepare(`SELECT id, user_id, owner_subject_hash, state, attempts, available_at,
      lease_expires_at, lease_token, object_key, object_key_hash, content_sha256,
      size_bytes, record_count, last_error_code, requested_at, updated_at, completed_at, expires_at
    FROM privacy_export_jobs
    WHERE object_key IS NOT NULL
      AND ((state = 'completed' AND expires_at <= ?)
        OR (state IN ('canceled', 'needs_attention')
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
        OR (state = 'processing' AND user_id IS NOT NULL
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))
    ORDER BY COALESCE(expires_at, updated_at), id LIMIT ?`)
    .bind(nowIso, nowIso, nowIso, EXPIRY_BATCH_SIZE)
    .all<PrivacyExportJobRow>();
  let deleted = 0;
  for (const job of rows.results ?? []) {
    if (!job.object_key) continue;
    const leaseToken = randomToken();
    const leaseExpiresAt = new Date(Date.now() + LEASE_SECONDS * 1000).toISOString();
    const staleAttempt = job.state === "processing" && job.user_id !== null;
    const claimed = staleAttempt
      ? await db.prepare(`UPDATE privacy_export_jobs
        SET state = 'needs_attention', lease_expires_at = ?, lease_token = ?,
          last_error_code = 'stale_attempt_object_cleanup', updated_at = ?
        WHERE id = ? AND user_id = ? AND state = 'processing' AND object_key = ?
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`)
        .bind(leaseExpiresAt, leaseToken, nowIso, job.id, job.user_id, job.object_key, nowIso)
        .run()
      : await db.prepare(`UPDATE privacy_export_jobs
        SET state = 'canceled', user_id = NULL, lease_expires_at = ?, lease_token = ?,
          last_error_code = 'export_expired', updated_at = ?
        WHERE id = ? AND object_key = ?
          AND ((state = 'completed' AND expires_at <= ?)
            OR (state IN ('canceled', 'needs_attention')
              AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))`)
        .bind(leaseExpiresAt, leaseToken, nowIso, job.id, job.object_key, nowIso, nowIso)
        .run();
    if (mutationChanges(claimed) !== 1) continue;
    if (!env.PRIVACY_EXPORTS) {
      await db.prepare(`UPDATE privacy_export_jobs SET state = 'needs_attention',
          lease_expires_at = NULL, lease_token = NULL,
          last_error_code = 'export_storage_unavailable', updated_at = ?
        WHERE id = ? AND state IN ('canceled', 'needs_attention') AND lease_token = ?`)
        .bind(new Date().toISOString(), job.id, leaseToken)
        .run();
      continue;
    }
    try {
      await env.PRIVACY_EXPORTS.delete(job.object_key);
      const finishedAt = new Date().toISOString();
      const finalized = staleAttempt
        ? await db.prepare(`UPDATE privacy_export_jobs
          SET state = CASE WHEN attempts >= ? THEN 'needs_attention' ELSE 'retry' END,
            available_at = ?, object_key = NULL, object_key_hash = NULL,
            content_sha256 = NULL, size_bytes = NULL, record_count = NULL,
            lease_expires_at = NULL, lease_token = NULL,
            last_error_code = CASE WHEN attempts >= ? THEN 'export_attempts_exhausted' ELSE NULL END,
            updated_at = ?
          WHERE id = ? AND state = 'needs_attention' AND lease_token = ? AND object_key = ?`)
          .bind(MAX_ATTEMPTS, finishedAt, MAX_ATTEMPTS, finishedAt, job.id, leaseToken, job.object_key)
          .run()
        : await db.prepare(`UPDATE privacy_export_jobs
          SET state = 'expired', object_key = NULL, object_key_hash = NULL,
            content_sha256 = NULL, size_bytes = NULL, record_count = NULL,
            lease_expires_at = NULL, lease_token = NULL, last_error_code = NULL,
            updated_at = ?
          WHERE id = ? AND state = 'canceled' AND lease_token = ? AND object_key = ?`)
          .bind(finishedAt, job.id, leaseToken, job.object_key)
          .run();
      if (mutationChanges(finalized) === 1) deleted += 1;
    } catch {
      await db.prepare(`UPDATE privacy_export_jobs SET state = 'needs_attention',
          lease_expires_at = NULL, lease_token = NULL,
          last_error_code = 'export_object_delete_failed', updated_at = ?
        WHERE id = ? AND state IN ('canceled', 'needs_attention') AND lease_token = ?`)
        .bind(new Date().toISOString(), job.id, leaseToken)
        .run();
    }
  }
  return deleted;
}

export async function buildPrivacyExportPayload(
  env: Pick<PrivacyExportEnv, "DB" | "TRIP_PHOTOS">,
  userId: string,
  exportedAt = new Date().toISOString(),
) {
  if (!env.DB) throw new Error("database_binding_missing");
  const db = env.DB;
  const [account, saved, gear, trips] = await Promise.all([
    db.prepare(`SELECT id, email, age_eligibility_confirmed_at, terms_accepted_at, terms_version,
      privacy_accepted_at, privacy_version, created_at, updated_at FROM users WHERE id = ? LIMIT 1`)
      .bind(userId).first<Record<string, unknown>>(),
    db.prepare("SELECT site_id, created_at FROM saved_sites WHERE user_id = ? ORDER BY created_at DESC")
      .bind(userId).all<Record<string, unknown>>(),
    db.prepare(`SELECT id, name, rod, reel, bait_lure, rig, created_at, updated_at
      FROM gear_profiles WHERE user_id = ? ORDER BY updated_at DESC`)
      .bind(userId).all<Record<string, unknown>>(),
    db.prepare(`SELECT id, status, source, site_id, started_at, ended_at, mode, fishing_method,
      gear, gear_profile_id, rod, reel, bait_lure, rig, angler_count, angler_hours,
      keeper_count, short_released_count, halibut_encounters, no_catch, other_catch_count,
      other_species, observations_json, observation_contract_version, taxon_catalog_version,
      target_taxon_id, contract_status, taxon_observations_json, outcome_class,
      target_encounter_count, any_fish_encounter_count, target_identification_confidence,
      notes, consent, consent_at, moderation_status,
      referral_code, opportunity_window_id, opportunity_score, habitat_score, seasonality_score,
      conditions_score, fishability_score, model_version, score_influenced_choice,
      prediction_metadata_json, photo_content_type, photo_size_bytes, created_at, updated_at,
      completed_at, ai_review_status, ai_review_json, ai_review_model, ai_reviewed_at,
      CASE WHEN photo_key IS NULL THEN 0 ELSE 1 END AS has_photo, photo_key
      FROM trips WHERE user_id = ? ORDER BY created_at DESC`)
      .bind(userId).all<Record<string, unknown>>(),
  ]);
  const tripRows = trips.results ?? [];
  const tripReports = tripRows.map((trip) => {
    const exportedTrip = { ...trip };
    delete exportedTrip.photo_key;
    return exportedTrip;
  });
  const [
    discussionRows,
    forecastImpressionRows,
    validationProvenanceRows,
    validationFeasibilityRows,
    validationFeasibilityRecruitmentRows,
    validationFeasibilityCorrectionRows,
  ] = await Promise.all([
    db.prepare(`SELECT site_discussion_posts.id, site_discussion_posts.trip_id,
        site_discussion_posts.site_id, site_discussion_posts.summary, site_discussion_posts.gear_summary,
        site_discussion_posts.technique_tags_json, site_discussion_posts.observed_at,
        site_discussion_posts.created_at, site_discussion_posts.updated_at,
        site_discussion_posts.review_model, site_discussion_posts.approved_at,
        site_discussion_posts.source_ai_reviewed_at
      FROM site_discussion_posts
      JOIN trips ON trips.id = site_discussion_posts.trip_id
      WHERE trips.user_id = ? ORDER BY site_discussion_posts.created_at DESC`)
      .bind(userId).all<Record<string, unknown>>(),
    db.prepare(`SELECT forecast_impressions.* FROM forecast_impressions
      JOIN trips ON trips.id = forecast_impressions.trip_id
      WHERE trips.user_id = ? ORDER BY forecast_impressions.attested_at ASC`)
      .bind(userId).all<Record<string, unknown>>(),
    db.prepare(`SELECT trip_validation_provenance.* FROM trip_validation_provenance
      JOIN trips ON trips.id = trip_validation_provenance.trip_id
      WHERE trips.user_id = ? ORDER BY trip_validation_provenance.created_at ASC`)
      .bind(userId).all<Record<string, unknown>>(),
    db.prepare(`SELECT validation_feasibility_events.* FROM validation_feasibility_events
      JOIN trips ON trips.id = validation_feasibility_events.trip_id
      WHERE trips.user_id = ? ORDER BY validation_feasibility_events.sequence ASC`)
      .bind(userId).all<Record<string, unknown>>(),
    db.prepare(`SELECT recruitment.event_id, recruitment.activation_id,
        recruitment.participant_group_id, recruitment.event_contract_version,
        recruitment.recruitment_frame_id, recruitment.recruitment_source_id,
        recruitment.selection_method, recruitment.recruited_at, recruitment.campaign_id,
        recruitment.invite_issued_at, recruitment.invite_expires_at,
        recruitment.community_approval_sha256, recruitment.event_sha256, recruitment.created_at
      FROM validation_feasibility_recruitment_events AS recruitment
      WHERE recruitment.user_id = ? ORDER BY recruitment.sequence ASC`)
      .bind(userId).all<Record<string, unknown>>(),
    db.prepare(`SELECT corrections.* FROM validation_feasibility_corrections AS corrections
      JOIN trips ON trips.id = corrections.trip_id
      WHERE trips.user_id = ? ORDER BY corrections.sequence ASC`)
      .bind(userId).all<Record<string, unknown>>(),
  ]);
  const photoRows = tripRows.filter((trip) => typeof trip.photo_key === "string" && trip.photo_key);
  const photoManifest = await mapWithConcurrency(
    photoRows,
    PHOTO_MANIFEST_CONCURRENCY,
    (trip) => buildPhotoExportManifest(env, trip),
  );
  const exportedFeasibilityEvents = (validationFeasibilityRows.results ?? []).map((row) => {
    const exported = { ...row };
    delete exported.snapshot_suppression_sha256;
    return exported;
  });
  const payload = {
    exportedAt,
    account,
    savedSites: saved.results ?? [],
    gearProfiles: gear.results ?? [],
    tripReports,
    forecastImpressions: forecastImpressionRows.results ?? [],
    validationProvenance: validationProvenanceRows.results ?? [],
    validationFeasibilityEvents: exportedFeasibilityEvents,
    validationFeasibilityRecruitment: validationFeasibilityRecruitmentRows.results ?? [],
    validationFeasibilityCorrections: validationFeasibilityCorrectionRows.results ?? [],
    discussionPosts: discussionRows.results ?? [],
    photos: photoManifest,
  };
  const recordCount = (account ? 1 : 0) + Object.values(payload)
    .filter(Array.isArray)
    .reduce((total, rows) => total + rows.length, 0);
  return { payload, recordCount };
}

async function buildPhotoExportManifest(
  env: Pick<PrivacyExportEnv, "TRIP_PHOTOS">,
  trip: Record<string, unknown>,
) {
  const tripId = String(trip.id);
  const contentType = safePhotoContentType(trip.photo_content_type);
  const sizeBytes = typeof trip.photo_size_bytes === "number" ? trip.photo_size_bytes : null;
  if (!env.TRIP_PHOTOS?.get) {
    return { tripId, contentType, sizeBytes, availability: "unavailable", downloadPath: null, reason: "photo_storage_unavailable" };
  }
  try {
    const object = await env.TRIP_PHOTOS.get(String(trip.photo_key));
    if (!object) {
      return { tripId, contentType, sizeBytes, availability: "missing", downloadPath: null, reason: "photo_object_missing" };
    }
    await object.body?.cancel().catch(() => undefined);
    return {
      tripId,
      contentType: safePhotoContentType(object.httpMetadata?.contentType ?? contentType),
      sizeBytes: object.size ?? sizeBytes,
      availability: "downloadable",
      downloadPath: `/api/profile/export/photos/${tripId}`,
      reason: null,
    };
  } catch {
    return { tripId, contentType, sizeBytes, availability: "temporarily_unavailable", downloadPath: null, reason: "photo_storage_error" };
  }
}

async function activeJobForUser(db: D1DatabaseLike, userId: string) {
  return db.prepare(`SELECT id, user_id, owner_subject_hash, state, attempts, available_at,
      lease_expires_at, lease_token, object_key, object_key_hash, content_sha256,
      size_bytes, record_count, last_error_code, requested_at, updated_at, completed_at, expires_at
    FROM privacy_export_jobs
    WHERE user_id = ? AND state IN ('pending', 'queued', 'processing', 'retry', 'completed', 'needs_attention')
    ORDER BY requested_at DESC LIMIT 1`)
    .bind(userId)
    .first<PrivacyExportJobRow>();
}

function parseQueueMessage(value: unknown): QueueMessageBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).sort().join(",") !== "jobId,version") return null;
  if (body.version !== PRIVACY_EXPORT_QUEUE_MESSAGE_VERSION || typeof body.jobId !== "string" || !JOB_ID_PATTERN.test(body.jobId)) return null;
  return { version: PRIVACY_EXPORT_QUEUE_MESSAGE_VERSION, jobId: body.jobId };
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, callback: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await callback(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function safePhotoContentType(value: unknown) {
  return value === "image/jpeg" || value === "image/png" || value === "image/webp"
    ? value
    : "application/octet-stream";
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Text(value: string) {
  return sha256Bytes(new TextEncoder().encode(value));
}

async function sha256Bytes(value: Uint8Array) {
  const bytes = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function mutationChanges(result: unknown) {
  if (!result || typeof result !== "object") return 0;
  const changes = Number((result as { meta?: { changes?: unknown } }).meta?.changes ?? 0);
  return Number.isFinite(changes) ? changes : 0;
}

function jsonError(status: number, code: string, message: string, retryAfter?: number) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
  if (retryAfter) headers["Retry-After"] = String(retryAfter);
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers });
}

function privacyExportIntegrityError(
  errorCode: "export_locator_hash_mismatch" | "export_object_metadata_mismatch",
) {
  logEvent("error", "privacy_export.download.integrity_rejected", { error_code: errorCode });
  return jsonError(
    503,
    "privacy_export_integrity_mismatch",
    "The export file could not be verified for download.",
    60,
  );
}
