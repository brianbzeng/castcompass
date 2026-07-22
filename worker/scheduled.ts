import { cleanupAuthRetentionData, processPrivacyDeletionTasks, type AuthApiEnv } from "./auth.ts";
import { dispatchPrivacyExportBacklog, processExpiredPrivacyExports, type PrivacyExportEnv } from "./privacy-export.ts";
import { dispatchAiReviewBacklog, type AiReviewQueueEnv } from "./trip-review-queue.ts";
import {
  processTripPhotoUploadReservations,
  type CuratedSite,
  type TripApiEnv,
} from "./trips.ts";

export const SCHEDULED_INTERVAL_MILLISECONDS = 5 * 60 * 1000;
export const SCHEDULED_D1_QUERY_CEILING = 50;

export const SCHEDULED_LANES = [
  "queue_dispatch",
  "trip_photo_reservations",
  "privacy_export_expiry",
  "auth_retention_and_deletion",
] as const;

export type ScheduledLane = typeof SCHEDULED_LANES[number];

export interface ScheduledControllerLike {
  scheduledTime?: number;
}

export interface ScheduledEnv
  extends TripApiEnv, AuthApiEnv, AiReviewQueueEnv, PrivacyExportEnv {}

export const SCHEDULED_LANE_LIMITS = Object.freeze({
  aiReviewDispatch: 1,
  privacyExportDispatch: 5,
  tripPhotoReservations: 7,
  privacyExportExpiry: 7,
  privacyDeletionTasks: 3,
});

// These are conservative branch maxima, including one cold schema-readiness query,
// D1 batch members, terminal read-back receipts, and repair writes. They are kept
// below the Free-plan per-invocation D1 limit rather than relying on a paid-plan limit.
export const SCHEDULED_LANE_D1_QUERY_BUDGET = Object.freeze({
  queue_dispatch: 32,
  trip_photo_reservations: 44,
  privacy_export_expiry: 36,
  auth_retention_and_deletion: 44,
} satisfies Record<ScheduledLane, number>);

export function scheduledLaneFor(controller: ScheduledControllerLike | unknown, fallbackTime = Date.now()) {
  const scheduledTime = typeof controller === "object" && controller !== null
      && "scheduledTime" in controller && typeof controller.scheduledTime === "number"
      && Number.isFinite(controller.scheduledTime) && controller.scheduledTime >= 0
    ? controller.scheduledTime
    : fallbackTime;
  const bucket = Math.floor(scheduledTime / SCHEDULED_INTERVAL_MILLISECONDS);
  return SCHEDULED_LANES[bucket % SCHEDULED_LANES.length];
}

export async function runScheduledLane(
  lane: ScheduledLane,
  env: ScheduledEnv,
  sites: readonly CuratedSite[],
  now = new Date(),
) {
  switch (lane) {
    case "queue_dispatch":
      await dispatchAiReviewBacklog(env, sites, SCHEDULED_LANE_LIMITS.aiReviewDispatch);
      await dispatchPrivacyExportBacklog(env, SCHEDULED_LANE_LIMITS.privacyExportDispatch);
      return;
    case "trip_photo_reservations":
      await processTripPhotoUploadReservations(env, now, SCHEDULED_LANE_LIMITS.tripPhotoReservations);
      return;
    case "privacy_export_expiry":
      await processExpiredPrivacyExports(env, SCHEDULED_LANE_LIMITS.privacyExportExpiry);
      return;
    case "auth_retention_and_deletion":
      await cleanupAuthRetentionData(env);
      await processPrivacyDeletionTasks(env, undefined, SCHEDULED_LANE_LIMITS.privacyDeletionTasks);
  }
}
