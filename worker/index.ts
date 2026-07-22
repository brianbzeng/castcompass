/** Cloudflare Worker entry point for the CastingCompass PWA. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import sites from "../public/data/sites.json";
import { handleTripRequest, type TripApiEnv } from "./trips";
import {
  authorizeDeletionReceiptRequest,
  authorizeOwnerRequest,
  handleAccountRequest,
  legalAcceptanceRequiredResponse,
  unauthorizedResponse,
  type AuthenticatedSession,
} from "./auth";
import {
  AI_REVIEW_QUEUE_MESSAGE_VERSION,
  consumeAiReviewQueue,
  scheduleTripReview,
  type AiReviewQueueEnv,
  type QueueBatchLike,
  type QueueMessageLike,
} from "./trip-review-queue.ts";
import {
  PRIVACY_EXPORT_QUEUE_MESSAGE_VERSION,
  consumePrivacyExportQueue,
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
import {
  apiRoutePolicyForRequest,
  apiRouteRejectionForRequest,
  type ApiRoutePolicy,
} from "./route-policy";
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
import { runScheduledLane, scheduledLaneFor } from "./scheduled.ts";

interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

interface Env extends TripApiEnv, TurnstileEnv, RateLimitEnv, ObservabilityEnv, AiReviewQueueEnv, PrivacyExportEnv {
  ASSETS: AssetFetcher;
  PUBLIC_DISCUSSIONS_ENABLED?: string;
  RELEASE_MAINTENANCE_MODE?: string;
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

  async scheduled(controller: unknown, env: Env, ctx: ExecutionContext) {
    if (releaseMaintenanceEnabled(env)) return;
    const lane = scheduledLaneFor(controller);
    ctx.waitUntil(observeScheduledTask(env, lane, () => runScheduledLane(lane, env, sites)));
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

  const apiRejection = apiRouteRejectionForRequest(request);
  if (apiRejection) {
    return new Response(JSON.stringify({
      error: { code: apiRejection.code, message: apiRejection.message },
    }), {
      status: apiRejection.status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...(apiRejection.status === 405 && !apiRejection.allowedMethods.includes("*")
          ? { Allow: apiRejection.allowedMethods.join(", ") }
          : {}),
      },
    });
  }

  const apiPolicy = apiRoutePolicyForRequest(request);
  let authenticatedSession: AuthenticatedSession | null = null;
  if (apiPolicy?.authorization === "owner") {
    const ownerAuthorization = await authorizeOwnerRequest(request, env, {
      currentLegalAcceptanceRequired: apiPolicy.currentLegalAcceptanceRequired,
      deletionFenceAccessAllowed: apiPolicy.deletionFenceAccessAllowed,
    });
    if (ownerAuthorization.response) return ownerAuthorization.response;
    authenticatedSession = ownerAuthorization.session;
  }
  if (apiPolicy?.authorization === "receipt") {
    if (apiPolicy.id !== "privacy.deletion_status.read") {
      return routePolicyUnavailableResponse();
    }
    const receiptAuthorization = await authorizeDeletionReceiptRequest(request, env);
    if (receiptAuthorization.response) return receiptAuthorization.response;
  }

  const guarded = await guardRequestBody(request);
  if (guarded.response) return guarded.response;

  const routedRequest = guarded.request;
  return routeRequest(routedRequest, env, ctx, apiPolicy, authenticatedSession);
}

function routePolicyUnavailableResponse(): Response {
  return new Response(JSON.stringify({
    error: {
      code: "route_unavailable",
      message: "This API route is temporarily unavailable.",
    },
  }), {
    status: 503,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function routeRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  apiPolicy: ApiRoutePolicy | null,
  authenticatedSession: AuthenticatedSession | null,
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname.startsWith("/api/")) {
    // The route registry is the sole API dispatcher. A handler that no longer
    // claims its assigned route is policy drift, not permission to fall through
    // to another handler or the static application.
    if (!apiPolicy) return routePolicyUnavailableResponse();

    let apiResponse: Response | null = null;
    switch (apiPolicy.handler) {
      case "turnstile":
        apiResponse = handleTurnstileConfigRequest(request, env);
        break;
      case "health":
        apiResponse = await healthResponse(request, env);
        break;
      case "discussions":
        apiResponse = await handleDiscussionRequest(request, env, sites);
        break;
      case "account":
        apiResponse = await handleAccountRequest(request, env, sites, {
          waitUntil: (promise) => ctx.waitUntil(promise),
          onTripUpdated: (trip) => ctx.waitUntil(
            scheduleTripReview(env, trip.id, sites, { resetForNewInput: true }),
          ),
          onTripReviewRequested: (trip) => ctx.waitUntil(
            scheduleTripReview(env, trip.id, sites, { expediteRetry: true }),
          ),
        });
        break;
      case "trips": {
        const protectedTripMutation = apiPolicy.authorization === "owner";
        let tripSession = authenticatedSession;
        if (protectedTripMutation) {
          const ownerAuthorization = await authorizeOwnerRequest(request, env, {
            currentLegalAcceptanceRequired: apiPolicy.currentLegalAcceptanceRequired,
            deletionFenceAccessAllowed: apiPolicy.deletionFenceAccessAllowed,
          });
          if (ownerAuthorization.response) return ownerAuthorization.response;
          tripSession = ownerAuthorization.session;
        }
        const authenticatedUser = protectedTripMutation ? tripSession?.user ?? null : null;
        if (protectedTripMutation && !authenticatedUser) {
          return unauthorizedResponse();
        }
        if (apiPolicy.currentLegalAcceptanceRequired && !authenticatedUser?.legalAccepted) {
          return legalAcceptanceRequiredResponse(authenticatedUser?.ageEligible ?? false);
        }
        apiResponse = await handleTripRequest(request, env, sites, {
          accountId: authenticatedUser?.id ?? null,
          onTripCompleted: (trip) => ctx.waitUntil(scheduleTripReview(env, trip.id, sites)),
        });
        break;
      }
      default:
        return routePolicyUnavailableResponse();
    }
    return apiResponse ?? routePolicyUnavailableResponse();
  }

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
