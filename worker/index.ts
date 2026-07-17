/** Cloudflare Worker entry point for the CastingCompass PWA. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import sites from "../public/data/sites.json";
import { handleTripRequest, type TripApiEnv } from "./trips";
import { cleanupAuthData, getAuthenticatedUser, handleAccountRequest, legalAcceptanceRequiredResponse, unauthorizedResponse } from "./auth";
import { reviewTripBacklog, reviewTripWithMimo } from "./trip-review";
import { handleDiscussionRequest } from "./discussions";
import {
  canonicalRedirect,
  guardRequestBody,
  hardenResponse,
  healthResponse,
  releaseMaintenanceEnabled,
  releaseMaintenanceResponse,
} from "./security";
import { handleTurnstileConfigRequest, type TurnstileEnv } from "./turnstile";

interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

interface Env extends TripApiEnv, TurnstileEnv {
  ASSETS: AssetFetcher;
  MIMO_API_KEY?: string;
  MIMO_MODEL?: string;
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
    const redirect = canonicalRedirect(request);
    if (redirect) return hardenResponse(redirect, request);

    const maintenance = releaseMaintenanceResponse(request, env);
    if (maintenance) return hardenResponse(maintenance, request);

    const guarded = await guardRequestBody(request);
    if (guarded.response) return hardenResponse(guarded.response, request);

    const routedRequest = guarded.request;
    const response = await routeRequest(routedRequest, env, ctx);
    return hardenResponse(response, routedRequest);
  },

  async scheduled(_controller: unknown, env: Env, ctx: ExecutionContext) {
    if (releaseMaintenanceEnabled(env)) return;
    ctx.waitUntil(reviewTripBacklog(env, sites));
    ctx.waitUntil(cleanupAuthData(env));
  },
};

async function routeRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  const turnstileConfig = handleTurnstileConfigRequest(request, env);
  if (turnstileConfig) return turnstileConfig;

  const health = await healthResponse(request, env);
  if (health) return health;

  const discussionResponse = await handleDiscussionRequest(request, env, sites);
  if (discussionResponse) return discussionResponse;

  const accountResponse = await handleAccountRequest(request, env, sites, {
    onTripUpdated: (trip) => ctx.waitUntil(reviewTripWithMimo(env, trip.id, sites)),
    onTripsReviewRequested: (trips) => {
      for (const trip of trips) ctx.waitUntil(reviewTripWithMimo(env, trip.id, sites));
    },
  });
  if (accountResponse) return accountResponse;

  const protectedTripMutation = url.pathname.startsWith("/api/trips/") &&
    url.pathname !== "/api/trips/summary" && request.method !== "GET";
  const authenticatedUser = protectedTripMutation ? await getAuthenticatedUser(request, env) : null;
  if (protectedTripMutation && !authenticatedUser) {
    return unauthorizedResponse();
  }
  if (protectedTripMutation && !authenticatedUser?.legalAccepted) {
    return legalAcceptanceRequiredResponse(authenticatedUser?.ageEligible ?? false);
  }

  const tripResponse = await handleTripRequest(request, env, sites, {
    accountId: authenticatedUser?.id ?? null,
    onTripCompleted: (trip) => ctx.waitUntil(reviewTripWithMimo(env, trip.id, sites)),
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

  return handler.fetch(request, env, ctx);
}

export default worker;
