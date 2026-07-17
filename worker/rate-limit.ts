interface RateLimitResult {
  success: boolean;
}

export interface RateLimiterBinding {
  limit(options: { key: string }): Promise<RateLimitResult>;
}

export interface RateLimitEnv {
  RATE_LIMITING_ENABLED?: string;
  RATE_LIMIT_KEY_SECRET?: string;
  AUTH_RATE_LIMITER?: RateLimiterBinding;
  EMAIL_RATE_LIMITER?: RateLimiterBinding;
  WRITE_RATE_LIMITER?: RateLimiterBinding;
  SENSITIVE_RATE_LIMITER?: RateLimiterBinding;
  READ_RATE_LIMITER?: RateLimiterBinding;
  AI_PROVIDER_RATE_LIMITER?: RateLimiterBinding;
}

type RequestLimitClass = "auth" | "email" | "write" | "sensitive" | "read";

const API_PREFIX = "/api/";
const RATE_LIMIT_WINDOW_SECONDS = 60;
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const AUTH_ABUSE_PATHS = new Set([
  "/api/auth/signup/eligibility",
  "/api/auth/signup/request",
  "/api/auth/signup/verify",
  "/api/auth/challenge/resend",
  "/api/auth/password/request",
  "/api/auth/password/reset",
  "/api/auth/login",
]);
const EMAIL_PRODUCING_PATHS = new Set([
  "/api/auth/signup/request",
  "/api/auth/signup/verify",
  "/api/auth/challenge/resend",
  "/api/auth/password/request",
]);

export async function enforceRequestRateLimit(request: Request, env: RateLimitEnv): Promise<Response | null> {
  const classes = requestLimitClasses(request);
  if (classes.length === 0) return null;

  const mode = rateLimitMode(env);
  if (mode === "disabled") return null;
  if (mode === "invalid") return unavailableResponse();

  const secret = env.RATE_LIMIT_KEY_SECRET;
  const clientAddress = safeClientAddress(request.headers.get("CF-Connecting-IP"));
  if (!secret || secret.length < 32 || secret.length > 256 || !clientAddress) return unavailableResponse();

  const bindings = classes.map((limitClass) => bindingForClass(env, limitClass));
  if (bindings.some((binding) => !binding)) return unavailableResponse();

  try {
    // The raw network address is never stored, logged, or passed as the
    // counter key. The deployment secret also separates these pseudonyms from
    // every other hash domain in the application.
    const actorKey = await hmacSha256(secret, `castingcompass.rate-limit/1\u0000${clientAddress}`);
    const results = await Promise.all(bindings.map((binding) => binding!.limit({ key: actorKey })));
    if (results.some((result) => result.success !== true)) return rateLimitedResponse();
    return null;
  } catch {
    console.error("Request rate limiter unavailable", { classes });
    return unavailableResponse();
  }
}

export async function aiProviderRateLimitAllowed(env: RateLimitEnv) {
  const mode = rateLimitMode(env);
  if (mode === "disabled") return true;
  if (mode === "invalid" || !env.AI_PROVIDER_RATE_LIMITER) {
    console.error("AI provider rate limiter configuration rejected", {
      code: "rate_limiter_configuration_invalid",
    });
    return false;
  }
  try {
    const result = await env.AI_PROVIDER_RATE_LIMITER.limit({ key: "castingcompass.ai-review/1" });
    if (result.success !== true) {
      console.warn("AI provider rate limit reached", { code: "ai_provider_rate_limited" });
      return false;
    }
    return true;
  } catch {
    console.error("AI provider rate limiter unavailable", { code: "rate_limiter_unavailable" });
    return false;
  }
}

export function requestLimitClasses(request: Request): RequestLimitClass[] {
  const url = new URL(request.url);
  const classes = new Set<RequestLimitClass>();
  if (!url.pathname.startsWith(API_PREFIX) || url.pathname === "/api/health") return [];

  if (request.method === "GET" || request.method === "HEAD") classes.add("read");
  if (request.method === "POST" && AUTH_ABUSE_PATHS.has(url.pathname)) classes.add("auth");
  if (request.method === "POST" && EMAIL_PRODUCING_PATHS.has(url.pathname)) classes.add("email");
  if (isSensitiveOperation(request, url.pathname)) classes.add("sensitive");
  if (MUTATION_METHODS.has(request.method) && !AUTH_ABUSE_PATHS.has(url.pathname)) classes.add("write");
  return [...classes];
}

function isSensitiveOperation(request: Request, pathname: string) {
  if (request.method === "GET" && pathname === "/api/profile/export") return true;
  if (request.method === "GET" && /^\/api\/profile\/export\/photos\/trip_[a-f0-9-]{36}$/.test(pathname)) {
    return true;
  }
  if (request.method === "POST" && pathname === "/api/profile/reviews/retry") return true;
  if (request.method === "DELETE" && pathname === "/api/profile") return true;
  return request.method === "DELETE" && /^\/api\/profile\/trips\/trip_[a-f0-9-]{36}$/.test(pathname);
}

function rateLimitMode(env: RateLimitEnv) {
  if (env.RATE_LIMITING_ENABLED === undefined || env.RATE_LIMITING_ENABLED === "false") return "disabled" as const;
  return env.RATE_LIMITING_ENABLED === "true" ? "enabled" as const : "invalid" as const;
}

function bindingForClass(env: RateLimitEnv, limitClass: RequestLimitClass) {
  if (limitClass === "auth") return env.AUTH_RATE_LIMITER;
  if (limitClass === "email") return env.EMAIL_RATE_LIMITER;
  if (limitClass === "write") return env.WRITE_RATE_LIMITER;
  if (limitClass === "sensitive") return env.SENSITIVE_RATE_LIMITER;
  return env.READ_RATE_LIMITER;
}

function safeClientAddress(value: string | null) {
  const address = value?.trim().toLowerCase() ?? "";
  if (address.length < 2 || address.length > 64 || !/^[0-9a-f:.]+$/.test(address)) return null;
  if (address.includes(":")) {
    try {
      const hostname = new URL(`http://[${address}]/`).hostname;
      return hostname.startsWith("[") && hostname.endsWith("]")
        ? hostname.slice(1, -1).toLowerCase()
        : null;
    } catch {
      return null;
    }
  }
  const octets = address.split(".");
  if (octets.length !== 4 || octets.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return octets.map((part) => String(Number(part))).join(".");
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

function rateLimitedResponse() {
  return jsonError(
    429,
    "rate_limited",
    "Too many requests were received. Try again shortly.",
    { "Retry-After": String(RATE_LIMIT_WINDOW_SECONDS) },
  );
}

function unavailableResponse() {
  return jsonError(
    503,
    "security_control_unavailable",
    "A required abuse-prevention control is temporarily unavailable. Try again shortly.",
    { "Retry-After": String(RATE_LIMIT_WINDOW_SECONDS) },
  );
}

function jsonError(status: number, code: string, message: string, extraHeaders?: HeadersInit) {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}
