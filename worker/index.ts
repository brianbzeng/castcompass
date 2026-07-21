/** Cloudflare Worker entry point for the CastingCompass PWA. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import sites from "../public/data/sites.json";
import { handleTripRequest, type TripApiEnv } from "./trips";
import { cleanupAuthData, getAuthenticatedUser, handleAccountRequest, legalAcceptanceRequiredResponse, unauthorizedResponse } from "./auth";
import {
  AI_REVIEW_QUEUE_MESSAGE_VERSION,
  consumeAiReviewQueue,
  dispatchAiReviewBacklog,
  scheduleTripReview,
  type AiReviewQueueEnv,
  type QueueBatchLike,
  type QueueMessageLike,
} from "./trip-review-queue.ts";
import {
  PRIVACY_EXPORT_QUEUE_MESSAGE_VERSION,
  consumePrivacyExportQueue,
  dispatchPrivacyExportBacklog,
  type PrivacyExportEnv,
} from "./privacy-export.ts";
import { handleDiscussionRequest } from "./discussions";
import {
  canonicalRedirect,
  guardRequestBody,
  hardenResponse,
  healthResponse,
  normalizeNotFoundDocument,
  releaseMaintenanceEnabled,
  releaseMaintenanceResponse,
} from "./security";
import { handleTurnstileConfigRequest, type TurnstileEnv } from "./turnstile";
import { enforceRequestRateLimit, type RateLimitEnv } from "./rate-limit";
import { apiRoutePolicyForRequest, isKnownApiPath } from "./route-policy";
import { unsupportedApiVersionResponse } from "./api-version.ts";
import {
  attachRequestId,
  internalErrorResponse,
  logEvent,
  logRequestCompleted,
  observeQueueTask,
  observeScheduledTask,
  requestLogContext,
  runWithLogContext,
  safeErrorFields,
  type ObservabilityEnv,
} from "./observability";

interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

interface Env extends TripApiEnv, TurnstileEnv, RateLimitEnv, ObservabilityEnv, AiReviewQueueEnv, PrivacyExportEnv {
  ASSETS: AssetFetcher;
  MIMO_API_KEY?: string;
  MIMO_MODEL?: string;
  PUBLIC_DISCUSSIONS_ENABLED?: string;
  RELEASE_MAINTENANCE_MODE?: string;
  SECURITY_EXERCISE_ID?: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const logContext = await requestLogContext(request, env);
    return runWithLogContext(logContext, async () => {
      const started = performance.now();
      let response: Response;
      try {
        response = await handleFetchRequest(request, env, ctx);
      } catch (error) {
        logEvent("error", "http.request.exception", safeErrorFields(error));
        response = internalErrorResponse(request);
      }
      const hardened = attachRequestId(hardenResponse(response, request), logContext.requestId);
      logRequestCompleted(hardened, performance.now() - started);
      return hardened;
    });
  },

  async scheduled(_controller: unknown, env: Env, ctx: ExecutionContext) {
    if (releaseMaintenanceEnabled(env)) return;
    ctx.waitUntil(observeScheduledTask(env, "trip_review_backlog", () => dispatchAiReviewBacklog(env, sites)));
    ctx.waitUntil(observeScheduledTask(env, "privacy_export_backlog", () => dispatchPrivacyExportBacklog(env)));
    ctx.waitUntil(observeScheduledTask(env, "auth_data_cleanup", () => cleanupAuthData(env)));
  },

  async queue(batch: QueueBatchLike, env: Env) {
    const aiReviewMessages: QueueMessageLike[] = [];
    const privacyExportMessages: QueueMessageLike[] = [];
    for (const message of batch.messages) {
      const version = message.body && typeof message.body === "object" && !Array.isArray(message.body)
        ? (message.body as { version?: unknown }).version
        : null;
      if (version === AI_REVIEW_QUEUE_MESSAGE_VERSION) aiReviewMessages.push(message);
      else if (version === PRIVACY_EXPORT_QUEUE_MESSAGE_VERSION) privacyExportMessages.push(message);
      else {
        logEvent("warn", "queue.message.rejected", { error_code: "unknown_queue_message_version" });
        message.ack();
      }
    }
    if (aiReviewMessages.length) {
      await observeQueueTask(env, "ai_review_consumer", () => consumeAiReviewQueue({
        queue: batch.queue,
        messages: aiReviewMessages,
      }, env, sites));
    }
    if (privacyExportMessages.length) {
      await observeQueueTask(env, "privacy_export_consumer", () => consumePrivacyExportQueue({
        queue: batch.queue,
        messages: privacyExportMessages,
      }, env));
    }
  },
};

async function handleFetchRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const redirect = canonicalRedirect(request);
  if (redirect) return redirect;

  const maintenance = releaseMaintenanceResponse(request, env);
  if (maintenance) return maintenance;

  const unsupportedApiVersion = unsupportedApiVersionResponse(request);
  if (unsupportedApiVersion) return unsupportedApiVersion;

  const rateLimit = await enforceRequestRateLimit(request, env);
  if (rateLimit) return rateLimit;

  const guarded = await guardRequestBody(request);
  if (guarded.response) return guarded.response;

  const routedRequest = guarded.request;
  return routeRequest(routedRequest, env, ctx);
}

async function routeRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const apiPolicy = apiRoutePolicyForRequest(request);
  if (url.pathname.startsWith("/api/") && !apiPolicy && !isKnownApiPath(url.pathname)) {
    return new Response(JSON.stringify({ error: { code: "not_found", message: "API route not found." } }), {
      status: 404,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  const turnstileConfig = handleTurnstileConfigRequest(request, env);
  if (turnstileConfig) return turnstileConfig;

  const health = await healthResponse(request, env);
  if (health) return health;

  const discussionResponse = await handleDiscussionRequest(request, env, sites);
  if (discussionResponse) return discussionResponse;

  const accountResponse = await handleAccountRequest(request, env, sites, {
    waitUntil: (promise) => ctx.waitUntil(promise),
    onTripUpdated: (trip) => ctx.waitUntil(scheduleTripReview(env, trip.id, sites, { resetForNewInput: true })),
    onTripsReviewRequested: (trips) => {
      for (const trip of trips) {
        ctx.waitUntil(scheduleTripReview(env, trip.id, sites, { expediteRetry: true }));
      }
    },
  });
  if (accountResponse) return accountResponse;

  const protectedTripMutation = apiPolicy?.handler === "trips" && apiPolicy.authorization === "owner";
  const authenticatedUser = protectedTripMutation ? await getAuthenticatedUser(request, env) : null;
  if (protectedTripMutation && !authenticatedUser) {
    return unauthorizedResponse();
  }
  if (protectedTripMutation && !authenticatedUser?.legalAccepted) {
    return legalAcceptanceRequiredResponse(authenticatedUser?.ageEligible ?? false);
  }

  const tripResponse = await handleTripRequest(request, env, sites, {
    accountId: authenticatedUser?.id ?? null,
    onTripCompleted: (trip) => ctx.waitUntil(scheduleTripReview(env, trip.id, sites)),
  });
  if (tripResponse) return tripResponse;

  if (url.pathname === "/_vinext/image") {
    const images = env.IMAGES;
    if (!images) return new Response("Image optimization is unavailable.", { status: 404 });
    const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
    return handleImageOptimization(request, {
      fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
      transformImage: async (body, { width, format, quality }) => {
        const result = await images.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
        return result.response();
      },
    }, allowedWidths);
  }

  return normalizeNotFoundDocument(await handler.fetch(request, env, ctx));
}

export default worker;
