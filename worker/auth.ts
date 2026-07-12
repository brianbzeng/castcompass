import type { CuratedSite, D1DatabaseLike } from "./trips";

const SESSION_COOKIE = "cc_session";
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const PASSWORD_ITERATIONS = 210_000;

export interface AuthApiEnv {
  DB?: D1DatabaseLike;
}

export interface AuthUser {
  id: string;
  email: string;
}

const initializedDatabases = new WeakMap<object, Promise<void>>();

class AuthError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "AuthError";
  }
}

const CREATE_USERS_SQL = `CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

const CREATE_SESSIONS_SQL = `CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
)`;

const CREATE_SAVED_SITES_SQL = `CREATE TABLE IF NOT EXISTS saved_sites (
  user_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, site_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
)`;

const CREATE_AUTH_ATTEMPTS_SQL = `CREATE TABLE IF NOT EXISTS auth_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  email_hash TEXT NOT NULL,
  attempted_at TEXT NOT NULL,
  successful INTEGER NOT NULL DEFAULT 0
)`;

async function initialize(db: D1DatabaseLike) {
  let pending = initializedDatabases.get(db as object);
  if (!pending) {
    pending = db.batch([
      db.prepare(CREATE_USERS_SQL),
      db.prepare(CREATE_SESSIONS_SQL),
      db.prepare(CREATE_SAVED_SITES_SQL),
      db.prepare(CREATE_AUTH_ATTEMPTS_SQL),
      db.prepare("CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions (user_id, expires_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS auth_attempts_email_time_idx ON auth_attempts (email_hash, attempted_at)"),
    ]).then(() => undefined).catch((error) => {
      initializedDatabases.delete(db as object);
      throw error;
    });
    initializedDatabases.set(db as object, pending);
  }
  await pending;
}

export async function getAuthenticatedUser(request: Request, env: AuthApiEnv): Promise<AuthUser | null> {
  if (!env.DB) return null;
  await initialize(env.DB);
  const token = parseCookies(request.headers.get("Cookie") ?? "").get(SESSION_COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{40,160}$/.test(token)) return null;
  const tokenHash = await sha256(token);
  const now = new Date().toISOString();
  return env.DB
    .prepare(`SELECT users.id, users.email
      FROM auth_sessions
      JOIN users ON users.id = auth_sessions.user_id
      WHERE auth_sessions.token_hash = ? AND auth_sessions.expires_at > ?
      LIMIT 1`)
    .bind(tokenHash, now)
    .first<AuthUser>();
}

export async function handleAccountRequest(
  request: Request,
  env: AuthApiEnv,
  curatedSites: readonly CuratedSite[],
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/auth") && !url.pathname.startsWith("/api/saved-sites")) return null;
  if (!env.DB) return errorResponse(503, "storage_unavailable", "Account storage is temporarily unavailable.");

  const db = env.DB;
  await initialize(db);

  try {
    if (url.pathname === "/api/auth/session") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      const user = await getAuthenticatedUser(request, env);
      return jsonResponse({ user });
    }

    if (url.pathname === "/api/auth/signup") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      assertSameOrigin(request);
      const body = await readJson(request);
      const email = parseEmail(body.email);
      const password = parsePassword(body.password);
      const existing = await db.prepare("SELECT id FROM users WHERE email = ? LIMIT 1").bind(email).first();
      if (existing) return errorResponse(409, "email_in_use", "An account already uses this email.");

      const salt = randomSecret(18);
      const passwordHash = await hashPassword(password, salt);
      const user: AuthUser = { id: `user_${crypto.randomUUID()}`, email };
      const timestamp = new Date().toISOString();
      await db.prepare(`INSERT INTO users (id, email, password_salt, password_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(user.id, email, salt, passwordHash, timestamp, timestamp)
        .run();
      return createSessionResponse(db, request, user, 201);
    }

    if (url.pathname === "/api/auth/login") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      assertSameOrigin(request);
      const body = await readJson(request);
      const email = parseEmail(body.email);
      const password = parsePassword(body.password);
      const emailHash = await sha256(email);
      const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const recent = await db
        .prepare("SELECT COUNT(*) AS count FROM auth_attempts WHERE email_hash = ? AND successful = 0 AND attempted_at >= ?")
        .bind(emailHash, cutoff)
        .first<{ count: number }>();
      if (Number(recent?.count ?? 0) >= 10) {
        return errorResponse(429, "too_many_attempts", "Too many sign-in attempts. Try again in an hour.");
      }

      const row = await db
        .prepare("SELECT id, email, password_salt, password_hash FROM users WHERE email = ? LIMIT 1")
        .bind(email)
        .first<AuthUser & { password_salt: string; password_hash: string }>();
      const valid = row ? await verifyPassword(password, row.password_salt, row.password_hash) : false;
      await db.prepare("INSERT INTO auth_attempts (id, email_hash, attempted_at, successful) VALUES (?, ?, ?, ?)")
        .bind(`attempt_${crypto.randomUUID()}`, emailHash, new Date().toISOString(), Number(valid))
        .run();
      if (!row || !valid) return errorResponse(401, "invalid_credentials", "Email or password is incorrect.");
      return createSessionResponse(db, request, { id: row.id, email: row.email });
    }

    if (url.pathname === "/api/auth/logout") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      assertSameOrigin(request);
      const token = parseCookies(request.headers.get("Cookie") ?? "").get(SESSION_COOKIE);
      if (token) await db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(await sha256(token)).run();
      return jsonResponse({ user: null }, 200, clearSessionCookie(request));
    }

    const user = await getAuthenticatedUser(request, env);
    if (!user) return unauthorizedResponse();

    if (url.pathname === "/api/saved-sites") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      const rows = await db
        .prepare("SELECT site_id FROM saved_sites WHERE user_id = ? ORDER BY created_at DESC")
        .bind(user.id)
        .all<{ site_id: string }>();
      return jsonResponse({ siteIds: (rows.results ?? []).map((row) => row.site_id) });
    }

    const match = url.pathname.match(/^\/api\/saved-sites\/([a-z0-9-]+)$/);
    if (!match) return errorResponse(404, "not_found", "Account route not found.");
    assertSameOrigin(request);
    const siteId = match[1];
    if (!curatedSites.some((site) => site.id === siteId)) {
      return errorResponse(422, "invalid_site", "Choose a current CastCompass location.");
    }
    if (request.method === "POST") {
      await db.prepare("INSERT OR IGNORE INTO saved_sites (user_id, site_id, created_at) VALUES (?, ?, ?)")
        .bind(user.id, siteId, new Date().toISOString())
        .run();
      return jsonResponse({ saved: true, siteId });
    }
    if (request.method === "DELETE") {
      await db.prepare("DELETE FROM saved_sites WHERE user_id = ? AND site_id = ?")
        .bind(user.id, siteId)
        .run();
      return jsonResponse({ saved: false, siteId });
    }
    return methodNotAllowed("POST, DELETE");
  } catch (error) {
    if (error instanceof AuthError) return errorResponse(error.status, error.code, error.message);
    console.error("Account API request failed", error);
    return errorResponse(500, "internal_error", "The account request could not be completed.");
  }
}

export function unauthorizedResponse() {
  return errorResponse(401, "authentication_required", "Sign in to submit a trip report or save a location.");
}

async function createSessionResponse(db: D1DatabaseLike, request: Request, user: AuthUser, status = 200) {
  const token = randomSecret(32);
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + SESSION_SECONDS * 1000);
  await db.prepare("INSERT INTO auth_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), user.id, expiresAt.toISOString(), createdAt.toISOString())
    .run();
  return jsonResponse({ user }, status, sessionCookie(request, token));
}

function sessionCookie(request: Request, token: string) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; SameSite=Lax${secure}`;
}

function clearSessionCookie(request: Request) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`;
}

function parseEmail(value: unknown) {
  if (typeof value !== "string") throw new AuthError(422, "invalid_email", "Enter a valid email address.");
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AuthError(422, "invalid_email", "Enter a valid email address.");
  }
  return email;
}

function parsePassword(value: unknown) {
  if (typeof value !== "string" || value.length < 10 || value.length > 128) {
    throw new AuthError(422, "invalid_password", "Use a password between 10 and 128 characters.");
  }
  return value;
}

async function hashPassword(password: string, salt: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    salt: base64UrlDecode(salt),
    iterations: PASSWORD_ITERATIONS,
  }, key, 256);
  return base64UrlEncode(new Uint8Array(bits));
}

async function verifyPassword(password: string, salt: string, expected: string) {
  const actual = await hashPassword(password, salt);
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
}

function randomSecret(length: number) {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(length)));
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseCookies(header: string) {
  const cookies = new Map<string, string>();
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    cookies.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return cookies;
}

function assertSameOrigin(request: Request) {
  const origin = request.headers.get("Origin");
  if (!origin || new URL(origin).origin !== new URL(request.url).origin) {
    throw new AuthError(403, "invalid_origin", "Account changes must come from CastCompass.");
  }
}

async function readJson(request: Request) {
  if (!(request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new AuthError(415, "unsupported_media_type", "Send account details as JSON.");
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new AuthError(400, "invalid_json", "Account details must be valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AuthError(400, "invalid_json", "Account details must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

function methodNotAllowed(allow: string) {
  return errorResponse(405, "method_not_allowed", `Use ${allow} for this endpoint.`, undefined, { Allow: allow });
}

function errorResponse(status: number, code: string, message: string, cookie?: string, headers?: HeadersInit) {
  return jsonResponse({ error: { code, message } }, status, cookie, headers);
}

function jsonResponse(body: unknown, status = 200, cookie?: string, extraHeaders?: HeadersInit) {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  if (cookie) headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify(body), { status, headers });
}
