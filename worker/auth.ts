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
const ACCOUNT_DELETION_FENCE_LEASE_MS = 5 * 60 * 1000;
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
const PRIVACY_DELETION_TASK_BATCH = 5;
const ACCOUNT_DELETION_INLINE_TASK_BATCH = 3;

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
  onTripReviewRequested?(trip: TripRow): void;
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

const AUTH_SCHEMA_READY_SQL = `SELECT
  (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN (
    'users', 'auth_sessions', 'saved_sites', 'auth_attempts', 'email_challenges',
    'gear_profiles', 'signup_age_proofs', 'privacy_deletion_jobs',
    'privacy_deletion_tasks', 'privacy_export_jobs', 'account_deletion_fences',
    'trip_photo_upload_reservations', 'trips'
  )) AS required_tables,
  (SELECT COUNT(*) FROM pragma_table_info('trips') WHERE name = 'photo_key_hash') AS photo_hash_columns`;

async function initialize(db: D1DatabaseLike) {
  let pending = initializedDatabases.get(db as object);
  if (!pending) {
    pending = (async () => {
      const readiness = await db.prepare(AUTH_SCHEMA_READY_SQL)
        .first<{ required_tables: number; photo_hash_columns: number }>();
      if (Number(readiness?.required_tables ?? 0) !== 13
        || Number(readiness?.photo_hash_columns ?? 0) !== 1) {
        throw new AuthError(
          503,
          "auth_schema_unavailable",
          "Account services are paused until the reviewed database migration is complete.",
        );
      }
    })().catch((error) => {
      initializedDatabases.delete(db as object);
      throw error;
    });
    initializedDatabases.set(db as object, pending);
  }
  await pending;
}

export interface AuthenticatedSession {
  user: AuthUser;
  accountVersion: AuthenticatedAccountVersion;
  sessionTokenHash: string;
  sessionExpiresAt: string;
  deletionFenced: boolean;
  cookieName: typeof SESSION_COOKIE | typeof LEGACY_SESSION_COOKIE;
}

interface AuthenticatedAccountVersion {
  id: string;
  email: string;
  ageEligibilityConfirmedAt: string;
  termsAcceptedAt: string | null;
  termsVersion: string | null;
  privacyAcceptedAt: string | null;
  privacyVersion: string | null;
  createdAt: string;
  updatedAt: string;
}

async function getAuthenticatedSession(request: Request, env: AuthApiEnv): Promise<AuthenticatedSession | null> {
  if (!env.DB) return null;
  await initialize(env.DB);
  const now = new Date().toISOString();
  for (const presented of presentedSessionTokens(request)) {
    const tokenHash = await sha256(presented.token);
    const row = await env.DB
      .prepare(`SELECT users.id, users.email,
          users.age_eligibility_confirmed_at, users.terms_accepted_at, users.terms_version,
          users.privacy_accepted_at, users.privacy_version, users.created_at, users.updated_at,
          auth_sessions.expires_at AS session_expires_at,
          CASE WHEN users.age_eligibility_confirmed_at IS NOT NULL THEN 1 ELSE 0 END AS age_eligible,
          CASE WHEN users.age_eligibility_confirmed_at IS NOT NULL
            AND users.terms_version = ? AND users.privacy_version = ?
            THEN 1 ELSE 0 END AS legal_accepted,
          CASE WHEN EXISTS (SELECT 1 FROM account_deletion_fences
            WHERE account_deletion_fences.user_id = users.id)
            THEN 1 ELSE 0 END AS deletion_fenced
        FROM auth_sessions
        JOIN users ON users.id = auth_sessions.user_id
        WHERE auth_sessions.token_hash = ? AND auth_sessions.expires_at > ?
        LIMIT 1`)
      .bind(LEGAL_VERSION, LEGAL_VERSION, tokenHash, now)
      .first<{
        id: string;
        email: string;
        age_eligibility_confirmed_at: string | null;
        terms_accepted_at: string | null;
        terms_version: string | null;
        privacy_accepted_at: string | null;
        privacy_version: string | null;
        created_at: string;
        updated_at: string;
        session_expires_at: string;
        age_eligible: number;
        legal_accepted: number;
        deletion_fenced: number;
      }>();
    if (row) {
      return {
        accountVersion: {
          id: row.id,
          email: row.email,
          ageEligibilityConfirmedAt: row.age_eligibility_confirmed_at ?? "",
          termsAcceptedAt: row.terms_accepted_at,
          termsVersion: row.terms_version,
          privacyAcceptedAt: row.privacy_accepted_at,
          privacyVersion: row.privacy_version,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        },
        sessionTokenHash: tokenHash,
        sessionExpiresAt: row.session_expires_at,
        cookieName: presented.cookieName,
        deletionFenced: Boolean(row.deletion_fenced),
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
  const session = await getAuthenticatedSession(request, env);
  return session && !session.deletionFenced ? session.user : null;
}

export interface OwnerAuthorizationOptions {
  currentLegalAcceptanceRequired: boolean;
  deletionFenceAccessAllowed: boolean;
}

export type OwnerAuthorizationResult =
  | { session: AuthenticatedSession; response: null }
  | { session: null; response: Response };

export type DeletionReceiptAuthorizationResult =
  | { response: null }
  | { response: Response };

export type OptionalSessionAuthorizationResult =
  | { response: null }
  | { response: Response };

/**
 * Resolve registry-declared owner access before a protected request body is read.
 * Receipt routes use their separate resource-token preflight, while optional-
 * session routes deliberately admit both authenticated and anonymous callers.
 */
export async function authorizeOwnerRequest(
  request: Request,
  env: AuthApiEnv,
  options: OwnerAuthorizationOptions,
): Promise<OwnerAuthorizationResult> {
  if (!env.DB) {
    return {
      session: null,
      response: errorResponse(503, "storage_unavailable", "Account storage is temporarily unavailable."),
    };
  }
  try {
    const session = await getAuthenticatedSession(request, env);
    if (!session) return { session: null, response: unauthorizedResponse() };
    if (session.deletionFenced && !options.deletionFenceAccessAllowed) {
      return { session: null, response: accountDeletionInProgressResponse() };
    }
    if (options.currentLegalAcceptanceRequired && !session.user.legalAccepted) {
      return {
        session: null,
        response: legalAcceptanceRequiredResponse(session.user.ageEligible),
      };
    }
    return { session, response: null };
  } catch (error) {
    return { session: null, response: accountRequestErrorResponse(error) };
  }
}

/**
 * Bind the registry's optional-session class to the two reviewed account
 * routes before a request body is read. These routes intentionally admit an
 * anonymous caller, but account storage and schema still have to be readable;
 * any future optional-session route must receive its own explicit preflight.
 */
export async function authorizeOptionalSessionRequest(
  request: Request,
  env: AuthApiEnv,
): Promise<OptionalSessionAuthorizationResult> {
  const url = new URL(request.url);
  const reviewedRoute =
    (request.method === "GET" && url.pathname === "/api/auth/session") ||
    (request.method === "POST" && url.pathname === "/api/auth/logout");
  if (!reviewedRoute) {
    return {
      response: errorResponse(
        503,
        "route_unavailable",
        "This API route is temporarily unavailable.",
      ),
    };
  }
  if (!env.DB) {
    return {
      response: errorResponse(
        503,
        "storage_unavailable",
        "Account storage is temporarily unavailable.",
      ),
    };
  }
  try {
    await initialize(env.DB);
    return { response: null };
  } catch (error) {
    return { response: accountRequestErrorResponse(error) };
  }
}

/**
 * Resolve the registry's deletion-receipt authority before account dispatch.
 * The account handler intentionally repeats this live lookup at execution so
 * an expired or removed receipt cannot survive on cached preflight state.
 */
export async function authorizeDeletionReceiptRequest(
  request: Request,
  env: AuthApiEnv,
): Promise<DeletionReceiptAuthorizationResult> {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.pathname !== "/api/privacy/deletion-status") {
    return {
      response: errorResponse(
        503,
        "route_unavailable",
        "This API route is temporarily unavailable.",
      ),
    };
  }
  if (!env.DB) {
    return {
      response: errorResponse(
        503,
        "storage_unavailable",
        "Account storage is temporarily unavailable.",
      ),
    };
  }
  try {
    await initialize(env.DB);
    const receipt = parseCookies(request.headers.get("Cookie") ?? "").get(DELETION_RECEIPT_COOKIE);
    if (!receipt || !/^[A-Za-z0-9_-]{40,160}$/.test(receipt)) {
      return {
        response: errorResponse(
          404,
          "deletion_receipt_not_found",
          "No deletion status receipt was found in this browser.",
        ),
      };
    }
    const job = await selectDeletionJobByReceipt(env.DB, receipt);
    if (!job) {
      return {
        response: errorResponse(
          404,
          "deletion_receipt_not_found",
          "That deletion status receipt is no longer available.",
        ),
      };
    }
    return { response: null };
  } catch (error) {
    return { response: accountRequestErrorResponse(error) };
  }
}

function accountRequestAllowedWhileDeletionFenced(request: Request) {
  const url = new URL(request.url);
  if (url.pathname === "/api/profile") {
    return request.method === "GET" || request.method === "DELETE";
  }
  if (request.method !== "GET") return false;
  return url.pathname === "/api/profile/export" ||
    API_ROUTE_PATTERNS.profileExportPhoto.test(url.pathname) ||
    API_ROUTE_PATTERNS.profileExportStatus.test(url.pathname) ||
    API_ROUTE_PATTERNS.profileExportDownload.test(url.pathname);
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
  if (url.pathname === "/api/privacy/deletion-status" && request.method === "DELETE") {
    try {
      assertSameOrigin(request);
      return jsonResponse({ cleared: true }, 200, clearDeletionReceiptCookie());
    } catch (error) {
      return accountRequestErrorResponse(error);
    }
  }
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
  try {
    await initialize(db);
    if (url.pathname === "/api/auth/session") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      const session = await getAuthenticatedSession(request, env);
      if (!session) {
        return jsonResponse(
          { user: null },
          200,
          hasPresentedSessionCookie(request) ? clearSessionCookies(request) : undefined,
        );
      }
      if (
        !session.deletionFenced && session.cookieName === LEGACY_SESSION_COOKIE &&
        new URL(request.url).protocol === "https:"
      ) {
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
      const proofHash = await sha256(proof);
      const createdAt = new Date();
      const expiresAt = new Date(createdAt.getTime() + AGE_PROOF_SECONDS * 1000);
      const proofCandidate: SignupAgeProofCandidate = {
        tokenHash: proofHash,
        confirmedAt,
        gateVersion: AGE_GATE_VERSION,
        expiresAt: expiresAt.toISOString(),
        createdAt: createdAt.toISOString(),
      };
      if (!await createSignupAgeProof(db, proofCandidate)) {
        await cleanupSignupAgeProofCandidate(db, proofCandidate);
        return errorResponse(
          503,
          "eligibility_proof_unconfirmed",
          "Age eligibility could not be confirmed. Retry the age step.",
        );
      }
      return jsonResponse({
        eligibilityProof: proof,
        expiresInMinutes: AGE_PROOF_SECONDS / 60,
        expiresInSeconds: AGE_PROOF_SECONDS,
      }, 200, clearAgeIneligibleCookie());
    }

    if (url.pathname === "/api/privacy/deletion-status") {
      if (request.method !== "GET") return methodNotAllowed("GET");
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
      const codeHash = await sha256(`${id}:${code}`);
      const salt = randomSecret(18);
      const timestamp = new Date();
      const challengeCutoff = new Date(timestamp.getTime() - 60 * 60 * 1000).toISOString();
      const challenge: EmailChallengeRow = {
        id,
        kind: "signup",
        email,
        user_id: null,
        code_hash: codeHash,
        password_salt: salt,
        password_hash: await hashPassword(password, salt),
        age_eligibility_confirmed_at: ageEligibilityConfirmedAt,
        terms_version: LEGAL_VERSION,
        privacy_version: LEGAL_VERSION,
        expires_at: new Date(timestamp.getTime() + 15 * 60 * 1000).toISOString(),
        attempts: 0,
        resend_count: 0,
        created_at: timestamp.toISOString(),
      };
      const challengeClaim = await createEmailChallenge(db, challenge, challengeCutoff);
      if (challengeClaim === "rate_limited") {
        throw new AuthError(429, "too_many_codes", "Too many email codes were requested. Try again in an hour.");
      }
      if (challengeClaim !== "created") {
        await cleanupEmailChallengeCandidate(db, challenge);
        throw new AuthError(
          503,
          "challenge_creation_unconfirmed",
          "Email verification could not be confirmed. Restart signup from the age step.",
        );
      }
      try {
        await sendVerificationEmail(env, email, code, "Confirm your CastingCompass account");
      } catch (error) {
        await cleanupEmailChallengeCandidate(db, challenge);
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
      try {
        await db.batch([
          db.prepare(`INSERT INTO users (id, email, password_salt, password_hash,
            age_eligibility_confirmed_at, terms_accepted_at, terms_version,
            privacy_accepted_at, privacy_version, created_at, updated_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM email_challenges
              WHERE id = ? AND kind = 'signup' AND email = ? AND code_hash = ?
                AND password_salt = ? AND password_hash = ?
                AND age_eligibility_confirmed_at = ? AND terms_version = ?
                AND privacy_version = ? AND created_at = ? AND attempts = ?
                AND resend_count = ? AND expires_at = ? AND expires_at > ?)`).bind(
              user.id, user.email, challenge.password_salt, challenge.password_hash,
              challenge.age_eligibility_confirmed_at, timestamp, LEGAL_VERSION,
              timestamp, LEGAL_VERSION, timestamp, timestamp,
              challenge.id, challenge.email, challenge.code_hash,
              challenge.password_salt, challenge.password_hash,
              challenge.age_eligibility_confirmed_at, challenge.terms_version,
              challenge.privacy_version, challenge.created_at, Number(challenge.attempts),
              Number(challenge.resend_count ?? 0), challenge.expires_at, timestamp,
            ),
          db.prepare(`DELETE FROM email_challenges
            WHERE id = ? AND kind = 'signup' AND email = ? AND code_hash = ?
              AND password_salt = ? AND password_hash = ?
              AND age_eligibility_confirmed_at = ? AND terms_version = ?
              AND privacy_version = ? AND created_at = ? AND attempts = ?
              AND resend_count = ? AND expires_at = ? AND expires_at > ?`)
            .bind(
              challenge.id, challenge.email, challenge.code_hash,
              challenge.password_salt, challenge.password_hash,
              challenge.age_eligibility_confirmed_at, challenge.terms_version,
              challenge.privacy_version, challenge.created_at, Number(challenge.attempts),
              Number(challenge.resend_count ?? 0), challenge.expires_at, timestamp,
            ),
        ]);
      } catch {
        // A committed atomic signup can lose its batch response. Only the complete post-state decides.
      }
      let receipt: AccountCreationReceiptRow | null = null;
      let receiptReadSucceeded = false;
      try {
        receipt = await db.prepare(`SELECT
            (SELECT COUNT(*) FROM users
              WHERE id = ? AND email = ? AND password_salt = ? AND password_hash = ?
                AND age_eligibility_confirmed_at = ? AND terms_accepted_at = ?
                AND terms_version = ? AND privacy_accepted_at = ? AND privacy_version = ?
                AND created_at = ? AND updated_at = ?) AS exact_user_count,
            (SELECT COUNT(*) FROM users WHERE id = ?) AS any_user_count,
            (SELECT COUNT(*) FROM users WHERE email = ?) AS email_user_count,
            (SELECT COUNT(*) FROM auth_sessions WHERE user_id = ?) AS session_count,
            (SELECT COUNT(*) FROM email_challenges
              WHERE id = ? AND kind = 'signup' AND email = ? AND code_hash = ?
                AND password_salt = ? AND password_hash = ?
                AND age_eligibility_confirmed_at = ? AND terms_version = ?
                AND privacy_version = ? AND created_at = ? AND attempts = ?
                AND resend_count = ? AND expires_at = ? AND expires_at > ?) AS exact_challenge_count,
            (SELECT COUNT(*) FROM email_challenges WHERE id = ?) AS any_challenge_count,
            (SELECT COUNT(*) FROM account_deletion_fences WHERE user_id = ?) AS fence_count`)
          .bind(
            user.id, user.email, challenge.password_salt, challenge.password_hash,
            challenge.age_eligibility_confirmed_at, timestamp, LEGAL_VERSION,
            timestamp, LEGAL_VERSION, timestamp, timestamp,
            user.id, user.email, user.id,
            challenge.id, challenge.email, challenge.code_hash,
            challenge.password_salt, challenge.password_hash,
            challenge.age_eligibility_confirmed_at, challenge.terms_version,
            challenge.privacy_version, challenge.created_at, Number(challenge.attempts),
            Number(challenge.resend_count ?? 0), challenge.expires_at, timestamp,
            challenge.id, user.id,
          )
          .first<AccountCreationReceiptRow>();
        receiptReadSucceeded = true;
      } catch {
        // Welcome delivery and session issuance must not escape an unreadable account boundary.
      }
      const exactUserCount = Number(receipt?.exact_user_count);
      const anyUserCount = Number(receipt?.any_user_count);
      const emailUserCount = Number(receipt?.email_user_count);
      const sessionCount = Number(receipt?.session_count);
      const exactChallengeCount = Number(receipt?.exact_challenge_count);
      const anyChallengeCount = Number(receipt?.any_challenge_count);
      const fenceCount = Number(receipt?.fence_count);
      const counts = [
        exactUserCount,
        anyUserCount,
        emailUserCount,
        sessionCount,
        exactChallengeCount,
        anyChallengeCount,
        fenceCount,
      ];
      if (!receiptReadSucceeded || counts.some((count) => !Number.isSafeInteger(count) || count < 0)
        || exactUserCount > 1 || anyUserCount > 1 || emailUserCount > 1
        || exactChallengeCount > 1 || anyChallengeCount > 1 || fenceCount > 1
        || exactUserCount > anyUserCount || exactUserCount > emailUserCount
        || exactChallengeCount > anyChallengeCount) {
        throw new AuthError(
          503,
          "account_creation_unconfirmed",
          "Account creation could not be confirmed. Try signing in before starting signup again.",
        );
      }
      if (exactUserCount === 0 && anyUserCount === 0 && emailUserCount === 1) {
        throw new AuthError(409, "email_in_use", "An account already uses this email.");
      }
      if (exactUserCount === 0 && anyUserCount === 0 && emailUserCount === 0
        && anyChallengeCount === 1 && exactChallengeCount === 0) {
        throw new AuthError(
          409,
          "signup_challenge_changed",
          "That verification request changed. Use its latest code or start signup again.",
        );
      }
      if (exactUserCount !== 1 || anyUserCount !== 1 || emailUserCount !== 1
        || sessionCount !== 0 || anyChallengeCount !== 0 || fenceCount !== 0) {
        throw new AuthError(
          503,
          "account_creation_unconfirmed",
          "Account creation could not be confirmed. Try signing in before starting signup again.",
        );
      }
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
        const codeHash = await sha256(`${challenge.id}:${code}`);
        const timestamp = new Date();
        const nextChallenge = resentEmailChallenge(challenge, codeHash, timestamp);
        if (await transitionEmailChallengeForResend(db, challenge, nextChallenge) !== "updated") {
          await cleanupEmailChallengeCandidate(db, nextChallenge);
          await responseNotBefore;
          return passwordRecoveryResendResponse(challengeId);
        }
        const delivery = deferPasswordRecoveryEmail(
          options,
          db,
          nextChallenge,
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
      const codeHash = await sha256(`${challenge.id}:${code}`);
      const timestamp = new Date();
      const nextChallenge = resentEmailChallenge(challenge, codeHash, timestamp);
      const transition = await transitionEmailChallengeForResend(db, challenge, nextChallenge);
      if (transition !== "updated") {
        if (transition === "unconfirmed") {
          await cleanupEmailChallengeCandidate(db, nextChallenge);
          throw new AuthError(503, "challenge_update_unconfirmed", "The new verification code could not be confirmed. Restart email verification.");
        }
        throw new AuthError(409, "challenge_changed", "That verification request changed. Use its latest code or start again.");
      }
      try {
        await sendVerificationEmail(
          env,
          challenge.email,
          code,
          "Confirm your CastingCompass account",
          `${challenge.id}:resend:${Number(challenge.resend_count ?? 0) + 1}`,
        );
      } catch (error) {
        await cleanupEmailChallengeCandidate(db, nextChallenge);
        throw error;
      }
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
      const codeHash = await sha256(`${id}:${code}`);
      const timestamp = new Date();
      const challengeCutoff = new Date(timestamp.getTime() - 60 * 60 * 1000).toISOString();
      const challenge: EmailChallengeRow = {
        id,
        kind: "password_reset",
        email,
        user_id: user.id,
        code_hash: codeHash,
        password_salt: null,
        password_hash: null,
        age_eligibility_confirmed_at: null,
        terms_version: null,
        privacy_version: null,
        expires_at: new Date(timestamp.getTime() + 15 * 60 * 1000).toISOString(),
        attempts: 0,
        resend_count: 0,
        created_at: timestamp.toISOString(),
      };
      if (await createEmailChallenge(db, challenge, challengeCutoff) !== "created") {
        await cleanupEmailChallengeCandidate(db, challenge);
        await responseNotBefore;
        return passwordRecoveryRequestedResponse();
      }
      const delivery = deferPasswordRecoveryEmail(
        options,
        db,
        challenge,
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
      const passwordHash = await hashPassword(password, salt);
      const timestamp = new Date().toISOString();
      try {
        await db.batch([
          db.prepare(`UPDATE users SET password_salt = ?, password_hash = ?, updated_at = ?
            WHERE id = ? AND EXISTS (SELECT 1 FROM email_challenges
              WHERE id = ? AND kind = 'password_reset' AND user_id = ? AND code_hash = ?
                AND created_at = ? AND attempts = ? AND expires_at > ?)`)
            .bind(
              salt,
              passwordHash,
              timestamp,
              challenge.user_id,
              challenge.id,
              challenge.user_id,
              challenge.code_hash,
              challenge.created_at,
              Number(challenge.attempts),
              timestamp,
            ),
          db.prepare(`DELETE FROM auth_sessions WHERE user_id = ?
            AND EXISTS (SELECT 1 FROM email_challenges
              WHERE id = ? AND kind = 'password_reset' AND user_id = ? AND code_hash = ?
                AND created_at = ? AND attempts = ? AND expires_at > ?)`)
            .bind(
              challenge.user_id,
              challenge.id,
              challenge.user_id,
              challenge.code_hash,
              challenge.created_at,
              Number(challenge.attempts),
              timestamp,
            ),
          db.prepare(`DELETE FROM email_challenges
            WHERE id = ? AND kind = 'password_reset' AND user_id = ? AND code_hash = ?
              AND created_at = ? AND attempts = ? AND expires_at > ?`)
            .bind(
              challenge.id,
              challenge.user_id,
              challenge.code_hash,
              challenge.created_at,
              Number(challenge.attempts),
              timestamp,
            ),
        ]);
      } catch {
        // A committed atomic reset can lose its batch response. Only the complete post-state decides.
      }
      let receipt: PasswordResetReceiptRow | null = null;
      let receiptReadSucceeded = false;
      try {
        receipt = await db.prepare(`SELECT
            (SELECT COUNT(*) FROM users
              WHERE id = ? AND email = ? AND password_salt = ? AND password_hash = ?
                AND updated_at = ?) AS exact_user_count,
            (SELECT COUNT(*) FROM users WHERE id = ?) AS any_user_count,
            (SELECT COUNT(*) FROM auth_sessions WHERE user_id = ?) AS session_count,
            (SELECT COUNT(*) FROM email_challenges
              WHERE id = ? AND kind = 'password_reset' AND user_id = ? AND code_hash = ?
                AND created_at = ? AND attempts = ? AND expires_at > ?) AS exact_challenge_count,
            (SELECT COUNT(*) FROM email_challenges WHERE id = ?) AS any_challenge_count,
            (SELECT COUNT(*) FROM account_deletion_fences WHERE user_id = ?) AS fence_count`)
          .bind(
            challenge.user_id,
            challenge.email,
            salt,
            passwordHash,
            timestamp,
            challenge.user_id,
            challenge.user_id,
            challenge.id,
            challenge.user_id,
            challenge.code_hash,
            challenge.created_at,
            Number(challenge.attempts),
            timestamp,
            challenge.id,
            challenge.user_id,
          )
          .first<PasswordResetReceiptRow>();
        receiptReadSucceeded = true;
      } catch {
        // Never create a replacement session when the credential lifecycle is unreadable.
      }
      const exactUserCount = Number(receipt?.exact_user_count);
      const anyUserCount = Number(receipt?.any_user_count);
      const sessionCount = Number(receipt?.session_count);
      const exactChallengeCount = Number(receipt?.exact_challenge_count);
      const anyChallengeCount = Number(receipt?.any_challenge_count);
      const fenceCount = Number(receipt?.fence_count);
      const counts = [
        exactUserCount,
        anyUserCount,
        sessionCount,
        exactChallengeCount,
        anyChallengeCount,
        fenceCount,
      ];
      if (!receiptReadSucceeded || counts.some((count) => !Number.isSafeInteger(count) || count < 0)
        || exactUserCount > 1 || anyUserCount > 1 || exactChallengeCount > 1
        || anyChallengeCount > 1 || fenceCount > 1 || exactUserCount > anyUserCount
        || exactChallengeCount > anyChallengeCount) {
        return errorResponse(
          503,
          "password_reset_unconfirmed",
          "The password reset could not be confirmed. Try signing in with the new password before requesting another code.",
          clearSessionCookies(request),
        );
      }
      if (anyUserCount === 0) {
        return errorResponse(
          404,
          "account_not_found",
          "The account could not be found.",
          clearSessionCookies(request),
        );
      }
      if (exactUserCount !== 1 || sessionCount !== 0 || anyChallengeCount !== 0 || fenceCount !== 0) {
        if (anyChallengeCount === 1 && exactChallengeCount === 0) {
          return errorResponse(
            409,
            "password_reset_challenge_changed",
            "That reset request changed. Use its latest code or request another one.",
          );
        }
        return errorResponse(
          503,
          "password_reset_unconfirmed",
          "The password reset could not be confirmed. Try signing in with the new password before requesting another code.",
          clearSessionCookies(request),
        );
      }
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
      const attemptedAt = options.now?.() ?? new Date();
      const attemptedAtIso = attemptedAt.toISOString();
      const cutoff = new Date(attemptedAt.getTime() - 60 * 60 * 1000).toISOString();
      const attemptId = `attempt_${crypto.randomUUID()}`;
      const attemptClaim = await claimSignInAttempt(db, attemptId, emailHash, attemptedAtIso, cutoff);
      if (attemptClaim === "rate_limited") {
        return errorResponse(429, "too_many_attempts", "Too many sign-in attempts. Try again in an hour.");
      }
      if (attemptClaim !== "claimed") {
        return errorResponse(
          503,
          "sign_in_accounting_unconfirmed",
          "The sign-in attempt could not be confirmed. Try again shortly.",
        );
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
      if (!row || !valid) return errorResponse(401, "invalid_credentials", "Email or password is incorrect.");
      if (!await classifySignInAttemptSuccessful(db, attemptId, emailHash, attemptedAtIso)) {
        return errorResponse(
          503,
          "sign_in_accounting_unconfirmed",
          "The sign-in attempt could not be confirmed. Try again shortly.",
        );
      }
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
      if (!await revokePresentedSessions(db, tokens)) {
        return errorResponse(
          503,
          "sign_out_unconfirmed",
          "The server could not confirm that this session ended. Retry sign-out or check its status.",
        );
      }
      return jsonResponse({ signedOut: true, user: null }, 200, clearSessionCookies(request));
    }

    const authenticatedSession = await getAuthenticatedSession(request, env);
    if (!authenticatedSession) return unauthorizedResponse();
    const user = authenticatedSession.user;
    if (authenticatedSession.deletionFenced && !accountRequestAllowedWhileDeletionFenced(request)) {
      return accountDeletionInProgressResponse();
    }

    if (url.pathname === "/api/auth/eligibility") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      assertSameOrigin(request);
      const body = await readJson(request);
      assertOnlyFields(body, ["termsAccepted", "privacyAccepted"]);
      assertSignupLegalAcceptance(body);
      if (!user.ageEligible) {
        throw new AuthError(428, "age_eligibility_unavailable", "Account features are paused. Contact privacy support or delete the account.");
      }
      const timestamp = (options.now?.() ?? new Date()).toISOString();
      const acceptance = await acceptCurrentLegalTerms(db, authenticatedSession, timestamp);
      if (acceptance === "authentication_missing") {
        return errorResponse(
          401,
          "authentication_required",
          "This account session has ended. Refresh before continuing.",
          clearSessionCookies(request),
        );
      }
      if (acceptance !== "accepted") {
        throw new AuthError(503, "legal_acceptance_unconfirmed", "Legal acceptance could not be confirmed.");
      }
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
      const ownerSubjectHash = await sha256(`account:${user.id}`);
      const fence = await claimAccountDeletionFence(
        db,
        user.id,
        ownerSubjectHash,
        options.now?.() ?? new Date(),
      );
      const deletion = await prepareDeletionJob(
        "account",
        user.id,
        user.id,
        [],
        fence.requestedAt,
      );
      const emailHash = await sha256(user.email);
      let deletionBatchResponseLost = false;
      try {
        await db.batch([
        deletion.jobStatementForAccountFence(db, user.id, fence.leaseToken),
        ...deletion.inventoryStatementsForAccountFence(db, user.id, fence.leaseToken),
        deletion.finalizeInventoryStatementForAccountFence(db, user.id, fence.leaseToken),
        db.prepare(`UPDATE privacy_deletion_tasks SET state = 'pending', available_at = ?,
          lease_expires_at = NULL, lease_token = NULL, last_error_code = NULL, updated_at = ?
          WHERE state = 'needs_attention' AND object_key IS NOT NULL
            AND job_id IN (SELECT id FROM privacy_deletion_jobs WHERE owner_subject_hash = ?)
            AND EXISTS (SELECT 1 FROM account_deletion_fences
              WHERE user_id = ? AND owner_subject_hash = ? AND lease_token = ?)
            AND EXISTS (SELECT 1 FROM privacy_deletion_jobs
              WHERE id = ? AND owner_subject_hash = ?)`)
          .bind(
            deletion.requestedAt,
            deletion.requestedAt,
            ownerSubjectHash,
            user.id,
            ownerSubjectHash,
            fence.leaseToken,
            deletion.id,
            ownerSubjectHash,
          ),
        db.prepare(`UPDATE privacy_export_jobs
          SET state = 'canceled', user_id = NULL, lease_expires_at = NULL, lease_token = NULL,
            last_error_code = 'account_deleted', updated_at = ?
          WHERE owner_subject_hash = ?
            AND state IN ('pending', 'queued', 'processing', 'retry', 'completed', 'needs_attention')
            AND EXISTS (SELECT 1 FROM account_deletion_fences
              WHERE user_id = ? AND owner_subject_hash = ? AND lease_token = ?)
            AND EXISTS (SELECT 1 FROM privacy_deletion_jobs
              WHERE id = ? AND owner_subject_hash = ?)`)
          .bind(
            deletion.requestedAt,
            ownerSubjectHash,
            user.id,
            ownerSubjectHash,
            fence.leaseToken,
            deletion.id,
            ownerSubjectHash,
          ),
        db.prepare(`DELETE FROM trip_photo_upload_reservations
          WHERE owner_subject_hash = ?
            AND EXISTS (SELECT 1 FROM account_deletion_fences
              WHERE user_id = ? AND owner_subject_hash = ? AND lease_token = ?)
            AND EXISTS (SELECT 1 FROM privacy_deletion_jobs
              WHERE id = ? AND owner_subject_hash = ?)`)
          .bind(ownerSubjectHash, user.id, ownerSubjectHash, fence.leaseToken, deletion.id, ownerSubjectHash),
        db.prepare(`DELETE FROM site_discussion_posts
          WHERE trip_id IN (SELECT id FROM trips WHERE user_id = ?)
            AND EXISTS (SELECT 1 FROM account_deletion_fences
              WHERE user_id = ? AND owner_subject_hash = ? AND lease_token = ?)
            AND EXISTS (SELECT 1 FROM privacy_deletion_jobs
              WHERE id = ? AND owner_subject_hash = ?)`)
          .bind(user.id, user.id, ownerSubjectHash, fence.leaseToken, deletion.id, ownerSubjectHash),
        db.prepare(`DELETE FROM trips WHERE user_id = ?
          AND EXISTS (SELECT 1 FROM account_deletion_fences
            WHERE user_id = ? AND owner_subject_hash = ? AND lease_token = ?)
          AND EXISTS (SELECT 1 FROM privacy_deletion_jobs
            WHERE id = ? AND owner_subject_hash = ?)`)
          .bind(user.id, user.id, ownerSubjectHash, fence.leaseToken, deletion.id, ownerSubjectHash),
        db.prepare(`DELETE FROM saved_sites WHERE user_id = ?
          AND EXISTS (SELECT 1 FROM account_deletion_fences
            WHERE user_id = ? AND owner_subject_hash = ? AND lease_token = ?)
          AND EXISTS (SELECT 1 FROM privacy_deletion_jobs
            WHERE id = ? AND owner_subject_hash = ?)`)
          .bind(user.id, user.id, ownerSubjectHash, fence.leaseToken, deletion.id, ownerSubjectHash),
        db.prepare(`DELETE FROM gear_profiles WHERE user_id = ?
          AND EXISTS (SELECT 1 FROM account_deletion_fences
            WHERE user_id = ? AND owner_subject_hash = ? AND lease_token = ?)
          AND EXISTS (SELECT 1 FROM privacy_deletion_jobs
            WHERE id = ? AND owner_subject_hash = ?)`)
          .bind(user.id, user.id, ownerSubjectHash, fence.leaseToken, deletion.id, ownerSubjectHash),
        db.prepare(`DELETE FROM auth_sessions WHERE user_id = ?
          AND EXISTS (SELECT 1 FROM account_deletion_fences
            WHERE user_id = ? AND owner_subject_hash = ? AND lease_token = ?)
          AND EXISTS (SELECT 1 FROM privacy_deletion_jobs
            WHERE id = ? AND owner_subject_hash = ?)`)
          .bind(user.id, user.id, ownerSubjectHash, fence.leaseToken, deletion.id, ownerSubjectHash),
        db.prepare(`DELETE FROM email_challenges WHERE (email = ? OR user_id = ?)
          AND EXISTS (SELECT 1 FROM account_deletion_fences
            WHERE user_id = ? AND owner_subject_hash = ? AND lease_token = ?)
          AND EXISTS (SELECT 1 FROM privacy_deletion_jobs
            WHERE id = ? AND owner_subject_hash = ?)`)
          .bind(user.email, user.id, user.id, ownerSubjectHash, fence.leaseToken, deletion.id, ownerSubjectHash),
        db.prepare(`DELETE FROM auth_attempts WHERE email_hash = ?
          AND EXISTS (SELECT 1 FROM account_deletion_fences
            WHERE user_id = ? AND owner_subject_hash = ? AND lease_token = ?)
          AND EXISTS (SELECT 1 FROM privacy_deletion_jobs
            WHERE id = ? AND owner_subject_hash = ?)`)
          .bind(
            emailHash,
            user.id,
            ownerSubjectHash,
            fence.leaseToken,
            deletion.id,
            ownerSubjectHash,
          ),
        db.prepare(`DELETE FROM users WHERE id = ?
          AND EXISTS (SELECT 1 FROM account_deletion_fences
            WHERE user_id = ? AND owner_subject_hash = ? AND lease_token = ?)
          AND EXISTS (SELECT 1 FROM privacy_deletion_jobs
            WHERE id = ? AND owner_subject_hash = ?)`)
          .bind(user.id, user.id, ownerSubjectHash, fence.leaseToken, deletion.id, ownerSubjectHash),
        ]);
      } catch {
        // A D1 batch can commit and lose its response. Only the exact post-state below grants a receipt.
        deletionBatchResponseLost = true;
      }
      let deletionCommit: PrivacyDeletionJobRow | null = null;
      try {
        deletionCommit = await exactAccountDeletionCommit(db, user.id, emailHash, deletion);
      } catch {
        // A failed confirmation read is ambiguous and must preserve the opaque status receipt.
      }
      if (!deletionCommit) {
        let missingPhotoHashes: { count: number } | null = null;
        try {
          missingPhotoHashes = await db.prepare(`SELECT COUNT(*) AS count FROM trips
            WHERE user_id = ? AND photo_key IS NOT NULL AND photo_key_hash IS NULL`)
            .bind(user.id)
            .first<{ count: number }>();
        } catch {
          // The opaque receipt below preserves read-only recovery when D1 remains unavailable.
        }
        if (Number(missingPhotoHashes?.count ?? 0) > 0) {
          throw new AuthError(
            503,
            "account_deletion_inventory_incomplete",
            "Account deletion is paused because a legacy private object needs protected migration. Contact support before retrying.",
          );
        }
        let currentFence: { lease_token: string } | null = null;
        try {
          currentFence = await db.prepare(`SELECT lease_token FROM account_deletion_fences
            WHERE user_id = ? AND owner_subject_hash = ? LIMIT 1`)
            .bind(user.id, ownerSubjectHash)
            .first<{ lease_token: string }>();
        } catch {
          // The opaque receipt below preserves read-only recovery when D1 remains unavailable.
        }
        if (currentFence && currentFence.lease_token !== fence.leaseToken) {
          throw new AuthError(
            409,
            "account_deletion_lease_changed",
            "Account deletion lost its bounded lease. Retry after the active request finishes.",
          );
        }
        return errorResponse(
          503,
          "account_deletion_unconfirmed",
          "Account deletion could not be confirmed. Check deletion status before retrying.",
          deletionReceiptCookie(deletion.receipt),
        );
      }
      deletion.objectsTotal = deletionCommit.objects_total;
      const status = await deletionStatusAfterCommit(
        env,
        deletion,
        deletionBatchResponseLost ? 1 : ACCOUNT_DELETION_INLINE_TASK_BATCH,
      );
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
      const rows = await db.prepare(`SELECT * FROM trips INDEXED BY trips_user_history_idx
        WHERE user_id = ? AND status = 'completed'
          AND (ai_review_status IS NULL OR ai_review_status = 'retry')
        ORDER BY COALESCE(completed_at, ended_at, started_at) DESC
        LIMIT 10`)
        .bind(user.id)
        .all<TripRow>();
      const trips = rows.results ?? [];
      if (trips.length) {
        try {
          await db.batch(trips.map((trip) => db.prepare(
            `UPDATE trips SET ai_review_status = 'queued', ai_review_json = NULL,
                ai_review_model = NULL, ai_reviewed_at = NULL
              WHERE id = ? AND user_id = ? AND status = 'completed'
                AND ai_review_status IS ? AND ai_review_json IS ?
                AND ai_review_model IS ? AND ai_reviewed_at IS ? AND updated_at = ?`,
          ).bind(
            trip.id,
            user.id,
            trip.ai_review_status,
            trip.ai_review_json,
            trip.ai_review_model,
            trip.ai_reviewed_at,
            trip.updated_at,
          )));
        } catch {
          // Exact per-trip read-back below distinguishes rollback from a committed
          // batch whose response was lost.
        }
        const receipts: ManualReviewRetryReceipt[] = [];
        for (const trip of trips) receipts.push(await manualReviewRetryReceipt(db, trip, user.id));
        const queuedTrips = trips.filter((_, index) => receipts[index] === "queued");
        // The ten-row transaction is durable work admission, not permission to start ten
        // independent background pipelines inside one Worker invocation. Dispatch one now and
        // leave every other queued row to the bounded scheduled backlog.
        if (queuedTrips.length) {
          options.onTripReviewRequested?.(queuedTrips[0]);
        }
        if (receipts.includes("unconfirmed")) {
          return errorResponse(
            503,
            "review_retry_unconfirmed",
            "The review retry could not be confirmed. Its status will be checked without repeating the request.",
          );
        }
        return jsonResponse({ queued: queuedTrips.length }, 202);
      }
      return jsonResponse({ queued: 0 }, 202);
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
          bait_lure, rig, ai_review_status,
          CASE WHEN ai_review_status = 'processing' THEN NULL ELSE ai_review_json END AS ai_review_json,
          ai_review_model, ai_reviewed_at, completed_at
          FROM trips INDEXED BY trips_user_history_idx
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
        try {
          await db.prepare(`INSERT INTO gear_profiles
            (id, user_id, name, rod, reel, bait_lure, rig, created_at, updated_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE (SELECT COUNT(*) FROM gear_profiles WHERE user_id = ?) < 100`)
            .bind(id, user.id, gear.name, gear.rod, gear.reel, gear.baitLure, gear.rig, timestamp, timestamp, user.id)
            .run();
        } catch {
          // A storage response can be lost after commit. Only exact D1 post-state grants the receipt.
        }
        const receipt = await db.prepare(`SELECT id, user_id, name, rod, reel, bait_lure, rig, created_at, updated_at
          FROM gear_profiles WHERE id = ? AND user_id = ? LIMIT 1`)
          .bind(id, user.id)
          .first<Record<string, unknown>>();
        if (
          !receipt || receipt.id !== id || receipt.user_id !== user.id || receipt.name !== gear.name ||
          receipt.rod !== gear.rod || receipt.reel !== gear.reel || receipt.bait_lure !== gear.baitLure ||
          receipt.rig !== gear.rig || receipt.created_at !== timestamp || receipt.updated_at !== timestamp
        ) {
          if (!receipt) {
            const atLimit = await db.prepare(`SELECT 1 AS at_limit FROM gear_profiles
              WHERE user_id = ? LIMIT 1 OFFSET 99`)
              .bind(user.id)
              .first<{ at_limit: number }>();
            if (Number(atLimit?.at_limit ?? 0) === 1) {
              throw new AuthError(409, "gear_profile_limit_reached", "Remove a gear preset before adding another.");
            }
          }
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
        try {
          await db.prepare("DELETE FROM gear_profiles WHERE id = ? AND user_id = ?")
            .bind(id, user.id)
            .run();
        } catch {
          // A committed delete can lose its response. Only exact post-state grants the receipt.
        }
        let deletionState: { owner_count: number; any_count: number } | null = null;
        try {
          deletionState = await db.prepare(`SELECT
              (SELECT COUNT(*) FROM gear_profiles WHERE id = ? AND user_id = ?) AS owner_count,
              (SELECT COUNT(*) FROM gear_profiles WHERE id = ?) AS any_count`)
            .bind(id, user.id, id)
            .first<{ owner_count: number; any_count: number }>();
        } catch {
          // The write remains ambiguous until an owner-bound read can confirm its result.
        }
        const ownerCount = Number(deletionState?.owner_count);
        const anyCount = Number(deletionState?.any_count);
        if (!Number.isSafeInteger(ownerCount) || !Number.isSafeInteger(anyCount)
          || ownerCount < 0 || ownerCount > 1 || anyCount < ownerCount || anyCount > 1) {
          throw new AuthError(503, "gear_profile_write_unconfirmed", "The gear preset removal could not be confirmed.");
        }
        if (ownerCount === 1) {
          throw new AuthError(503, "gear_profile_write_unconfirmed", "The gear preset removal could not be confirmed.");
        }
        if (anyCount === 1) {
          return errorResponse(404, "gear_profile_not_found", "That gear preset could not be found.");
        }
        return jsonResponse({ deleted: true, id });
      }
      if (request.method === "PATCH") {
        const body = await readJson(request);
        assertOnlyFields(body, ["name", "rod", "reel", "baitLure", "rig"]);
        const gear = parseGearProfile(body);
        const timestamp = new Date().toISOString();
        try {
          await db.prepare(`UPDATE gear_profiles SET name = ?, rod = ?, reel = ?, bait_lure = ?, rig = ?, updated_at = ?
            WHERE id = ? AND user_id = ?`)
            .bind(gear.name, gear.rod, gear.reel, gear.baitLure, gear.rig, timestamp, id, user.id)
            .run();
        } catch {
          // A committed update can lose its response. Only exact post-state grants the receipt.
        }
        let receipt: GearProfileReceiptRow | null = null;
        let receiptReadSucceeded = false;
        try {
          receipt = await db.prepare(`SELECT id, user_id, name, rod, reel, bait_lure, rig, created_at, updated_at
            FROM gear_profiles WHERE id = ? AND user_id = ? LIMIT 1`)
            .bind(id, user.id)
            .first<GearProfileReceiptRow>();
          receiptReadSucceeded = true;
        } catch {
          // The write remains ambiguous until an owner-bound read can confirm its result.
        }
        if (!receiptReadSucceeded) {
          throw new AuthError(503, "gear_profile_write_unconfirmed", "The gear preset update could not be confirmed.");
        }
        if (!receipt) {
          return errorResponse(404, "gear_profile_not_found", "That gear preset could not be found.");
        }
        if (
          receipt.id !== id || receipt.user_id !== user.id || receipt.name !== gear.name ||
          receipt.rod !== gear.rod || receipt.reel !== gear.reel || receipt.bait_lure !== gear.baitLure ||
          receipt.rig !== gear.rig || receipt.updated_at !== timestamp
        ) {
          throw new AuthError(503, "gear_profile_write_unconfirmed", "The gear preset update could not be confirmed.");
        }
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
        try {
          await db.batch([
            deletion.jobStatementForPendingTrip(db, tripId, user.id),
            ...deletion.taskStatementsForPendingTrip(db, tripId, user.id),
            db.prepare(`DELETE FROM site_discussion_posts WHERE trip_id = ?
              AND EXISTS (SELECT 1 FROM trips WHERE id = ? AND user_id = ? AND moderation_status = 'pending')`)
              .bind(tripId, tripId, user.id),
            db.prepare("DELETE FROM trips WHERE id = ? AND user_id = ? AND moderation_status = 'pending'")
              .bind(tripId, user.id),
          ]);
        } catch {
          // A D1 batch can commit and lose its response. Only the exact ledger and absence proof below grant a receipt.
        }
        let deletionCommitted = false;
        try {
          deletionCommitted = await exactPendingTripDeletionCommit(db, tripId, user.id, deletion);
        } catch {
          // A failed confirmation read is ambiguous and must keep the opaque deletion receipt recoverable.
        }
        if (!deletionCommitted) {
          let current: { moderation_status: string } | null = null;
          try {
            current = await db.prepare("SELECT moderation_status FROM trips WHERE id = ? AND user_id = ? LIMIT 1")
              .bind(tripId, user.id)
              .first<{ moderation_status: string }>();
          } catch {
            // Preserve the ambiguity response and receipt cookie below.
          }
          if (current && current.moderation_status !== "pending") {
            return errorResponse(409, "trip_reviewed", "Reviewed trip logs can no longer be changed.");
          }
          return errorResponse(
            503,
            "trip_delete_unconfirmed",
            "The trip deletion could not be confirmed.",
            deletionReceiptCookie(deletion.receipt),
          );
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
            FROM validation_feasibility_events AS event
            WHERE event.trip_id = ? AND event.event_type = 'started'
              AND EXISTS (
                SELECT 1 FROM trips AS owner_trip
                WHERE owner_trip.id = event.trip_id AND owner_trip.user_id = ?
              )
            LIMIT 1`)
            .bind(tripId, user.id).first<StoredFeasibilityStart>(),
          db.prepare(`SELECT activation_id, event_sha256 FROM validation_feasibility_events AS event
            WHERE event.trip_id = ? AND event.event_type = 'completed'
              AND EXISTS (
                SELECT 1 FROM trips AS owner_trip
                WHERE owner_trip.id = event.trip_id AND owner_trip.user_id = ?
              )
            LIMIT 1`)
            .bind(tripId, user.id).first<{ activation_id: string; event_sha256: string }>(),
          db.prepare(`SELECT root_completion_event_sha256, event_sha256
            FROM validation_feasibility_corrections AS correction
            WHERE correction.trip_id = ?
              AND EXISTS (
                SELECT 1 FROM trips AS owner_trip
                WHERE owner_trip.id = correction.trip_id AND owner_trip.user_id = ?
              )
            ORDER BY correction.sequence DESC LIMIT 1`)
            .bind(tripId, user.id).first<{ root_completion_event_sha256: string; event_sha256: string }>(),
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
          ai_review_status = 'retry', ai_review_json = NULL, ai_review_model = NULL, ai_reviewed_at = NULL
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
        const editReceiptId = `validation_${crypto.randomUUID()}`;
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
              editReceiptId,
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
        try {
          await db.batch(statements);
        } catch {
          // A D1 batch can commit and lose its response. Only the exact post-state below grants a receipt.
        }
        const updatedTrip = await db.prepare(`SELECT trip.*,
            evidence.id AS edit_receipt_id,
            correction.correction_id AS correction_receipt_id
          FROM trips AS trip
          INNER JOIN trip_validation_provenance AS evidence
            ON evidence.id = ? AND evidence.trip_id = trip.id
            AND evidence.event_type = 'evidence_exclusion'
            AND evidence.attestation_status = 'invalidated_after_edit'
            AND evidence.evidence_status = 'context_only'
            AND evidence.exclusion_reason = 'post_completion_profile_edit'
            AND evidence.created_at = ?
          LEFT JOIN validation_feasibility_corrections AS correction
            ON correction.correction_id = ? AND correction.trip_id = trip.id
            AND correction.corrected_at = ?
          WHERE trip.id = ? AND trip.user_id = ? LIMIT 1`)
          .bind(
            editReceiptId,
            timestamp,
            feasibilityCorrection?.correctionId ?? null,
            timestamp,
            tripId,
            user.id,
          )
          .first<TripRow & { edit_receipt_id: string; correction_receipt_id: string | null }>();
        const exactReceipt = updatedTrip
          && updatedTrip.edit_receipt_id === editReceiptId
          && updatedTrip.correction_receipt_id === (feasibilityCorrection?.correctionId ?? null)
          && updatedTrip.status === "completed"
          && updatedTrip.moderation_status === "pending"
          && updatedTrip.site_id === siteId
          && updatedTrip.started_at === startedAt
          && updatedTrip.ended_at === endedAt
          && updatedTrip.mode === mode
          && updatedTrip.fishing_method === fishingMethod
          && updatedTrip.angler_count === anglerCount
          && updatedTrip.angler_hours === anglerHours
          && updatedTrip.keeper_count === keeperCount
          && updatedTrip.short_released_count === shortReleasedCount
          && updatedTrip.halibut_encounters === keeperCount + shortReleasedCount
          && updatedTrip.no_catch === Number(noCatch)
          && updatedTrip.gear_profile_id === gearProfileId
          && updatedTrip.rod === rod
          && updatedTrip.reel === reel
          && updatedTrip.bait_lure === baitLure
          && updatedTrip.rig === rig
          && updatedTrip.other_catch_count === otherCatchCount
          && updatedTrip.other_species === otherSpecies
          && updatedTrip.observations_json === observations
          && updatedTrip.notes === notes
          && updatedTrip.updated_at === timestamp
          && updatedTrip.completed_at === endedAt
          && updatedTrip.observation_contract_version === speciesObservation.observationContractVersion
          && updatedTrip.taxon_catalog_version === speciesObservation.taxonCatalogVersion
          && updatedTrip.target_taxon_id === speciesObservation.targetTaxonId
          && updatedTrip.contract_status === speciesObservation.contractStatus
          && updatedTrip.taxon_observations_json === speciesObservation.taxonObservationsJson
          && updatedTrip.outcome_class === speciesObservation.outcomeClass
          && updatedTrip.target_encounter_count === speciesObservation.targetEncounterCount
          && updatedTrip.any_fish_encounter_count === speciesObservation.anyFishEncounterCount
          && updatedTrip.target_identification_confidence === speciesObservation.targetIdentificationConfidence
          && updatedTrip.ai_review_status === "retry"
          && updatedTrip.ai_review_json === null
          && updatedTrip.ai_review_model === null
          && updatedTrip.ai_reviewed_at === null
          && (!forecastAttributionChanged || (
            updatedTrip.opportunity_window_id === null
            && updatedTrip.opportunity_score === null
            && updatedTrip.habitat_score === null
            && updatedTrip.seasonality_score === null
            && updatedTrip.conditions_score === null
            && updatedTrip.fishability_score === null
            && updatedTrip.model_version === null
            && updatedTrip.prediction_metadata_json === null
          ));
        if (!updatedTrip || !exactReceipt) {
          const current = await db.prepare("SELECT moderation_status FROM trips WHERE id = ? AND user_id = ? LIMIT 1")
            .bind(tripId, user.id)
            .first<{ moderation_status: string }>();
          if (current && current.moderation_status !== "pending") {
            return errorResponse(409, "trip_reviewed", "Reviewed trip logs can no longer be changed.");
          }
          return errorResponse(503, "trip_update_unconfirmed", "The trip update could not be confirmed.");
        }
        options.onTripUpdated?.(updatedTrip);
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
      try {
        await db.prepare(`INSERT OR IGNORE INTO saved_sites (user_id, site_id, created_at)
          SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM saved_sites WHERE user_id = ?) < 100`)
          .bind(user.id, siteId, new Date().toISOString(), user.id)
          .run();
      } catch {
        // A lost response after commit is resolved by the exact owner/site state below.
      }
      const present = await db.prepare(
        "SELECT 1 AS present FROM saved_sites WHERE user_id = ? AND site_id = ? LIMIT 1",
      ).bind(user.id, siteId).first<{ present: number }>();
      if (Number(present?.present ?? 0) !== 1) {
        const atLimit = await db.prepare(`SELECT 1 AS at_limit FROM saved_sites
          WHERE user_id = ? LIMIT 1 OFFSET 99`)
          .bind(user.id)
          .first<{ at_limit: number }>();
        if (Number(atLimit?.at_limit ?? 0) === 1) {
          throw new AuthError(409, "saved_site_limit_reached", "Remove a saved location before adding another.");
        }
        throw new AuthError(503, "saved_site_write_unconfirmed", "The saved location could not be confirmed.");
      }
      return jsonResponse({ saved: true, siteId });
    }
    if (request.method === "DELETE") {
      try {
        await db.prepare("DELETE FROM saved_sites WHERE user_id = ? AND site_id = ?")
          .bind(user.id, siteId)
          .run();
      } catch {
        // Absence after a lost committed response is the exact idempotent removal receipt.
      }
      const present = await db.prepare(
        "SELECT 1 AS present FROM saved_sites WHERE user_id = ? AND site_id = ? LIMIT 1",
      ).bind(user.id, siteId).first<{ present: number }>();
      if (Number(present?.present ?? 0) === 1) {
        throw new AuthError(503, "saved_site_write_unconfirmed", "The saved location removal could not be confirmed.");
      }
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

interface GearProfileReceiptRow {
  id: string;
  user_id: string;
  name: string;
  rod: string | null;
  reel: string | null;
  bait_lure: string | null;
  rig: string | null;
  created_at: string;
  updated_at: string;
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

function accountDeletionInProgressResponse() {
  return errorResponse(
    409,
    "account_deletion_in_progress",
    "Account deletion is already in progress. Export or retry deletion from Profile.",
  );
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
  availableAt?: string;
}

interface AccountDeletionFenceClaim {
  leaseToken: string;
  leaseExpiresAt: string;
  requestedAt: string;
}

async function claimAccountDeletionFence(
  db: D1DatabaseLike,
  userId: string,
  ownerSubjectHash: string,
  now: Date,
): Promise<AccountDeletionFenceClaim> {
  const leaseToken = randomSecret(32);
  const nowIso = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + ACCOUNT_DELETION_FENCE_LEASE_MS).toISOString();
  try {
    await db.prepare(`INSERT INTO account_deletion_fences (
        user_id, owner_subject_hash, lease_token, lease_expires_at, requested_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)
      ON CONFLICT(user_id) DO UPDATE SET
        lease_token = excluded.lease_token,
        lease_expires_at = excluded.lease_expires_at,
        updated_at = excluded.updated_at
      WHERE account_deletion_fences.owner_subject_hash = excluded.owner_subject_hash
        AND account_deletion_fences.lease_expires_at <= ?`)
      .bind(
        userId,
        ownerSubjectHash,
        leaseToken,
        leaseExpiresAt,
        nowIso,
        nowIso,
        userId,
        nowIso,
      )
      .run();
  } catch {
    // A D1 response can be lost after the fence commits. Exact read-back decides ownership.
  }
  const exact = await db.prepare(`SELECT requested_at FROM account_deletion_fences
    WHERE user_id = ? AND owner_subject_hash = ? AND lease_token = ? AND lease_expires_at = ?
    LIMIT 1`)
    .bind(userId, ownerSubjectHash, leaseToken, leaseExpiresAt)
    .first<{ requested_at: string }>();
  if (exact) return { leaseToken, leaseExpiresAt, requestedAt: exact.requested_at };

  const existing = await db.prepare(`SELECT lease_expires_at FROM account_deletion_fences
    WHERE user_id = ? AND owner_subject_hash = ? LIMIT 1`)
    .bind(userId, ownerSubjectHash)
    .first<{ lease_expires_at: string }>();
  if (existing) {
    throw new AuthError(
      409,
      "account_deletion_in_progress",
      "Another account-deletion request is in progress. Retry after its bounded lease expires.",
    );
  }
  const userStillExists = await db.prepare("SELECT 1 AS present FROM users WHERE id = ? LIMIT 1")
    .bind(userId)
    .first<{ present: number }>();
  if (!userStillExists) {
    throw new AuthError(401, "authentication_required", "This account session has ended.");
  }
  throw new AuthError(
    503,
    "account_deletion_fence_unconfirmed",
    "Account deletion could not establish its write fence. Retry before making other changes.",
  );
}

function laterDeletionAvailableAt(
  first: string | undefined,
  second: string | undefined,
  fallback: string,
) {
  let latest = fallback;
  for (const candidate of [first, second]) {
    if (candidate && Number.isFinite(Date.parse(candidate)) && candidate > latest) latest = candidate;
  }
  return latest;
}

async function prepareDeletionJob(
  scope: PrivacyDeletionJobRow["scope"],
  stableSubjectId: string,
  ownerStableId: string,
  objects: PrivacyDeletionObject[],
  requestedAt?: string,
) {
  const id = `deletion_${crypto.randomUUID()}`;
  const receipt = randomSecret(32);
  const timestamp = requestedAt ?? new Date().toISOString();
  const uniqueObjects = [...objects.reduce((byLocator, object) => {
    const identity = `${object.objectStore}\u0000${object.objectKey}`;
    const existing = byLocator.get(identity);
    byLocator.set(identity, {
      ...object,
      availableAt: laterDeletionAvailableAt(existing?.availableAt, object.availableAt, timestamp),
    });
    return byLocator;
  }, new Map<string, PrivacyDeletionObject>()).values()];
  const tasks = await Promise.all(uniqueObjects.map(async ({ objectStore, objectKey, availableAt }) => ({
    id: `deletion_task_${crypto.randomUUID()}`,
    objectStore,
    objectKey,
    objectKeyHash: await sha256(`${objectStore}\u0000${objectKey}`),
    availableAt: availableAt ?? timestamp,
  })));
  const subjectHash = await sha256(`${scope}:${stableSubjectId}`);
  const ownerSubjectHash = await sha256(`account:${ownerStableId}`);
  const receiptHash = await sha256(receipt);
  const completed = tasks.length === 0;
  return {
    id,
    receipt,
    scope,
    subjectHash,
    ownerSubjectHash,
    requestedAt: timestamp,
    objectsTotal: tasks.length,
    taskReceipts: tasks.map((task) => ({ ...task })),
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
    jobStatementForAccountFence: (
      db: D1DatabaseLike,
      userId: string,
      leaseToken: string,
    ) => db.prepare(`INSERT INTO privacy_deletion_jobs
      (id, receipt_hash, scope, subject_hash, owner_subject_hash, state, objects_total, objects_deleted,
        last_error_code, requested_at, active_data_removed_at, completed_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM account_deletion_fences
        WHERE user_id = ? AND owner_subject_hash = ? AND lease_token = ?)
        AND NOT EXISTS (SELECT 1 FROM trips
          WHERE user_id = ? AND photo_key IS NOT NULL AND photo_key_hash IS NULL)`)
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
        userId,
        ownerSubjectHash,
        leaseToken,
        userId,
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
      .bind(task.id, id, task.objectKey, task.objectKeyHash, task.objectStore, task.availableAt, timestamp, timestamp)),
    inventoryStatementsForAccountFence: (
      db: D1DatabaseLike,
      userId: string,
      leaseToken: string,
    ) => [
      db.prepare(`INSERT INTO privacy_deletion_tasks
        (id, job_id, object_key, object_key_hash, object_store, state, attempts, available_at,
          lease_expires_at, lease_token, last_error_code, created_at, updated_at, completed_at)
        SELECT ? || ':' || task.object_key_hash, ?, task.object_key, task.object_key_hash,
          task.object_store, 'pending', 0, ?, NULL, NULL, NULL, ?, ?, NULL
        FROM privacy_deletion_tasks AS task
        JOIN privacy_deletion_jobs AS source_job ON source_job.id = task.job_id
        WHERE source_job.owner_subject_hash = ? AND source_job.id != ?
          AND task.state != 'completed' AND task.object_key IS NOT NULL
          AND EXISTS (SELECT 1 FROM account_deletion_fences
            WHERE user_id = ? AND owner_subject_hash = ? AND lease_token = ?)
          AND EXISTS (SELECT 1 FROM privacy_deletion_jobs
            WHERE id = ? AND owner_subject_hash = ?)
        ON CONFLICT(job_id, object_key_hash) DO UPDATE SET
          available_at = CASE
            WHEN excluded.available_at > privacy_deletion_tasks.available_at THEN excluded.available_at
            ELSE privacy_deletion_tasks.available_at
          END`)
        .bind(
          id,
          id,
          timestamp,
          timestamp,
          timestamp,
          ownerSubjectHash,
          id,
          userId,
          ownerSubjectHash,
          leaseToken,
          id,
          ownerSubjectHash,
        ),
      db.prepare(`INSERT INTO privacy_deletion_tasks
        (id, job_id, object_key, object_key_hash, object_store, state, attempts, available_at,
          lease_expires_at, lease_token, last_error_code, created_at, updated_at, completed_at)
        SELECT ? || ':' || reservation.object_key_hash, ?, reservation.object_key,
          reservation.object_key_hash, 'trip_photos', 'pending', 0, reservation.available_at,
          NULL, NULL, NULL, ?, ?, NULL
        FROM trip_photo_upload_reservations AS reservation
        WHERE reservation.owner_subject_hash = ?
          AND EXISTS (SELECT 1 FROM account_deletion_fences
            WHERE user_id = ? AND owner_subject_hash = ? AND lease_token = ?)
          AND EXISTS (SELECT 1 FROM privacy_deletion_jobs
            WHERE id = ? AND owner_subject_hash = ?)
        ON CONFLICT(job_id, object_key_hash) DO UPDATE SET
          available_at = CASE
            WHEN excluded.available_at > privacy_deletion_tasks.available_at THEN excluded.available_at
            ELSE privacy_deletion_tasks.available_at
          END`)
        .bind(
          id,
          id,
          timestamp,
          timestamp,
          ownerSubjectHash,
          userId,
          ownerSubjectHash,
          leaseToken,
          id,
          ownerSubjectHash,
        ),
      db.prepare(`INSERT INTO privacy_deletion_tasks
        (id, job_id, object_key, object_key_hash, object_store, state, attempts, available_at,
          lease_expires_at, lease_token, last_error_code, created_at, updated_at, completed_at)
        SELECT ? || ':' || export.object_key_hash, ?, export.object_key, export.object_key_hash,
          'privacy_exports', 'pending', 0, ?, NULL, NULL, NULL, ?, ?, NULL
        FROM privacy_export_jobs AS export
        WHERE export.owner_subject_hash = ? AND export.object_key IS NOT NULL
          AND export.object_key_hash IS NOT NULL
          AND export.state IN ('pending', 'queued', 'processing', 'retry', 'completed', 'needs_attention')
          AND EXISTS (SELECT 1 FROM account_deletion_fences
            WHERE user_id = ? AND owner_subject_hash = ? AND lease_token = ?)
          AND EXISTS (SELECT 1 FROM privacy_deletion_jobs
            WHERE id = ? AND owner_subject_hash = ?)
        ON CONFLICT(job_id, object_key_hash) DO UPDATE SET
          available_at = CASE
            WHEN excluded.available_at > privacy_deletion_tasks.available_at THEN excluded.available_at
            ELSE privacy_deletion_tasks.available_at
          END`)
        .bind(
          id,
          id,
          timestamp,
          timestamp,
          timestamp,
          ownerSubjectHash,
          userId,
          ownerSubjectHash,
          leaseToken,
          id,
          ownerSubjectHash,
        ),
      db.prepare(`INSERT INTO privacy_deletion_tasks
        (id, job_id, object_key, object_key_hash, object_store, state, attempts, available_at,
          lease_expires_at, lease_token, last_error_code, created_at, updated_at, completed_at)
        SELECT ? || ':' || trip.photo_key_hash, ?, trip.photo_key, trip.photo_key_hash,
          'trip_photos', 'pending', 0, ?, NULL, NULL, NULL, ?, ?, NULL
        FROM trips AS trip
        WHERE trip.user_id = ? AND trip.photo_key IS NOT NULL AND trip.photo_key_hash IS NOT NULL
          AND EXISTS (SELECT 1 FROM account_deletion_fences
            WHERE user_id = ? AND owner_subject_hash = ? AND lease_token = ?)
          AND EXISTS (SELECT 1 FROM privacy_deletion_jobs
            WHERE id = ? AND owner_subject_hash = ?)
        ON CONFLICT(job_id, object_key_hash) DO UPDATE SET
          available_at = CASE
            WHEN excluded.available_at > privacy_deletion_tasks.available_at THEN excluded.available_at
            ELSE privacy_deletion_tasks.available_at
          END`)
        .bind(
          id,
          id,
          timestamp,
          timestamp,
          timestamp,
          userId,
          userId,
          ownerSubjectHash,
          leaseToken,
          id,
          ownerSubjectHash,
        ),
    ],
    finalizeInventoryStatementForAccountFence: (
      db: D1DatabaseLike,
      userId: string,
      leaseToken: string,
    ) => db.prepare(`UPDATE privacy_deletion_jobs SET
        objects_total = (SELECT COUNT(*) FROM privacy_deletion_tasks WHERE job_id = ?),
        state = CASE
          WHEN EXISTS (SELECT 1 FROM privacy_deletion_tasks WHERE job_id = ?)
            THEN 'active_data_removed'
          ELSE 'completed'
        END,
        completed_at = CASE
          WHEN EXISTS (SELECT 1 FROM privacy_deletion_tasks WHERE job_id = ?)
            THEN NULL
          ELSE ?
        END,
        updated_at = ?
      WHERE id = ? AND owner_subject_hash = ?
        AND EXISTS (SELECT 1 FROM account_deletion_fences
          WHERE user_id = ? AND owner_subject_hash = ? AND lease_token = ?)`)
      .bind(
        id,
        id,
        id,
        timestamp,
        timestamp,
        id,
        ownerSubjectHash,
        userId,
        ownerSubjectHash,
        leaseToken,
      ),
    taskStatementsForPendingTrip: (db: D1DatabaseLike, tripId: string, userId: string) => tasks.map((task) => db.prepare(`INSERT INTO privacy_deletion_tasks
      (id, job_id, object_key, object_key_hash, object_store, state, attempts, available_at, lease_expires_at,
        lease_token, last_error_code, created_at, updated_at, completed_at)
      SELECT ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, ?, ?, NULL
      WHERE EXISTS (SELECT 1 FROM trips WHERE id = ? AND user_id = ? AND moderation_status = 'pending')`)
      .bind(task.id, id, task.objectKey, task.objectKeyHash, task.objectStore, task.availableAt, timestamp, timestamp, tripId, userId)),
  };
}

type ManualReviewRetryReceipt = "queued" | "changed" | "unconfirmed";

interface ManualReviewRetryReceiptRow {
  queued_count: number;
  prior_count: number;
  owner_count: number;
  any_count: number;
}

async function manualReviewRetryReceipt(
  db: D1DatabaseLike,
  trip: TripRow,
  userId: string,
): Promise<ManualReviewRetryReceipt> {
  if (trip.user_id !== userId || trip.status !== "completed"
    || (trip.ai_review_status !== null && trip.ai_review_status !== "retry")) {
    return "unconfirmed";
  }
  try {
    const receipt = await db.prepare(`SELECT
        (SELECT COUNT(*) FROM trips
          WHERE id = ? AND user_id = ? AND status = 'completed'
            AND ai_review_status = 'queued' AND ai_review_json IS NULL
            AND ai_review_model IS NULL AND ai_reviewed_at IS NULL AND updated_at = ?) AS queued_count,
        (SELECT COUNT(*) FROM trips
          WHERE id = ? AND user_id = ? AND status = 'completed'
            AND ai_review_status IS ? AND ai_review_json IS ?
            AND ai_review_model IS ? AND ai_reviewed_at IS ? AND updated_at = ?) AS prior_count,
        (SELECT COUNT(*) FROM trips
          WHERE id = ? AND user_id = ? AND status = 'completed') AS owner_count,
        (SELECT COUNT(*) FROM trips WHERE id = ?) AS any_count`)
      .bind(
        trip.id,
        userId,
        trip.updated_at,
        trip.id,
        userId,
        trip.ai_review_status,
        trip.ai_review_json,
        trip.ai_review_model,
        trip.ai_reviewed_at,
        trip.updated_at,
        trip.id,
        userId,
        trip.id,
      )
      .first<ManualReviewRetryReceiptRow>();
    if (!exactReceiptCounts(receipt, ["queued_count", "prior_count", "owner_count", "any_count"])) {
      return "unconfirmed";
    }
    const queuedCount = Number(receipt?.queued_count);
    const priorCount = Number(receipt?.prior_count);
    const ownerCount = Number(receipt?.owner_count);
    const anyCount = Number(receipt?.any_count);
    if (queuedCount === 1 && priorCount === 0 && ownerCount === 1 && anyCount === 1) return "queued";
    if (queuedCount === 0 && priorCount === 1 && ownerCount === 1 && anyCount === 1) return "unconfirmed";
    if (queuedCount === 0 && priorCount === 0) return "changed";
    return "unconfirmed";
  } catch {
    return "unconfirmed";
  }
}

function exactReceiptCounts(receipt: unknown, fields: string[]) {
  if (!receipt || typeof receipt !== "object") return false;
  return fields.every((field) => {
    const count = Number((receipt as Record<string, unknown>)[field]);
    return Number.isSafeInteger(count) && count >= 0 && count <= 1;
  });
}

type LegalAcceptanceReceipt = "accepted" | "authentication_missing" | "unconfirmed";

interface LegalAcceptanceReceiptRow {
  accepted_count: number;
  prior_count: number;
  account_count: number;
  session_count: number;
}

function authenticatedAccountVersionBindings(version: AuthenticatedAccountVersion) {
  return [
    version.id,
    version.email,
    version.ageEligibilityConfirmedAt,
    version.termsAcceptedAt,
    version.termsVersion,
    version.privacyAcceptedAt,
    version.privacyVersion,
    version.createdAt,
    version.updatedAt,
  ];
}

async function acceptCurrentLegalTerms(
  db: D1DatabaseLike,
  session: AuthenticatedSession,
  acceptedAt: string,
): Promise<LegalAcceptanceReceipt> {
  const prior = session.accountVersion;
  if (!prior.ageEligibilityConfirmedAt) return "unconfirmed";
  try {
    await db.prepare(`UPDATE users SET terms_accepted_at = ?, terms_version = ?,
        privacy_accepted_at = ?, privacy_version = ?, updated_at = ?
      WHERE id = ? AND email = ? AND age_eligibility_confirmed_at = ?
        AND terms_accepted_at IS ? AND terms_version IS ?
        AND privacy_accepted_at IS ? AND privacy_version IS ?
        AND created_at = ? AND updated_at = ?
        AND EXISTS (SELECT 1 FROM auth_sessions
          WHERE token_hash = ? AND user_id = ? AND expires_at = ? AND expires_at > ?)`)
      .bind(
        acceptedAt,
        LEGAL_VERSION,
        acceptedAt,
        LEGAL_VERSION,
        acceptedAt,
        ...authenticatedAccountVersionBindings(prior),
        session.sessionTokenHash,
        prior.id,
        session.sessionExpiresAt,
        acceptedAt,
      )
      .run();
  } catch {
    // A committed write can lose its response. The complete account and live-session
    // receipt below is the only authority for a browser compliance response.
  }

  try {
    const receipt = await db.prepare(`SELECT
        (SELECT COUNT(*) FROM users
          WHERE id = ? AND email = ? AND age_eligibility_confirmed_at = ?
            AND terms_accepted_at = ? AND terms_version = ?
            AND privacy_accepted_at = ? AND privacy_version = ?
            AND created_at = ? AND updated_at = ?) AS accepted_count,
        (SELECT COUNT(*) FROM users
          WHERE id = ? AND email = ? AND age_eligibility_confirmed_at = ?
            AND terms_accepted_at IS ? AND terms_version IS ?
            AND privacy_accepted_at IS ? AND privacy_version IS ?
            AND created_at = ? AND updated_at = ?) AS prior_count,
        (SELECT COUNT(*) FROM users WHERE id = ?) AS account_count,
        (SELECT COUNT(*) FROM auth_sessions
          WHERE token_hash = ? AND user_id = ? AND expires_at = ? AND expires_at > ?) AS session_count`)
      .bind(
        prior.id,
        prior.email,
        prior.ageEligibilityConfirmedAt,
        acceptedAt,
        LEGAL_VERSION,
        acceptedAt,
        LEGAL_VERSION,
        prior.createdAt,
        acceptedAt,
        ...authenticatedAccountVersionBindings(prior),
        prior.id,
        session.sessionTokenHash,
        prior.id,
        session.sessionExpiresAt,
        acceptedAt,
      )
      .first<LegalAcceptanceReceiptRow>();
    if (!exactReceiptCounts(receipt, ["accepted_count", "prior_count", "account_count", "session_count"])) {
      return "unconfirmed";
    }
    const acceptedCount = Number(receipt?.accepted_count);
    const priorCount = Number(receipt?.prior_count);
    const accountCount = Number(receipt?.account_count);
    const sessionCount = Number(receipt?.session_count);
    if (acceptedCount === 1 && priorCount === 0 && accountCount === 1 && sessionCount === 1) {
      return "accepted";
    }
    if (accountCount === 0 || sessionCount === 0) return "authentication_missing";
    return "unconfirmed";
  } catch {
    return "unconfirmed";
  }
}

type SignInAttemptClaim = "claimed" | "rate_limited" | "unconfirmed";

interface SignInAttemptClaimReceiptRow {
  pending_count: number;
  any_count: number;
  recent_failed_count: number;
}

async function claimSignInAttempt(
  db: D1DatabaseLike,
  attemptId: string,
  emailHash: string,
  attemptedAt: string,
  cutoff: string,
): Promise<SignInAttemptClaim> {
  try {
    await db.prepare(`INSERT INTO auth_attempts
      (id, email_hash, attempted_at, successful)
      SELECT ?, ?, ?, 0
      WHERE (SELECT COUNT(*) FROM auth_attempts
        WHERE email_hash = ? AND successful = 0 AND attempted_at >= ?) < 10`)
      .bind(attemptId, emailHash, attemptedAt, emailHash, cutoff)
      .run();
  } catch {
    // The insert can commit and lose its response. Only exact stored state decides.
  }

  let receipt: SignInAttemptClaimReceiptRow | null = null;
  let receiptReadSucceeded = false;
  try {
    receipt = await db.prepare(`SELECT
        (SELECT COUNT(*) FROM auth_attempts
          WHERE id = ? AND email_hash = ? AND attempted_at = ? AND successful = 0) AS pending_count,
        (SELECT COUNT(*) FROM auth_attempts WHERE id = ?) AS any_count,
        (SELECT COUNT(*) FROM auth_attempts
          WHERE email_hash = ? AND successful = 0 AND attempted_at >= ?) AS recent_failed_count`)
      .bind(attemptId, emailHash, attemptedAt, attemptId, emailHash, cutoff)
      .first<SignInAttemptClaimReceiptRow>();
    receiptReadSucceeded = true;
  } catch {
    // Credential verification cannot follow an unreadable abuse-accounting claim.
  }

  const pendingCount = Number(receipt?.pending_count);
  const anyCount = Number(receipt?.any_count);
  const recentFailedCount = Number(receipt?.recent_failed_count);
  const countsValid = [pendingCount, anyCount, recentFailedCount]
    .every((count) => Number.isSafeInteger(count) && count >= 0)
    && pendingCount <= 1
    && anyCount <= 1
    && pendingCount <= anyCount
    && pendingCount <= recentFailedCount;
  if (!receiptReadSucceeded || !countsValid) return "unconfirmed";
  if (pendingCount === 1 && anyCount === 1 && recentFailedCount <= 10) return "claimed";
  if (pendingCount === 0 && anyCount === 0 && recentFailedCount >= 10) return "rate_limited";
  return "unconfirmed";
}

interface SignInAttemptClassificationReceiptRow {
  classified_count: number;
  pending_count: number;
  any_count: number;
}

async function classifySignInAttemptSuccessful(
  db: D1DatabaseLike,
  attemptId: string,
  emailHash: string,
  attemptedAt: string,
) {
  try {
    await db.prepare(`UPDATE auth_attempts SET successful = 1
      WHERE id = ? AND email_hash = ? AND attempted_at = ? AND successful = 0`)
      .bind(attemptId, emailHash, attemptedAt)
      .run();
  } catch {
    // The update can commit and lose its response. Only exact stored state decides.
  }

  let receipt: SignInAttemptClassificationReceiptRow | null = null;
  let receiptReadSucceeded = false;
  try {
    receipt = await db.prepare(`SELECT
        (SELECT COUNT(*) FROM auth_attempts
          WHERE id = ? AND email_hash = ? AND attempted_at = ? AND successful = 1) AS classified_count,
        (SELECT COUNT(*) FROM auth_attempts
          WHERE id = ? AND email_hash = ? AND attempted_at = ? AND successful = 0) AS pending_count,
        (SELECT COUNT(*) FROM auth_attempts WHERE id = ?) AS any_count`)
      .bind(attemptId, emailHash, attemptedAt, attemptId, emailHash, attemptedAt, attemptId)
      .first<SignInAttemptClassificationReceiptRow>();
    receiptReadSucceeded = true;
  } catch {
    // Session issuance cannot follow an unreadable success classification.
  }

  const classifiedCount = Number(receipt?.classified_count);
  const pendingCount = Number(receipt?.pending_count);
  const anyCount = Number(receipt?.any_count);
  const countsValid = [classifiedCount, pendingCount, anyCount]
    .every((count) => Number.isSafeInteger(count) && count >= 0 && count <= 1)
    && classifiedCount + pendingCount <= anyCount;
  return receiptReadSucceeded
    && countsValid
    && classifiedCount === 1
    && pendingCount === 0
    && anyCount === 1;
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
  maximumTasks = ACCOUNT_DELETION_INLINE_TASK_BATCH,
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
    await processPrivacyDeletionTasks(env, deletion.id, maximumTasks);
  } catch (error) {
    logEvent("error", "privacy.deletion.cleanup_deferred", safeErrorContext(error));
  }
  const job = env.DB ? await selectDeletionJobByReceipt(env.DB, deletion.receipt) : null;
  return job ? publicDeletionStatus(job) : fallback;
}

async function selectDeletionJobByReceipt(db: D1DatabaseLike, receipt: string) {
  return db.prepare(`SELECT scope, state, objects_total, objects_deleted, requested_at, completed_at
    FROM privacy_deletion_jobs WHERE receipt_hash = ? LIMIT 1`)
    .bind(await sha256(receipt))
    .first<PrivacyDeletionJobRow>();
}

async function exactAccountDeletionCommit(
  db: D1DatabaseLike,
  userId: string,
  emailHash: string,
  deletion: {
    id: string;
    receipt: string;
    scope: PrivacyDeletionJobRow["scope"];
    subjectHash: string;
    ownerSubjectHash: string;
    requestedAt: string;
  },
) {
  if (deletion.scope !== "account") return null;
  const row = await db.prepare(`SELECT job.id AS job_id, job.scope, job.subject_hash,
      job.owner_subject_hash, job.state, job.objects_total, job.objects_deleted,
      job.last_error_code, job.requested_at, job.active_data_removed_at,
      job.completed_at, job.updated_at,
      (SELECT COUNT(*) FROM privacy_deletion_tasks WHERE job_id = job.id) AS task_count,
      (SELECT COUNT(*) FROM privacy_deletion_tasks AS task
        WHERE task.job_id = job.id AND (
          task.id != (job.id || ':' || task.object_key_hash)
          OR task.object_key IS NULL
          OR length(task.object_key_hash) != 64
          OR task.object_key_hash GLOB '*[^a-f0-9]*'
          OR task.object_store NOT IN ('trip_photos', 'privacy_exports')
          OR task.state != 'pending' OR task.attempts != 0
          OR task.lease_expires_at IS NOT NULL OR task.lease_token IS NOT NULL
          OR task.last_error_code IS NOT NULL OR task.completed_at IS NOT NULL
          OR task.created_at != job.requested_at OR task.updated_at != job.requested_at
        )) AS invalid_task_count,
      (SELECT COUNT(*) FROM users WHERE id = ?) AS user_count,
      (SELECT COUNT(*) FROM trips WHERE user_id = ?) AS trip_count,
      (SELECT COUNT(*) FROM account_deletion_fences
        WHERE user_id = ? OR owner_subject_hash = ?) AS fence_count,
      (SELECT COUNT(*) FROM trip_photo_upload_reservations
        WHERE owner_subject_hash = ?) AS reservation_count,
      (SELECT COUNT(*) FROM auth_attempts WHERE email_hash = ?) AS auth_attempt_count,
      (SELECT COUNT(*) FROM privacy_export_jobs
        WHERE user_id = ?
          AND state IN ('pending', 'queued', 'processing', 'retry', 'completed', 'needs_attention'))
        AS export_user_count,
      (SELECT COUNT(*) FROM privacy_export_jobs
        WHERE owner_subject_hash = ?
          AND state IN ('pending', 'queued', 'processing', 'retry', 'completed', 'needs_attention'))
        AS active_export_count
    FROM privacy_deletion_jobs AS job
    WHERE job.receipt_hash = ? LIMIT 1`)
    .bind(
      userId,
      userId,
      userId,
      deletion.ownerSubjectHash,
      deletion.ownerSubjectHash,
      emailHash,
      userId,
      deletion.ownerSubjectHash,
      await sha256(deletion.receipt),
    )
    .first<PrivacyDeletionJobRow & {
      job_id: string;
      subject_hash: string;
      owner_subject_hash: string;
      last_error_code: string | null;
      active_data_removed_at: string | null;
      updated_at: string;
      task_count: number;
      invalid_task_count: number;
      user_count: number;
      trip_count: number;
      fence_count: number;
      reservation_count: number;
      auth_attempt_count: number;
      export_user_count: number;
      active_export_count: number;
    }>();
  if (!row) return null;
  const expectedState = row.task_count === 0 ? "completed" : "active_data_removed";
  const exact = row.job_id === deletion.id
    && row.scope === deletion.scope
    && row.subject_hash === deletion.subjectHash
    && row.owner_subject_hash === deletion.ownerSubjectHash
    && row.state === expectedState
    && row.objects_total === row.task_count
    && row.objects_deleted === 0
    && row.last_error_code === null
    && row.requested_at === deletion.requestedAt
    && row.active_data_removed_at === deletion.requestedAt
    && row.completed_at === (row.task_count === 0 ? deletion.requestedAt : null)
    && row.updated_at === deletion.requestedAt
    && row.invalid_task_count === 0
    && row.user_count === 0
    && row.trip_count === 0
    && row.fence_count === 0
    && row.reservation_count === 0
    && row.auth_attempt_count === 0
    && row.export_user_count === 0
    && row.active_export_count === 0;
  return exact ? row : null;
}

async function exactPendingTripDeletionCommit(
  db: D1DatabaseLike,
  tripId: string,
  userId: string,
  deletion: {
    id: string;
    receipt: string;
    scope: PrivacyDeletionJobRow["scope"];
    subjectHash: string;
    ownerSubjectHash: string;
    requestedAt: string;
    objectsTotal: number;
    taskReceipts: Array<{
      id: string;
      objectStore: PrivacyObjectStore;
      objectKey: string;
      objectKeyHash: string;
      availableAt: string;
    }>;
  },
) {
  if (deletion.scope !== "trip"
    || deletion.taskReceipts.length > 1
    || deletion.objectsTotal !== deletion.taskReceipts.length) return false;
  const row = await db.prepare(`SELECT job.id AS job_id, job.scope, job.subject_hash,
      job.owner_subject_hash, job.state AS job_state, job.objects_total, job.objects_deleted,
      job.last_error_code AS job_error, job.requested_at, job.active_data_removed_at,
      job.completed_at AS job_completed_at, job.updated_at AS job_updated_at,
      task.id AS task_id, task.object_key, task.object_key_hash, task.object_store,
      task.state AS task_state, task.attempts AS task_attempts, task.available_at,
      task.lease_expires_at, task.lease_token, task.last_error_code AS task_error,
      task.created_at AS task_created_at, task.updated_at AS task_updated_at,
      task.completed_at AS task_completed_at,
      (SELECT COUNT(*) FROM privacy_deletion_tasks WHERE job_id = job.id) AS task_count,
      (SELECT COUNT(*) FROM trips WHERE id = ? AND user_id = ?) AS trip_count,
      (SELECT COUNT(*) FROM site_discussion_posts WHERE trip_id = ?) AS discussion_count
    FROM privacy_deletion_jobs AS job
    LEFT JOIN privacy_deletion_tasks AS task ON task.job_id = job.id
    WHERE job.receipt_hash = ? LIMIT 1`)
    .bind(tripId, userId, tripId, await sha256(deletion.receipt))
    .first<{
      job_id: string;
      scope: string;
      subject_hash: string;
      owner_subject_hash: string;
      job_state: string;
      objects_total: number;
      objects_deleted: number;
      job_error: string | null;
      requested_at: string;
      active_data_removed_at: string;
      job_completed_at: string | null;
      job_updated_at: string;
      task_id: string | null;
      object_key: string | null;
      object_key_hash: string | null;
      object_store: string | null;
      task_state: string | null;
      task_attempts: number | null;
      available_at: string | null;
      lease_expires_at: string | null;
      lease_token: string | null;
      task_error: string | null;
      task_created_at: string | null;
      task_updated_at: string | null;
      task_completed_at: string | null;
      task_count: number;
      trip_count: number;
      discussion_count: number;
    }>();
  if (!row) return false;
  const expectedTask = deletion.taskReceipts[0] ?? null;
  const expectedState = deletion.objectsTotal === 0 ? "completed" : "active_data_removed";
  return row.job_id === deletion.id
    && row.scope === deletion.scope
    && row.subject_hash === deletion.subjectHash
    && row.owner_subject_hash === deletion.ownerSubjectHash
    && row.job_state === expectedState
    && row.objects_total === deletion.objectsTotal
    && row.objects_deleted === 0
    && row.job_error === null
    && row.requested_at === deletion.requestedAt
    && row.active_data_removed_at === deletion.requestedAt
    && row.job_completed_at === (deletion.objectsTotal === 0 ? deletion.requestedAt : null)
    && row.job_updated_at === deletion.requestedAt
    && row.task_count === deletion.objectsTotal
    && row.trip_count === 0
    && row.discussion_count === 0
    && row.task_id === (expectedTask?.id ?? null)
    && row.object_key === (expectedTask?.objectKey ?? null)
    && row.object_key_hash === (expectedTask?.objectKeyHash ?? null)
    && row.object_store === (expectedTask?.objectStore ?? null)
    && row.task_state === (expectedTask ? "pending" : null)
    && row.task_attempts === (expectedTask ? 0 : null)
    && row.available_at === (expectedTask?.availableAt ?? null)
    && row.lease_expires_at === null
    && row.lease_token === null
    && row.task_error === null
    && row.task_created_at === (expectedTask ? deletion.requestedAt : null)
    && row.task_updated_at === (expectedTask ? deletion.requestedAt : null)
    && row.task_completed_at === null;
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
  state: "pending" | "leased" | "completed";
  attempts: number;
  available_at: string;
  lease_expires_at: string | null;
  lease_token: string | null;
  completed_at: string | null;
}

export async function processPrivacyDeletionTasks(
  env: AuthApiEnv,
  onlyJobId?: string,
  maximumTasks = PRIVACY_DELETION_TASK_BATCH,
) {
  if (!env.DB) return 0;
  const db = env.DB;
  await initialize(db);
  const now = new Date();
  const nowIso = now.toISOString();
  const query = onlyJobId
    ? `SELECT id, job_id, object_key, object_key_hash, object_store, state, attempts,
         available_at, lease_expires_at, lease_token, completed_at FROM privacy_deletion_tasks
       WHERE job_id = ?
         AND ((state = 'pending' AND available_at <= ?)
           OR (state = 'leased' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))
       ORDER BY created_at LIMIT ?`
    : `SELECT id, job_id, object_key, object_key_hash, object_store, state, attempts,
         available_at, lease_expires_at, lease_token, completed_at FROM privacy_deletion_tasks
       WHERE (state = 'pending' AND available_at <= ?)
         OR (state = 'leased' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
       ORDER BY available_at, created_at LIMIT ?`;
  const statement = db.prepare(query);
  const taskLimit = Number.isSafeInteger(maximumTasks)
    ? Math.max(1, Math.min(PRIVACY_DELETION_TASK_BATCH, maximumTasks))
    : PRIVACY_DELETION_TASK_BATCH;
  const rows = onlyJobId
    ? await statement.bind(onlyJobId, nowIso, nowIso, taskLimit).all<PrivacyDeletionTaskRow>()
    : await statement.bind(nowIso, nowIso, taskLimit).all<PrivacyDeletionTaskRow>();
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
    try {
      await db.prepare(`UPDATE privacy_deletion_tasks
        SET state = 'leased', attempts = attempts + 1, lease_expires_at = ?, lease_token = ?, updated_at = ?
        WHERE id = ?
          AND ((state = 'pending' AND available_at <= ?)
            OR (state = 'leased' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))`)
        .bind(leaseExpiresAt, leaseToken, nowIso, task.id, nowIso, nowIso)
        .run();
    } catch {
      // A transport failure can arrive after D1 committed the claim. The exact receipt below is authoritative.
    }
    const claimReceipt = await db.prepare(`SELECT id, job_id, object_key, object_key_hash, object_store,
        state, attempts, available_at, lease_expires_at, lease_token, completed_at
      FROM privacy_deletion_tasks
      WHERE id = ? AND job_id = ? AND state = 'leased' AND attempts = ?
        AND object_key = ? AND object_key_hash = ? AND object_store = ?
        AND lease_expires_at = ? AND lease_token = ? AND completed_at IS NULL
      LIMIT 1`)
      .bind(
        task.id,
        task.job_id,
        Number(task.attempts) + 1,
        task.object_key,
        task.object_key_hash,
        task.object_store,
        leaseExpiresAt,
        leaseToken,
      )
      .first<PrivacyDeletionTaskRow>();
    if (!claimReceipt?.object_key) continue;
    const objectKey = claimReceipt.object_key;
    const expectedObjectKeyHash = await sha256(`${claimReceipt.object_store}\0${objectKey}`);
    if (expectedObjectKeyHash !== claimReceipt.object_key_hash) {
      await db.prepare(`UPDATE privacy_deletion_tasks
        SET state = 'needs_attention', lease_expires_at = NULL, lease_token = NULL,
          last_error_code = 'object_locator_hash_mismatch', updated_at = ?
        WHERE id = ? AND state = 'leased' AND lease_token = ?`)
        .bind(nowIso, claimReceipt.id, leaseToken)
        .run();
      continue;
    }
    try {
      await db.prepare("UPDATE privacy_deletion_jobs SET state = 'purging', last_error_code = NULL, updated_at = ? WHERE id = ? AND state != 'completed'")
        .bind(nowIso, claimReceipt.job_id).run();
      await bucket.delete(objectKey);
      const finishedAt = new Date().toISOString();
      const terminalStatements = [];
      if (claimReceipt.object_store === "privacy_exports") {
        terminalStatements.push(db.prepare(`UPDATE privacy_export_jobs
            SET state = 'expired', user_id = NULL, object_key = NULL, object_key_hash = NULL,
              content_sha256 = NULL, size_bytes = NULL, record_count = NULL,
              lease_expires_at = NULL, lease_token = NULL, last_error_code = NULL, updated_at = ?
            WHERE object_key = ? AND object_key_hash = ?
              AND user_id IS NULL AND state != 'completed'`)
          .bind(finishedAt, objectKey, claimReceipt.object_key_hash));
      }
      terminalStatements.push(db.prepare(`UPDATE privacy_deletion_tasks SET state = 'completed', object_key = NULL,
          lease_expires_at = NULL, lease_token = NULL, last_error_code = NULL,
          completed_at = ?, updated_at = ?
        WHERE id = ? AND state = 'leased' AND lease_token = ?`)
        .bind(finishedAt, finishedAt, claimReceipt.id, leaseToken));
      try {
        await db.batch(terminalStatements);
      } catch {
        // A transport failure can arrive after the atomic batch committed. Exact receipts decide the outcome.
      }
      const completionReceipt = await db.prepare(`SELECT id, job_id, object_key, object_key_hash, object_store,
          state, attempts, available_at, lease_expires_at, lease_token, completed_at
        FROM privacy_deletion_tasks
        WHERE id = ? AND job_id = ? AND state = 'completed' AND attempts = ?
          AND object_key IS NULL AND object_key_hash = ? AND object_store = ?
          AND lease_expires_at IS NULL AND lease_token IS NULL AND completed_at = ?
        LIMIT 1`)
        .bind(
          claimReceipt.id,
          claimReceipt.job_id,
          Number(claimReceipt.attempts),
          claimReceipt.object_key_hash,
          claimReceipt.object_store,
          finishedAt,
        )
        .first<PrivacyDeletionTaskRow>();
      if (!completionReceipt) throw new Error("privacy deletion completion receipt missing");
      if (claimReceipt.object_store === "privacy_exports") {
        const remainingLocator = await db.prepare(`SELECT COUNT(*) AS count FROM privacy_export_jobs
          WHERE user_id IS NULL AND state != 'completed'
            AND (object_key = ? OR object_key_hash = ?)`)
          .bind(objectKey, claimReceipt.object_key_hash)
          .first<{ count: number }>();
        if (Number(remainingLocator?.count ?? 0) !== 0) {
          throw new Error("privacy export deletion linkage receipt missing");
        }
      }
      completed += 1;
    } catch {
      const attempts = Number(claimReceipt.attempts);
      const backoffSeconds = Math.min(6 * 60 * 60, 30 * (2 ** Math.min(attempts - 1, 10)));
      const retryAt = new Date(Date.now() + backoffSeconds * 1000).toISOString();
      await db.prepare(`UPDATE privacy_deletion_tasks
        SET state = CASE WHEN attempts >= ? THEN 'needs_attention' ELSE 'pending' END,
        available_at = ?, lease_expires_at = NULL,
        lease_token = NULL, last_error_code = 'object_delete_failed', updated_at = ?
        WHERE id = ? AND state = 'leased' AND lease_token = ?`)
        .bind(MAX_DELETION_ATTEMPTS, retryAt, new Date().toISOString(), claimReceipt.id, leaseToken).run();
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

async function reconcileDeletionJobs(db: D1DatabaseLike) {
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
    WHERE id IN (
      SELECT id FROM privacy_deletion_jobs
      WHERE state != 'completed'
        OR objects_deleted != objects_total
        OR (SELECT COUNT(*) FROM privacy_deletion_tasks
          WHERE job_id = privacy_deletion_jobs.id) != objects_total
        OR EXISTS (SELECT 1 FROM privacy_deletion_tasks
          WHERE job_id = privacy_deletion_jobs.id AND state != 'completed')
      ORDER BY updated_at LIMIT 100
    )`)
    .bind(timestamp, timestamp)
    .run();
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

export async function cleanupAuthRetentionData(env: AuthApiEnv) {
  if (!env.DB) return;
  await initialize(env.DB);
  const now = new Date();
  const expiredChallengeCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const attemptCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const proofCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const tombstoneCutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const pruneCandidate = await env.DB.prepare(`SELECT
      job.id, job.completed_at, job.objects_total, job.objects_deleted,
      (SELECT COUNT(*) FROM (
        SELECT task.id
        FROM privacy_deletion_tasks AS task
          INDEXED BY privacy_deletion_tasks_job_object_unique
        WHERE task.job_id = job.id
          AND task.state = 'completed'
          AND task.object_key IS NULL
        ORDER BY task.object_key_hash LIMIT ?
      )) AS prune_count
    FROM privacy_deletion_jobs AS job
      INDEXED BY privacy_deletion_jobs_state_completed_idx
    WHERE job.state = 'completed' AND job.completed_at < ?
      AND job.objects_deleted = job.objects_total
      AND job.objects_total > 0
      AND job.last_error_code IS NULL
      AND EXISTS (
        SELECT 1
        FROM privacy_deletion_tasks AS eligible_task
          INDEXED BY privacy_deletion_tasks_job_object_unique
        WHERE eligible_task.job_id = job.id
          AND eligible_task.state = 'completed'
          AND eligible_task.object_key IS NULL
        LIMIT 1
      )
      AND job.objects_total >= (
        SELECT COUNT(*) FROM (
          SELECT bounded_task.id
          FROM privacy_deletion_tasks AS bounded_task
            INDEXED BY privacy_deletion_tasks_job_object_unique
          WHERE bounded_task.job_id = job.id
            AND bounded_task.state = 'completed'
            AND bounded_task.object_key IS NULL
          ORDER BY bounded_task.object_key_hash LIMIT ?
        )
      )
    ORDER BY job.completed_at LIMIT 1`)
    .bind(AUTH_RETENTION_DELETE_BATCH, tombstoneCutoff, AUTH_RETENTION_DELETE_BATCH)
    .first<{
      id: string;
      completed_at: string;
      objects_total: number;
      objects_deleted: number;
      prune_count: number;
    }>();
  const retentionStatements = [
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
  ];
  const pruneCount = Number(pruneCandidate?.prune_count ?? 0);
  const objectsTotal = Number(pruneCandidate?.objects_total ?? 0);
  const objectsDeleted = Number(pruneCandidate?.objects_deleted ?? 0);
  if (pruneCandidate) {
    if (!pruneCandidate.id || !pruneCandidate.completed_at
      || !Number.isSafeInteger(pruneCount) || pruneCount < 1
      || pruneCount > AUTH_RETENTION_DELETE_BATCH
      || !Number.isSafeInteger(objectsTotal) || objectsTotal < pruneCount
      || !Number.isSafeInteger(objectsDeleted) || objectsDeleted !== objectsTotal) {
      throw new Error("privacy_retention_prune_candidate_invalid");
    }
    const retentionPruneClaim = `retention_prune_${randomSecret(16)}`;
    const nextObjectsTotal = objectsTotal - pruneCount;
    const nextObjectsDeleted = objectsDeleted - pruneCount;
    retentionStatements.push(
      env.DB.prepare(`UPDATE privacy_deletion_jobs
        SET objects_total = ?, objects_deleted = ?, last_error_code = ?
        WHERE id = ? AND state = 'completed' AND completed_at = ?
          AND objects_total = ? AND objects_deleted = ? AND last_error_code IS NULL`).bind(
        nextObjectsTotal,
        nextObjectsDeleted,
        retentionPruneClaim,
        pruneCandidate.id,
        pruneCandidate.completed_at,
        objectsTotal,
        objectsDeleted,
      ),
      env.DB.prepare(`DELETE FROM privacy_deletion_tasks WHERE id IN (
        SELECT task.id
        FROM privacy_deletion_tasks AS task
          INDEXED BY privacy_deletion_tasks_job_object_unique
        WHERE task.job_id = ?
          AND task.state = 'completed'
          AND task.object_key IS NULL
          AND EXISTS (
            SELECT 1 FROM privacy_deletion_jobs AS job
            WHERE job.id = ? AND job.state = 'completed' AND job.completed_at = ?
              AND job.objects_total = ? AND job.objects_deleted = ?
              AND job.last_error_code = ?
            LIMIT 1
          )
        ORDER BY task.object_key_hash LIMIT ?
      )`).bind(
        pruneCandidate.id,
        pruneCandidate.id,
        pruneCandidate.completed_at,
        nextObjectsTotal,
        nextObjectsDeleted,
        retentionPruneClaim,
        pruneCount,
      ),
      env.DB.prepare(`UPDATE privacy_deletion_jobs
        SET last_error_code = NULL
        WHERE id = ? AND state = 'completed' AND completed_at = ?
          AND objects_total = ? AND objects_deleted = ? AND last_error_code = ?`).bind(
        pruneCandidate.id,
        pruneCandidate.completed_at,
        nextObjectsTotal,
        nextObjectsDeleted,
        retentionPruneClaim,
      ),
    );
  }
  retentionStatements.push(
    env.DB.prepare(`DELETE FROM privacy_deletion_jobs
      WHERE id IN (
        SELECT job.id
        FROM privacy_deletion_jobs AS job
          INDEXED BY privacy_deletion_jobs_state_completed_idx
        WHERE job.state = 'completed' AND job.completed_at < ?
          AND job.objects_deleted = job.objects_total
          AND job.objects_total = 0
          AND job.objects_deleted = 0
          AND job.last_error_code IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM privacy_deletion_tasks AS task
              INDEXED BY privacy_deletion_tasks_job_object_unique
            WHERE task.job_id = job.id
            LIMIT 1
          )
        ORDER BY job.completed_at LIMIT ?
      )`).bind(tombstoneCutoff, AUTH_RETENTION_DELETE_BATCH),
    env.DB.prepare(`DELETE FROM privacy_export_jobs WHERE id IN (
      SELECT id FROM privacy_export_jobs
      WHERE state = 'expired' AND updated_at < ? AND object_key IS NULL
      ORDER BY updated_at, id LIMIT ?
    )`).bind(tombstoneCutoff, AUTH_RETENTION_DELETE_BATCH),
  );
  await env.DB.batch(retentionStatements);
}

export async function cleanupAuthData(env: AuthApiEnv) {
  await cleanupAuthRetentionData(env);
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
  const tokenHash = await sha256(token);
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + SESSION_SECONDS * 1000);
  const priorSessionDeletes = await Promise.all(presentedSessionTokens(request).map(async (presented) =>
    db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(await sha256(presented.token))));
  try {
    await db.batch([
      ...priorSessionDeletes,
      db.prepare(`INSERT INTO auth_sessions (token_hash, user_id, expires_at, created_at)
        SELECT ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)
          AND NOT EXISTS (SELECT 1 FROM account_deletion_fences WHERE user_id = ?)`)
        .bind(
          tokenHash,
          user.id,
          expiresAt.toISOString(),
          createdAt.toISOString(),
          user.id,
          user.id,
        ),
    ]);
  } catch {
    // D1 can commit an atomic batch and lose its response. The random token hash is the receipt key.
  }
  let receipt: { token_hash: string; user_id: string; expires_at: string; created_at: string } | null = null;
  let receiptReadSucceeded = false;
  try {
    receipt = await db.prepare(`SELECT token_hash, user_id, expires_at, created_at
      FROM auth_sessions
      WHERE token_hash = ? AND user_id = ? AND expires_at = ? AND created_at = ?
        AND EXISTS (SELECT 1 FROM users WHERE id = ?)
        AND NOT EXISTS (SELECT 1 FROM account_deletion_fences WHERE user_id = ?)
      LIMIT 1`)
      .bind(
        tokenHash,
        user.id,
        expiresAt.toISOString(),
        createdAt.toISOString(),
        user.id,
        user.id,
      )
      .first<{ token_hash: string; user_id: string; expires_at: string; created_at: string }>();
    receiptReadSucceeded = true;
  } catch {
    // Never disclose a bearer token until its complete post-state is readable.
  }
  if (!receiptReadSucceeded || !receipt
    || receipt.token_hash !== tokenHash || receipt.user_id !== user.id
    || receipt.expires_at !== expiresAt.toISOString() || receipt.created_at !== createdAt.toISOString()) {
    try {
      await db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(tokenHash).run();
    } catch (error) {
      logEvent("error", "auth.session.unconfirmed_cleanup_failed", safeErrorContext(error));
    }
    return errorResponse(
      503,
      "session_creation_unconfirmed",
      "The new session could not be confirmed. Sign in again.",
      clearSessionCookies(request),
    );
  }
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

interface SignupAgeProofCandidate {
  tokenHash: string;
  confirmedAt: string;
  gateVersion: string;
  expiresAt: string;
  createdAt: string;
}

interface SignupAgeProofCreationReceiptRow {
  exact_count: number;
  any_count: number;
}

async function createSignupAgeProof(db: D1DatabaseLike, proof: SignupAgeProofCandidate) {
  try {
    await db.prepare(`INSERT INTO signup_age_proofs
      (token_hash, confirmed_at, gate_version, expires_at, consumed_at, created_at)
      VALUES (?, ?, ?, ?, NULL, ?)`)
      .bind(proof.tokenHash, proof.confirmedAt, proof.gateVersion, proof.expiresAt, proof.createdAt)
      .run();
  } catch {
    // A committed insert can lose its response. Exact stored state below decides
    // whether the random plaintext proof may leave the Worker.
  }

  try {
    const receipt = await db.prepare(`SELECT
        (SELECT COUNT(*) FROM signup_age_proofs
          WHERE token_hash = ? AND confirmed_at = ? AND gate_version = ?
            AND expires_at = ? AND consumed_at IS NULL AND created_at = ?) AS exact_count,
        (SELECT COUNT(*) FROM signup_age_proofs WHERE token_hash = ?) AS any_count`)
      .bind(
        proof.tokenHash,
        proof.confirmedAt,
        proof.gateVersion,
        proof.expiresAt,
        proof.createdAt,
        proof.tokenHash,
      )
      .first<SignupAgeProofCreationReceiptRow>();
    return exactReceiptCounts(receipt, ["exact_count", "any_count"])
      && Number(receipt?.exact_count) === 1
      && Number(receipt?.any_count) === 1;
  } catch {
    return false;
  }
}

type ValidSignupAgeProof = SignupAgeProofCandidate;

async function validateSignupAgeProof(db: D1DatabaseLike, value: unknown): Promise<ValidSignupAgeProof> {
  const proof = typeof value === "string" ? value : "";
  if (!/^[A-Za-z0-9_-]{40,160}$/.test(proof)) {
    throw new AuthError(422, "eligibility_proof_required", "Confirm age eligibility before entering account details.");
  }
  const tokenHash = await sha256(proof);
  const checkedAt = new Date().toISOString();
  const row = await db.prepare(`SELECT confirmed_at, gate_version, expires_at, created_at FROM signup_age_proofs
    WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ? AND gate_version = ?
    LIMIT 1`)
    .bind(tokenHash, checkedAt, AGE_GATE_VERSION)
    .first<{ confirmed_at: string; gate_version: string; expires_at: string; created_at: string }>();
  if (!row?.confirmed_at) {
    throw new AuthError(410, "eligibility_proof_expired", "Age eligibility expired or was already used. Start the age step again.");
  }
  return {
    tokenHash,
    confirmedAt: row.confirmed_at,
    gateVersion: row.gate_version,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

interface SignupAgeProofConsumptionReceiptRow {
  consumed_count: number;
  prior_count: number;
  any_count: number;
}

async function consumeSignupAgeProof(db: D1DatabaseLike, proof: ValidSignupAgeProof) {
  const consumedAt = new Date().toISOString();
  try {
    await db.prepare(`UPDATE signup_age_proofs SET consumed_at = ?
      WHERE token_hash = ? AND confirmed_at = ? AND gate_version = ? AND expires_at = ?
        AND consumed_at IS NULL AND created_at = ? AND expires_at > ?`)
      .bind(
        consumedAt,
        proof.tokenHash,
        proof.confirmedAt,
        proof.gateVersion,
        proof.expiresAt,
        proof.createdAt,
        consumedAt,
      )
      .run();
  } catch {
    // Exact read-back distinguishes a rolled-back use from a committed response loss.
  }

  let receipt: SignupAgeProofConsumptionReceiptRow | null = null;
  let receiptReadSucceeded = false;
  try {
    receipt = await db.prepare(`SELECT
        (SELECT COUNT(*) FROM signup_age_proofs
          WHERE token_hash = ? AND confirmed_at = ? AND gate_version = ? AND expires_at = ?
            AND consumed_at = ? AND created_at = ?) AS consumed_count,
        (SELECT COUNT(*) FROM signup_age_proofs
          WHERE token_hash = ? AND confirmed_at = ? AND gate_version = ? AND expires_at = ?
            AND consumed_at IS NULL AND created_at = ? AND expires_at > ?) AS prior_count,
        (SELECT COUNT(*) FROM signup_age_proofs WHERE token_hash = ?) AS any_count`)
      .bind(
        proof.tokenHash,
        proof.confirmedAt,
        proof.gateVersion,
        proof.expiresAt,
        consumedAt,
        proof.createdAt,
        proof.tokenHash,
        proof.confirmedAt,
        proof.gateVersion,
        proof.expiresAt,
        proof.createdAt,
        consumedAt,
        proof.tokenHash,
      )
      .first<SignupAgeProofConsumptionReceiptRow>();
    receiptReadSucceeded = true;
  } catch {
    // Challenge creation cannot follow an unreadable one-use proof transition.
  }

  if (!receiptReadSucceeded || !exactReceiptCounts(receipt, ["consumed_count", "prior_count", "any_count"])) {
    throw new AuthError(
      503,
      "eligibility_proof_consumption_unconfirmed",
      "Age eligibility use could not be confirmed. Restart signup from the age step.",
    );
  }
  const consumedCount = Number(receipt?.consumed_count);
  const priorCount = Number(receipt?.prior_count);
  const anyCount = Number(receipt?.any_count);
  if (consumedCount === 1 && priorCount === 0 && anyCount === 1) return proof.confirmedAt;
  if (priorCount === 0) {
    throw new AuthError(410, "eligibility_proof_expired", "Age eligibility expired or was already used. Start the age step again.");
  }
  throw new AuthError(
    503,
    "eligibility_proof_consumption_unconfirmed",
    "Age eligibility use could not be confirmed. Restart signup from the age step.",
  );
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

type EmailChallengeCreation = "created" | "rate_limited" | "unconfirmed";

interface EmailChallengeCreationReceiptRow {
  exact_count: number;
  any_count: number;
  recent_count: number;
}

function emailChallengeSnapshotBindings(challenge: EmailChallengeRow) {
  return [
    challenge.id,
    challenge.kind,
    challenge.email,
    challenge.user_id,
    challenge.code_hash,
    challenge.password_salt,
    challenge.password_hash,
    challenge.age_eligibility_confirmed_at,
    challenge.terms_version,
    challenge.privacy_version,
    challenge.expires_at,
    challenge.attempts,
    challenge.resend_count,
    challenge.created_at,
  ];
}

async function createEmailChallenge(
  db: D1DatabaseLike,
  challenge: EmailChallengeRow,
  challengeCutoff: string,
): Promise<EmailChallengeCreation> {
  try {
    await db.prepare(`INSERT INTO email_challenges
      (id, kind, email, user_id, code_hash, password_salt, password_hash,
        age_eligibility_confirmed_at, terms_version, privacy_version, expires_at,
        attempts, resend_count, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE (SELECT COUNT(*) FROM email_challenges WHERE email = ? AND created_at >= ?) < 5`)
      .bind(...emailChallengeSnapshotBindings(challenge), challenge.email, challengeCutoff)
      .run();
  } catch {
    // A committed insert can lose its response. Provider delivery requires the
    // complete random challenge snapshot below, never mutation metadata.
  }

  try {
    const receipt = await db.prepare(`SELECT
        (SELECT COUNT(*) FROM email_challenges
          WHERE id = ? AND kind = ? AND email = ? AND user_id IS ? AND code_hash = ?
            AND password_salt IS ? AND password_hash IS ?
            AND age_eligibility_confirmed_at IS ? AND terms_version IS ? AND privacy_version IS ?
            AND expires_at = ? AND attempts = ? AND resend_count = ? AND created_at = ?) AS exact_count,
        (SELECT COUNT(*) FROM email_challenges WHERE id = ?) AS any_count,
        (SELECT COUNT(*) FROM email_challenges WHERE email = ? AND created_at >= ?) AS recent_count`)
      .bind(
        ...emailChallengeSnapshotBindings(challenge),
        challenge.id,
        challenge.email,
        challengeCutoff,
      )
      .first<EmailChallengeCreationReceiptRow>();
    const exactCount = Number(receipt?.exact_count);
    const anyCount = Number(receipt?.any_count);
    const recentCount = Number(receipt?.recent_count);
    const countsValid = exactReceiptCounts(receipt, ["exact_count", "any_count"])
      && Number.isSafeInteger(recentCount)
      && recentCount >= 0
      && exactCount <= anyCount
      && exactCount <= recentCount;
    if (!countsValid) return "unconfirmed";
    if (exactCount === 1 && anyCount === 1 && recentCount >= 1 && recentCount <= 5) return "created";
    if (exactCount === 0 && anyCount === 0 && recentCount >= 5) return "rate_limited";
    return "unconfirmed";
  } catch {
    return "unconfirmed";
  }
}

function resentEmailChallenge(challenge: EmailChallengeRow, codeHash: string, timestamp: Date): EmailChallengeRow {
  return {
    ...challenge,
    code_hash: codeHash,
    expires_at: new Date(timestamp.getTime() + 15 * 60 * 1000).toISOString(),
    attempts: 0,
    resend_count: Number(challenge.resend_count ?? 0) + 1,
    created_at: timestamp.toISOString(),
  };
}

type EmailChallengeTransition = "updated" | "changed" | "unconfirmed";

interface EmailChallengeTransitionReceiptRow {
  next_count: number;
  prior_count: number;
  any_count: number;
}

async function transitionEmailChallengeForResend(
  db: D1DatabaseLike,
  prior: EmailChallengeRow,
  next: EmailChallengeRow,
): Promise<EmailChallengeTransition> {
  try {
    await db.prepare(`UPDATE email_challenges
      SET code_hash = ?, expires_at = ?, attempts = ?, resend_count = ?, created_at = ?
      WHERE id = ? AND kind = ? AND email = ? AND user_id IS ? AND code_hash = ?
        AND password_salt IS ? AND password_hash IS ? AND age_eligibility_confirmed_at IS ?
        AND terms_version IS ? AND privacy_version IS ? AND expires_at = ?
        AND attempts = ? AND resend_count = ? AND created_at = ?`)
      .bind(
        next.code_hash,
        next.expires_at,
        next.attempts,
        next.resend_count,
        next.created_at,
        ...emailChallengeSnapshotBindings(prior),
      )
      .run();
  } catch {
    // Exact next/prior state distinguishes commit-response loss from rollback.
  }

  try {
    const receipt = await db.prepare(`SELECT
        (SELECT COUNT(*) FROM email_challenges
          WHERE id = ? AND kind = ? AND email = ? AND user_id IS ? AND code_hash = ?
            AND password_salt IS ? AND password_hash IS ?
            AND age_eligibility_confirmed_at IS ? AND terms_version IS ? AND privacy_version IS ?
            AND expires_at = ? AND attempts = ? AND resend_count = ? AND created_at = ?) AS next_count,
        (SELECT COUNT(*) FROM email_challenges
          WHERE id = ? AND kind = ? AND email = ? AND user_id IS ? AND code_hash = ?
            AND password_salt IS ? AND password_hash IS ?
            AND age_eligibility_confirmed_at IS ? AND terms_version IS ? AND privacy_version IS ?
            AND expires_at = ? AND attempts = ? AND resend_count = ? AND created_at = ?) AS prior_count,
        (SELECT COUNT(*) FROM email_challenges WHERE id = ?) AS any_count`)
      .bind(
        ...emailChallengeSnapshotBindings(next),
        ...emailChallengeSnapshotBindings(prior),
        prior.id,
      )
      .first<EmailChallengeTransitionReceiptRow>();
    if (!exactReceiptCounts(receipt, ["next_count", "prior_count", "any_count"])) return "unconfirmed";
    const nextCount = Number(receipt?.next_count);
    const priorCount = Number(receipt?.prior_count);
    const anyCount = Number(receipt?.any_count);
    if (nextCount === 1 && priorCount === 0 && anyCount === 1) return "updated";
    if (nextCount === 0 && priorCount === 0) return "changed";
    return "unconfirmed";
  } catch {
    return "unconfirmed";
  }
}

interface PasswordResetReceiptRow {
  exact_user_count: number;
  any_user_count: number;
  session_count: number;
  exact_challenge_count: number;
  any_challenge_count: number;
  fence_count: number;
}

interface AccountCreationReceiptRow {
  exact_user_count: number;
  any_user_count: number;
  email_user_count: number;
  session_count: number;
  exact_challenge_count: number;
  any_challenge_count: number;
  fence_count: number;
}

interface ChallengeAttemptReceiptRow {
  claimed_count: number;
  prior_count: number;
  any_count: number;
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
  const verifiedAt = new Date().toISOString();
  if (!row || row.expires_at <= verifiedAt) {
    if (kind === "password_reset") {
      throw new AuthError(401, "invalid_code", "That code is invalid or expired. Request a new one.");
    }
    throw new AuthError(410, "code_expired", "That code expired. Request a new one.");
  }
  if (Number(row.attempts) >= 6) {
    if (kind === "password_reset") {
      throw new AuthError(401, "invalid_code", "That code is invalid or expired. Request a new one.");
    }
    throw new AuthError(429, "too_many_code_attempts", "Too many code attempts. Request a new code.");
  }
  const claimedAttempts = Number(row.attempts) + 1;
  const snapshotParameters = (attempts: number) => [
    row.id,
    row.kind,
    row.email,
    row.user_id,
    row.code_hash,
    row.password_salt,
    row.password_hash,
    row.age_eligibility_confirmed_at,
    row.terms_version,
    row.privacy_version,
    row.created_at,
    attempts,
    Number(row.resend_count ?? 0),
    row.expires_at,
    verifiedAt,
  ];
  try {
    await db.prepare(`UPDATE email_challenges SET attempts = ?
      WHERE id = ? AND kind = ? AND email = ? AND user_id IS ? AND code_hash = ?
        AND password_salt IS ? AND password_hash IS ? AND age_eligibility_confirmed_at IS ?
        AND terms_version IS ? AND privacy_version IS ? AND created_at = ?
        AND attempts = ? AND resend_count = ? AND expires_at = ? AND expires_at > ?`)
      .bind(claimedAttempts, ...snapshotParameters(Number(row.attempts)))
      .run();
  } catch {
    // The claim can commit and lose its response. Only the exact challenge version decides.
  }
  let receipt: ChallengeAttemptReceiptRow | null = null;
  let receiptReadSucceeded = false;
  try {
    receipt = await db.prepare(`SELECT
        (SELECT COUNT(*) FROM email_challenges
          WHERE id = ? AND kind = ? AND email = ? AND user_id IS ? AND code_hash = ?
            AND password_salt IS ? AND password_hash IS ? AND age_eligibility_confirmed_at IS ?
            AND terms_version IS ? AND privacy_version IS ? AND created_at = ?
            AND attempts = ? AND resend_count = ? AND expires_at = ? AND expires_at > ?) AS claimed_count,
        (SELECT COUNT(*) FROM email_challenges
          WHERE id = ? AND kind = ? AND email = ? AND user_id IS ? AND code_hash = ?
            AND password_salt IS ? AND password_hash IS ? AND age_eligibility_confirmed_at IS ?
            AND terms_version IS ? AND privacy_version IS ? AND created_at = ?
            AND attempts = ? AND resend_count = ? AND expires_at = ? AND expires_at > ?) AS prior_count,
        (SELECT COUNT(*) FROM email_challenges WHERE id = ? AND kind = ?) AS any_count`)
      .bind(
        ...snapshotParameters(claimedAttempts),
        ...snapshotParameters(Number(row.attempts)),
        row.id,
        row.kind,
      )
      .first<ChallengeAttemptReceiptRow>();
    receiptReadSucceeded = true;
  } catch {
    // Never let an unreadable claim authorize a credential transition.
  }
  const claimedCount = Number(receipt?.claimed_count);
  const priorCount = Number(receipt?.prior_count);
  const anyCount = Number(receipt?.any_count);
  const countsValid = [claimedCount, priorCount, anyCount]
    .every((count) => Number.isSafeInteger(count) && count >= 0 && count <= 1)
    && claimedCount + priorCount <= anyCount;
  if (!receiptReadSucceeded || !countsValid || claimedCount !== 1 || anyCount !== 1) {
    if (kind === "password_reset") {
      throw new AuthError(401, "invalid_code", "That code is invalid or expired. Request a new one.");
    }
    if (receiptReadSucceeded && countsValid && priorCount === 0) {
      throw new AuthError(409, "challenge_changed", "That verification request changed. Use its latest code or start again.");
    }
    throw new AuthError(503, "challenge_attempt_unconfirmed", "That code attempt could not be confirmed. Try again.");
  }
  const valid = (await sha256(`${challengeId}:${code}`)) === row.code_hash;
  if (!valid) {
    if (kind === "password_reset") {
      throw new AuthError(401, "invalid_code", "That code is invalid or expired. Request a new one.");
    }
    throw new AuthError(401, "invalid_code", "That verification code is incorrect.");
  }
  return { ...row, attempts: claimedAttempts };
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

function hasPresentedSessionCookie(request: Request) {
  const cookies = parseCookies(request.headers.get("Cookie") ?? "");
  return cookies.has(SESSION_COOKIE) || cookies.has(LEGACY_SESSION_COOKIE);
}

async function revokePresentedSessions(
  db: D1DatabaseLike,
  tokens: Array<{ cookieName: string; token: string }>,
) {
  if (tokens.length === 0) return true;
  const tokenHashes = await Promise.all(tokens.map(({ token }) => sha256(token)));
  try {
    await db.batch(tokenHashes.map((tokenHash) =>
      db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(tokenHash)));
  } catch {
    // A transactional batch can commit and lose its response. Exact absence below
    // is the only receipt that is allowed to clear the browser's session cookie.
  }

  try {
    const receipts = await Promise.all(tokenHashes.map((tokenHash) =>
      db.prepare("SELECT COUNT(*) AS count FROM auth_sessions WHERE token_hash = ?")
        .bind(tokenHash)
        .first<{ count: number }>()));
    return receipts.every((receipt) => {
      const count = Number(receipt?.count);
      return receipt !== null && Number.isSafeInteger(count) && count === 0;
    });
  } catch {
    return false;
  }
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
  challenge: EmailChallengeRow,
  delivery: Promise<void>,
) {
  const guardedDelivery = delivery.catch(async (error) => {
    await cleanupEmailChallengeCandidate(db, challenge);
    logEvent("error", "password_recovery.email_delivery_deferred", safeErrorContext(error));
  });
  options.waitUntil?.(guardedDelivery);
  return guardedDelivery;
}

async function cleanupSignupAgeProofCandidate(db: D1DatabaseLike, proof: SignupAgeProofCandidate) {
  try {
    await db.prepare(`DELETE FROM signup_age_proofs
      WHERE token_hash = ? AND confirmed_at = ? AND gate_version = ?
        AND expires_at = ? AND consumed_at IS NULL AND created_at = ?`)
      .bind(proof.tokenHash, proof.confirmedAt, proof.gateVersion, proof.expiresAt, proof.createdAt)
      .run();
  } catch (error) {
    logEvent("error", "signup.age_proof_cleanup_failed", safeErrorContext(error));
  }
}

async function cleanupEmailChallengeCandidate(
  db: D1DatabaseLike,
  challenge: EmailChallengeRow,
) {
  try {
    await db.prepare(`DELETE FROM email_challenges
      WHERE id = ? AND kind = ? AND email = ? AND user_id IS ? AND code_hash = ?
        AND password_salt IS ? AND password_hash IS ? AND age_eligibility_confirmed_at IS ?
        AND terms_version IS ? AND privacy_version IS ? AND expires_at = ?
        AND attempts = ? AND resend_count = ? AND created_at = ?`)
      .bind(...emailChallengeSnapshotBindings(challenge))
      .run();
  } catch (error) {
    logEvent("error", "email.challenge_cleanup_failed", safeErrorContext(error));
  }
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

function errorResponse(status: number, code: string, message: string, cookie?: string | string[], headers?: HeadersInit) {
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
