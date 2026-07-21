import { buildSpeciesObservationFields, hasServerControlledObservationFields } from "./trips.ts";
import type { CuratedSite, D1DatabaseLike, TripRow } from "./trips.ts";
import {
  buildFeasibilityCorrectionEvent,
  type FeasibilityCorrectionRecord,
  type StoredFeasibilityStart,
} from "./validation-feasibility.ts";
import {
  TURNSTILE_ACTIONS,
  TurnstileVerificationError,
  verifyTurnstileChallenge,
  type TurnstileAction,
  type TurnstileEnv,
} from "./turnstile.ts";
import { logEvent } from "./observability.ts";
import { API_ROUTE_PATTERNS } from "./route-policy.ts";
import {
  buildPrivacyExportPayload,
  downloadPrivacyExport,
  privacyExportJobForOwner,
  privacyExportQueueMode,
  processExpiredPrivacyExports,
  publicPrivacyExportStatus,
  requestPrivacyExport,
  type PrivacyExportEnv,
} from "./privacy-export.ts";

const SESSION_COOKIE = "__Host-cc_session";
const LEGACY_SESSION_COOKIE = "cc_session";
const DELETION_RECEIPT_COOKIE = "cc_deletion_receipt";
const AGE_INELIGIBLE_COOKIE = "cc_age_ineligible";
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const DELETION_RECEIPT_SECONDS = 30 * 24 * 60 * 60;
const AGE_PROOF_SECONDS = 10 * 60;
const MAX_DELETION_ATTEMPTS = 8;
const MAX_SAVED_SITES_PER_ACCOUNT = 100;
const MAX_GEAR_PROFILES_PER_ACCOUNT = 100;
const AUTH_RETENTION_DELETE_BATCH = 100;
export const LEGAL_VERSION = "2026-07-17.1";
const AGE_GATE_VERSION = `age-13:${LEGAL_VERSION}`;
const MINIMUM_ACCOUNT_AGE = 13;
// Cloudflare Workers currently caps Web Crypto PBKDF2 at 100,000 rounds.
const PASSWORD_ITERATIONS = 100_000;
const NEW_PASSWORD_MINIMUM_CHARACTERS = 15;
const PASSWORD_MAXIMUM_CHARACTERS = 128;
const PWNED_PASSWORDS_RANGE_URL = "https://api.pwnedpasswords.com/range/";
const PWNED_PASSWORDS_TIMEOUT_MS = 3_000;
const PWNED_PASSWORDS_MAX_RESPONSE_BYTES = 64 * 1024;
const PASSWORD_RECOVERY_MINIMUM_RESPONSE_MS = 250;
const DUMMY_PASSWORD_SALT = "Y2FzdGluZ2NvbXBhc3MtdGltaW5n";

export interface AuthApiEnv extends TurnstileEnv, PrivacyExportEnv {
  DB?: D1DatabaseLike;
  RESEND_API_KEY?: string;
  AUTH_EMAIL_FROM?: string;
}

export interface AuthUser {
  id: string;
  email: string;
  ageEligible: boolean;
  legalAccepted: boolean;
}

interface AccountRequestOptions {
  onTripUpdated?(trip: TripRow): void;
  onTripsReviewRequested?(trips: TripRow[]): void;
  waitUntil?(promise: Promise<unknown>): void;
  now?(): Date;
}

const initializedDatabases = new WeakMap<object, Promise<void>>();

class AuthError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.code = code;
  }
}

function safeErrorContext(error: unknown) {
  if (error instanceof AuthError) {
    return { error_name: error.name, error_status: error.status, error_code: error.code };
  }
  return { error_name: error instanceof Error ? error.name : "UnknownError" };
}

function enforceAccountResourceCeiling<T>(
  rows: T[],
  maximum: number,
  code: "saved_site_limit_exceeded" | "gear_profile_limit_exceeded",
  label: string,
) {
  if (rows.length > maximum) {
    throw new AuthError(
      409,
      code,
      `This account exceeds the current ${label} safety limit. Contact support before making more changes.`,
    );
  }
  return rows;
}

function providerRequestId(response: Response) {
  const value = response.headers.get("x-request-id") ?? response.headers.get("cf-ray");
  return safeProviderIdentifier(value);
}

function safeProviderIdentifier(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
}

const CREATE_USERS_SQL = `CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  age_eligibility_confirmed_at TEXT,
  terms_accepted_at TEXT,
  terms_version TEXT,
  privacy_accepted_at TEXT,
  privacy_version TEXT,
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

const CREATE_EMAIL_CHALLENGES_SQL = `CREATE TABLE IF NOT EXISTS email_challenges (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  email TEXT NOT NULL,
  user_id TEXT,
  code_hash TEXT NOT NULL,
  password_salt TEXT,
  password_hash TEXT,
  age_eligibility_confirmed_at TEXT,
  terms_version TEXT,
  privacy_version TEXT,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  resend_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  CONSTRAINT email_challenges_kind_check CHECK (kind in ('signup', 'password_reset'))
)`;

const CREATE_GEAR_PROFILES_SQL = `CREATE TABLE IF NOT EXISTS gear_profiles (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  rod TEXT,
  reel TEXT,
  bait_lure TEXT,
  rig TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
)`;

const CREATE_SIGNUP_AGE_PROOFS_SQL = `CREATE TABLE IF NOT EXISTS signup_age_proofs (
  token_hash TEXT PRIMARY KEY NOT NULL,
  confirmed_at TEXT NOT NULL,
  gate_version TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
)`;

const CREATE_PRIVACY_DELETION_JOBS_SQL = `CREATE TABLE IF NOT EXISTS privacy_deletion_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  receipt_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK (scope IN ('account', 'trip')),
  subject_hash TEXT NOT NULL,
  owner_subject_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active_data_removed', 'purging', 'completed', 'needs_attention')),
  objects_total INTEGER NOT NULL DEFAULT 0,
  objects_deleted INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  requested_at TEXT NOT NULL,
  active_data_removed_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
)`;

const CREATE_PRIVACY_DELETION_TASKS_SQL = `CREATE TABLE IF NOT EXISTS privacy_deletion_tasks (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL,
  object_key TEXT,
  object_key_hash TEXT NOT NULL,
  object_store TEXT NOT NULL DEFAULT 'trip_photos' CHECK (object_store IN ('trip_photos', 'privacy_exports')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'completed', 'needs_attention')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  lease_expires_at TEXT,
  lease_token TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (job_id) REFERENCES privacy_deletion_jobs(id) ON DELETE CASCADE,
  UNIQUE (job_id, object_key_hash),
  CHECK ((state = 'completed' AND object_key IS NULL)
    OR (state != 'completed' AND object_key IS NOT NULL))
)`;

const CREATE_PRIVACY_EXPORT_JOBS_SQL = `CREATE TABLE IF NOT EXISTS privacy_export_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT,
  owner_subject_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'queued', 'processing', 'retry', 'completed', 'canceled', 'expired', 'needs_attention')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 5),
  available_at TEXT NOT NULL,
  lease_expires_at TEXT,
  lease_token TEXT,
  object_key TEXT,
  object_key_hash TEXT,
  content_sha256 TEXT,
  size_bytes INTEGER,
  record_count INTEGER,
  last_error_code TEXT,
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  expires_at TEXT,
  CHECK ((object_key IS NULL AND object_key_hash IS NULL)
    OR (object_key IS NOT NULL AND object_key_hash IS NOT NULL)),
  CHECK (state != 'completed' OR (user_id IS NOT NULL AND object_key IS NOT NULL
    AND content_sha256 IS NOT NULL AND size_bytes IS NOT NULL AND record_count IS NOT NULL
    AND completed_at IS NOT NULL AND expires_at IS NOT NULL)),
  CHECK (state != 'expired' OR (user_id IS NULL AND object_key IS NULL))
)`;

async function initialize(db: D1DatabaseLike) {
  let pending = initializedDatabases.get(db as object);
  if (!pending) {
    pending = (async () => {
      await db.batch([
        db.prepare(CREATE_USERS_SQL),
        db.prepare(CREATE_SESSIONS_SQL),
        db.prepare(CREATE_SAVED_SITES_SQL),
        db.prepare(CREATE_AUTH_ATTEMPTS_SQL),
        db.prepare(CREATE_EMAIL_CHALLENGES_SQL),
        db.prepare(CREATE_GEAR_PROFILES_SQL),
        db.prepare(CREATE_SIGNUP_AGE_PROOFS_SQL),
        db.prepare(CREATE_PRIVACY_DELETION_JOBS_SQL),
        db.prepare(CREATE_PRIVACY_DELETION_TASKS_SQL),
        db.prepare(CREATE_PRIVACY_EXPORT_JOBS_SQL),
      ]);
      await db.batch([
        db.prepare("CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions (user_id, expires_at)"),
        db.prepare("CREATE INDEX IF NOT EXISTS auth_sessions_expires_idx ON auth_sessions (expires_at)"),
        db.prepare("CREATE INDEX IF NOT EXISTS saved_sites_user_created_idx ON saved_sites (user_id, created_at DESC)"),
        db.prepare("CREATE INDEX IF NOT EXISTS auth_attempts_email_time_idx ON auth_attempts (email_hash, attempted_at)"),
        db.prepare("CREATE INDEX IF NOT EXISTS auth_attempts_attempted_idx ON auth_attempts (attempted_at)"),
        db.prepare("CREATE INDEX IF NOT EXISTS email_challenges_email_time_idx ON email_challenges (email, created_at)"),
        db.prepare("CREATE INDEX IF NOT EXISTS email_challenges_expires_idx ON email_challenges (expires_at)"),
        db.prepare("CREATE INDEX IF NOT EXISTS email_challenges_user_idx ON email_challenges (user_id) WHERE user_id IS NOT NULL"),
        db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS gear_profiles_user_name_unique ON gear_profiles (user_id, name)"),
        db.prepare("CREATE INDEX IF NOT EXISTS gear_profiles_user_updated_idx ON gear_profiles (user_id, updated_at)"),
        db.prepare("CREATE INDEX IF NOT EXISTS signup_age_proofs_expiry_idx ON signup_age_proofs (expires_at, consumed_at)"),
        db.prepare("CREATE INDEX IF NOT EXISTS signup_age_proofs_consumed_idx ON signup_age_proofs (consumed_at) WHERE consumed_at IS NOT NULL"),
        db.prepare("CREATE INDEX IF NOT EXISTS privacy_deletion_jobs_state_updated_idx ON privacy_deletion_jobs (state, updated_at)"),
        db.prepare("CREATE INDEX IF NOT EXISTS privacy_deletion_jobs_owner_state_idx ON privacy_deletion_jobs (owner_subject_hash, state, updated_at)"),
        db.prepare("CREATE INDEX IF NOT EXISTS privacy_deletion_jobs_scope_subject_idx ON privacy_deletion_jobs (scope, subject_hash)"),
        db.prepare("CREATE INDEX IF NOT EXISTS privacy_deletion_jobs_state_completed_idx ON privacy_deletion_jobs (state, completed_at)"),
        db.prepare("CREATE INDEX IF NOT EXISTS privacy_deletion_tasks_retry_idx ON privacy_deletion_tasks (state, available_at, lease_expires_at)"),
        db.prepare("CREATE INDEX IF NOT EXISTS privacy_deletion_tasks_store_retry_idx ON privacy_deletion_tasks (object_store, state, available_at, lease_expires_at)"),
        db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS privacy_export_jobs_active_user_unique ON privacy_export_jobs (user_id) WHERE user_id IS NOT NULL AND state IN ('pending', 'queued', 'processing', 'retry', 'completed', 'needs_attention')"),
        db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS privacy_export_jobs_object_key_unique ON privacy_export_jobs (object_key) WHERE object_key IS NOT NULL"),
        db.prepare("CREATE INDEX IF NOT EXISTS privacy_export_jobs_dispatch_idx ON privacy_export_jobs (state, available_at, lease_expires_at)"),
        db.prepare("CREATE INDEX IF NOT EXISTS privacy_export_jobs_expiry_idx ON privacy_export_jobs (state, expires_at, lease_expires_at)"),
        db.prepare("CREATE INDEX IF NOT EXISTS privacy_export_jobs_owner_idx ON privacy_export_jobs (owner_subject_hash, updated_at)"),
      ]);
    })().catch((error) => {
      initializedDatabases.delete(db as object);
      throw error;
    });
    initializedDatabases.set(db as object, pending);
  }
  await pending;
}

interface AuthenticatedSession {
  user: AuthUser;
  cookieName: typeof SESSION_COOKIE | typeof LEGACY_SESSION_COOKIE;
}

async function getAuthenticatedSession(request: Request, env: AuthApiEnv): Promise<AuthenticatedSession | null> {
  if (!env.DB) return null;
  await initialize(env.DB);
  const now = new Date().toISOString();
  for (const presented of presentedSessionTokens(request)) {
    const row = await env.DB
      .prepare(`SELECT users.id, users.email,
          CASE WHEN users.age_eligibility_confirmed_at IS NOT NULL THEN 1 ELSE 0 END AS age_eligible,
          CASE WHEN users.age_eligibility_confirmed_at IS NOT NULL
            AND users.terms_version = ? AND users.privacy_version = ?
            THEN 1 ELSE 0 END AS legal_accepted
        FROM auth_sessions
        JOIN users ON users.id = auth_sessions.user_id
        WHERE auth_sessions.token_hash = ? AND auth_sessions.expires_at > ?
        LIMIT 1`)
      .bind(LEGAL_VERSION, LEGAL_VERSION, await sha256(presented.token), now)
      .first<{ id: string; email: string; age_eligible: number; legal_accepted: number }>();
    if (row) {
      return {
        cookieName: presented.cookieName,
        user: {
          id: row.id,
          email: row.email,
          ageEligible: Boolean(row.age_eligible),
          legalAccepted: Boolean(row.legal_accepted),
        },
      };
    }
  }
  return null;
}

export async function getAuthenticatedUser(request: Request, env: AuthApiEnv): Promise<AuthUser | null> {
  return (await getAuthenticatedSession(request, env))?.user ?? null;
}

export async function handleAccountRequest(
  request: Request,
  env: AuthApiEnv,
  curatedSites: readonly CuratedSite[],
  options: AccountRequestOptions = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    !url.pathname.startsWith("/api/auth") &&
    !url.pathname.startsWith("/api/saved-sites") &&
    !url.pathname.startsWith("/api/gear-profiles") &&
    !url.pathname.startsWith("/api/profile") &&
    !url.pathname.startsWith("/api/privacy") &&
    !url.pathname.startsWith("/api/profile/reviews/") &&
    !url.pathname.startsWith("/api/profile/trips/")
  ) return null;
  if (!env.DB) return errorResponse(503, "storage_unavailable", "Account storage is temporarily unavailable.");

  const db = env.DB;
  const turnstileAction = turnstileActionForAccountRequest(request);
  if (turnstileAction) {
    try {
      // Reject cross-origin requests before spending a single-use provider
      // token, and verify before D1 initialization or any account side effect.
      assertSameOrigin(request);
      const challengeBody = await readJson(request.clone());
      await verifyTurnstileChallenge(env, challengeBody, turnstileAction);
    } catch (error) {
      return accountRequestErrorResponse(error);
    }
  }
  await initialize(db);

  try {
    if (url.pathname === "/api/auth/session") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      const session = await getAuthenticatedSession(request, env);
      if (!session) {
        return jsonResponse(
          { user: null },
          200,
          presentedSessionTokens(request).length > 0 ? clearSessionCookies(request) : undefined,
        );
      }
      if (session.cookieName === LEGACY_SESSION_COOKIE && new URL(request.url).protocol === "https:") {
        return createSessionResponse(db, request, session.user);
      }
      return jsonResponse({ user: session.user });
    }

    if (url.pathname === "/api/auth/signup") {
      return errorResponse(410, "verification_required", "Create accounts through email verification.");
    }

    if (url.pathname === "/api/auth/signup/eligibility") {
      if (request.method === "GET") {
        return jsonResponse({
          available: !parseCookies(request.headers.get("Cookie") ?? "").has(AGE_INELIGIBLE_COOKIE),
        });
      }
      if (request.method !== "POST") return methodNotAllowed("GET, POST");
      assertSameOrigin(request);
      if (parseCookies(request.headers.get("Cookie") ?? "").has(AGE_INELIGIBLE_COOKIE)) {
        return errorResponse(403, "age_restricted", "CastingCompass accounts are not available from this browser right now.");
      }
      const body = await readJson(request);
      assertOnlyFields(body, ["birthDate", "turnstileToken"]);
      let confirmedAt: string;
      try {
        confirmedAt = evaluateAgeEligibility(body.birthDate);
      } catch (error) {
        if (error instanceof AuthError && error.code === "age_restricted") {
          return errorResponse(error.status, error.code, error.message, ageIneligibleCookie());
        }
        throw error;
      }
      const proof = randomSecret(32);
      const createdAt = new Date();
      const expiresAt = new Date(createdAt.getTime() + AGE_PROOF_SECONDS * 1000);
      await db.prepare(`INSERT INTO signup_age_proofs
        (token_hash, confirmed_at, gate_version, expires_at, consumed_at, created_at)
        VALUES (?, ?, ?, ?, NULL, ?)`)
        .bind(await sha256(proof), confirmedAt, AGE_GATE_VERSION, expiresAt.toISOString(), createdAt.toISOString())
        .run();
      return jsonResponse({
        eligibilityProof: proof,
        expiresInMinutes: AGE_PROOF_SECONDS / 60,
        expiresInSeconds: AGE_PROOF_SECONDS,
      }, 200, clearAgeIneligibleCookie());
    }

    if (url.pathname === "/api/privacy/deletion-status") {
      if (request.method === "DELETE") {
        assertSameOrigin(request);
        return jsonResponse({ cleared: true }, 200, clearDeletionReceiptCookie());
      }
      if (request.method !== "GET") return methodNotAllowed("GET, DELETE");
      const receipt = parseCookies(request.headers.get("Cookie") ?? "").get(DELETION_RECEIPT_COOKIE);
      if (!receipt || !/^[A-Za-z0-9_-]{40,160}$/.test(receipt)) {
        return errorResponse(404, "deletion_receipt_not_found", "No deletion status receipt was found in this browser.");
      }
      const job = await selectDeletionJobByReceipt(db, receipt);
      if (!job) return errorResponse(404, "deletion_receipt_not_found", "That deletion status receipt is no longer available.");
      return jsonResponse({ deletion: publicDeletionStatus(job) });
    }

    if (url.pathname === "/api/auth/signup/request") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      assertSameOrigin(request);
      const body = await readJson(request);
      assertOnlyFields(body, ["eligibilityProof", "email", "password", "termsAccepted", "privacyAccepted", "turnstileToken"]);
      if (parseCookies(request.headers.get("Cookie") ?? "").has(AGE_INELIGIBLE_COOKIE)) {
        return errorResponse(403, "age_restricted", "CastingCompass accounts are not available from this browser right now.");
      }
      const ageProof = await validateSignupAgeProof(db, body.eligibilityProof);
      const email = parseEmail(body.email);
      const password = parseNewPassword(body.password);
      assertSignupLegalAcceptance(body);
      await assertNewPasswordAllowed(password, email);
      const ageEligibilityConfirmedAt = await consumeSignupAgeProof(db, ageProof);
      const existing = await db.prepare("SELECT id FROM users WHERE email = ? LIMIT 1").bind(email).first();
      if (existing) return errorResponse(409, "email_in_use", "An account already uses this email.");
      await assertEmailChallengeAllowed(db, email);
      const id = `challenge_${crypto.randomUUID()}`;
      const code = randomCode();
      const salt = randomSecret(18);
      const timestamp = new Date();
      await db.prepare(`INSERT INTO email_challenges
        (id, kind, email, user_id, code_hash, password_salt, password_hash,
          age_eligibility_confirmed_at, terms_version, privacy_version, expires_at, attempts, created_at)
        VALUES (?, 'signup', ?, NULL, ?, ?, ?, ?, ?, ?, ?, 0, ?)`)
        .bind(
          id,
          email,
          await sha256(`${id}:${code}`),
          salt,
          await hashPassword(password, salt),
          ageEligibilityConfirmedAt,
          LEGAL_VERSION,
          LEGAL_VERSION,
          new Date(timestamp.getTime() + 15 * 60 * 1000).toISOString(),
          timestamp.toISOString(),
        )
        .run();
      try {
        await sendVerificationEmail(env, email, code, "Confirm your CastingCompass account");
      } catch (error) {
        await db.prepare("DELETE FROM email_challenges WHERE id = ?").bind(id).run();
        throw error;
      }
      return jsonResponse({ challengeId: id, expiresInMinutes: 15 });
    }

    if (url.pathname === "/api/auth/signup/verify") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      assertSameOrigin(request);
      const body = await readJson(request);
      assertOnlyFields(body, ["challengeId", "code", "turnstileToken"]);
      const challenge = await verifyEmailChallenge(db, body.challengeId, body.code, "signup");
      const existing = await db.prepare("SELECT id FROM users WHERE email = ? LIMIT 1").bind(challenge.email).first();
      if (existing) return errorResponse(409, "email_in_use", "An account already uses this email.");
      if (!challenge.password_salt || !challenge.password_hash || !challenge.age_eligibility_confirmed_at ||
        challenge.terms_version !== LEGAL_VERSION || challenge.privacy_version !== LEGAL_VERSION) {
        throw new AuthError(400, "invalid_challenge", "Request a new verification code.");
      }
      const user: AuthUser = {
        id: `user_${crypto.randomUUID()}`,
        email: challenge.email,
        ageEligible: true,
        legalAccepted: true,
      };
      const timestamp = new Date().toISOString();
      await db.batch([
        db.prepare(`INSERT INTO users (id, email, password_salt, password_hash,
          age_eligibility_confirmed_at, terms_accepted_at, terms_version,
          privacy_accepted_at, privacy_version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
            user.id, user.email, challenge.password_salt, challenge.password_hash,
            challenge.age_eligibility_confirmed_at, timestamp, LEGAL_VERSION,
            timestamp, LEGAL_VERSION, timestamp, timestamp,
          ),
        db.prepare("DELETE FROM email_challenges WHERE id = ?").bind(challenge.id),
      ]);
      // Account creation should succeed even if the optional welcome message is
      // delayed. Verification already proved ownership of the address.
      await sendWelcomeEmail(env, user.email, user.id).catch((error) => {
        logEvent("error", "email.welcome.delivery_failed", safeErrorContext(error));
      });
      return createSessionResponse(db, request, user, 201);
    }

    if (url.pathname === "/api/auth/challenge/resend") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      assertSameOrigin(request);
      const body = await readJson(request);
      assertOnlyFields(body, ["challengeId", "turnstileToken"]);
      const challengeId = typeof body.challengeId === "string" ? body.challengeId : "";
      if (!/^challenge_[a-f0-9-]{36}$/.test(challengeId)) {
        throw new AuthError(422, "invalid_challenge", "Start the email verification again.");
      }
      const challenge = await db.prepare("SELECT * FROM email_challenges WHERE id = ? LIMIT 1")
        .bind(challengeId)
        .first<EmailChallengeRow>();
      if (!challenge) {
        // Keep password-reset requests from becoming an account-enumeration path.
        await minimumDelay(PASSWORD_RECOVERY_MINIMUM_RESPONSE_MS);
        return passwordRecoveryResendResponse(challengeId);
      }
      const createdAt = new Date(challenge.created_at).getTime();
      const retryAfterSeconds = Math.max(0, 60 - Math.floor((Date.now() - createdAt) / 1000));
      if (challenge.kind === "password_reset") {
        const responseNotBefore = minimumDelay(PASSWORD_RECOVERY_MINIMUM_RESPONSE_MS);
        if (retryAfterSeconds > 0 || Number(challenge.resend_count ?? 0) >= 4) {
          await responseNotBefore;
          return passwordRecoveryResendResponse(challengeId);
        }
        const code = randomCode();
        const timestamp = new Date();
        await db.prepare(`UPDATE email_challenges
          SET code_hash = ?, expires_at = ?, attempts = 0, resend_count = resend_count + 1, created_at = ?
          WHERE id = ?`)
          .bind(
            await sha256(`${challenge.id}:${code}`),
            new Date(timestamp.getTime() + 15 * 60 * 1000).toISOString(),
            timestamp.toISOString(),
            challenge.id,
          )
          .run();
        const delivery = deferPasswordRecoveryEmail(
          options,
          db,
          challenge.id,
          sendVerificationEmail(
            env,
            challenge.email,
            code,
            "Reset your CastingCompass password",
            `${challenge.id}:resend:${Number(challenge.resend_count ?? 0) + 1}`,
          ),
        );
        if (!options.waitUntil) await delivery;
        await responseNotBefore;
        return passwordRecoveryResendResponse(challengeId);
      }
      if (retryAfterSeconds > 0) {
        return errorResponse(
          429,
          "resend_cooldown",
          `Wait ${retryAfterSeconds} seconds before requesting another code.`,
          undefined,
          { "Retry-After": String(retryAfterSeconds) },
        );
      }
      if (Number(challenge.resend_count ?? 0) >= 4) {
        throw new AuthError(429, "too_many_codes", "Too many email codes were requested. Start again in an hour.");
      }
      const code = randomCode();
      const timestamp = new Date();
      await sendVerificationEmail(
        env,
        challenge.email,
        code,
        challenge.kind === "signup" ? "Confirm your CastingCompass account" : "Reset your CastingCompass password",
        `${challenge.id}:resend:${Number(challenge.resend_count ?? 0) + 1}`,
      );
      await db.prepare(`UPDATE email_challenges
        SET code_hash = ?, expires_at = ?, attempts = 0, resend_count = resend_count + 1, created_at = ?
        WHERE id = ?`)
        .bind(
          await sha256(`${challenge.id}:${code}`),
          new Date(timestamp.getTime() + 15 * 60 * 1000).toISOString(),
          timestamp.toISOString(),
          challenge.id,
        )
        .run();
      return jsonResponse({ requested: true, challengeId, expiresInMinutes: 15, retryAfterSeconds: 60 });
    }

    if (url.pathname === "/api/auth/password/request") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      assertSameOrigin(request);
      const body = await readJson(request);
      // The previously shipped client used one generic payload branch and sent
      // `password: null` from this password-less form. Accept only that exact
      // legacy shape so a default-off rollout does not break cached PWAs.
      assertOnlyFields(body, ["email", "password", "turnstileToken"]);
      if (body.password !== undefined && body.password !== null) {
        throw new AuthError(422, "unexpected_fields", "Send only the fields required for this account step.");
      }
      const email = parseEmail(body.email);
      const responseNotBefore = minimumDelay(PASSWORD_RECOVERY_MINIMUM_RESPONSE_MS);
      const user = await db.prepare("SELECT id FROM users WHERE email = ? LIMIT 1").bind(email).first<{ id: string }>();
      if (!user) {
        await responseNotBefore;
        return passwordRecoveryRequestedResponse();
      }
      try {
        await assertEmailChallengeAllowed(db, email);
      } catch (error) {
        if (error instanceof AuthError && error.code === "too_many_codes") {
          await responseNotBefore;
          return passwordRecoveryRequestedResponse();
        }
        throw error;
      }
      const id = `challenge_${crypto.randomUUID()}`;
      const code = randomCode();
      const timestamp = new Date();
      await db.prepare(`INSERT INTO email_challenges
        (id, kind, email, user_id, code_hash, expires_at, attempts, created_at)
        VALUES (?, 'password_reset', ?, ?, ?, ?, 0, ?)`)
        .bind(id, email, user.id, await sha256(`${id}:${code}`), new Date(timestamp.getTime() + 15 * 60 * 1000).toISOString(), timestamp.toISOString())
        .run();
      const delivery = deferPasswordRecoveryEmail(
        options,
        db,
        id,
        sendVerificationEmail(env, email, code, "Reset your CastingCompass password"),
      );
      if (!options.waitUntil) await delivery;
      await responseNotBefore;
      return passwordRecoveryRequestedResponse(id);
    }

    if (url.pathname === "/api/auth/password/reset") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      assertSameOrigin(request);
      const body = await readJson(request);
      assertOnlyFields(body, ["challengeId", "code", "password", "turnstileToken"]);
      const password = parseNewPassword(body.password);
      const responseNotBefore = minimumDelay(PASSWORD_RECOVERY_MINIMUM_RESPONSE_MS);
      let challenge: EmailChallengeRow;
      try {
        challenge = await verifyEmailChallenge(db, body.challengeId, body.code, "password_reset");
      } catch (error) {
        if (error instanceof AuthError && error.code === "invalid_code") await responseNotBefore;
        throw error;
      }
      if (!challenge.user_id) throw new AuthError(400, "invalid_challenge", "Request a new reset code.");
      await assertNewPasswordAllowed(password, challenge.email);
      const salt = randomSecret(18);
      const timestamp = new Date().toISOString();
      await db.batch([
        db.prepare("UPDATE users SET password_salt = ?, password_hash = ?, updated_at = ? WHERE id = ?")
          .bind(salt, await hashPassword(password, salt), timestamp, challenge.user_id),
        db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").bind(challenge.user_id),
        db.prepare("DELETE FROM email_challenges WHERE id = ?").bind(challenge.id),
      ]);
      const user = await selectUserForSession(db, challenge.user_id);
      if (!user) throw new AuthError(404, "account_not_found", "The account could not be found.");
      return createSessionResponse(db, request, user);
    }

    if (url.pathname === "/api/auth/login") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      assertSameOrigin(request);
      const body = await readJson(request);
      assertOnlyFields(body, ["email", "password", "turnstileToken"]);
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
        .prepare(`SELECT id, email, password_salt, password_hash,
          CASE WHEN age_eligibility_confirmed_at IS NOT NULL THEN 1 ELSE 0 END AS age_eligible,
          CASE WHEN age_eligibility_confirmed_at IS NOT NULL AND terms_version = ? AND privacy_version = ?
            THEN 1 ELSE 0 END AS legal_accepted
          FROM users WHERE email = ? LIMIT 1`)
        .bind(LEGAL_VERSION, LEGAL_VERSION, email)
        .first<{
          id: string;
          email: string;
          password_salt: string;
          password_hash: string;
          age_eligible: number;
          legal_accepted: number;
        }>();
      const valid = row
        ? await verifyPassword(password, row.password_salt, row.password_hash)
        : (await hashPassword(password, DUMMY_PASSWORD_SALT), false);
      await db.prepare("INSERT INTO auth_attempts (id, email_hash, attempted_at, successful) VALUES (?, ?, ?, ?)")
        .bind(`attempt_${crypto.randomUUID()}`, emailHash, new Date().toISOString(), Number(valid))
        .run();
      if (!row || !valid) return errorResponse(401, "invalid_credentials", "Email or password is incorrect.");
      return createSessionResponse(db, request, {
        id: row.id,
        email: row.email,
        ageEligible: Boolean(row.age_eligible),
        legalAccepted: Boolean(row.legal_accepted),
      });
    }

    if (url.pathname === "/api/auth/logout") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      assertSameOrigin(request);
      const tokens = presentedSessionTokens(request);
      if (tokens.length > 0) {
        await db.batch(await Promise.all(tokens.map(async ({ token }) =>
          db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(await sha256(token)))));
      }
      return jsonResponse({ signedOut: true, user: null }, 200, clearSessionCookies(request));
    }

    const user = await getAuthenticatedUser(request, env);
    if (!user) return unauthorizedResponse();

    if (url.pathname === "/api/auth/eligibility") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      assertSameOrigin(request);
      const body = await readJson(request);
      assertOnlyFields(body, ["termsAccepted", "privacyAccepted"]);
      assertSignupLegalAcceptance(body);
      if (!user.ageEligible) {
        throw new AuthError(428, "age_eligibility_unavailable", "Account features are paused. Contact privacy support or delete the account.");
      }
      const timestamp = new Date().toISOString();
      await db.prepare(`UPDATE users SET terms_accepted_at = ?, terms_version = ?,
        privacy_accepted_at = ?, privacy_version = ?, updated_at = ? WHERE id = ?`)
        .bind(timestamp, LEGAL_VERSION, timestamp, LEGAL_VERSION, timestamp, user.id)
        .run();
      return jsonResponse({ user: { ...user, legalAccepted: true }, legalVersion: LEGAL_VERSION });
    }

    const exportPhotoMatch = url.pathname.match(API_ROUTE_PATTERNS.profileExportPhoto);
    if (exportPhotoMatch) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      const trip = await db.prepare(`SELECT id, photo_key, photo_content_type
        FROM trips WHERE id = ? AND user_id = ? LIMIT 1`)
        .bind(exportPhotoMatch[1], user.id)
        .first<{ id: string; photo_key: string | null; photo_content_type: string | null }>();
      if (!trip?.photo_key) return errorResponse(404, "photo_not_found", "That trip has no stored photo.");
      if (!env.TRIP_PHOTOS?.get) {
        return errorResponse(503, "photo_storage_unavailable", "The stored photo cannot be exported right now.");
      }
      const object = await env.TRIP_PHOTOS.get(trip.photo_key);
      if (!object) return errorResponse(404, "photo_object_missing", "The stored photo could not be found.");
      const body = object.body ?? (object.arrayBuffer ? await object.arrayBuffer() : null);
      if (!body) return errorResponse(503, "photo_storage_unavailable", "The stored photo cannot be exported right now.");
      const contentType = safePhotoContentType(object.httpMetadata?.contentType ?? trip.photo_content_type);
      const headers = new Headers({
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${trip.id}.${photoFileExtension(contentType)}"`,
        "Cache-Control": "no-store",
      });
      if (object.size !== undefined) headers.set("Content-Length", String(object.size));
      return new Response(body, {
        status: 200,
        headers,
      });
    }

    const exportDownloadMatch = url.pathname.match(API_ROUTE_PATTERNS.profileExportDownload);
    if (exportDownloadMatch) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return await downloadPrivacyExport(env, user.id, exportDownloadMatch[1])
        ?? errorResponse(404, "privacy_export_not_found", "That export request could not be found.");
    }

    const exportStatusMatch = url.pathname.match(API_ROUTE_PATTERNS.profileExportStatus);
    if (exportStatusMatch) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      const job = await privacyExportJobForOwner(db, user.id, exportStatusMatch[1]);
      if (!job) return errorResponse(404, "privacy_export_not_found", "That export request could not be found.");
      return jsonResponse({ export: publicPrivacyExportStatus(job) });
    }

    if (url.pathname === "/api/profile/export") {
      if (request.method === "POST") {
        assertSameOrigin(request);
        const result = await requestPrivacyExport(env, user.id);
        if (result.configurationError === "feature_disabled") {
          return errorResponse(409, "async_privacy_export_disabled", "Background export packaging is not enabled yet. The direct JSON download remains available.");
        }
        if (result.configurationError || !result.job) {
          logEvent("error", "privacy_export.request.configuration_rejected", {
            error_code: result.configurationError ?? "privacy_export_unavailable",
          });
          return errorResponse(503, "privacy_export_unavailable", "The background export service is unavailable. Try again later.");
        }
        const status = publicPrivacyExportStatus(result.job);
        return jsonResponse({ export: status }, status.status === "ready" ? 200 : 202);
      }
      if (request.method !== "GET") return methodNotAllowed("GET, POST");
      const exportMode = privacyExportQueueMode(env);
      if (exportMode === "invalid") {
        return errorResponse(503, "privacy_export_configuration_invalid", "The export service is unavailable. Try again later.");
      }
      if (exportMode === "enabled") {
        return errorResponse(409, "async_privacy_export_required", "Request a background export before downloading it.");
      }
      const built = await buildPrivacyExportPayload(env, user.id);
      return jsonResponse(
        built.payload,
        200,
        undefined,
        { "Content-Disposition": `attachment; filename="castingcompass-data-${new Date().toISOString().slice(0, 10)}.json"` },
      );
    }

    if (url.pathname === "/api/profile" && request.method === "DELETE") {
      assertSameOrigin(request);
      const body = await readJson(request);
      if (body.confirmation !== "DELETE") {
        throw new AuthError(422, "confirmation_required", "Type DELETE to confirm account deletion.");
      }
      const password = parsePassword(body.password);
      const credentials = await db.prepare("SELECT password_salt, password_hash FROM users WHERE id = ? LIMIT 1")
        .bind(user.id).first<{ password_salt: string; password_hash: string }>();
      if (!credentials || !await verifyPassword(password, credentials.password_salt, credentials.password_hash)) {
        throw new AuthError(401, "invalid_credentials", "Your password is incorrect.");
      }
      const photos = await db.prepare("SELECT photo_key FROM trips WHERE user_id = ? AND photo_key IS NOT NULL")
        .bind(user.id).all<{ photo_key: string }>();
      const ownerSubjectHash = await sha256(`account:${user.id}`);
      const pendingObjects = await db.prepare(`SELECT privacy_deletion_tasks.object_key,
          privacy_deletion_tasks.object_store
        FROM privacy_deletion_tasks
        JOIN privacy_deletion_jobs ON privacy_deletion_jobs.id = privacy_deletion_tasks.job_id
        WHERE privacy_deletion_jobs.owner_subject_hash = ?
          AND privacy_deletion_tasks.state != 'completed' AND privacy_deletion_tasks.object_key IS NOT NULL`)
        .bind(ownerSubjectHash).all<{ object_key: string; object_store: PrivacyObjectStore }>();
      const exportObjects = await db.prepare(`SELECT object_key FROM privacy_export_jobs
        WHERE owner_subject_hash = ? AND object_key IS NOT NULL
          AND state IN ('pending', 'queued', 'processing', 'retry', 'completed', 'needs_attention')`)
        .bind(ownerSubjectHash).all<{ object_key: string }>();
      const deletionObjects: PrivacyDeletionObject[] = [
        ...(photos.results ?? []).map((photo) => ({ objectStore: "trip_photos" as const, objectKey: photo.photo_key })),
        ...(pendingObjects.results ?? []).map((object) => ({ objectStore: object.object_store, objectKey: object.object_key })),
        ...(exportObjects.results ?? []).map((object) => ({ objectStore: "privacy_exports" as const, objectKey: object.object_key })),
      ];
      const deletion = await prepareDeletionJob("account", user.id, user.id, deletionObjects);
      await db.batch([
        deletion.jobStatement(db),
        ...deletion.taskStatements(db),
        db.prepare(`UPDATE privacy_deletion_tasks SET state = 'pending', available_at = ?,
          lease_expires_at = NULL, lease_token = NULL, last_error_code = NULL, updated_at = ?
          WHERE state = 'needs_attention' AND object_key IS NOT NULL
            AND job_id IN (SELECT id FROM privacy_deletion_jobs WHERE owner_subject_hash = ?)`)
          .bind(deletion.requestedAt, deletion.requestedAt, ownerSubjectHash),
        db.prepare(`UPDATE privacy_export_jobs
          SET state = 'canceled', user_id = NULL, lease_expires_at = NULL, lease_token = NULL,
            last_error_code = 'account_deleted', updated_at = ?
          WHERE owner_subject_hash = ?
            AND state IN ('pending', 'queued', 'processing', 'retry', 'completed', 'needs_attention')`)
          .bind(deletion.requestedAt, ownerSubjectHash),
        db.prepare("DELETE FROM site_discussion_posts WHERE trip_id IN (SELECT id FROM trips WHERE user_id = ?)").bind(user.id),
        db.prepare("DELETE FROM trips WHERE user_id = ?").bind(user.id),
        db.prepare("DELETE FROM saved_sites WHERE user_id = ?").bind(user.id),
        db.prepare("DELETE FROM gear_profiles WHERE user_id = ?").bind(user.id),
        db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").bind(user.id),
        db.prepare("DELETE FROM email_challenges WHERE email = ? OR user_id = ?").bind(user.email, user.id),
        db.prepare("DELETE FROM auth_attempts WHERE email_hash = ?").bind(await sha256(user.email)),
        db.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
      ]);
      const status = await deletionStatusAfterCommit(env, deletion);
      return jsonResponse(
        { deleted: true, deletion: status },
        status.status === "completed" ? 200 : 202,
        [
          ...clearSessionCookies(request),
          clearReporterCookie(),
          clearAgeIneligibleCookie(),
          deletionReceiptCookie(deletion.receipt),
        ],
      );
    }

    if (!user.legalAccepted) {
      return user.ageEligible
        ? errorResponse(428, "legal_acceptance_required", "Accept the current Terms and Privacy Policy to continue.")
        : errorResponse(428, "age_eligibility_unavailable", "This legacy account is paused because no prior age-eligibility confirmation is available. Export or delete it from Profile, or contact privacy support.");
    }

    if (url.pathname === "/api/profile/reviews/retry") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      assertSameOrigin(request);
      const rows = await db.prepare(`SELECT * FROM trips
        WHERE user_id = ? AND status = 'completed'
          AND (ai_review_status IS NULL OR ai_review_status = 'retry')
        ORDER BY COALESCE(completed_at, ended_at, started_at) DESC
        LIMIT 10`)
        .bind(user.id)
        .all<TripRow>();
      const trips = rows.results ?? [];
      if (trips.length) {
        await db.batch(trips.map((trip) => db.prepare(
          "UPDATE trips SET ai_review_status = 'queued' WHERE id = ? AND (ai_review_status IS NULL OR ai_review_status = 'retry')",
        ).bind(trip.id)));
        options.onTripsReviewRequested?.(trips);
      }
      return jsonResponse({ queued: trips.length }, 202);
    }

    if (url.pathname === "/api/profile") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      const [savedRows, tripRows, gearRows] = await Promise.all([
        db.prepare("SELECT site_id, created_at FROM saved_sites WHERE user_id = ? ORDER BY created_at DESC LIMIT 101")
          .bind(user.id)
          .all<{ site_id: string; created_at: string }>(),
        db.prepare(`SELECT id, source, site_id, started_at, ended_at, mode, fishing_method,
          angler_count, angler_hours, keeper_count, short_released_count, halibut_encounters,
          no_catch, other_catch_count, other_species, observations_json, notes, moderation_status,
          observation_contract_version, taxon_catalog_version, target_taxon_id, contract_status,
          taxon_observations_json, outcome_class, target_encounter_count, any_fish_encounter_count,
          target_identification_confidence,
          opportunity_score, fishability_score, model_version, gear_profile_id, rod, reel,
          bait_lure, rig, ai_review_status, ai_review_json, ai_review_model, ai_reviewed_at, completed_at
          FROM trips
          WHERE user_id = ? AND status = 'completed'
          ORDER BY COALESCE(completed_at, ended_at, started_at) DESC
          LIMIT 100`)
          .bind(user.id)
          .all<Record<string, unknown>>(),
        db.prepare(`SELECT id, name, rod, reel, bait_lure, rig, created_at, updated_at
          FROM gear_profiles WHERE user_id = ? ORDER BY updated_at DESC LIMIT 101`)
          .bind(user.id)
          .all<Record<string, unknown>>(),
      ]);
      const savedSites = enforceAccountResourceCeiling(
        savedRows.results ?? [],
        MAX_SAVED_SITES_PER_ACCOUNT,
        "saved_site_limit_exceeded",
        "saved-location",
      );
      const gearProfiles = enforceAccountResourceCeiling(
        gearRows.results ?? [],
        MAX_GEAR_PROFILES_PER_ACCOUNT,
        "gear_profile_limit_exceeded",
        "gear-preset",
      );
      return jsonResponse({
        user,
        savedSites,
        trips: tripRows.results ?? [],
        gearProfiles,
      });
    }

    if (url.pathname === "/api/gear-profiles") {
      if (request.method === "GET") {
        const rows = await db.prepare(`SELECT id, name, rod, reel, bait_lure, rig, created_at, updated_at
          FROM gear_profiles WHERE user_id = ? ORDER BY updated_at DESC LIMIT 101`)
          .bind(user.id)
          .all<Record<string, unknown>>();
        return jsonResponse({
          gearProfiles: enforceAccountResourceCeiling(
            rows.results ?? [],
            MAX_GEAR_PROFILES_PER_ACCOUNT,
            "gear_profile_limit_exceeded",
            "gear-preset",
          ),
        });
      }
      if (request.method === "POST") {
        assertSameOrigin(request);
        const body = await readJson(request);
        assertOnlyFields(body, ["name", "rod", "reel", "baitLure", "rig"]);
        const id = `gear_${crypto.randomUUID()}`;
        const timestamp = new Date().toISOString();
        const gear = parseGearProfile(body);
        const result = await db.prepare(`INSERT INTO gear_profiles
          (id, user_id, name, rod, reel, bait_lure, rig, created_at, updated_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE (SELECT COUNT(*) FROM gear_profiles WHERE user_id = ?) < 100`)
          .bind(id, user.id, gear.name, gear.rod, gear.reel, gear.baitLure, gear.rig, timestamp, timestamp, user.id)
          .run();
        if (result.meta?.changes === 0) {
          throw new AuthError(409, "gear_profile_limit_reached", "Remove a gear preset before adding another.");
        }
        if (result.meta?.changes !== 1) {
          throw new AuthError(503, "gear_profile_write_unconfirmed", "The gear preset could not be confirmed.");
        }
        return jsonResponse({ gearProfile: { id, ...gear, created_at: timestamp, updated_at: timestamp } }, 201);
      }
      return methodNotAllowed("GET, POST");
    }

    const gearProfileMatch = url.pathname.match(API_ROUTE_PATTERNS.gearProfile);
    if (gearProfileMatch) {
      assertSameOrigin(request);
      const id = gearProfileMatch[1];
      const existing = await db.prepare("SELECT id FROM gear_profiles WHERE id = ? AND user_id = ? LIMIT 1")
        .bind(id, user.id)
        .first();
      if (!existing) return errorResponse(404, "gear_profile_not_found", "That gear preset could not be found.");
      if (request.method === "DELETE") {
        await db.prepare("DELETE FROM gear_profiles WHERE id = ? AND user_id = ?").bind(id, user.id).run();
        return jsonResponse({ deleted: true, id });
      }
      if (request.method === "PATCH") {
        const body = await readJson(request);
        assertOnlyFields(body, ["name", "rod", "reel", "baitLure", "rig"]);
        const gear = parseGearProfile(body);
        const timestamp = new Date().toISOString();
        await db.prepare(`UPDATE gear_profiles SET name = ?, rod = ?, reel = ?, bait_lure = ?, rig = ?, updated_at = ?
          WHERE id = ? AND user_id = ?`)
          .bind(gear.name, gear.rod, gear.reel, gear.baitLure, gear.rig, timestamp, id, user.id)
          .run();
        return jsonResponse({ updated: true, id });
      }
      return methodNotAllowed("PATCH, DELETE");
    }

    const profileTripMatch = url.pathname.match(API_ROUTE_PATTERNS.profileTrip);
    if (profileTripMatch) {
      assertSameOrigin(request);
      const tripId = profileTripMatch[1];
      const trip = await db.prepare(`SELECT id, user_id, site_id, started_at, ended_at, mode, moderation_status, photo_key,
          observation_contract_version, taxon_catalog_version,
          target_taxon_id, contract_status, taxon_observations_json, outcome_class,
          target_encounter_count, any_fish_encounter_count, target_identification_confidence,
          score_influenced_choice
        FROM trips WHERE id = ? AND user_id = ? AND status = 'completed' LIMIT 1`)
        .bind(tripId, user.id)
        .first<Pick<TripRow,
          "id" | "user_id" | "site_id" | "started_at" | "ended_at" | "mode" | "moderation_status" | "photo_key" |
          "observation_contract_version" |
          "taxon_catalog_version" | "target_taxon_id" | "contract_status" |
          "taxon_observations_json" | "outcome_class" | "target_encounter_count" |
          "any_fish_encounter_count" | "target_identification_confidence" | "score_influenced_choice"
        >>();
      if (!trip) return errorResponse(404, "trip_not_found", "That trip log could not be found.");
      if (trip.moderation_status !== "pending") {
        return errorResponse(409, "trip_reviewed", "Reviewed trip logs can no longer be changed.");
      }

      if (request.method === "DELETE") {
        const deletion = await prepareDeletionJob(
          "trip",
          tripId,
          user.id,
          trip.photo_key ? [{ objectStore: "trip_photos", objectKey: trip.photo_key }] : [],
        );
        const deletionResults = await db.batch([
          deletion.jobStatementForPendingTrip(db, tripId, user.id),
          ...deletion.taskStatementsForPendingTrip(db, tripId, user.id),
          db.prepare(`DELETE FROM site_discussion_posts WHERE trip_id = ?
            AND EXISTS (SELECT 1 FROM trips WHERE id = ? AND user_id = ? AND moderation_status = 'pending')`)
            .bind(tripId, tripId, user.id),
          db.prepare("DELETE FROM trips WHERE id = ? AND user_id = ? AND moderation_status = 'pending'")
            .bind(tripId, user.id),
        ]);
        if (mutationChanges(deletionResults.at(-1)) !== 1) {
          return errorResponse(409, "trip_reviewed", "Reviewed trip logs can no longer be changed.");
        }
        const status = await deletionStatusAfterCommit(env, deletion);
        return jsonResponse(
          { deleted: true, deletion: status },
          status.status === "completed" ? 200 : 202,
          deletionReceiptCookie(deletion.receipt),
        );
      }

      if (request.method === "PATCH") {
        const body = await readJson(request);
        const requestNow = options.now?.() ?? new Date();
        const [feasibilityStart, feasibilityCompletion, latestFeasibilityCorrection] = await Promise.all([
          db.prepare(`SELECT activation_id, trip_id, event_sha256, source_record_sha256,
              participant_group_id, recruitment_frame_id, recruitment_source_id, selection_method,
              score_influenced_choice, study_consent_version, study_consented_at, target_taxon_id,
              site_id, geographic_panel, mode, segment_start_at, angler_count,
              scoring_system_kind, scoring_system_version, scoring_system_sha256,
              opportunity_score, opportunity_window_id, snapshot_sha256,
              snapshot_suppression_sha256
            FROM validation_feasibility_events
            WHERE trip_id = ? AND event_type = 'started' LIMIT 1`)
            .bind(tripId).first<StoredFeasibilityStart>(),
          db.prepare(`SELECT activation_id, event_sha256 FROM validation_feasibility_events
            WHERE trip_id = ? AND event_type = 'completed' LIMIT 1`)
            .bind(tripId).first<{ activation_id: string; event_sha256: string }>(),
          db.prepare(`SELECT root_completion_event_sha256, event_sha256
            FROM validation_feasibility_corrections WHERE trip_id = ?
            ORDER BY sequence DESC LIMIT 1`)
            .bind(tripId).first<{ root_completion_event_sha256: string; event_sha256: string }>(),
        ]);
        if (feasibilityStart && (
          !feasibilityCompletion || feasibilityCompletion.activation_id !== feasibilityStart.activation_id ||
          (latestFeasibilityCorrection &&
            latestFeasibilityCorrection.root_completion_event_sha256 !== feasibilityCompletion.event_sha256)
        )) {
          throw new AuthError(
            409,
            "validation_correction_chain_invalid",
            "This validation-pilot trip cannot be edited until its correction chain is reconciled.",
          );
        }
        if (hasServerControlledObservationFields(body)) {
          throw new AuthError(
            422,
            "observation_contract_override_forbidden",
            "The trip target and observation contract are controlled by CastingCompass.",
          );
        }
        assertOnlyFields(body, [
          "siteId",
          "startedAt",
          "endedAt",
          "mode",
          "anglerCount",
          "keeperCount",
          "shortReleasedCount",
          "fishingMethod",
          "gearProfileId",
          "rod",
          "reel",
          "baitLure",
          "rig",
          "otherCatchCount",
          "otherSpecies",
          "shorebreak",
          "wadingDepth",
          "waterClarity",
          "crowding",
          "fishabilityRating",
          "observedWaveHeightFeet",
          "fishabilityNotes",
          "notes",
        ]);
        const siteId = parseProfileTripSite(body.siteId, curatedSites);
        const startedAt = parseProfileTripDate(body.startedAt, "start time", requestNow);
        const endedAt = parseProfileTripDate(body.endedAt, "finish time", requestNow);
        const mode = parseProfileTripMode(body.mode ?? trip.mode);
        const durationHours = (new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 3_600_000;
        if (!Number.isFinite(durationHours) || durationHours < (1 / 60) || durationHours > 36) {
          throw new AuthError(422, "invalid_duration", "Trip duration must be between 1 minute and 36 hours.");
        }
        const anglerCount = parseProfileTripInteger(body.anglerCount, "angler count", 1, 12);
        const keeperCount = parseProfileTripInteger(body.keeperCount, "kept halibut", 0, 25);
        const shortReleasedCount = parseProfileTripInteger(body.shortReleasedCount, "short or released halibut", 0, 25);
        if (keeperCount + shortReleasedCount > 40) {
          throw new AuthError(422, "invalid_counts", "Combined halibut encounters cannot exceed 40.");
        }
        const fishingMethod = parseProfileTripText(body.fishingMethod, "fishing method", 80, true);
        let gearProfileId: string | null = null;
        if (typeof body.gearProfileId === "string" && body.gearProfileId.trim()) {
          if (!/^gear_[a-f0-9-]{36}$/.test(body.gearProfileId)) {
            throw new AuthError(422, "invalid_gear_profile", "Choose one of your saved gear presets.");
          }
          const gearProfile = await db.prepare("SELECT id FROM gear_profiles WHERE id = ? AND user_id = ? LIMIT 1")
            .bind(body.gearProfileId, user.id)
            .first();
          if (!gearProfile) throw new AuthError(422, "invalid_gear_profile", "Choose one of your saved gear presets.");
          gearProfileId = body.gearProfileId;
        }
        const rod = parseProfileTripText(body.rod, "rod", 160, false);
        const reel = parseProfileTripText(body.reel, "reel", 160, false);
        const baitLure = parseProfileTripText(body.baitLure, "bait or lure", 200, false);
        const rig = parseProfileTripText(body.rig, "rig", 200, false);
        const otherCatchCount = parseProfileTripInteger(body.otherCatchCount ?? 0, "other fish caught", 0, 100);
        const otherSpecies = parseProfileTripText(body.otherSpecies, "other species", 240, false);
        if (otherCatchCount === 0 && otherSpecies) {
          throw new AuthError(422, "invalid_other_species", "Enter an other-fish count when describing a non-halibut catch.");
        }
        const observations = parseProfileTripObservations(body);
        const notes = parseProfileTripText(body.notes, "notes", 1000, false);
        const timestamp = requestNow.toISOString();
        const anglerHours = Math.round(durationHours * anglerCount * 100) / 100;
        const forecastAttributionChanged = siteId !== trip.site_id
          || startedAt !== trip.started_at
          || endedAt !== trip.ended_at
          || mode !== trip.mode;
        const speciesObservation = trip.contract_status === "valid"
          ? buildSpeciesObservationFields({
              tripId,
              siteId,
              startedAt,
              endedAt,
              mode,
              anglerHours,
              keeperCount,
              shortReleasedCount,
              otherCatchCount,
            })
          : {
              observationContractVersion: trip.observation_contract_version,
              taxonCatalogVersion: trip.taxon_catalog_version,
              targetTaxonId: trip.target_taxon_id,
              contractStatus: trip.contract_status,
              taxonObservationsJson: trip.taxon_observations_json,
              outcomeClass: trip.outcome_class,
              targetEncounterCount: trip.target_encounter_count,
              anyFishEncounterCount: trip.any_fish_encounter_count,
              targetIdentificationConfidence: trip.target_identification_confidence,
            };
        const noCatch = trip.contract_status === "valid"
          ? speciesObservation.anyFishEncounterCount === 0
          : keeperCount + shortReleasedCount + otherCatchCount === 0;
        const feasibilityCorrection = feasibilityStart && feasibilityCompletion
          ? await buildFeasibilityCorrectionEvent({
              start: feasibilityStart,
              rootCompletionEventSha256: feasibilityCompletion.event_sha256,
              previousEventSha256: latestFeasibilityCorrection?.event_sha256 ?? feasibilityCompletion.event_sha256,
              siteId,
              mode,
              segmentStartAt: startedAt,
              segmentEndAt: endedAt,
              anglerCount,
              targetEncounterCount: keeperCount + shortReleasedCount,
              targetRetainedCount: keeperCount,
              targetReleasedCount: shortReleasedCount,
              correctedAt: timestamp,
            })
          : null;
        if (feasibilityStart && !feasibilityCorrection) {
          throw new AuthError(
            422,
            "validation_correction_invalid",
            "The edited trip is outside the validation-pilot correction contract.",
          );
        }
        const forecastInvalidation = forecastAttributionChanged
          ? `opportunity_window_id = NULL, opportunity_score = NULL, habitat_score = NULL,
             seasonality_score = NULL, conditions_score = NULL, fishability_score = NULL,
             model_version = NULL, prediction_metadata_json = NULL,`
          : "";
        const updateStatement = db.prepare(`UPDATE trips SET site_id = ?, started_at = ?, ended_at = ?, mode = ?, fishing_method = ?,
          angler_count = ?, angler_hours = ?, keeper_count = ?, short_released_count = ?,
          halibut_encounters = ?, no_catch = ?, gear_profile_id = ?, rod = ?, reel = ?, bait_lure = ?, rig = ?,
          other_catch_count = ?, other_species = ?, observations_json = ?, notes = ?, updated_at = ?, completed_at = ?,
          ${forecastInvalidation}
          observation_contract_version = ?, taxon_catalog_version = ?, target_taxon_id = ?, contract_status = ?,
          taxon_observations_json = ?, outcome_class = ?, target_encounter_count = ?, any_fish_encounter_count = ?,
          target_identification_confidence = ?,
          ai_review_status = 'retry', ai_review_json = NULL, ai_reviewed_at = NULL
          WHERE id = ? AND user_id = ? AND moderation_status = 'pending'`)
          .bind(
            siteId,
            startedAt,
            endedAt,
            mode,
            fishingMethod,
            anglerCount,
            anglerHours,
            keeperCount,
            shortReleasedCount,
            keeperCount + shortReleasedCount,
            Number(noCatch),
            gearProfileId,
            rod,
            reel,
            baitLure,
            rig,
            otherCatchCount,
            otherSpecies,
            observations,
            notes,
            timestamp,
            endedAt,
            speciesObservation.observationContractVersion,
            speciesObservation.taxonCatalogVersion,
            speciesObservation.targetTaxonId,
            speciesObservation.contractStatus,
            speciesObservation.taxonObservationsJson,
            speciesObservation.outcomeClass,
            speciesObservation.targetEncounterCount,
            speciesObservation.anyFishEncounterCount,
            speciesObservation.targetIdentificationConfidence,
            tripId,
            user.id,
          );
        const statements = [
          updateStatement,
          db.prepare(`INSERT INTO trip_validation_provenance (
              id, trip_id, event_type, collection_contract_version, validation_protocol_id,
              cohort_id, source_role, recruitment_source_id, incentive_policy_id, selection_method,
              target_intent, mode_at_enrollment, score_influenced_choice, attestation_status,
              evidence_status, exclusion_reason, created_at
            ) SELECT ?, id, 'evidence_exclusion', 'castingcompass.validation-collection/1.0.0', NULL,
              'predeployment-context', 'context_only', 'profile-edit',
              'none-outcome-independent/1.0.0', 'legacy_unknown', 'legacy_unknown', ?, ?,
              'invalidated_after_edit', 'context_only', 'post_completion_profile_edit', ?
            FROM trips WHERE id = ? AND user_id = ? AND moderation_status = 'pending'`)
            .bind(
              `validation_${crypto.randomUUID()}`,
              trip.mode,
              trip.score_influenced_choice,
              timestamp,
              tripId,
              user.id,
            ),
        ];
        if (feasibilityCorrection) {
          statements.push(prepareConditionalFeasibilityCorrectionInsert(
            db,
            feasibilityCorrection,
            user.id,
            timestamp,
          ));
        }
        const [updateResult] = await db.batch(statements);
        if (mutationChanges(updateResult) !== 1) {
          return errorResponse(409, "trip_reviewed", "Reviewed trip logs can no longer be changed.");
        }
        const updatedTrip = await db.prepare("SELECT * FROM trips WHERE id = ? AND user_id = ? LIMIT 1")
          .bind(tripId, user.id)
          .first<TripRow>();
        if (updatedTrip) options.onTripUpdated?.(updatedTrip);
        return jsonResponse({
          updated: true,
          tripId,
          forecastAttributionCleared: forecastAttributionChanged,
          validationEvidenceExcluded: true,
          ...(feasibilityCorrection ? {
            validationFeasibilityCorrected: true,
            validationFeasibilityStatus: feasibilityCorrection.analyticalStatus,
          } : {}),
        });
      }

      return methodNotAllowed("PATCH, DELETE");
    }

    if (url.pathname === "/api/saved-sites") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      const rows = await db
        .prepare("SELECT site_id FROM saved_sites WHERE user_id = ? ORDER BY created_at DESC LIMIT 101")
        .bind(user.id)
        .all<{ site_id: string }>();
      const savedSites = enforceAccountResourceCeiling(
        rows.results ?? [],
        MAX_SAVED_SITES_PER_ACCOUNT,
        "saved_site_limit_exceeded",
        "saved-location",
      );
      return jsonResponse({ siteIds: savedSites.map((row) => row.site_id) });
    }

    const match = url.pathname.match(API_ROUTE_PATTERNS.savedSite);
    if (!match) return errorResponse(404, "not_found", "Account route not found.");
    assertSameOrigin(request);
    const siteId = match[1];
    if (!curatedSites.some((site) => site.id === siteId)) {
      return errorResponse(422, "invalid_site", "Choose a current CastingCompass location.");
    }
    if (request.method === "POST") {
      const result = await db.prepare(`INSERT OR IGNORE INTO saved_sites (user_id, site_id, created_at)
        SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM saved_sites WHERE user_id = ?) < 100`)
        .bind(user.id, siteId, new Date().toISOString(), user.id)
        .run();
      if (result.meta?.changes === 0) {
        const existing = await db.prepare(
          "SELECT 1 AS present FROM saved_sites WHERE user_id = ? AND site_id = ? LIMIT 1",
        ).bind(user.id, siteId).first<{ present: number }>();
        if (!existing) {
          throw new AuthError(409, "saved_site_limit_reached", "Remove a saved location before adding another.");
        }
      } else if (result.meta?.changes !== 1) {
        throw new AuthError(503, "saved_site_write_unconfirmed", "The saved location could not be confirmed.");
      }
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
    return accountRequestErrorResponse(error);
  }
}

export function turnstileActionForAccountRequest(request: Request) {
  if (request.method !== "POST") return null;
  const pathname = new URL(request.url).pathname;
  const actionByPath: Record<string, TurnstileAction> = {
    "/api/auth/signup/eligibility": TURNSTILE_ACTIONS.signupEligibility,
    "/api/auth/signup/request": TURNSTILE_ACTIONS.signupRequest,
    "/api/auth/signup/verify": TURNSTILE_ACTIONS.signupVerify,
    "/api/auth/challenge/resend": TURNSTILE_ACTIONS.challengeResend,
    "/api/auth/password/request": TURNSTILE_ACTIONS.passwordRequest,
    "/api/auth/password/reset": TURNSTILE_ACTIONS.passwordReset,
    "/api/auth/login": TURNSTILE_ACTIONS.login,
  };
  return actionByPath[pathname] ?? null;
}

function accountRequestErrorResponse(error: unknown) {
  if (error instanceof AuthError || error instanceof TurnstileVerificationError) {
    return errorResponse(error.status, error.code, error.message);
  }
  logEvent("error", "account.request.failed", safeErrorContext(error));
  return errorResponse(500, "internal_error", "The account request could not be completed.");
}

function parseProfileTripSite(value: unknown, curatedSites: readonly CuratedSite[]) {
  if (typeof value !== "string" || !curatedSites.some((site) => site.id === value)) {
    throw new AuthError(422, "invalid_site", "Choose a current CastingCompass location.");
  }
  return value;
}

function parseProfileTripDate(value: unknown, label: string, now = new Date()) {
  if (typeof value !== "string" || value.length > 80) {
    throw new AuthError(422, "invalid_date", `Enter a valid ${label}.`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() > now.getTime() + 15 * 60 * 1000) {
    throw new AuthError(422, "invalid_date", `Enter a valid ${label}.`);
  }
  return date.toISOString();
}

function parseProfileTripMode(value: unknown) {
  const allowed = new Set(["shore", "beach", "pier", "jetty", "kayak", "boat", "other"]);
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new AuthError(422, "invalid_mode", "Choose a supported fishing mode.");
  }
  return value;
}

function parseProfileTripInteger(value: unknown, label: string, minimum: number, maximum: number) {
  if (typeof value !== "number" && typeof value !== "string") {
    throw new AuthError(422, "invalid_number", `${label} must be a whole number from ${minimum} to ${maximum}.`);
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new AuthError(422, "invalid_number", `${label} must be a whole number from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function parseProfileTripText(value: unknown, label: string, maximum: number, required: boolean) {
  if ((value === null || value === undefined || value === "") && !required) return null;
  if (typeof value !== "string" || value.trim().length > maximum || (required && !value.trim())) {
    throw new AuthError(422, "invalid_text", `${label} must be ${required ? "provided and " : ""}under ${maximum} characters.`);
  }
  return value.trim() || null;
}

function parseGearProfile(body: Record<string, unknown>) {
  return {
    name: parseProfileTripText(body.name, "preset name", 60, true) as string,
    rod: parseProfileTripText(body.rod, "rod", 160, false),
    reel: parseProfileTripText(body.reel, "reel", 160, false),
    baitLure: parseProfileTripText(body.baitLure, "bait or lure", 200, false),
    rig: parseProfileTripText(body.rig, "rig", 200, false),
  };
}

function parseProfileTripObservations(body: Record<string, unknown>) {
  const observations = {
    shorebreak: parseProfileTripText(body.shorebreak, "shorebreak", 40, false),
    wadingDepth: parseProfileTripText(body.wadingDepth, "water depth", 40, false),
    waterClarity: parseProfileTripText(body.waterClarity, "water clarity", 40, false),
    crowding: parseProfileTripText(body.crowding, "crowding", 40, false),
    fishabilityRating: body.fishabilityRating === null || body.fishabilityRating === undefined || body.fishabilityRating === ""
      ? null
      : parseProfileTripInteger(body.fishabilityRating, "fishability rating", 1, 5),
    observedWaveHeightFeet: parseOptionalProfileTripNumber(body.observedWaveHeightFeet, "observed wave height", 0, 30),
    fishabilityNotes: parseProfileTripText(body.fishabilityNotes, "fishability notes", 500, false),
  };
  return Object.values(observations).some((value) => value !== null) ? JSON.stringify(observations) : null;
}

function parseOptionalProfileTripNumber(value: unknown, label: string, minimum: number, maximum: number) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" && typeof value !== "string") {
    throw new AuthError(422, "invalid_number", `${label} must be between ${minimum} and ${maximum}.`);
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new AuthError(422, "invalid_number", `${label} must be between ${minimum} and ${maximum}.`);
  }
  return Math.round(parsed * 10) / 10;
}

export function unauthorizedResponse() {
  return errorResponse(401, "authentication_required", "Sign in to submit a trip report or save a location.");
}

export function legalAcceptanceRequiredResponse(ageEligible = true) {
  return ageEligible
    ? errorResponse(428, "legal_acceptance_required", "Accept the current Terms and Privacy Policy to continue.")
    : errorResponse(428, "age_eligibility_unavailable", "This legacy account is paused because no prior age-eligibility confirmation is available. Export or delete it from Profile, or contact privacy support.");
}

interface PrivacyDeletionJobRow {
  scope: "account" | "trip";
  state: "active_data_removed" | "purging" | "completed" | "needs_attention";
  objects_total: number;
  objects_deleted: number;
  requested_at: string;
  completed_at: string | null;
}

type PrivacyObjectStore = "trip_photos" | "privacy_exports";

interface PrivacyDeletionObject {
  objectStore: PrivacyObjectStore;
  objectKey: string;
}

async function prepareDeletionJob(
  scope: PrivacyDeletionJobRow["scope"],
  stableSubjectId: string,
  ownerStableId: string,
  objects: PrivacyDeletionObject[],
) {
  const id = `deletion_${crypto.randomUUID()}`;
  const receipt = randomSecret(32);
  const timestamp = new Date().toISOString();
  const uniqueObjects = [...new Map(objects.map((object) => [
    `${object.objectStore}\u0000${object.objectKey}`,
    object,
  ])).values()];
  const tasks = await Promise.all(uniqueObjects.map(async ({ objectStore, objectKey }) => ({
    id: `deletion_task_${crypto.randomUUID()}`,
    objectStore,
    objectKey,
    objectKeyHash: await sha256(`${objectStore}\u0000${objectKey}`),
  })));
  const subjectHash = await sha256(`${scope}:${stableSubjectId}`);
  const ownerSubjectHash = await sha256(`account:${ownerStableId}`);
  const receiptHash = await sha256(receipt);
  const completed = tasks.length === 0;
  return {
    id,
    receipt,
    scope,
    requestedAt: timestamp,
    objectsTotal: tasks.length,
    jobStatement: (db: D1DatabaseLike) => db.prepare(`INSERT INTO privacy_deletion_jobs
      (id, receipt_hash, scope, subject_hash, owner_subject_hash, state, objects_total, objects_deleted,
        last_error_code, requested_at, active_data_removed_at, completed_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?)`)
      .bind(
        id,
        receiptHash,
        scope,
        subjectHash,
        ownerSubjectHash,
        completed ? "completed" : "active_data_removed",
        tasks.length,
        timestamp,
        timestamp,
        completed ? timestamp : null,
        timestamp,
      ),
    jobStatementForPendingTrip: (db: D1DatabaseLike, tripId: string, userId: string) => db.prepare(`INSERT INTO privacy_deletion_jobs
      (id, receipt_hash, scope, subject_hash, owner_subject_hash, state, objects_total, objects_deleted,
        last_error_code, requested_at, active_data_removed_at, completed_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM trips WHERE id = ? AND user_id = ? AND moderation_status = 'pending')`)
      .bind(
        id,
        receiptHash,
        scope,
        subjectHash,
        ownerSubjectHash,
        completed ? "completed" : "active_data_removed",
        tasks.length,
        timestamp,
        timestamp,
        completed ? timestamp : null,
        timestamp,
        tripId,
        userId,
      ),
    taskStatements: (db: D1DatabaseLike) => tasks.map((task) => db.prepare(`INSERT INTO privacy_deletion_tasks
      (id, job_id, object_key, object_key_hash, object_store, state, attempts, available_at, lease_expires_at,
        lease_token, last_error_code, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, ?, ?, NULL)`)
      .bind(task.id, id, task.objectKey, task.objectKeyHash, task.objectStore, timestamp, timestamp, timestamp)),
    taskStatementsForPendingTrip: (db: D1DatabaseLike, tripId: string, userId: string) => tasks.map((task) => db.prepare(`INSERT INTO privacy_deletion_tasks
      (id, job_id, object_key, object_key_hash, object_store, state, attempts, available_at, lease_expires_at,
        lease_token, last_error_code, created_at, updated_at, completed_at)
      SELECT ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, ?, ?, NULL
      WHERE EXISTS (SELECT 1 FROM trips WHERE id = ? AND user_id = ? AND moderation_status = 'pending')`)
      .bind(task.id, id, task.objectKey, task.objectKeyHash, task.objectStore, timestamp, timestamp, timestamp, tripId, userId)),
  };
}

function mutationChanges(result: unknown) {
  if (!result || typeof result !== "object") return 0;
  const meta = (result as { meta?: { changes?: unknown } }).meta;
  const changes = Number(meta?.changes ?? 0);
  return Number.isFinite(changes) ? changes : 0;
}

function prepareConditionalFeasibilityCorrectionInsert(
  db: D1DatabaseLike,
  correction: FeasibilityCorrectionRecord,
  userId: string,
  updatedAt: string,
) {
  return db.prepare(`INSERT INTO validation_feasibility_corrections (
      correction_id, activation_id, trip_id, correction_contract_version,
      root_completion_event_sha256, previous_event_sha256, correction_reason,
      analytical_status, site_id, geographic_panel, mode, segment_start_at,
      segment_end_at, angler_count, effort_minutes, target_encountered,
      target_encounter_count, target_retained_count, target_released_count,
      identification_confidence, corrected_at, event_sha256
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM trips WHERE id = ? AND user_id = ? AND moderation_status = 'pending'
        AND updated_at = ?
    )`)
    .bind(
      correction.correctionId,
      correction.activationId,
      correction.tripId,
      correction.correctionContractVersion,
      correction.rootCompletionEventSha256,
      correction.previousEventSha256,
      correction.correctionReason,
      correction.analyticalStatus,
      correction.siteId,
      correction.geographicPanel,
      correction.mode,
      correction.segmentStartAt,
      correction.segmentEndAt,
      correction.anglerCount,
      correction.effortMinutes,
      Number(correction.targetEncountered),
      correction.targetEncounterCount,
      correction.targetRetainedCount,
      correction.targetReleasedCount,
      correction.identificationConfidence,
      correction.correctedAt,
      correction.eventSha256,
      correction.tripId,
      userId,
      updatedAt,
    );
}

async function deletionStatusAfterCommit(
  env: AuthApiEnv,
  deletion: {
    id: string;
    receipt: string;
    scope: "account" | "trip";
    requestedAt: string;
    objectsTotal: number;
  },
) {
  const fallback = {
    status: deletion.objectsTotal === 0 ? "completed" as const : "processing" as const,
    scope: deletion.scope,
    requestedAt: deletion.requestedAt,
    completedAt: deletion.objectsTotal === 0 ? deletion.requestedAt : null,
    objectsTotal: deletion.objectsTotal,
    objectsDeleted: 0,
  };
  try {
    await processPrivacyDeletionTasks(env, deletion.id);
    const job = env.DB ? await selectDeletionJobByReceipt(env.DB, deletion.receipt) : null;
    return job ? publicDeletionStatus(job) : fallback;
  } catch (error) {
    logEvent("error", "privacy.deletion.cleanup_deferred", safeErrorContext(error));
    return fallback;
  }
}

async function selectDeletionJobByReceipt(db: D1DatabaseLike, receipt: string) {
  return db.prepare(`SELECT scope, state, objects_total, objects_deleted, requested_at, completed_at
    FROM privacy_deletion_jobs WHERE receipt_hash = ? LIMIT 1`)
    .bind(await sha256(receipt))
    .first<PrivacyDeletionJobRow>();
}

function publicDeletionStatus(job: PrivacyDeletionJobRow) {
  const status = job.state === "completed"
    ? "completed"
    : job.state === "needs_attention" ? "needs_attention" : "processing";
  return {
    status,
    scope: job.scope,
    requestedAt: job.requested_at,
    completedAt: job.completed_at,
    objectsTotal: Number(job.objects_total),
    objectsDeleted: Number(job.objects_deleted),
  };
}

interface PrivacyDeletionTaskRow {
  id: string;
  job_id: string;
  object_key: string | null;
  object_key_hash: string;
  object_store: PrivacyObjectStore;
  state: "pending" | "leased";
  attempts: number;
}

export async function processPrivacyDeletionTasks(env: AuthApiEnv, onlyJobId?: string) {
  if (!env.DB) return 0;
  const db = env.DB;
  await initialize(db);
  const now = new Date();
  const nowIso = now.toISOString();
  const query = onlyJobId
    ? `SELECT id, job_id, object_key, object_key_hash, object_store, state, attempts FROM privacy_deletion_tasks
       WHERE job_id = ?
         AND ((state = 'pending' AND available_at <= ?)
           OR (state = 'leased' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))
       ORDER BY created_at LIMIT 50`
    : `SELECT id, job_id, object_key, object_key_hash, object_store, state, attempts FROM privacy_deletion_tasks
       WHERE (state = 'pending' AND available_at <= ?)
         OR (state = 'leased' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
       ORDER BY available_at, created_at LIMIT 50`;
  const statement = db.prepare(query);
  const rows = onlyJobId
    ? await statement.bind(onlyJobId, nowIso, nowIso).all<PrivacyDeletionTaskRow>()
    : await statement.bind(nowIso, nowIso).all<PrivacyDeletionTaskRow>();
  const tasks = rows.results ?? [];
  if (!tasks.length) {
    await reconcileDeletionJobs(db);
    return 0;
  }

  const jobIds = new Set(tasks.map((task) => task.job_id));
  const runnableTasks: PrivacyDeletionTaskRow[] = [];
  for (const task of tasks) {
    if (task.state === "leased" && Number(task.attempts) >= MAX_DELETION_ATTEMPTS) {
      await db.prepare(`UPDATE privacy_deletion_tasks
        SET state = 'needs_attention', lease_expires_at = NULL, lease_token = NULL,
          last_error_code = 'object_delete_lease_expired', updated_at = ?
        WHERE id = ? AND state = 'leased' AND attempts >= ?
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`)
        .bind(nowIso, task.id, MAX_DELETION_ATTEMPTS, nowIso).run();
      continue;
    }
    if (task.object_key) {
      runnableTasks.push(task);
      continue;
    }
    await db.prepare(`UPDATE privacy_deletion_tasks
      SET state = 'needs_attention', attempts = CASE WHEN attempts < ? THEN ? ELSE attempts END,
        lease_expires_at = NULL, lease_token = NULL,
        last_error_code = 'object_locator_missing', updated_at = ?
      WHERE id = ? AND state != 'completed'`)
      .bind(MAX_DELETION_ATTEMPTS, MAX_DELETION_ATTEMPTS, nowIso, task.id).run();
  }
  if (!runnableTasks.length) {
    for (const jobId of jobIds) await refreshDeletionJobStatus(db, jobId);
    await reconcileDeletionJobs(db);
    return 0;
  }
  let completed = 0;
  for (const task of runnableTasks) {
    const bucket = task.object_store === "privacy_exports" ? env.PRIVACY_EXPORTS : env.TRIP_PHOTOS;
    if (!bucket) {
      const retryAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
      await db.prepare(`UPDATE privacy_deletion_tasks
        SET state = 'needs_attention', available_at = ?, lease_expires_at = NULL, lease_token = NULL,
          last_error_code = 'object_storage_unavailable', updated_at = ?
        WHERE id = ? AND state != 'completed'
          AND (state != 'leased' OR lease_expires_at IS NULL OR lease_expires_at <= ?)`)
        .bind(retryAt, nowIso, task.id, nowIso)
        .run();
      continue;
    }
    const leaseExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const leaseToken = randomSecret(24);
    const claimed = await db.prepare(`UPDATE privacy_deletion_tasks
      SET state = 'leased', attempts = attempts + 1, lease_expires_at = ?, lease_token = ?, updated_at = ?
      WHERE id = ?
        AND ((state = 'pending' AND available_at <= ?)
          OR (state = 'leased' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))`)
      .bind(leaseExpiresAt, leaseToken, nowIso, task.id, nowIso, nowIso)
      .run();
    if (Number(claimed.meta?.changes ?? 0) !== 1) continue;
    await db.prepare("UPDATE privacy_deletion_jobs SET state = 'purging', last_error_code = NULL, updated_at = ? WHERE id = ? AND state != 'completed'")
      .bind(nowIso, task.job_id).run();
    try {
      await bucket.delete(task.object_key as string);
      const finishedAt = new Date().toISOString();
      const finalized = await db.prepare(`UPDATE privacy_deletion_tasks SET state = 'completed', object_key = NULL,
        lease_expires_at = NULL, lease_token = NULL, last_error_code = NULL,
        completed_at = ?, updated_at = ?
        WHERE id = ? AND state = 'leased' AND lease_token = ?`)
        .bind(finishedAt, finishedAt, task.id, leaseToken).run();
      if (Number(finalized.meta?.changes ?? 0) === 1) {
        completed += 1;
        if (task.object_store === "privacy_exports") {
          await db.prepare(`UPDATE privacy_export_jobs
            SET state = 'expired', user_id = NULL, object_key = NULL, object_key_hash = NULL,
              content_sha256 = NULL, size_bytes = NULL, record_count = NULL,
              lease_expires_at = NULL, lease_token = NULL, last_error_code = NULL, updated_at = ?
            WHERE object_key_hash = ? AND user_id IS NULL AND state != 'completed'`)
            .bind(finishedAt, task.object_key_hash)
            .run();
        }
      }
    } catch {
      const attempts = Number(task.attempts) + 1;
      const backoffSeconds = Math.min(6 * 60 * 60, 30 * (2 ** Math.min(attempts - 1, 10)));
      const retryAt = new Date(Date.now() + backoffSeconds * 1000).toISOString();
      await db.prepare(`UPDATE privacy_deletion_tasks
        SET state = CASE WHEN attempts >= ? THEN 'needs_attention' ELSE 'pending' END,
        available_at = ?, lease_expires_at = NULL,
        lease_token = NULL, last_error_code = 'object_delete_failed', updated_at = ?
        WHERE id = ? AND state = 'leased' AND lease_token = ?`)
        .bind(MAX_DELETION_ATTEMPTS, retryAt, new Date().toISOString(), task.id, leaseToken).run();
    }
  }

  for (const jobId of jobIds) await refreshDeletionJobStatus(db, jobId);
  await reconcileDeletionJobs(db);
  return completed;
}

async function refreshDeletionJobStatus(db: D1DatabaseLike, jobId: string) {
  const timestamp = new Date().toISOString();
  await db.prepare(`UPDATE privacy_deletion_jobs SET
      objects_deleted = (SELECT COUNT(*) FROM privacy_deletion_tasks
        WHERE job_id = privacy_deletion_jobs.id AND state = 'completed'),
      state = CASE
        WHEN (SELECT COUNT(*) FROM privacy_deletion_tasks WHERE job_id = privacy_deletion_jobs.id) = objects_total
          AND NOT EXISTS (SELECT 1 FROM privacy_deletion_tasks
            WHERE job_id = privacy_deletion_jobs.id AND state != 'completed')
          THEN 'completed'
        WHEN (SELECT COUNT(*) FROM privacy_deletion_tasks WHERE job_id = privacy_deletion_jobs.id) != objects_total
          THEN 'needs_attention'
        WHEN EXISTS (SELECT 1 FROM privacy_deletion_tasks
          WHERE job_id = privacy_deletion_jobs.id AND state = 'needs_attention')
          THEN 'needs_attention'
        ELSE 'active_data_removed'
      END,
      last_error_code = CASE
        WHEN (SELECT COUNT(*) FROM privacy_deletion_tasks WHERE job_id = privacy_deletion_jobs.id) = objects_total
          AND NOT EXISTS (SELECT 1 FROM privacy_deletion_tasks
            WHERE job_id = privacy_deletion_jobs.id AND state != 'completed')
          THEN NULL
        WHEN (SELECT COUNT(*) FROM privacy_deletion_tasks WHERE job_id = privacy_deletion_jobs.id) != objects_total
          THEN 'task_ledger_incomplete'
        WHEN EXISTS (SELECT 1 FROM privacy_deletion_tasks
          WHERE job_id = privacy_deletion_jobs.id AND state = 'needs_attention')
          THEN 'photo_delete_incomplete'
        ELSE NULL
      END,
      completed_at = CASE
        WHEN (SELECT COUNT(*) FROM privacy_deletion_tasks WHERE job_id = privacy_deletion_jobs.id) = objects_total
          AND NOT EXISTS (SELECT 1 FROM privacy_deletion_tasks
            WHERE job_id = privacy_deletion_jobs.id AND state != 'completed')
          THEN COALESCE(completed_at, ?)
        ELSE NULL
      END,
      updated_at = ?
    WHERE id = ?`)
    .bind(timestamp, timestamp, jobId)
    .run();
}

async function reconcileDeletionJobs(db: D1DatabaseLike, onlyJobId?: string) {
  const rows = onlyJobId
    ? await db.prepare("SELECT id FROM privacy_deletion_jobs WHERE id = ? AND state != 'completed' LIMIT 1")
      .bind(onlyJobId).all<{ id: string }>()
    : await db.prepare(`SELECT id FROM privacy_deletion_jobs
      WHERE state != 'completed'
        OR objects_deleted != objects_total
        OR (SELECT COUNT(*) FROM privacy_deletion_tasks
          WHERE job_id = privacy_deletion_jobs.id) != objects_total
        OR EXISTS (SELECT 1 FROM privacy_deletion_tasks
          WHERE job_id = privacy_deletion_jobs.id AND state != 'completed')
      ORDER BY updated_at LIMIT 100`)
      .all<{ id: string }>();
  for (const job of rows.results ?? []) await refreshDeletionJobStatus(db, job.id);
}

function photoFileExtension(contentType: string) {
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  return "bin";
}

function safePhotoContentType(value: unknown) {
  return value === "image/jpeg" || value === "image/png" || value === "image/webp"
    ? value
    : "application/octet-stream";
}

export async function cleanupAuthData(env: AuthApiEnv) {
  if (!env.DB) return;
  await initialize(env.DB);
  const now = new Date();
  const expiredChallengeCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const attemptCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const proofCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const tombstoneCutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM auth_sessions WHERE token_hash IN (
      SELECT token_hash FROM auth_sessions WHERE expires_at <= ?
      ORDER BY expires_at, token_hash LIMIT ?
    )`).bind(now.toISOString(), AUTH_RETENTION_DELETE_BATCH),
    env.DB.prepare(`DELETE FROM email_challenges WHERE id IN (
      SELECT id FROM email_challenges WHERE expires_at <= ?
      ORDER BY expires_at, id LIMIT ?
    )`).bind(expiredChallengeCutoff, AUTH_RETENTION_DELETE_BATCH),
    env.DB.prepare(`DELETE FROM auth_attempts WHERE id IN (
      SELECT id FROM auth_attempts WHERE attempted_at < ?
      ORDER BY attempted_at, id LIMIT ?
    )`).bind(attemptCutoff, AUTH_RETENTION_DELETE_BATCH),
    env.DB.prepare(`DELETE FROM signup_age_proofs WHERE token_hash IN (
      SELECT token_hash FROM signup_age_proofs
      WHERE expires_at < ? OR (consumed_at IS NOT NULL AND consumed_at < ?)
      LIMIT ?
    )`).bind(proofCutoff, proofCutoff, AUTH_RETENTION_DELETE_BATCH),
    env.DB.prepare(`DELETE FROM privacy_deletion_jobs
      WHERE id IN (
        SELECT id FROM privacy_deletion_jobs
        WHERE state = 'completed' AND completed_at < ?
          AND objects_deleted = objects_total
          AND (SELECT COUNT(*) FROM privacy_deletion_tasks
            WHERE job_id = privacy_deletion_jobs.id) = objects_total
          AND NOT EXISTS (SELECT 1 FROM privacy_deletion_tasks
            WHERE job_id = privacy_deletion_jobs.id AND state != 'completed')
        ORDER BY completed_at, id LIMIT ?
      )`).bind(tombstoneCutoff, AUTH_RETENTION_DELETE_BATCH),
    env.DB.prepare(`DELETE FROM privacy_export_jobs WHERE id IN (
      SELECT id FROM privacy_export_jobs
      WHERE state = 'expired' AND updated_at < ? AND object_key IS NULL
      ORDER BY updated_at, id LIMIT ?
    )`).bind(tombstoneCutoff, AUTH_RETENTION_DELETE_BATCH),
  ]);
  await processExpiredPrivacyExports(env);
  await processPrivacyDeletionTasks(env);
}

async function selectUserForSession(db: D1DatabaseLike, userId: string) {
  const row = await db.prepare(`SELECT id, email,
    CASE WHEN age_eligibility_confirmed_at IS NOT NULL THEN 1 ELSE 0 END AS age_eligible,
    CASE WHEN age_eligibility_confirmed_at IS NOT NULL AND terms_version = ? AND privacy_version = ?
      THEN 1 ELSE 0 END AS legal_accepted
    FROM users WHERE id = ? LIMIT 1`)
    .bind(LEGAL_VERSION, LEGAL_VERSION, userId)
    .first<{ id: string; email: string; age_eligible: number; legal_accepted: number }>();
  return row ? {
    id: row.id,
    email: row.email,
    ageEligible: Boolean(row.age_eligible),
    legalAccepted: Boolean(row.legal_accepted),
  } : null;
}

async function createSessionResponse(db: D1DatabaseLike, request: Request, user: AuthUser, status = 200) {
  const token = randomSecret(32);
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + SESSION_SECONDS * 1000);
  const priorSessionDeletes = await Promise.all(presentedSessionTokens(request).map(async (presented) =>
    db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(await sha256(presented.token))));
  await db.batch([
    ...priorSessionDeletes,
    db.prepare("INSERT INTO auth_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256(token), user.id, expiresAt.toISOString(), createdAt.toISOString()),
  ]);
  return jsonResponse({ user }, status, sessionCookie(request, token));
}

function sessionCookie(request: Request, token: string) {
  if (new URL(request.url).protocol === "https:") {
    return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; SameSite=Lax; Secure`;
  }
  return `${LEGACY_SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; SameSite=Lax`;
}

function clearSessionCookies(request: Request) {
  const secure = new URL(request.url).protocol === "https:";
  return [
    ...(secure ? [`${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`] : []),
    `${LEGACY_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`,
  ];
}

function deletionReceiptCookie(receipt: string) {
  return `${DELETION_RECEIPT_COOKIE}=${receipt}; Path=/api/privacy/deletion-status; Max-Age=${DELETION_RECEIPT_SECONDS}; HttpOnly; SameSite=Lax; Secure`;
}

function clearDeletionReceiptCookie() {
  return `${DELETION_RECEIPT_COOKIE}=; Path=/api/privacy/deletion-status; Max-Age=0; HttpOnly; SameSite=Lax; Secure`;
}

function ageIneligibleCookie() {
  return `${AGE_INELIGIBLE_COOKIE}=1; Path=/api/auth/signup; Max-Age=${24 * 60 * 60}; HttpOnly; SameSite=Lax; Secure`;
}

function clearAgeIneligibleCookie() {
  return `${AGE_INELIGIBLE_COOKIE}=; Path=/api/auth/signup; Max-Age=0; HttpOnly; SameSite=Lax; Secure`;
}

function clearReporterCookie() {
  return "cc_reporter=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict; Secure";
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

export function parseNewPassword(value: unknown) {
  if (typeof value !== "string") {
    throw new AuthError(
      422,
      "invalid_password",
      `Use a password between ${NEW_PASSWORD_MINIMUM_CHARACTERS} and ${PASSWORD_MAXIMUM_CHARACTERS} characters.`,
    );
  }
  const characterCount = Array.from(value).length;
  if (characterCount < NEW_PASSWORD_MINIMUM_CHARACTERS || characterCount > PASSWORD_MAXIMUM_CHARACTERS) {
    throw new AuthError(
      422,
      "invalid_password",
      `Use a password between ${NEW_PASSWORD_MINIMUM_CHARACTERS} and ${PASSWORD_MAXIMUM_CHARACTERS} characters.`,
    );
  }
  return value;
}

/**
 * Screen a prospective password only after the complete value is submitted.
 * HIBP receives a padded five-character SHA-1 prefix, never the password,
 * account email, or complete hash. SHA-1 is used solely because it is the
 * range API's lookup format; stored passwords continue to use salted PBKDF2.
 */
export async function assertNewPasswordAllowed(
  password: string,
  email: string,
  fetcher: typeof fetch = fetch,
) {
  if (isContextSpecificPassword(password, email)) {
    throw new AuthError(
      422,
      "context_specific_password",
      "Choose a password that is not based on your email address or the CastingCompass name.",
    );
  }

  const passwordSha1 = await sha1(password);
  const prefix = passwordSha1.slice(0, 5);
  const suffix = passwordSha1.slice(5);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PWNED_PASSWORDS_TIMEOUT_MS);

  try {
    const response = await fetcher(`${PWNED_PASSWORDS_RANGE_URL}${prefix}`, {
      method: "GET",
      headers: {
        Accept: "text/plain",
        "Add-Padding": "true",
        "User-Agent": "CastingCompass password safety/1.0",
      },
      signal: controller.signal,
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("unexpected Pwned Passwords status");
    }
    const range = await readBoundedText(response, PWNED_PASSWORDS_MAX_RESPONSE_BYTES);
    let parsedEntries = 0;
    for (const rawLine of range.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const match = line.match(/^([A-F0-9]{35}):(\d+)$/i);
      if (!match) throw new Error("invalid Pwned Passwords response");
      parsedEntries += 1;
      if (match[1].toUpperCase() === suffix && Number(match[2]) > 0) {
        throw new AuthError(
          422,
          "compromised_password",
          "That password appears in known breach data. Choose a unique password or passphrase.",
        );
      }
    }
    if (parsedEntries === 0) throw new Error("empty Pwned Passwords response");
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError(
      503,
      "password_screening_unavailable",
      "Password safety screening is temporarily unavailable. No account change was made; try again shortly.",
    );
  } finally {
    clearTimeout(timeout);
  }
}

function isContextSpecificPassword(password: string, email: string) {
  const candidate = passwordComparisonToken(password);
  const [localPart = "", domain = ""] = email.split("@", 2);
  const roots = new Set([
    "castingcompass",
    "castingcompasscom",
    passwordComparisonToken(localPart),
    passwordComparisonToken(domain),
    passwordComparisonToken(email),
  ]);
  for (const root of roots) {
    if (root.length < 4 || !candidate.startsWith(root)) continue;
    const suffix = candidate.slice(root.length);
    if (/^\d{0,6}$/.test(suffix)) return true;
  }
  return false;
}

function passwordComparisonToken(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]/gu, "");
}

async function readBoundedText(response: Response, maximumBytes: number) {
  if (!response.body) throw new Error("missing response body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maximumBytes) {
        await reader.cancel("Pwned Passwords response exceeds limit");
        throw new Error("oversized response body");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function assertSignupLegalAcceptance(body: Record<string, unknown>) {
  if (body.termsAccepted !== true || body.privacyAccepted !== true) {
    throw new AuthError(422, "legal_acceptance_required", "Accept the Terms of Service and Privacy Policy to create an account.");
  }
}

function assertOnlyFields(body: Record<string, unknown>, allowed: string[]) {
  const allowedFields = new Set(allowed);
  if (Object.keys(body).some((field) => !allowedFields.has(field))) {
    throw new AuthError(422, "unexpected_fields", "Send only the fields required for this account step.");
  }
}

interface ValidSignupAgeProof {
  tokenHash: string;
  confirmedAt: string;
}

async function validateSignupAgeProof(db: D1DatabaseLike, value: unknown): Promise<ValidSignupAgeProof> {
  const proof = typeof value === "string" ? value : "";
  if (!/^[A-Za-z0-9_-]{40,160}$/.test(proof)) {
    throw new AuthError(422, "eligibility_proof_required", "Confirm age eligibility before entering account details.");
  }
  const tokenHash = await sha256(proof);
  const checkedAt = new Date().toISOString();
  const row = await db.prepare(`SELECT confirmed_at FROM signup_age_proofs
    WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ? AND gate_version = ?
    LIMIT 1`)
    .bind(tokenHash, checkedAt, AGE_GATE_VERSION)
    .first<{ confirmed_at: string }>();
  if (!row?.confirmed_at) {
    throw new AuthError(410, "eligibility_proof_expired", "Age eligibility expired or was already used. Start the age step again.");
  }
  return { tokenHash, confirmedAt: row.confirmed_at };
}

async function consumeSignupAgeProof(db: D1DatabaseLike, proof: ValidSignupAgeProof) {
  const consumedAt = new Date().toISOString();
  const result = await db.prepare(`UPDATE signup_age_proofs SET consumed_at = ?
    WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ? AND gate_version = ?`)
    .bind(consumedAt, proof.tokenHash, consumedAt, AGE_GATE_VERSION)
    .run();
  if (Number(result.meta?.changes ?? 0) !== 1) {
    throw new AuthError(410, "eligibility_proof_expired", "Age eligibility expired or was already used. Start the age step again.");
  }
  return proof.confirmedAt;
}

export function evaluateAgeEligibility(value: unknown, now = new Date()) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AuthError(422, "invalid_birth_date", "Enter a valid birth date.");
  }
  const [year, month, day] = value.split("-").map(Number);
  const birthDate = new Date(Date.UTC(year, month - 1, day));
  if (birthDate.getUTCFullYear() !== year || birthDate.getUTCMonth() !== month - 1 || birthDate.getUTCDate() !== day) {
    throw new AuthError(422, "invalid_birth_date", "Enter a valid birth date.");
  }
  // Account eligibility follows the product's California calendar, not UTC,
  // so a birthday does not arrive several hours early on the West Coast.
  const today = losAngelesCalendarDate(now);
  const dateOrder = year - today.year || month - today.month || day - today.day;
  if (dateOrder > 0 || today.year - year > 120) {
    throw new AuthError(422, "invalid_birth_date", "Enter a valid birth date.");
  }
  let age = today.year - year;
  if (today.month < month || (today.month === month && today.day < day)) age -= 1;
  if (age < MINIMUM_ACCOUNT_AGE) {
    throw new AuthError(403, "age_restricted", "CastingCompass accounts are available only to people age 13 or older.");
  }
  if (age > 120) {
    throw new AuthError(422, "invalid_birth_date", "Enter a valid birth date.");
  }
  // The birth date is deliberately not retained. Only this eligibility timestamp is stored.
  return now.toISOString();
}

function losAngelesCalendarDate(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const values = Object.fromEntries(parts
    .filter((part) => part.type === "year" || part.type === "month" || part.type === "day")
    .map((part) => [part.type, Number(part.value)]));
  return { year: values.year, month: values.month, day: values.day };
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

interface EmailChallengeRow {
  id: string;
  kind: "signup" | "password_reset";
  email: string;
  user_id: string | null;
  code_hash: string;
  password_salt: string | null;
  password_hash: string | null;
  age_eligibility_confirmed_at: string | null;
  terms_version: string | null;
  privacy_version: string | null;
  expires_at: string;
  attempts: number;
  resend_count: number;
  created_at: string;
}

async function assertEmailChallengeAllowed(db: D1DatabaseLike, email: string) {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const row = await db.prepare("SELECT COUNT(*) AS count FROM email_challenges WHERE email = ? AND created_at >= ?")
    .bind(email, cutoff)
    .first<{ count: number }>();
  if (Number(row?.count ?? 0) >= 5) {
    throw new AuthError(429, "too_many_codes", "Too many email codes were requested. Try again in an hour.");
  }
}

async function verifyEmailChallenge(
  db: D1DatabaseLike,
  challengeIdValue: unknown,
  codeValue: unknown,
  kind: EmailChallengeRow["kind"],
) {
  const challengeId = typeof challengeIdValue === "string" ? challengeIdValue : "";
  const code = typeof codeValue === "string" ? codeValue.trim() : "";
  if (!/^challenge_[a-f0-9-]{36}$/.test(challengeId) || !/^\d{6}$/.test(code)) {
    throw new AuthError(422, "invalid_code", "Enter the six-digit code from your email.");
  }
  const row = await db.prepare("SELECT * FROM email_challenges WHERE id = ? AND kind = ? LIMIT 1")
    .bind(challengeId, kind)
    .first<EmailChallengeRow>();
  if (!row || row.expires_at <= new Date().toISOString()) {
    if (row) await db.prepare("DELETE FROM email_challenges WHERE id = ?").bind(challengeId).run();
    if (kind === "password_reset") {
      throw new AuthError(401, "invalid_code", "That code is invalid or expired. Request a new one.");
    }
    throw new AuthError(410, "code_expired", "That code expired. Request a new one.");
  }
  if (Number(row.attempts) >= 6) {
    if (kind === "password_reset") {
      await db.prepare("DELETE FROM email_challenges WHERE id = ?").bind(challengeId).run();
      throw new AuthError(401, "invalid_code", "That code is invalid or expired. Request a new one.");
    }
    throw new AuthError(429, "too_many_code_attempts", "Too many code attempts. Request a new code.");
  }
  const valid = (await sha256(`${challengeId}:${code}`)) === row.code_hash;
  if (!valid) {
    if (kind === "password_reset" && Number(row.attempts) >= 5) {
      await db.prepare("DELETE FROM email_challenges WHERE id = ?").bind(challengeId).run();
    } else {
      await db.prepare("UPDATE email_challenges SET attempts = attempts + 1 WHERE id = ?").bind(challengeId).run();
    }
    if (kind === "password_reset") {
      throw new AuthError(401, "invalid_code", "That code is invalid or expired. Request a new one.");
    }
    throw new AuthError(401, "invalid_code", "That verification code is incorrect.");
  }
  return row;
}

async function sendVerificationEmail(
  env: AuthApiEnv,
  to: string,
  code: string,
  subject: string,
  idempotencyKey = `${subject}:${to}:${code}`,
) {
  if (!env.RESEND_API_KEY) {
    throw new AuthError(503, "email_not_configured", "Email verification is waiting for the site mail sender to be connected.");
  }
  const from = env.AUTH_EMAIL_FROM ?? "CastingCompass <account@castingcompass.com>";
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `castingcompass/${idempotencyKey}`.slice(0, 256),
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      text: `Your CastingCompass verification code is ${code}. It expires in 15 minutes. If you did not request this, you can ignore this email.`,
      html: `<div style="font-family:Arial,sans-serif;color:#081a33"><h1>CastingCompass</h1><p>Your verification code is:</p><p style="font-size:32px;font-weight:700;letter-spacing:8px">${code}</p><p>This code expires in 15 minutes. If you did not request it, you can ignore this email.</p></div>`,
    }),
  });
  if (!response.ok) {
    logEvent("error", "email.transactional.delivery_failed", {
      status: response.status,
      provider_request_id: providerRequestId(response),
    });
    await response.body?.cancel().catch(() => undefined);
    throw new AuthError(502, "email_delivery_failed", "The verification email could not be sent. Try again shortly.");
  }
  const receipt = await response.json().catch(() => null) as { id?: string } | null;
  logEvent("info", "email.transactional.accepted", {
    provider: "resend",
    provider_request_id: safeProviderIdentifier(receipt?.id),
  });
}

async function sendWelcomeEmail(env: AuthApiEnv, to: string, userId: string) {
  if (!env.RESEND_API_KEY) return;
  const from = env.AUTH_EMAIL_FROM ?? "CastingCompass <account@castingcompass.com>";
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `castingcompass/welcome/${userId}`,
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: "Welcome to CastingCompass",
      text: "Welcome to CastingCompass. Start by saving a few fishing spots, checking the practical fishability details before you leave, and logging the full trip when you get back—even when it is a skunk. CastingCompass is still a work in progress, and complete trip logs are especially valuable right now because they create the real-world backlog needed to test and improve the model. Scores are planning guidance, not catch guarantees. Respect access rules, the water, and current California regulations.",
      html: `<div style="font-family:Arial,sans-serif;line-height:1.55;color:#081a33;max-width:620px"><h1>Welcome to CastingCompass.</h1><p>Save a few fishing spots, check practical fishability before you leave, and log the full trip when you get back, even when it is a skunk.</p><h2>Quick guide</h2><ol><li>Choose the hours you can fish.</li><li>Compare the opportunity and fishability details.</li><li>Save the spot and add your gear.</li><li>Log the result, conditions you observed, and any catch.</li></ol><p><strong>This project is still a work in progress.</strong> Complete trip logs are especially helpful right now because they create the real-world backlog needed to test and improve the model.</p><p>Scores are planning guidance, not catch guarantees. Respect access rules, the water, and current California regulations.</p><p><a href="https://castingcompass.com">Open CastingCompass</a></p></div>`,
    }),
  });
  if (!response.ok) {
    logEvent("error", "email.welcome.provider_failed", {
      status: response.status,
      provider_request_id: providerRequestId(response),
    });
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Welcome email provider request failed");
  }
  const receipt = await response.json().catch(() => null) as { id?: string } | null;
  logEvent("info", "email.welcome.accepted", {
    provider: "resend",
    provider_request_id: safeProviderIdentifier(receipt?.id),
  });
}

const VERIFICATION_CODE_SPACE = 1_000_000;
const UINT32_SPACE = 2 ** 32;
const UNBIASED_VERIFICATION_CODE_LIMIT =
  Math.floor(UINT32_SPACE / VERIFICATION_CODE_SPACE) * VERIFICATION_CODE_SPACE;

function secureRandomUint32() {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

export function randomCode(randomUint32: () => number = secureRandomUint32) {
  let value: number;
  do {
    value = randomUint32();
  } while (value >= UNBIASED_VERIFICATION_CODE_LIMIT);
  return String(value % VERIFICATION_CODE_SPACE).padStart(6, "0");
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

async function sha1(value: string) {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
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

function presentedSessionTokens(request: Request) {
  const cookies = parseCookies(request.headers.get("Cookie") ?? "");
  const tokens: Array<{
    cookieName: typeof SESSION_COOKIE | typeof LEGACY_SESSION_COOKIE;
    token: string;
  }> = [];
  const seen = new Set<string>();
  for (const cookieName of [SESSION_COOKIE, LEGACY_SESSION_COOKIE] as const) {
    const token = cookies.get(cookieName);
    if (!token || !/^[A-Za-z0-9_-]{40,160}$/.test(token) || seen.has(token)) continue;
    seen.add(token);
    tokens.push({ cookieName, token });
  }
  return tokens;
}

function minimumDelay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function passwordRecoveryRequestedResponse(challengeId = `challenge_${crypto.randomUUID()}`) {
  return jsonResponse({ requested: true, challengeId, expiresInMinutes: 15 });
}

function passwordRecoveryResendResponse(challengeId: string) {
  return jsonResponse({ requested: true, challengeId, expiresInMinutes: 15, retryAfterSeconds: 60 });
}

function deferPasswordRecoveryEmail(
  options: AccountRequestOptions,
  db: D1DatabaseLike,
  challengeId: string,
  delivery: Promise<void>,
) {
  const guardedDelivery = delivery.catch(async (error) => {
    try {
      await db.prepare("DELETE FROM email_challenges WHERE id = ?").bind(challengeId).run();
    } catch (cleanupError) {
      logEvent("error", "password_recovery.challenge_cleanup_failed", safeErrorContext(cleanupError));
    }
    logEvent("error", "password_recovery.email_delivery_deferred", safeErrorContext(error));
  });
  options.waitUntil?.(guardedDelivery);
  return guardedDelivery;
}

function assertSameOrigin(request: Request) {
  const origin = request.headers.get("Origin");
  if (!origin || new URL(origin).origin !== new URL(request.url).origin) {
    throw new AuthError(403, "invalid_origin", "Account changes must come from CastingCompass.");
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

function jsonResponse(body: unknown, status = 200, cookie?: string | string[], extraHeaders?: HeadersInit) {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  if (cookie) {
    for (const value of Array.isArray(cookie) ? cookie : [cookie]) headers.append("Set-Cookie", value);
  }
  return new Response(JSON.stringify(body), { status, headers });
}
