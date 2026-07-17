const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const TURNSTILE_SITEVERIFY_TIMEOUT_MS = 5_000;

export const TURNSTILE_ACTIONS = {
  signupEligibility: "signup_eligibility",
  signupRequest: "signup_request",
  signupVerify: "signup_verify",
  challengeResend: "challenge_resend",
  passwordRequest: "password_request",
  passwordReset: "password_reset",
  login: "login",
} as const;

export type TurnstileAction = typeof TURNSTILE_ACTIONS[keyof typeof TURNSTILE_ACTIONS];

export interface TurnstileEnv {
  TURNSTILE_ENABLED?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_ALLOWED_HOSTNAMES?: string;
}

type TurnstileConfig =
  | { mode: "disabled" }
  | { mode: "enabled"; siteKey: string; secretKey: string; allowedHostnames: ReadonlySet<string> }
  | { mode: "invalid" };

export class TurnstileVerificationError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "TurnstileVerificationError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Runtime-only public configuration for the account challenge. This route is
 * intentionally independent of D1 so the client can render (or truthfully
 * disable) protected account actions even during a database outage.
 */
export function handleTurnstileConfigRequest(request: Request, env: TurnstileEnv = {}): Response | null {
  const url = new URL(request.url);
  if (url.pathname !== "/api/auth/turnstile-config") return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse(
      { error: { code: "method_not_allowed", message: "Use GET or HEAD for this endpoint." } },
      405,
      request.method === "HEAD",
      { Allow: "GET, HEAD" },
    );
  }

  const config = readTurnstileConfig(env);
  if (config.mode === "disabled") {
    return jsonResponse({ turnstile: { enabled: false } }, 200, request.method === "HEAD");
  }
  if (config.mode === "invalid") {
    return jsonResponse({
      turnstile: { enabled: true, available: false },
      error: {
        code: "security_verification_unavailable",
        message: "Security verification is temporarily unavailable.",
      },
    }, 503, request.method === "HEAD");
  }
  return jsonResponse({
    turnstile: { enabled: true, available: true, siteKey: config.siteKey },
  }, 200, request.method === "HEAD");
}

/**
 * Validate a single action-bound token. The request intentionally contains no
 * visitor IP, account identifier, email, birth date, password, or custom data.
 * Siteverify owns expiry and single-use enforcement; this code never caches or
 * retries a token.
 */
export async function verifyTurnstileChallenge(
  env: TurnstileEnv,
  body: Record<string, unknown>,
  expectedAction: TurnstileAction,
): Promise<void> {
  const config = readTurnstileConfig(env);
  if (config.mode === "disabled") return;
  if (config.mode === "invalid") throw unavailableError();

  const token = body.turnstileToken;
  if (typeof token !== "string" || token.length < 1 || token.length > 2_048 || token !== token.trim()) {
    throw new TurnstileVerificationError(
      422,
      "security_verification_required",
      "Complete the security verification and try again.",
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TURNSTILE_SITEVERIFY_TIMEOUT_MS);
  let result: Record<string, unknown>;
  try {
    const parameters = new URLSearchParams({
      secret: config.secretKey,
      response: token,
      idempotency_key: crypto.randomUUID(),
    });
    const response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: parameters,
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw unavailableError();
    }
    const value = await response.json();
    if (!isRecord(value) || typeof value.success !== "boolean") throw new Error("invalid Siteverify response");
    result = value;
  } catch (error) {
    if (error instanceof TurnstileVerificationError) throw error;
    throw unavailableError();
  } finally {
    // Keep the same hard deadline through headers, body consumption, and JSON
    // parsing. A provider that sends headers and stalls the body must not hold
    // an account request open indefinitely.
    clearTimeout(timeout);
  }

  if (result.success !== true) {
    const errorCodes = Array.isArray(result["error-codes"])
      ? result["error-codes"].filter((value): value is string => typeof value === "string")
      : [];
    if (errorCodes.some((code) =>
      code === "missing-input-secret" || code === "invalid-input-secret" ||
      code === "missing-input-response" || code === "bad-request" || code === "internal-error")) {
      throw unavailableError();
    }
    throw challengeFailedError();
  }

  if (result.action !== expectedAction ||
    typeof result.hostname !== "string" ||
    !config.allowedHostnames.has(result.hostname)) {
    throw challengeFailedError();
  }
}

function readTurnstileConfig(env: TurnstileEnv): TurnstileConfig {
  const mode = env.TURNSTILE_ENABLED?.trim() ?? "";
  if (mode === "" || mode === "false") return { mode: "disabled" };
  if (mode !== "true") return { mode: "invalid" };

  const siteKey = env.TURNSTILE_SITE_KEY?.trim() ?? "";
  const secretKey = env.TURNSTILE_SECRET_KEY?.trim() ?? "";
  const allowedHostnames = parseAllowedHostnames(env.TURNSTILE_ALLOWED_HOSTNAMES);
  if (!isKeyLike(siteKey) || !isKeyLike(secretKey) || !allowedHostnames) return { mode: "invalid" };
  return { mode: "enabled", siteKey, secretKey, allowedHostnames };
}

function parseAllowedHostnames(value: string | undefined): ReadonlySet<string> | null {
  if (!value) return null;
  const hostnames = value.split(",").map((hostname) => hostname.trim());
  if (hostnames.length < 1 || hostnames.length > 20 || hostnames.some((hostname) => !isHostname(hostname))) {
    return null;
  }
  return new Set(hostnames);
}

function isHostname(value: string) {
  if (value.length < 1 || value.length > 253 || value !== value.toLowerCase() ||
    value.startsWith(".") || value.endsWith(".") || value.includes("..")) return false;
  return value.split(".").every((label) =>
    label.length >= 1 && label.length <= 63 &&
    /^[a-z0-9-]+$/.test(label) && !label.startsWith("-") && !label.endsWith("-"));
}

function isKeyLike(value: string) {
  return value.length >= 8 && value.length <= 256 && /^[A-Za-z0-9_-]+$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unavailableError() {
  return new TurnstileVerificationError(
    503,
    "security_verification_unavailable",
    "Security verification is temporarily unavailable. Try again shortly.",
  );
}

function challengeFailedError() {
  return new TurnstileVerificationError(
    400,
    "security_verification_failed",
    "Security verification was not accepted. Complete a fresh challenge and try again.",
  );
}

function jsonResponse(body: unknown, status: number, head: boolean, extraHeaders?: HeadersInit) {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(head ? null : JSON.stringify(body), { status, headers });
}
