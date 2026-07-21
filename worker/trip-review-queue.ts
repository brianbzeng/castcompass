import type { CuratedSite, D1DatabaseLike } from "./trips";
import { logEvent } from "./observability.ts";
import { releaseMaintenanceEnabled } from "./security.ts";
import { reviewTripBacklog, reviewTripWithMimo } from "./trip-review.ts";
import type { RateLimitEnv } from "./rate-limit.ts";

export const AI_REVIEW_QUEUE_MESSAGE_VERSION = "castingcompass.ai-review-queue/1.0.0";
const JOB_ID_PATTERN = /^airj_[a-f0-9]{32}$/;
const MAX_BATCH_MESSAGES = 5;
const MAX_ATTEMPTS = 5;
const LEASE_SECONDS = 60;
const REDISPATCH_SECONDS = 15 * 60;
const MAINTENANCE_DELAY_SECONDS = 5 * 60;
const RETRY_DELAYS_SECONDS = [60, 5 * 60, 15 * 60, 60 * 60] as const;

export interface QueueSendOptionsLike {
  delaySeconds?: number;
}

export interface QueueBindingLike {
  send(body: unknown, options?: QueueSendOptionsLike): Promise<unknown>;
}

export interface QueueMessageLike {
  readonly id: string;
  readonly body: unknown;
  readonly attempts: number;
  ack(): void;
  retry(options?: QueueSendOptionsLike): void;
}

export interface QueueBatchLike {
  readonly queue: string;
  readonly messages: readonly QueueMessageLike[];
}

export interface AiReviewQueueEnv extends RateLimitEnv {
  DB?: D1DatabaseLike;
  MIMO_API_KEY?: string;
  MIMO_MODEL?: string;
  AI_REVIEW_QUEUE_ENABLED?: string;
  AI_REVIEW_QUEUE?: QueueBindingLike;
  RELEASE_MAINTENANCE_MODE?: string;
}

interface QueueMessageBody {
  version: typeof AI_REVIEW_QUEUE_MESSAGE_VERSION;
  jobId: string;
}

interface AiReviewJobRow {
  id: string;
  trip_id: string;
  state: "pending" | "queued" | "processing" | "retry" | "completed" | "needs_attention";
  attempts: number;
  available_at: string;
  lease_expires_at: string | null;
}

interface TripReviewStateRow {
  ai_review_status: string | null;
}

export function aiReviewQueueMode(env: AiReviewQueueEnv) {
  if (env.AI_REVIEW_QUEUE_ENABLED === undefined || env.AI_REVIEW_QUEUE_ENABLED === "false") {
    return "disabled" as const;
  }
  return env.AI_REVIEW_QUEUE_ENABLED === "true" ? "enabled" as const : "invalid" as const;
}

export async function scheduleTripReview(
  env: AiReviewQueueEnv,
  tripId: string,
  sites: readonly CuratedSite[],
  options: { expediteRetry?: boolean; resetForNewInput?: boolean } = {},
) {
  const mode = aiReviewQueueMode(env);
  if (mode === "disabled") return reviewTripWithMimo(env, tripId, sites);
  if (mode === "invalid") {
    logQueueConfigurationRejected("invalid_feature_flag");
    return;
  }
  if (!env.DB) {
    logQueueConfigurationRejected("database_binding_missing");
    return;
  }

  try {
    let job = await ensureAiReviewJob(env.DB, tripId, Boolean(options.resetForNewInput));
    if (!job) return;
    if (options.expediteRetry && job.state === "retry") {
      const now = new Date().toISOString();
      await env.DB.prepare(`UPDATE ai_review_jobs SET state = 'pending', available_at = ?,
          lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND state = 'retry'`)
        .bind(now, now, job.id)
        .run();
      job = { ...job, state: "pending", available_at: now, lease_expires_at: null };
    }
    await dispatchJob(env, job);
  } catch {
    logEvent("error", "ai_review.queue.schedule_failed", {
      error_code: "queue_schedule_failed",
    });
  }
}

export async function dispatchAiReviewBacklog(
  env: AiReviewQueueEnv,
  sites: readonly CuratedSite[],
  limit = 10,
) {
  const mode = aiReviewQueueMode(env);
  if (mode === "disabled") {
    return reviewTripBacklog(env, sites, limit);
  }
  if (mode === "invalid") {
    logQueueConfigurationRejected("invalid_feature_flag");
    return 0;
  }
  if (!env.DB) {
    logQueueConfigurationRejected("database_binding_missing");
    return 0;
  }

  try {
    const pendingTrips = await env.DB.prepare(`SELECT trip.id FROM trips AS trip
      LEFT JOIN ai_review_jobs AS job ON job.trip_id = trip.id
      WHERE trip.status = 'completed'
        AND (trip.ai_review_status IS NULL OR trip.ai_review_status = 'queued' OR trip.ai_review_status = 'retry')
        AND job.id IS NULL
      ORDER BY COALESCE(trip.completed_at, trip.ended_at, trip.started_at) ASC
      LIMIT ?`)
      .bind(boundedLimit(limit))
      .all<{ id: string }>();
    for (const trip of pendingTrips.results ?? []) await ensureAiReviewJob(env.DB, trip.id, false);

    const now = new Date().toISOString();
    const rows = await env.DB.prepare(`SELECT id, trip_id, state, attempts, available_at, lease_expires_at
      FROM ai_review_jobs
      WHERE ((state = 'pending' OR state = 'retry' OR state = 'queued') AND available_at <= ?)
        OR (state = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
      ORDER BY available_at, created_at
      LIMIT ?`)
      .bind(now, now, boundedLimit(limit))
      .all<AiReviewJobRow>();
    for (const job of rows.results ?? []) await dispatchJob(env, job);
    return (rows.results ?? []).length;
  } catch {
    logEvent("error", "ai_review.queue.backlog_failed", {
      error_code: "queue_backlog_failed",
    });
    return 0;
  }
}

export async function consumeAiReviewQueue(
  batch: QueueBatchLike,
  env: AiReviewQueueEnv,
  sites: readonly CuratedSite[],
) {
  const mode = aiReviewQueueMode(env);
  if (mode === "disabled" && env.DB) {
    for (const message of batch.messages) {
      await deferMessage(env.DB, message, "queue_disabled", REDISPATCH_SECONDS);
    }
    return;
  }
  if (mode !== "enabled" || !env.DB) {
    logQueueConfigurationRejected(mode === "invalid"
      ? "invalid_feature_flag"
      : mode === "disabled" ? "consumer_disabled" : "database_binding_missing");
    for (const message of batch.messages) message.retry({ delaySeconds: MAINTENANCE_DELAY_SECONDS });
    return;
  }

  if (releaseMaintenanceEnabled(env)) {
    for (const message of batch.messages) {
      await deferMessage(env.DB, message, "release_maintenance", MAINTENANCE_DELAY_SECONDS);
    }
    return;
  }

  for (const [index, message] of batch.messages.entries()) {
    if (index >= MAX_BATCH_MESSAGES) {
      message.retry({ delaySeconds: RETRY_DELAYS_SECONDS[0] });
      continue;
    }
    const body = parseQueueMessage(message.body);
    if (!body) {
      logEvent("warn", "ai_review.queue.message_rejected", {
        error_code: "invalid_queue_message",
      });
      message.ack();
      continue;
    }
    await consumeMessage(env, env.DB, sites, message, body);
  }
}

async function ensureAiReviewJob(db: D1DatabaseLike, tripId: string, resetFailed: boolean) {
  const now = new Date().toISOString();
  const id = `airj_${crypto.randomUUID().replaceAll("-", "")}`;
  await db.prepare(`INSERT INTO ai_review_jobs
      (id, trip_id, state, attempts, available_at, lease_expires_at, last_error_code,
        created_at, updated_at, completed_at)
    SELECT ?, id, 'pending', 0, ?, NULL, NULL, ?, ?, NULL
    FROM trips
    WHERE id = ? AND status = 'completed'
      AND (ai_review_status IS NULL OR ai_review_status = 'queued' OR ai_review_status = 'retry')
    ON CONFLICT(trip_id) DO UPDATE SET
      state = CASE WHEN ? = 1 AND ai_review_jobs.state IN ('retry', 'completed', 'needs_attention')
        THEN 'pending' ELSE ai_review_jobs.state END,
      attempts = CASE WHEN ? = 1 AND ai_review_jobs.state IN ('retry', 'completed', 'needs_attention')
        THEN 0 ELSE ai_review_jobs.attempts END,
      available_at = CASE WHEN ? = 1 AND ai_review_jobs.state IN ('retry', 'completed', 'needs_attention')
        THEN excluded.available_at ELSE ai_review_jobs.available_at END,
      lease_expires_at = CASE WHEN ? = 1 AND ai_review_jobs.state IN ('retry', 'completed', 'needs_attention')
        THEN NULL ELSE ai_review_jobs.lease_expires_at END,
      last_error_code = CASE WHEN ? = 1 AND ai_review_jobs.state IN ('retry', 'completed', 'needs_attention')
        THEN NULL ELSE ai_review_jobs.last_error_code END,
      completed_at = CASE WHEN ? = 1 AND ai_review_jobs.state IN ('retry', 'completed', 'needs_attention')
        THEN NULL ELSE ai_review_jobs.completed_at END,
      updated_at = CASE WHEN ? = 1 AND ai_review_jobs.state IN ('retry', 'completed', 'needs_attention')
        THEN excluded.updated_at ELSE ai_review_jobs.updated_at END`)
    .bind(id, now, now, now, tripId, ...Array(7).fill(Number(resetFailed)))
    .run();
  return db.prepare(`SELECT id, trip_id, state, attempts, available_at, lease_expires_at
    FROM ai_review_jobs WHERE trip_id = ? LIMIT 1`)
    .bind(tripId)
    .first<AiReviewJobRow>();
}

async function dispatchJob(env: AiReviewQueueEnv, job: AiReviewJobRow) {
  if (!env.DB) return;
  if (!env.AI_REVIEW_QUEUE) {
    logQueueConfigurationRejected("producer_binding_missing");
    return;
  }
  const now = new Date();
  if (job.state === "completed" || job.state === "needs_attention" || job.available_at > now.toISOString()) return;
  if (job.state === "processing") {
    if (job.lease_expires_at && job.lease_expires_at > now.toISOString()) return;
  }
  const body: QueueMessageBody = { version: AI_REVIEW_QUEUE_MESSAGE_VERSION, jobId: job.id };
  const redispatchAt = new Date(now.getTime() + REDISPATCH_SECONDS * 1000).toISOString();
  const staged = await env.DB.prepare(`UPDATE ai_review_jobs SET state = 'queued',
      available_at = ?, lease_expires_at = NULL, last_error_code = NULL, updated_at = ?
    WHERE id = ? AND state IN ('pending', 'retry', 'queued', 'processing')
      AND (((state = 'pending' OR state = 'retry' OR state = 'queued') AND available_at <= ?)
        OR (state = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))`)
    .bind(redispatchAt, now.toISOString(), job.id, now.toISOString(), now.toISOString())
    .run();
  if (Number(staged.meta?.changes ?? 0) !== 1) return;
  try {
    await env.AI_REVIEW_QUEUE.send(body);
  } catch {
    const retryAt = new Date(Date.now() + RETRY_DELAYS_SECONDS[0] * 1000).toISOString();
    await env.DB.prepare(`UPDATE ai_review_jobs SET state = 'pending', available_at = ?,
        last_error_code = 'queue_publish_failed', updated_at = ?
      WHERE id = ? AND state = 'queued'`)
      .bind(retryAt, new Date().toISOString(), job.id)
      .run();
    logEvent("error", "ai_review.queue.publish_failed", {
      error_code: "queue_publish_failed",
    });
  }
}

async function consumeMessage(
  env: AiReviewQueueEnv,
  db: D1DatabaseLike,
  sites: readonly CuratedSite[],
  message: QueueMessageLike,
  body: QueueMessageBody,
) {
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + LEASE_SECONDS * 1000).toISOString();
  const claimed = await db.prepare(`UPDATE ai_review_jobs SET state = 'processing',
      attempts = attempts + 1, lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND attempts < ?
      AND (state = 'queued'
        OR ((state = 'pending' OR state = 'retry') AND available_at <= ?)
        OR (state = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))`)
    .bind(leaseExpiresAt, nowIso, body.jobId, MAX_ATTEMPTS, nowIso, nowIso)
    .run();
  if (Number(claimed.meta?.changes ?? 0) !== 1) {
    await settleUnclaimedMessage(db, message, body.jobId);
    return;
  }

  const job = await db.prepare(`SELECT id, trip_id, state, attempts, available_at, lease_expires_at
    FROM ai_review_jobs WHERE id = ? LIMIT 1`)
    .bind(body.jobId)
    .first<AiReviewJobRow>();
  if (!job) {
    message.ack();
    return;
  }

  await db.prepare(`UPDATE trips SET ai_review_status = 'retry', ai_review_json = NULL,
      ai_review_model = NULL, ai_reviewed_at = NULL
    WHERE id = ? AND ai_review_status = 'needs_attention'`)
    .bind(job.trip_id)
    .run();

  await reviewTripWithMimo(env, job.trip_id, sites);
  const trip = await db.prepare("SELECT ai_review_status FROM trips WHERE id = ? LIMIT 1")
    .bind(job.trip_id)
    .first<TripReviewStateRow>();
  if (!trip || trip.ai_review_status === "reviewed") {
    const finishedAt = new Date().toISOString();
    await db.prepare(`UPDATE ai_review_jobs SET state = 'completed', available_at = ?,
        lease_expires_at = NULL, last_error_code = NULL, updated_at = ?, completed_at = ?
      WHERE id = ? AND state = 'processing'`)
      .bind(finishedAt, finishedAt, finishedAt, job.id)
      .run();
    message.ack();
    return;
  }

  const attempts = Number(job.attempts);
  const terminal = attempts >= MAX_ATTEMPTS;
  const delaySeconds = retryDelay(attempts);
  const availableAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
  const updatedAt = new Date().toISOString();
  const jobStatement = db.prepare(`UPDATE ai_review_jobs SET state = ?, available_at = ?,
      lease_expires_at = NULL, last_error_code = ?, updated_at = ?
    WHERE id = ? AND state = 'processing'`)
    .bind(
      terminal ? "needs_attention" : "retry",
      availableAt,
      safeTripReviewErrorCode(trip.ai_review_status),
      updatedAt,
      job.id,
    );
  if (terminal) {
    await db.batch([
      jobStatement,
      db.prepare(`UPDATE trips SET ai_review_status = 'needs_attention', ai_review_json = NULL,
          ai_review_model = NULL, ai_reviewed_at = NULL
        WHERE id = ? AND ai_review_status != 'reviewed'`)
        .bind(job.trip_id),
    ]);
  } else {
    await jobStatement.run();
  }
  if (terminal) {
    logEvent("error", "ai_review.queue.exhausted", {
      error_code: "ai_review_attempts_exhausted",
      attempts,
    });
    message.ack();
  } else {
    message.retry({ delaySeconds });
  }
}

async function settleUnclaimedMessage(db: D1DatabaseLike, message: QueueMessageLike, jobId: string) {
  const job = await db.prepare("SELECT state, available_at FROM ai_review_jobs WHERE id = ? LIMIT 1")
    .bind(jobId)
    .first<Pick<AiReviewJobRow, "state" | "available_at">>();
  if (!job || job.state === "completed" || job.state === "needs_attention") {
    message.ack();
    return;
  }
  const delaySeconds = Math.max(1, Math.min(
    REDISPATCH_SECONDS,
    Math.ceil((Date.parse(job.available_at) - Date.now()) / 1000),
  ));
  message.retry({ delaySeconds });
}

async function deferMessage(
  db: D1DatabaseLike,
  message: QueueMessageLike,
  errorCode: "queue_disabled" | "release_maintenance",
  delaySeconds: number,
) {
  const body = parseQueueMessage(message.body);
  if (!body) {
    logEvent("warn", "ai_review.queue.message_rejected", { error_code: "invalid_queue_message" });
    message.ack();
    return;
  }
  const now = new Date();
  const availableAt = new Date(now.getTime() + delaySeconds * 1000).toISOString();
  await db.prepare(`UPDATE ai_review_jobs SET state = 'pending', available_at = ?,
      lease_expires_at = NULL, last_error_code = ?, updated_at = ?
    WHERE id = ? AND state != 'completed' AND state != 'needs_attention'`)
    .bind(availableAt, errorCode, now.toISOString(), body.jobId)
    .run();
  message.ack();
}

function parseQueueMessage(value: unknown): QueueMessageBody | null {
  if (!isRecord(value) || Object.keys(value).length !== 2) return null;
  if (value.version !== AI_REVIEW_QUEUE_MESSAGE_VERSION) return null;
  if (typeof value.jobId !== "string" || !JOB_ID_PATTERN.test(value.jobId)) return null;
  return { version: AI_REVIEW_QUEUE_MESSAGE_VERSION, jobId: value.jobId };
}

function retryDelay(attempts: number) {
  const index = Math.max(0, Math.min(RETRY_DELAYS_SECONDS.length - 1, attempts - 1));
  return RETRY_DELAYS_SECONDS[index];
}

function safeTripReviewErrorCode(status: string | null) {
  if (status === "retry") return "provider_review_failed";
  if (status === "processing") return "review_not_settled";
  if (status === "queued" || status === null) return "review_deferred";
  return "review_state_unexpected";
}

function boundedLimit(value: number) {
  return Number.isInteger(value) && value >= 1 ? Math.min(value, 50) : 10;
}

function logQueueConfigurationRejected(errorCode: string) {
  logEvent("error", "ai_review.queue.configuration_rejected", {
    error_code: errorCode,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
