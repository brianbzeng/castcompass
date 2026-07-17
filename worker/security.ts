import type { D1DatabaseLike } from "./trips";

interface SecurityEnv {
  DB?: D1DatabaseLike;
  CF_VERSION_METADATA?: { id?: string };
  RELEASE_MAINTENANCE_MODE?: string;
}

export const API_MUTATION_BODY_LIMIT = 64 * 1024;
export const TRIP_MULTIPART_BODY_LIMIT = 6 * 1024 * 1024;

const CANONICAL_HOST = "castingcompass.com";
const CANONICAL_ALIASES = new Set([
  "www.castingcompass.com",
  "castcompass.brianbzeng.com",
  "contourcast.brianbzeng.com",
]);
const PRODUCTION_HOSTS = new Set([CANONICAL_HOST, ...CANONICAL_ALIASES]);
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type GuardedRequest =
  | { request: Request; response: null }
  | { request: null; response: Response };

/**
 * Return a same-path permanent redirect for known production aliases and for
 * cleartext requests to the canonical hostname. Unknown hosts (including the
 * workers.dev preview hostname) are deliberately left alone.
 */
export function canonicalRedirect(request: Request): Response | null {
  const url = new URL(request.url);
  const isAlias = CANONICAL_ALIASES.has(url.hostname);
  const isCleartextCanonical = url.hostname === CANONICAL_HOST && url.protocol !== "https:";
  if (!isAlias && !isCleartextCanonical) return null;

  url.protocol = "https:";
  url.hostname = CANONICAL_HOST;
  url.port = "";
  return new Response(null, {
    status: 308,
    headers: {
      Location: url.toString(),
      "Cache-Control": "public, max-age=3600",
    },
  });
}

/** A lightweight readiness check that verifies both the Worker and D1 binding. */
export async function healthResponse(request: Request, env: SecurityEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/health") return null;

  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonError(
      405,
      "method_not_allowed",
      "Use GET or HEAD for this endpoint.",
      { Allow: "GET, HEAD" },
    );
  }

  let databaseAvailable = false;
  try {
    const result = await env.DB?.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    databaseAvailable = result?.ok === 1;
  } catch {
    databaseAvailable = false;
  }

  const status = databaseAvailable ? 200 : 503;
  const workerVersionId = safeWorkerVersionId(env.CF_VERSION_METADATA?.id);
  const body = JSON.stringify({
    status: databaseAvailable ? "ok" : "degraded",
    service: "castingcompass-web",
    workerVersionId,
    releaseMaintenance: releaseMaintenanceEnabled(env),
  });
  return new Response(request.method === "HEAD" ? null : body, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/**
 * During a schema bridge, keep static guidance available but stop every API
 * handler before it can read or write a version-dependent table. Missing is
 * normal for historical Workers; any configured value other than exact
 * "false" fails safe into maintenance.
 */
export function releaseMaintenanceEnabled(env?: SecurityEnv): boolean {
  return env?.RELEASE_MAINTENANCE_MODE !== undefined && env.RELEASE_MAINTENANCE_MODE !== "false";
}

export function releaseMaintenanceResponse(request: Request, env?: SecurityEnv): Response | null {
  const url = new URL(request.url);
  if (!releaseMaintenanceEnabled(env) || !url.pathname.startsWith("/api/") || url.pathname === "/api/health") {
    return null;
  }
  return jsonError(
    503,
    "release_maintenance",
    "CastingCompass is briefly read-only while a database release completes. Please retry shortly.",
    { "Retry-After": "300" },
  );
}

function safeWorkerVersionId(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9-]{1,128}$/.test(value) ? value : null;
}

/**
 * Enforce mutation limits against the bytes actually received, rather than
 * trusting Content-Length. The consumed body is rebuilt for the route handler.
 */
export async function guardRequestBody(request: Request): Promise<GuardedRequest> {
  const maximumBytes = bodyLimitForRequest(request);
  if (maximumBytes === null || request.body === null) {
    return { request, response: null };
  }

  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength && /^\d+$/.test(declaredLength)) {
    const parsedLength = Number(declaredLength);
    if (Number.isSafeInteger(parsedLength) && parsedLength > maximumBytes) {
      return { request: null, response: payloadTooLarge() };
    }
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maximumBytes) {
        await reader.cancel("request body exceeds configured limit");
        return { request: null, response: payloadTooLarge() };
      }
      chunks.push(value);
    }
  } catch {
    return {
      request: null,
      response: jsonError(400, "invalid_body", "The request body could not be read."),
    };
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const headers = new Headers(request.headers);
  // The incoming value is no longer authoritative after rebuilding the body.
  headers.delete("Content-Length");
  return {
    request: new Request(request, { body: body.buffer, headers }),
    response: null,
  };
}

export function bodyLimitForRequest(request: Request): number | null {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/") || !MUTATION_METHODS.has(request.method)) return null;
  if (
    url.pathname === "/api/trips/report" ||
    /^\/api\/trips\/[^/]+\/complete$/.test(url.pathname)
  ) {
    return TRIP_MULTIPART_BODY_LIMIT;
  }
  return API_MUTATION_BODY_LIMIT;
}

/** Add security headers and a fail-safe no-store policy to sensitive responses. */
export function hardenResponse(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  const url = new URL(request.url);
  const isApi = url.pathname.startsWith("/api/");
  const isPreviewHost = url.hostname.endsWith(".workers.dev");
  const isProductionHttps = url.protocol === "https:" && (
    PRODUCTION_HOSTS.has(url.hostname) || isPreviewHost
  );

  if (!headers.has("Content-Security-Policy")) {
    headers.set("Content-Security-Policy", "base-uri 'self'; object-src 'none'; frame-ancestors 'none'");
  }
  headers.set("Permissions-Policy", "camera=(), microphone=(), payment=(), usb=(), geolocation=(self)");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Permitted-Cross-Domain-Policies", "none");
  if (isProductionHttps) headers.set("Strict-Transport-Security", "max-age=31536000");

  if (isApi || isPreviewHost) headers.set("X-Robots-Tag", "noindex, nofollow");
  if (isApi || headers.has("Set-Cookie") || response.status >= 400) {
    headers.set("Cache-Control", "no-store");
    headers.set("CDN-Cache-Control", "no-store");
  } else if (response.status >= 300 && response.status < 400 && !headers.has("Cache-Control")) {
    headers.set("Cache-Control", "no-store");
    headers.set("CDN-Cache-Control", "no-store");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function payloadTooLarge() {
  return jsonError(413, "payload_too_large", "This request is larger than the service accepts.");
}

function jsonError(status: number, code: string, message: string, extraHeaders?: HeadersInit) {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers });
}
