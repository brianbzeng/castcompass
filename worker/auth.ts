import type { CuratedSite, D1DatabaseLike, TripRow } from "./trips";

const SESSION_COOKIE = "cc_session";
const SESSION_SECONDS = 30 * 24 * 60 * 60;
export const LEGAL_VERSION = "2026-07-15";
const MINIMUM_ACCOUNT_AGE = 13;
// Cloudflare Workers currently caps Web Crypto PBKDF2 at 100,000 rounds.
const PASSWORD_ITERATIONS = 100_000;

export interface AuthApiEnv {
  DB?: D1DatabaseLike;
  TRIP_PHOTOS?: { delete(key: string): Promise<void> };
  RESEND_API_KEY?: string;
  AUTH_EMAIL_FROM?: string;
}

export interface AuthUser {
  id: string;
  email: string;
  legalAccepted: boolean;
}

interface AccountRequestOptions {
  onTripUpdated?(trip: TripRow): void;
  onTripsReviewRequested?(trips: TripRow[]): void;
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

async function initialize(db: D1DatabaseLike) {
  let pending = initializedDatabases.get(db as object);
  if (!pending) {
    pending = db.batch([
      db.prepare(CREATE_USERS_SQL),
      db.prepare(CREATE_SESSIONS_SQL),
      db.prepare(CREATE_SAVED_SITES_SQL),
      db.prepare(CREATE_AUTH_ATTEMPTS_SQL),
      db.prepare(CREATE_EMAIL_CHALLENGES_SQL),
      db.prepare(CREATE_GEAR_PROFILES_SQL),
      db.prepare("CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions (user_id, expires_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS auth_attempts_email_time_idx ON auth_attempts (email_hash, attempted_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS email_challenges_email_time_idx ON email_challenges (email, created_at)"),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS gear_profiles_user_name_unique ON gear_profiles (user_id, name)"),
      db.prepare("CREATE INDEX IF NOT EXISTS gear_profiles_user_updated_idx ON gear_profiles (user_id, updated_at)"),
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
  const row = await env.DB
    .prepare(`SELECT users.id, users.email,
        CASE WHEN users.age_eligibility_confirmed_at IS NOT NULL
          AND users.terms_version = ? AND users.privacy_version = ?
          THEN 1 ELSE 0 END AS legal_accepted
      FROM auth_sessions
      JOIN users ON users.id = auth_sessions.user_id
      WHERE auth_sessions.token_hash = ? AND auth_sessions.expires_at > ?
      LIMIT 1`)
    .bind(LEGAL_VERSION, LEGAL_VERSION, tokenHash, now)
    .first<{ id: string; email: string; legal_accepted: number }>();
  return row ? { id: row.id, email: row.email, legalAccepted: Boolean(row.legal_accepted) } : null;
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
    !url.pathname.startsWith("/api/profile/reviews/") &&
    !url.pathname.startsWith("/api/profile/trips/")
  ) return null;
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
      return errorResponse(410, "verification_required", "Create accounts through email verification.");
    }

    if (url.pathname === "/api/auth/signup/request") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      assertSameOrigin(request);
      const body = await readJson(request);
      const email = parseEmail(body.email);
      const password = parsePassword(body.password);
      const ageEligibilityConfirmedAt = parseAgeEligibility(body.birthDate);
      assertLegalAcceptance(body);
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
      const challenge = await verifyEmailChallenge(db, body.challengeId, body.code, "signup");
      const existing = await db.prepare("SELECT id FROM users WHERE email = ? LIMIT 1").bind(challenge.email).first();
      if (existing) return errorResponse(409, "email_in_use", "An account already uses this email.");
      if (!challenge.password_salt || !challenge.password_hash || !challenge.age_eligibility_confirmed_at ||
        challenge.terms_version !== LEGAL_VERSION || challenge.privacy_version !== LEGAL_VERSION) {
        throw new AuthError(400, "invalid_challenge", "Request a new verification code.");
      }
      const user: AuthUser = { id: `user_${crypto.randomUUID()}`, email: challenge.email, legalAccepted: true };
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
        console.error("Welcome email delivery failed", error);
      });
      return createSessionResponse(db, request, user, 201);
    }

    if (url.pathname === "/api/auth/challenge/resend") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      assertSameOrigin(request);
      const body = await readJson(request);
      const challengeId = typeof body.challengeId === "string" ? body.challengeId : "";
      if (!/^challenge_[a-f0-9-]{36}$/.test(challengeId)) {
        throw new AuthError(422, "invalid_challenge", "Start the email verification again.");
      }
      const challenge = await db.prepare("SELECT * FROM email_challenges WHERE id = ? LIMIT 1")
        .bind(challengeId)
        .first<EmailChallengeRow>();
      if (!challenge) {
        // Keep password-reset requests from becoming an account-enumeration path.
        return jsonResponse({ requested: true, challengeId, expiresInMinutes: 15, retryAfterSeconds: 60 });
      }
      const createdAt = new Date(challenge.created_at).getTime();
      const retryAfterSeconds = Math.max(0, 60 - Math.floor((Date.now() - createdAt) / 1000));
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
      const email = parseEmail(body.email);
      const user = await db.prepare("SELECT id FROM users WHERE email = ? LIMIT 1").bind(email).first<{ id: string }>();
      if (!user) return jsonResponse({ requested: true, challengeId: `challenge_${crypto.randomUUID()}`, expiresInMinutes: 15 });
      await assertEmailChallengeAllowed(db, email);
      const id = `challenge_${crypto.randomUUID()}`;
      const code = randomCode();
      const timestamp = new Date();
      await db.prepare(`INSERT INTO email_challenges
        (id, kind, email, user_id, code_hash, expires_at, attempts, created_at)
        VALUES (?, 'password_reset', ?, ?, ?, ?, 0, ?)`)
        .bind(id, email, user.id, await sha256(`${id}:${code}`), new Date(timestamp.getTime() + 15 * 60 * 1000).toISOString(), timestamp.toISOString())
        .run();
      try {
        await sendVerificationEmail(env, email, code, "Reset your CastingCompass password");
      } catch (error) {
        await db.prepare("DELETE FROM email_challenges WHERE id = ?").bind(id).run();
        throw error;
      }
      return jsonResponse({ requested: true, challengeId: id, expiresInMinutes: 15 });
    }

    if (url.pathname === "/api/auth/password/reset") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      assertSameOrigin(request);
      const body = await readJson(request);
      const password = parsePassword(body.password);
      const challenge = await verifyEmailChallenge(db, body.challengeId, body.code, "password_reset");
      if (!challenge.user_id) throw new AuthError(400, "invalid_challenge", "Request a new reset code.");
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
          CASE WHEN age_eligibility_confirmed_at IS NOT NULL AND terms_version = ? AND privacy_version = ?
            THEN 1 ELSE 0 END AS legal_accepted
          FROM users WHERE email = ? LIMIT 1`)
        .bind(LEGAL_VERSION, LEGAL_VERSION, email)
        .first<{ id: string; email: string; password_salt: string; password_hash: string; legal_accepted: number }>();
      const valid = row ? await verifyPassword(password, row.password_salt, row.password_hash) : false;
      await db.prepare("INSERT INTO auth_attempts (id, email_hash, attempted_at, successful) VALUES (?, ?, ?, ?)")
        .bind(`attempt_${crypto.randomUUID()}`, emailHash, new Date().toISOString(), Number(valid))
        .run();
      if (!row || !valid) return errorResponse(401, "invalid_credentials", "Email or password is incorrect.");
      return createSessionResponse(db, request, { id: row.id, email: row.email, legalAccepted: Boolean(row.legal_accepted) });
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

    if (url.pathname === "/api/auth/eligibility") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      assertSameOrigin(request);
      const body = await readJson(request);
      const timestamp = parseAgeEligibility(body.birthDate);
      assertLegalAcceptance(body);
      await db.prepare(`UPDATE users SET age_eligibility_confirmed_at = ?, terms_accepted_at = ?, terms_version = ?,
        privacy_accepted_at = ?, privacy_version = ?, updated_at = ? WHERE id = ?`)
        .bind(timestamp, timestamp, LEGAL_VERSION, timestamp, LEGAL_VERSION, timestamp, user.id)
        .run();
      return jsonResponse({ user: { ...user, legalAccepted: true }, legalVersion: LEGAL_VERSION });
    }

    if (url.pathname === "/api/profile/export") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      const [account, saved, gear, trips] = await Promise.all([
        db.prepare(`SELECT id, email, age_eligibility_confirmed_at, terms_accepted_at, terms_version,
          privacy_accepted_at, privacy_version, created_at, updated_at FROM users WHERE id = ? LIMIT 1`)
          .bind(user.id).first<Record<string, unknown>>(),
        db.prepare("SELECT site_id, created_at FROM saved_sites WHERE user_id = ? ORDER BY created_at DESC")
          .bind(user.id).all<Record<string, unknown>>(),
        db.prepare(`SELECT id, name, rod, reel, bait_lure, rig, created_at, updated_at
          FROM gear_profiles WHERE user_id = ? ORDER BY updated_at DESC`)
          .bind(user.id).all<Record<string, unknown>>(),
        db.prepare(`SELECT id, source, site_id, started_at, ended_at, mode, fishing_method, gear_profile_id,
          rod, reel, bait_lure, rig, angler_count, angler_hours, keeper_count, short_released_count,
          halibut_encounters, no_catch, other_catch_count, other_species, observations_json, notes,
          moderation_status, opportunity_window_id, opportunity_score, habitat_score, seasonality_score,
          conditions_score, fishability_score, model_version, score_influenced_choice,
          prediction_metadata_json, photo_content_type, photo_size_bytes, created_at, updated_at,
          completed_at, ai_review_status, ai_review_json, ai_review_model, ai_reviewed_at
          FROM trips WHERE user_id = ? ORDER BY created_at DESC`)
          .bind(user.id).all<Record<string, unknown>>(),
      ]);
      return jsonResponse({
        exportedAt: new Date().toISOString(),
        account,
        savedSites: saved.results ?? [],
        gearProfiles: gear.results ?? [],
        tripReports: trips.results ?? [],
      }, 200, undefined, { "Content-Disposition": `attachment; filename="castingcompass-data-${new Date().toISOString().slice(0, 10)}.json"` });
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
      await db.batch([
        db.prepare("DELETE FROM site_discussion_posts WHERE trip_id IN (SELECT id FROM trips WHERE user_id = ?)").bind(user.id),
        db.prepare("DELETE FROM trips WHERE user_id = ?").bind(user.id),
        db.prepare("DELETE FROM saved_sites WHERE user_id = ?").bind(user.id),
        db.prepare("DELETE FROM gear_profiles WHERE user_id = ?").bind(user.id),
        db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").bind(user.id),
        db.prepare("DELETE FROM email_challenges WHERE email = ? OR user_id = ?").bind(user.email, user.id),
        db.prepare("DELETE FROM auth_attempts WHERE email_hash = ?").bind(await sha256(user.email)),
        db.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
      ]);
      await Promise.all((photos.results ?? []).map((photo) => env.TRIP_PHOTOS?.delete(photo.photo_key).catch(() => undefined)));
      return jsonResponse({ deleted: true }, 200, clearSessionCookie(request));
    }

    if (!user.legalAccepted) {
      return errorResponse(428, "legal_acceptance_required", "Confirm that you are 13 or older and accept the current Terms and Privacy Policy to continue.");
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
        db.prepare("SELECT site_id, created_at FROM saved_sites WHERE user_id = ? ORDER BY created_at DESC")
          .bind(user.id)
          .all<{ site_id: string; created_at: string }>(),
        db.prepare(`SELECT id, source, site_id, started_at, ended_at, mode, fishing_method,
          angler_count, angler_hours, keeper_count, short_released_count, halibut_encounters,
          no_catch, other_catch_count, other_species, observations_json, notes, moderation_status,
          opportunity_score, fishability_score, model_version, gear_profile_id, rod, reel,
          bait_lure, rig, ai_review_status, ai_review_json, ai_review_model, ai_reviewed_at, completed_at
          FROM trips
          WHERE user_id = ? AND status = 'completed'
          ORDER BY COALESCE(completed_at, ended_at, started_at) DESC
          LIMIT 100`)
          .bind(user.id)
          .all<Record<string, unknown>>(),
        db.prepare(`SELECT id, name, rod, reel, bait_lure, rig, created_at, updated_at
          FROM gear_profiles WHERE user_id = ? ORDER BY updated_at DESC`)
          .bind(user.id)
          .all<Record<string, unknown>>(),
      ]);
      return jsonResponse({
        user,
        savedSites: savedRows.results ?? [],
        trips: tripRows.results ?? [],
        gearProfiles: gearRows.results ?? [],
      });
    }

    if (url.pathname === "/api/gear-profiles") {
      if (request.method === "GET") {
        const rows = await db.prepare(`SELECT id, name, rod, reel, bait_lure, rig, created_at, updated_at
          FROM gear_profiles WHERE user_id = ? ORDER BY updated_at DESC`)
          .bind(user.id)
          .all<Record<string, unknown>>();
        return jsonResponse({ gearProfiles: rows.results ?? [] });
      }
      if (request.method === "POST") {
        assertSameOrigin(request);
        const body = await readJson(request);
        const id = `gear_${crypto.randomUUID()}`;
        const timestamp = new Date().toISOString();
        const gear = parseGearProfile(body);
        await db.prepare(`INSERT INTO gear_profiles
          (id, user_id, name, rod, reel, bait_lure, rig, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(id, user.id, gear.name, gear.rod, gear.reel, gear.baitLure, gear.rig, timestamp, timestamp)
          .run();
        return jsonResponse({ gearProfile: { id, ...gear, created_at: timestamp, updated_at: timestamp } }, 201);
      }
      return methodNotAllowed("GET, POST");
    }

    const gearProfileMatch = url.pathname.match(/^\/api\/gear-profiles\/(gear_[a-f0-9-]{36})$/);
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
        const gear = parseGearProfile(await readJson(request));
        const timestamp = new Date().toISOString();
        await db.prepare(`UPDATE gear_profiles SET name = ?, rod = ?, reel = ?, bait_lure = ?, rig = ?, updated_at = ?
          WHERE id = ? AND user_id = ?`)
          .bind(gear.name, gear.rod, gear.reel, gear.baitLure, gear.rig, timestamp, id, user.id)
          .run();
        return jsonResponse({ updated: true, id });
      }
      return methodNotAllowed("PATCH, DELETE");
    }

    const profileTripMatch = url.pathname.match(/^\/api\/profile\/trips\/(trip_[a-f0-9-]{36})$/);
    if (profileTripMatch) {
      assertSameOrigin(request);
      const tripId = profileTripMatch[1];
      const trip = await db.prepare(`SELECT id, user_id, moderation_status, photo_key
        FROM trips WHERE id = ? AND user_id = ? AND status = 'completed' LIMIT 1`)
        .bind(tripId, user.id)
        .first<{ id: string; user_id: string; moderation_status: string; photo_key: string | null }>();
      if (!trip) return errorResponse(404, "trip_not_found", "That trip log could not be found.");
      if (trip.moderation_status !== "pending") {
        return errorResponse(409, "trip_reviewed", "Reviewed trip logs can no longer be changed.");
      }

      if (request.method === "DELETE") {
        await db.prepare("DELETE FROM trips WHERE id = ? AND user_id = ? AND moderation_status = 'pending'")
          .bind(tripId, user.id)
          .run();
        if (trip.photo_key) await env.TRIP_PHOTOS?.delete(trip.photo_key).catch(() => undefined);
        return jsonResponse({ deleted: true, tripId });
      }

      if (request.method === "PATCH") {
        const body = await readJson(request);
        const siteId = parseProfileTripSite(body.siteId, curatedSites);
        const startedAt = parseProfileTripDate(body.startedAt, "start time");
        const endedAt = parseProfileTripDate(body.endedAt, "finish time");
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
        const observations = parseProfileTripObservations(body);
        const notes = parseProfileTripText(body.notes, "notes", 1000, false);
        const timestamp = new Date().toISOString();
        await db.prepare(`UPDATE trips SET site_id = ?, started_at = ?, ended_at = ?, fishing_method = ?,
          angler_count = ?, angler_hours = ?, keeper_count = ?, short_released_count = ?,
          halibut_encounters = ?, no_catch = ?, gear_profile_id = ?, rod = ?, reel = ?, bait_lure = ?, rig = ?,
          other_catch_count = ?, other_species = ?, observations_json = ?, notes = ?, updated_at = ?, completed_at = ?,
          ai_review_status = 'retry', ai_review_json = NULL, ai_reviewed_at = NULL
          WHERE id = ? AND user_id = ? AND moderation_status = 'pending'`)
          .bind(
            siteId,
            startedAt,
            endedAt,
            fishingMethod,
            anglerCount,
            Math.round(durationHours * anglerCount * 100) / 100,
            keeperCount,
            shortReleasedCount,
            keeperCount + shortReleasedCount,
            Number(keeperCount + shortReleasedCount === 0),
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
            tripId,
            user.id,
          )
          .run();
        const updatedTrip = await db.prepare("SELECT * FROM trips WHERE id = ? AND user_id = ? LIMIT 1")
          .bind(tripId, user.id)
          .first<TripRow>();
        if (updatedTrip) options.onTripUpdated?.(updatedTrip);
        return jsonResponse({ updated: true, tripId });
      }

      return methodNotAllowed("PATCH, DELETE");
    }

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
      return errorResponse(422, "invalid_site", "Choose a current CastingCompass location.");
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

function parseProfileTripSite(value: unknown, curatedSites: readonly CuratedSite[]) {
  if (typeof value !== "string" || !curatedSites.some((site) => site.id === value)) {
    throw new AuthError(422, "invalid_site", "Choose a current CastingCompass location.");
  }
  return value;
}

function parseProfileTripDate(value: unknown, label: string) {
  if (typeof value !== "string" || value.length > 80) {
    throw new AuthError(422, "invalid_date", `Enter a valid ${label}.`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() > Date.now() + 15 * 60 * 1000) {
    throw new AuthError(422, "invalid_date", `Enter a valid ${label}.`);
  }
  return date.toISOString();
}

function parseProfileTripInteger(value: unknown, label: string, minimum: number, maximum: number) {
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
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new AuthError(422, "invalid_number", `${label} must be between ${minimum} and ${maximum}.`);
  }
  return Math.round(parsed * 10) / 10;
}

export function unauthorizedResponse() {
  return errorResponse(401, "authentication_required", "Sign in to submit a trip report or save a location.");
}

export function legalAcceptanceRequiredResponse() {
  return errorResponse(428, "legal_acceptance_required", "Confirm that you are 13 or older and accept the current Terms and Privacy Policy to continue.");
}

export async function cleanupAuthData(env: AuthApiEnv) {
  if (!env.DB) return;
  await initialize(env.DB);
  const now = new Date();
  const expiredChallengeCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const attemptCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").bind(now.toISOString()),
    env.DB.prepare("DELETE FROM email_challenges WHERE expires_at <= ?").bind(expiredChallengeCutoff),
    env.DB.prepare("DELETE FROM auth_attempts WHERE attempted_at < ?").bind(attemptCutoff),
  ]);
}

async function selectUserForSession(db: D1DatabaseLike, userId: string) {
  const row = await db.prepare(`SELECT id, email,
    CASE WHEN age_eligibility_confirmed_at IS NOT NULL AND terms_version = ? AND privacy_version = ?
      THEN 1 ELSE 0 END AS legal_accepted
    FROM users WHERE id = ? LIMIT 1`)
    .bind(LEGAL_VERSION, LEGAL_VERSION, userId)
    .first<{ id: string; email: string; legal_accepted: number }>();
  return row ? { id: row.id, email: row.email, legalAccepted: Boolean(row.legal_accepted) } : null;
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

function assertLegalAcceptance(body: Record<string, unknown>) {
  if (body.acceptTerms !== true || body.acceptPrivacy !== true) {
    throw new AuthError(422, "legal_acceptance_required", "Accept the Terms of Service and Privacy Policy to create or continue using an account.");
  }
}

function parseAgeEligibility(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AuthError(422, "invalid_birth_date", "Enter a valid birth date.");
  }
  const [year, month, day] = value.split("-").map(Number);
  const birthDate = new Date(Date.UTC(year, month - 1, day));
  if (birthDate.getUTCFullYear() !== year || birthDate.getUTCMonth() !== month - 1 || birthDate.getUTCDate() !== day) {
    throw new AuthError(422, "invalid_birth_date", "Enter a valid birth date.");
  }
  const today = new Date();
  let age = today.getUTCFullYear() - year;
  if (today.getUTCMonth() < month - 1 || (today.getUTCMonth() === month - 1 && today.getUTCDate() < day)) age -= 1;
  if (age < MINIMUM_ACCOUNT_AGE) {
    throw new AuthError(403, "age_restricted", "CastingCompass accounts are available only to people age 13 or older.");
  }
  if (age > 120 || birthDate.getTime() > today.getTime()) {
    throw new AuthError(422, "invalid_birth_date", "Enter a valid birth date.");
  }
  // The birth date is deliberately not retained. Only this eligibility timestamp is stored.
  return today.toISOString();
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
    throw new AuthError(410, "code_expired", "That code expired. Request a new one.");
  }
  if (Number(row.attempts) >= 6) {
    throw new AuthError(429, "too_many_code_attempts", "Too many code attempts. Request a new code.");
  }
  const valid = (await sha256(`${challengeId}:${code}`)) === row.code_hash;
  if (!valid) {
    await db.prepare("UPDATE email_challenges SET attempts = attempts + 1 WHERE id = ?").bind(challengeId).run();
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
    console.error("Transactional email delivery failed", response.status, await response.text());
    throw new AuthError(502, "email_delivery_failed", "The verification email could not be sent. Try again shortly.");
  }
  const receipt = await response.json().catch(() => null) as { id?: string } | null;
  console.log("Transactional email accepted by Resend", { id: receipt?.id, to, subject });
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
  if (!response.ok) throw new Error(`Welcome email failed with status ${response.status}: ${await response.text()}`);
  const receipt = await response.json().catch(() => null) as { id?: string } | null;
  console.log("Welcome email accepted by Resend", { id: receipt?.id, to });
}

function randomCode() {
  const values = crypto.getRandomValues(new Uint32Array(1));
  return String(values[0] % 1_000_000).padStart(6, "0");
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

function jsonResponse(body: unknown, status = 200, cookie?: string, extraHeaders?: HeadersInit) {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  if (cookie) headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify(body), { status, headers });
}
