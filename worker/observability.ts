import { AsyncLocalStorage } from "node:async_hooks";

export interface ObservabilityEnv {
  CF_VERSION_METADATA?: { id?: string };
  LOG_LEVEL?: string;
  OBSERVABILITY_PSEUDONYM_SECRET?: string;
}

type LogLevel = "debug" | "info" | "warn" | "error";
type LogValue = string | number | boolean | null | readonly string[] | undefined;
type LogFields = Record<string, LogValue>;

export interface RequestLogContext {
  requestId: string;
  traceId: string | null;
  actorSessionKey: string | null;
  workerVersionId: string | null;
  environment: "development" | "preview" | "production" | "unknown";
  method: string;
  route: string;
  minimumLevel: LogLevel;
}

interface OperationLogContext {
  operationId: string;
  workerVersionId: string | null;
  environment: "scheduled" | "queue";
  minimumLevel: LogLevel;
}

type LogContext = RequestLogContext | OperationLogContext;

const SERVICE = "castingcompass-web";
const SCHEMA_VERSION = "castingcompass.log/1.0.0";
const LEVEL_PRIORITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SAFE_FIELD_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9_.:-]{1,128}$/;
const SAFE_LOG_STRING = /^[A-Za-z0-9_.:/-]{1,160}$/;
const FORBIDDEN_FIELD_NAME = /(^|_)(account_id|actor|authorization|body|cookie|coordinates|email|ip_address|latitude|longitude|note|object_key|password|passphrase|payload|photo_key|prompt|secret|site_id|token|trip_id|user_id)(_|$)/;
const RESERVED_FIELD_NAMES = new Set([
  "actor_session_key",
  "environment",
  "event",
  "level",
  "method",
  "operation_id",
  "request_id",
  "route",
  "schema_version",
  "service",
  "timestamp",
  "trace_id",
  "worker_version_id",
]);
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/g;
const SESSION_COOKIE_NAMES = ["__Host-cc_session", "cc_session"];
const EXACT_ROUTES = new Set([
  "/api/auth/challenge/resend",
  "/api/auth/eligibility",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/password/request",
  "/api/auth/password/reset",
  "/api/auth/session",
  "/api/auth/signup",
  "/api/auth/signup/eligibility",
  "/api/auth/signup/request",
  "/api/auth/signup/verify",
  "/api/auth/turnstile-config",
  "/api/gear-profiles",
  "/api/health",
  "/api/privacy/deletion-status",
  "/api/profile",
  "/api/profile/export",
  "/api/profile/reviews/retry",
  "/api/saved-sites",
  "/api/trips/report",
  "/api/trips/start",
  "/api/trips/summary",
  "/ai-disclosure",
  "/privacy",
  "/profile",
  "/terms",
  "/",
]);

const storage = new AsyncLocalStorage<LogContext>();

export async function requestLogContext(
  request: Request,
  env: ObservabilityEnv = {},
): Promise<RequestLogContext> {
  const url = new URL(request.url);
  const sessionToken = presentedSessionToken(request.headers.get("Cookie"));
  const secret = validPseudonymSecret(env.OBSERVABILITY_PSEUDONYM_SECRET);
  return {
    requestId: crypto.randomUUID(),
    traceId: safeTraceIdentifier(request.headers.get("CF-Ray")),
    actorSessionKey: sessionToken && secret
      ? await hmacSha256(secret, `castingcompass.observability/session/1\u0000${sessionToken}`)
      : null,
    workerVersionId: safeIdentifier(env.CF_VERSION_METADATA?.id),
    environment: environmentForUrl(url),
    method: safeMethod(request.method),
    route: routeTemplate(url.pathname),
    minimumLevel: configuredLogLevel(env.LOG_LEVEL),
  };
}

export function runWithLogContext<T>(context: LogContext, callback: () => T): T {
  return storage.run(context, callback);
}

export function attachRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Request-ID", requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function logRequestCompleted(response: Response, durationMilliseconds: number): void {
  const context = storage.getStore();
  if (!context || !("requestId" in context)) return;
  const level = response.status >= 500
    ? "error"
    : response.status === 429
      ? "warn"
      : isAssetRoute(context.route)
        ? "debug"
        : "info";
  logEvent(level, "http.request.completed", {
    status: response.status,
    duration_ms: Math.max(0, Math.round(durationMilliseconds * 100) / 100),
    outcome: response.status >= 500 ? "server_error" : response.status >= 400 ? "client_error" : "ok",
  });
}

export function logEvent(level: LogLevel, event: string, fields: LogFields = {}): void {
  const context = storage.getStore();
  const minimumLevel = context?.minimumLevel ?? "info";
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minimumLevel]) return;

  const entry: Record<string, string | number | boolean | null | readonly string[]> = {
    schema_version: SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    service: SERVICE,
    level,
    event: /^[a-z][a-z0-9_.]{0,95}$/.test(event) ? event : "observability.invalid_event",
  };
  if (context) addContext(entry, context);
  for (const [key, value] of Object.entries(fields)) {
    if (!SAFE_FIELD_NAME.test(key) || FORBIDDEN_FIELD_NAME.test(key) || RESERVED_FIELD_NAMES.has(key)) continue;
    const sanitized = safeLogValue(value);
    if (sanitized !== undefined) entry[key] = sanitized;
  }

  if (level === "error") console.error(entry);
  else if (level === "warn") console.warn(entry);
  else console.log(entry);
}

export function safeErrorFields(error: unknown, code = "internal_error"): LogFields {
  return {
    error_name: safeIdentifier(error instanceof Error ? error.name : null) ?? "UnknownError",
    error_code: safeIdentifier(code) ?? "internal_error",
  };
}

export function internalErrorResponse(request: Request): Response {
  if (new URL(request.url).pathname.startsWith("/api/")) {
    return new Response(JSON.stringify({
      error: { code: "internal_error", message: "The request could not be completed." },
    }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  return new Response("CastingCompass could not load this page right now.", {
    status: 500,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export function observeScheduledTask(
  env: ObservabilityEnv,
  task: string,
  callback: () => Promise<unknown>,
): Promise<void> {
  const context: OperationLogContext = {
    operationId: crypto.randomUUID(),
    workerVersionId: safeIdentifier(env.CF_VERSION_METADATA?.id),
    environment: "scheduled",
    minimumLevel: configuredLogLevel(env.LOG_LEVEL),
  };
  return runWithLogContext(context, async () => {
    const started = performance.now();
    logEvent("info", "scheduled.task.started", { task });
    try {
      await callback();
      logEvent("info", "scheduled.task.completed", {
        task,
        duration_ms: Math.max(0, Math.round((performance.now() - started) * 100) / 100),
      });
    } catch (error) {
      logEvent("error", "scheduled.task.failed", {
        task,
        duration_ms: Math.max(0, Math.round((performance.now() - started) * 100) / 100),
        ...safeErrorFields(error, "scheduled_task_failed"),
      });
    }
  });
}

export function observeQueueTask(
  env: ObservabilityEnv,
  task: string,
  callback: () => Promise<unknown>,
): Promise<void> {
  const context: OperationLogContext = {
    operationId: crypto.randomUUID(),
    workerVersionId: safeIdentifier(env.CF_VERSION_METADATA?.id),
    environment: "queue",
    minimumLevel: configuredLogLevel(env.LOG_LEVEL),
  };
  return runWithLogContext(context, async () => {
    const started = performance.now();
    logEvent("info", "queue.task.started", { task });
    try {
      await callback();
      logEvent("info", "queue.task.completed", {
        task,
        duration_ms: Math.max(0, Math.round((performance.now() - started) * 100) / 100),
      });
    } catch (error) {
      logEvent("error", "queue.task.failed", {
        task,
        duration_ms: Math.max(0, Math.round((performance.now() - started) * 100) / 100),
        ...safeErrorFields(error, "queue_task_failed"),
      });
      throw error;
    }
  });
}

export function routeTemplate(pathname: string): string {
  if (EXACT_ROUTES.has(pathname)) return pathname;
  if (/^\/api\/discussions\/[a-z0-9-]+$/.test(pathname)) return "/api/discussions/:site_id";
  if (/^\/api\/gear-profiles\/gear_[a-f0-9-]{36}$/.test(pathname)) return "/api/gear-profiles/:gear_id";
  if (/^\/api\/profile\/exports\/pexj_[a-f0-9]{32}\/download$/.test(pathname)) {
    return "/api/profile/exports/:job_id/download";
  }
  if (/^\/api\/profile\/exports\/pexj_[a-f0-9]{32}$/.test(pathname)) {
    return "/api/profile/exports/:job_id";
  }
  if (/^\/api\/profile\/export\/photos\/trip_[a-f0-9-]{36}$/.test(pathname)) {
    return "/api/profile/export/photos/:trip_id";
  }
  if (/^\/api\/profile\/trips\/trip_[a-f0-9-]{36}$/.test(pathname)) return "/api/profile/trips/:trip_id";
  if (/^\/api\/saved-sites\/[a-z0-9-]+$/.test(pathname)) return "/api/saved-sites/:site_id";
  if (/^\/api\/trips\/[^/]+\/cancel$/.test(pathname)) return "/api/trips/:trip_id/cancel";
  if (/^\/api\/trips\/[^/]+\/complete$/.test(pathname)) return "/api/trips/:trip_id/complete";
  if (pathname === "/_vinext/image") return "/_vinext/image";
  if (pathname.startsWith("/_next/") || pathname.startsWith("/assets/")) return "/:asset";
  if (pathname === "/manifest.webmanifest" || pathname === "/sw.js" || pathname.startsWith("/icons/")) {
    return "/:pwa_asset";
  }
  if (pathname === "/data/sites.json" || pathname === "/data/opportunities.json" ||
      pathname === "/data/community-pulse.json") return pathname;
  return pathname.startsWith("/api/") ? "/api/:unknown" : "/:unknown";
}

function addContext(
  entry: Record<string, string | number | boolean | null | readonly string[]>,
  context: LogContext,
) {
  entry.environment = context.environment;
  entry.worker_version_id = context.workerVersionId;
  if ("requestId" in context) {
    entry.request_id = context.requestId;
    entry.trace_id = context.traceId;
    entry.actor_session_key = context.actorSessionKey;
    entry.method = context.method;
    entry.route = context.route;
  } else {
    entry.operation_id = context.operationId;
  }
}

function safeLogValue(value: LogValue): string | number | boolean | null | readonly string[] | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const sanitized = value.replace(CONTROL_CHARACTERS, "?").slice(0, 160);
    return SAFE_LOG_STRING.test(sanitized) ? sanitized : undefined;
  }
  if (Array.isArray(value)) {
    const sanitized = value.slice(0, 16)
      .map((item) => item.replace(CONTROL_CHARACTERS, "?").slice(0, 80))
      .filter((item) => SAFE_LOG_STRING.test(item));
    return sanitized.length > 0 ? sanitized : undefined;
  }
  return undefined;
}

function safeIdentifier(value: unknown): string | null {
  return typeof value === "string" && SAFE_IDENTIFIER.test(value) ? value : null;
}

function safeTraceIdentifier(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{16,32}(?:-[A-Za-z]{3})?$/.test(value)
    ? value
    : null;
}

function configuredLogLevel(value: unknown): LogLevel {
  return value === "debug" || value === "warn" || value === "error" ? value : "info";
}

function environmentForUrl(url: URL): RequestLogContext["environment"] {
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]") {
    return "development";
  }
  if (url.hostname.endsWith(".workers.dev")) return "preview";
  if (url.protocol === "https:" && (
    url.hostname === "castingcompass.com" ||
    url.hostname === "www.castingcompass.com" ||
    url.hostname === "castcompass.brianbzeng.com" ||
    url.hostname === "contourcast.brianbzeng.com"
  )) return "production";
  return "unknown";
}

function safeMethod(value: string): string {
  return /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(value) ? value : "OTHER";
}

function isAssetRoute(route: string): boolean {
  return route === "/:asset" || route === "/:pwa_asset";
}

function validPseudonymSecret(value: unknown): string | null {
  return typeof value === "string" && value.length >= 32 && value.length <= 256 ? value : null;
}

function presentedSessionToken(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const cookies = new Map<string, string>();
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    cookies.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  for (const name of SESSION_COOKIE_NAMES) {
    const token = cookies.get(name);
    if (token && /^[A-Za-z0-9_-]{40,160}$/.test(token)) return token;
  }
  return null;
}

async function hmacSha256(secret: string, value: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
