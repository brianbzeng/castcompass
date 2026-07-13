const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_PHOTO_BYTES + 1024 * 1024;
const REPORTER_COOKIE = "cc_reporter";
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const ALLOWED_MODES = new Set(["shore", "beach", "pier", "jetty", "kayak", "boat", "other"]);

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<{ success?: boolean; meta?: { changes?: number } }>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch(statements: D1PreparedStatementLike[]): Promise<unknown[]>;
}

interface R2BucketLike {
  put(
    key: string,
    value: ArrayBuffer,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
  delete(key: string): Promise<void>;
}

interface ImageBindingLike {
  input(stream: ReadableStream): {
    transform(options: Record<string, unknown>): {
      output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
    };
  };
}

export interface TripApiEnv {
  DB?: D1DatabaseLike;
  TRIP_PHOTOS?: R2BucketLike;
  IMAGES?: ImageBindingLike;
}

export interface CuratedSite {
  id: string;
  type?: string;
}

export interface TripRow {
  id: string;
  user_id: string | null;
  status: "active" | "completed";
  source: "live" | "past_report";
  site_id: string;
  started_at: string;
  ended_at: string | null;
  mode: string;
  fishing_method: string | null;
  gear: string | null;
  angler_count: number;
  angler_hours: number | null;
  keeper_count: number | null;
  short_released_count: number | null;
  halibut_encounters: number | null;
  no_catch: number | null;
  notes: string | null;
  consent: number;
  consent_at: string | null;
  moderation_status: "pending" | "approved" | "rejected";
  reporter_key_hash: string;
  referral_code: string | null;
  token_hash: string | null;
  opportunity_window_id: string | null;
  opportunity_score: number | null;
  habitat_score: number | null;
  seasonality_score: number | null;
  conditions_score: number | null;
  model_version: string | null;
  score_influenced_choice: number | null;
  prediction_metadata_json: string | null;
  photo_key: string | null;
  photo_content_type: string | null;
  photo_size_bytes: number | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  ai_review_status: string | null;
  ai_review_json: string | null;
  ai_review_model: string | null;
  ai_reviewed_at: string | null;
}

interface NewTripRecord {
  id: string;
  userId: string | null;
  status: "active" | "completed";
  source: "live" | "past_report";
  siteId: string;
  startedAt: string;
  endedAt: string | null;
  mode: string;
  fishingMethod: string | null;
  gear: string | null;
  anglerCount: number;
  anglerHours: number | null;
  keeperCount: number | null;
  shortReleasedCount: number | null;
  halibutEncounters: number | null;
  noCatch: boolean | null;
  notes: string | null;
  consent: boolean;
  consentAt: string | null;
  moderationStatus: "pending";
  reporterKeyHash: string;
  referralCode: string | null;
  tokenHash: string | null;
  opportunityWindowId: string | null;
  opportunityScore: number | null;
  habitatScore: number | null;
  seasonalityScore: number | null;
  conditionsScore: number | null;
  modelVersion: string | null;
  scoreInfluencedChoice: boolean | null;
  predictionMetadataJson: string | null;
  photoKey: string | null;
  photoContentType: string | null;
  photoSizeBytes: number | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface CompletionRecord {
  endedAt: string;
  mode: string;
  fishingMethod: string | null;
  gear: string | null;
  anglerCount: number;
  anglerHours: number;
  keeperCount: number;
  shortReleasedCount: number;
  halibutEncounters: number;
  noCatch: boolean;
  notes: string | null;
  consentAt: string;
  scoreInfluencedChoice: boolean | null;
  photoKey: string | null;
  photoContentType: string | null;
  photoSizeBytes: number | null;
  updatedAt: string;
}

interface TripSummary {
  completedTrips: number;
  noCatchTrips: number;
  halibutTrips: number;
  totalHalibut: number;
  anglerHours: number;
  halibutEncounters: number;
  sitesCovered: number;
  lastUpdated: string | null;
  past24Hours: {
    completedTrips: number;
    anglerHours: number;
    halibutEncounters: number;
    sitesCovered: number;
  };
}

export interface TripStore {
  initialize(): Promise<void>;
  assertSubmissionAllowed(reporterKeyHash: string, now: Date): Promise<void>;
  insertTrip(record: NewTripRecord): Promise<TripRow>;
  getTrip(id: string): Promise<TripRow | null>;
  completeTrip(id: string, tokenHash: string, completion: CompletionRecord): Promise<TripRow | null>;
  getSummary(now: Date): Promise<TripSummary>;
}

export interface TripHandlerOptions {
  store?: TripStore;
  now?: () => Date;
  accountId?: string | null;
  onTripCompleted?: (trip: TripRow) => void;
}

const CREATE_TRIPS_SQL = `CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  site_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  mode TEXT NOT NULL,
  fishing_method TEXT,
  gear TEXT,
  angler_count INTEGER NOT NULL,
  angler_hours REAL,
  keeper_count INTEGER,
  short_released_count INTEGER,
  halibut_encounters INTEGER,
  no_catch INTEGER,
  notes TEXT,
  consent INTEGER NOT NULL,
  consent_at TEXT,
  moderation_status TEXT NOT NULL,
  reporter_key_hash TEXT NOT NULL,
  referral_code TEXT,
  token_hash TEXT,
  opportunity_window_id TEXT,
  opportunity_score REAL,
  habitat_score REAL,
  seasonality_score REAL,
  conditions_score REAL,
  model_version TEXT,
  score_influenced_choice INTEGER,
  prediction_metadata_json TEXT,
  photo_key TEXT,
  photo_content_type TEXT,
  photo_size_bytes INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  ai_review_status TEXT,
  ai_review_json TEXT,
  ai_review_model TEXT,
  ai_reviewed_at TEXT,
  CONSTRAINT trips_status_check CHECK (status in ('active', 'completed')),
  CONSTRAINT trips_source_check CHECK (source in ('live', 'past_report')),
  CONSTRAINT trips_moderation_status_check CHECK (moderation_status in ('pending', 'approved', 'rejected')),
  CONSTRAINT trips_angler_count_check CHECK (angler_count between 1 and 12)
)`;

const CREATE_INDEX_STATEMENTS = [
  "CREATE INDEX IF NOT EXISTS trips_status_started_idx ON trips (status, started_at)",
  "CREATE INDEX IF NOT EXISTS trips_site_started_idx ON trips (site_id, started_at)",
  "CREATE INDEX IF NOT EXISTS trips_reporter_created_idx ON trips (reporter_key_hash, created_at)",
  "CREATE INDEX IF NOT EXISTS trips_referral_created_idx ON trips (referral_code, created_at)",
  "CREATE INDEX IF NOT EXISTS trips_user_completed_idx ON trips (user_id, completed_at)",
];

const INSERT_TRIP_SQL = `INSERT INTO trips (
  id, user_id, status, source, site_id, started_at, ended_at, mode, fishing_method, gear,
  angler_count, angler_hours, keeper_count, short_released_count, halibut_encounters,
  no_catch, notes, consent, consent_at, moderation_status, reporter_key_hash, referral_code, token_hash,
  opportunity_window_id, opportunity_score, habitat_score, seasonality_score, conditions_score,
  model_version, score_influenced_choice, prediction_metadata_json, photo_key,
  photo_content_type, photo_size_bytes, created_at, updated_at, completed_at
) VALUES (
  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?, ?
)`;

const initializedDatabases = new WeakMap<object, Promise<void>>();

export class RateLimitError extends Error {
  constructor() {
    super("Too many trip submissions. Please try again later.");
    this.name = "RateLimitError";
  }
}

class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function createTripStore(db: D1DatabaseLike): TripStore {
  const initialize = async () => {
    let pending = initializedDatabases.get(db as object);
    if (!pending) {
      pending = db
        .batch([
          db.prepare(CREATE_TRIPS_SQL),
          ...CREATE_INDEX_STATEMENTS.map((statement) => db.prepare(statement)),
        ])
        .then(() => undefined)
        .catch((error) => {
          initializedDatabases.delete(db as object);
          throw error;
        });
      initializedDatabases.set(db as object, pending);
    }
    await pending;
  };

  const getTrip = async (id: string) =>
    db.prepare("SELECT * FROM trips WHERE id = ? LIMIT 1").bind(id).first<TripRow>();

  return {
    initialize,

    async assertSubmissionAllowed(reporterKeyHash, now) {
      const hourCutoff = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
      const dayCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
      const activeCutoff = new Date(now.getTime() - 36 * 60 * 60 * 1000).toISOString();
      const [hour, day, active] = await Promise.all([
        db
          .prepare("SELECT COUNT(*) AS count FROM trips WHERE reporter_key_hash = ? AND created_at >= ?")
          .bind(reporterKeyHash, hourCutoff)
          .first<{ count: number }>(),
        db
          .prepare("SELECT COUNT(*) AS count FROM trips WHERE reporter_key_hash = ? AND created_at >= ?")
          .bind(reporterKeyHash, dayCutoff)
          .first<{ count: number }>(),
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM trips WHERE reporter_key_hash = ? AND status = 'active' AND created_at >= ?",
          )
          .bind(reporterKeyHash, activeCutoff)
          .first<{ count: number }>(),
      ]);

      if (Number(hour?.count ?? 0) >= 8 || Number(day?.count ?? 0) >= 30 || Number(active?.count ?? 0) >= 3) {
        throw new RateLimitError();
      }
    },

    async insertTrip(record) {
      await db
        .prepare(INSERT_TRIP_SQL)
        .bind(
          record.id,
          record.userId,
          record.status,
          record.source,
          record.siteId,
          record.startedAt,
          record.endedAt,
          record.mode,
          record.fishingMethod,
          record.gear,
          record.anglerCount,
          record.anglerHours,
          record.keeperCount,
          record.shortReleasedCount,
          record.halibutEncounters,
          record.noCatch === null ? null : Number(record.noCatch),
          record.notes,
          Number(record.consent),
          record.consentAt,
          record.moderationStatus,
          record.reporterKeyHash,
          record.referralCode,
          record.tokenHash,
          record.opportunityWindowId,
          record.opportunityScore,
          record.habitatScore,
          record.seasonalityScore,
          record.conditionsScore,
          record.modelVersion,
          record.scoreInfluencedChoice === null ? null : Number(record.scoreInfluencedChoice),
          record.predictionMetadataJson,
          record.photoKey,
          record.photoContentType,
          record.photoSizeBytes,
          record.createdAt,
          record.updatedAt,
          record.completedAt,
        )
        .run();

      const inserted = await getTrip(record.id);
      if (!inserted) throw new Error("Trip insert did not return a record");
      return inserted;
    },

    getTrip,

    async completeTrip(id, tokenHash, completion) {
      const result = await db
        .prepare(`UPDATE trips SET
          status = 'completed', ended_at = ?, mode = ?, fishing_method = ?, gear = ?,
          angler_count = ?, angler_hours = ?, keeper_count = ?, short_released_count = ?,
          halibut_encounters = ?, no_catch = ?, notes = ?, consent = 1, consent_at = ?,
          moderation_status = 'pending', score_influenced_choice = ?, photo_key = ?,
          photo_content_type = ?, photo_size_bytes = ?, updated_at = ?, completed_at = ?, token_hash = NULL
        WHERE id = ? AND status = 'active' AND token_hash = ?`)
        .bind(
          completion.endedAt,
          completion.mode,
          completion.fishingMethod,
          completion.gear,
          completion.anglerCount,
          completion.anglerHours,
          completion.keeperCount,
          completion.shortReleasedCount,
          completion.halibutEncounters,
          Number(completion.noCatch),
          completion.notes,
          completion.consentAt,
          completion.scoreInfluencedChoice === null ? null : Number(completion.scoreInfluencedChoice),
          completion.photoKey,
          completion.photoContentType,
          completion.photoSizeBytes,
          completion.updatedAt,
          completion.updatedAt,
          id,
          tokenHash,
        )
        .run();

      if (Number(result.meta?.changes ?? 0) !== 1) return null;
      return getTrip(id);
    },

    async getSummary(now) {
      const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
      const row = await db
        .prepare(`SELECT
          COUNT(*) AS completed_trips,
          COALESCE(SUM(CASE WHEN no_catch = 1 THEN 1 ELSE 0 END), 0) AS no_catch_trips,
          COALESCE(SUM(CASE WHEN halibut_encounters > 0 THEN 1 ELSE 0 END), 0) AS halibut_trips,
          COALESCE(SUM(angler_hours), 0) AS angler_hours,
          COALESCE(SUM(halibut_encounters), 0) AS halibut_encounters,
          COUNT(DISTINCT site_id) AS sites_covered,
          MAX(updated_at) AS last_updated,
          COALESCE(SUM(CASE WHEN completed_at >= ? THEN 1 ELSE 0 END), 0) AS recent_completed_trips,
          COALESCE(SUM(CASE WHEN completed_at >= ? THEN angler_hours ELSE 0 END), 0) AS recent_angler_hours,
          COALESCE(SUM(CASE WHEN completed_at >= ? THEN halibut_encounters ELSE 0 END), 0) AS recent_halibut_encounters,
          COUNT(DISTINCT CASE WHEN completed_at >= ? THEN site_id END) AS recent_sites_covered
        FROM trips
        WHERE status = 'completed' AND consent = 1 AND moderation_status != 'rejected'`)
        .bind(cutoff, cutoff, cutoff, cutoff)
        .first<{
          completed_trips: number;
          no_catch_trips: number;
          halibut_trips: number;
          angler_hours: number;
          halibut_encounters: number;
          sites_covered: number;
          last_updated: string | null;
          recent_completed_trips: number;
          recent_angler_hours: number;
          recent_halibut_encounters: number;
          recent_sites_covered: number;
        }>();

      return {
        completedTrips: Number(row?.completed_trips ?? 0),
        noCatchTrips: Number(row?.no_catch_trips ?? 0),
        halibutTrips: Number(row?.halibut_trips ?? 0),
        totalHalibut: Number(row?.halibut_encounters ?? 0),
        anglerHours: round(Number(row?.angler_hours ?? 0), 2),
        halibutEncounters: Number(row?.halibut_encounters ?? 0),
        sitesCovered: Number(row?.sites_covered ?? 0),
        lastUpdated: row?.last_updated ?? null,
        past24Hours: {
          completedTrips: Number(row?.recent_completed_trips ?? 0),
          anglerHours: round(Number(row?.recent_angler_hours ?? 0), 2),
          halibutEncounters: Number(row?.recent_halibut_encounters ?? 0),
          sitesCovered: Number(row?.recent_sites_covered ?? 0),
        },
      };
    },
  };
}

export async function handleTripRequest(
  request: Request,
  env: TripApiEnv,
  curatedSites: readonly CuratedSite[],
  options: TripHandlerOptions = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/trips")) return null;

  const now = options.now?.() ?? new Date();
  const siteMap = new Map(curatedSites.map((site) => [site.id, site]));

  try {
    const store = options.store ?? (env.DB ? createTripStore(env.DB) : null);
    if (!store) throw new ApiError(503, "storage_unavailable", "Trip storage is temporarily unavailable.");
    await store.initialize();

    if (url.pathname === "/api/trips/summary") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return jsonResponse(await store.getSummary(now));
    }

    if (request.method !== "POST") return methodNotAllowed("POST");
    assertSameOrigin(request);

    if (url.pathname === "/api/trips/start") {
      assertContentType(request, "application/json");
      assertBodySize(request, 64 * 1024);
      const body = await readJsonObject(request);
      assertHoneypot(body.website);
      assertConsent(body.consent);

      const reporter = await getOrCreateReporter(request, body.reporterKey);
      await store.assertSubmissionAllowed(reporter.hash, now);
      const site = getSite(siteMap, body.siteId);
      const startedAt = parseStartDate(body.startedAt, now, 48);
      const token = randomSecret();
      const timestamp = now.toISOString();
      const prediction = parsePrediction(body);

      const trip = await store.insertTrip({
        id: `trip_${crypto.randomUUID()}`,
        userId: options.accountId ?? null,
        status: "active",
        source: "live",
        siteId: site.id,
        startedAt,
        endedAt: null,
        mode: parseMode(body.mode, defaultMode(site)),
        fishingMethod: optionalText(body.method ?? body.fishingMethod, "method", 80),
        gear: optionalText(body.gear, "gear", 300),
        anglerCount: parseInteger(body.anglerCount, "anglerCount", 1, 12, 1),
        anglerHours: null,
        keeperCount: null,
        shortReleasedCount: null,
        halibutEncounters: null,
        noCatch: null,
        notes: null,
        consent: true,
        consentAt: timestamp,
        moderationStatus: "pending",
        reporterKeyHash: reporter.hash,
        referralCode: parseReferralCode(body.referralCode),
        tokenHash: await sha256(token),
        ...prediction,
        photoKey: null,
        photoContentType: null,
        photoSizeBytes: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: null,
      });

      return jsonResponse({ trip: publicTrip(trip), token }, 201, reporter.setCookie);
    }

    const completionMatch = url.pathname.match(/^\/api\/trips\/([^/]+)\/complete$/);
    if (completionMatch) {
      assertContentType(request, "multipart/form-data");
      assertBodySize(request, MAX_MULTIPART_BYTES);
      const form = await request.formData();
      assertHoneypot(form.get("website"));
      const id = completionMatch[1];
      if (!/^trip_[a-f0-9-]{36}$/.test(id)) {
        throw new ApiError(404, "trip_not_found", "The active trip could not be found.");
      }
      const token = requiredText(form.get("token"), "token", 160);
      if (!/^[A-Za-z0-9_-]{40,160}$/.test(token)) {
        throw new ApiError(404, "trip_not_found", "The active trip could not be found.");
      }

      const existing = await store.getTrip(id);
      if (!existing || existing.status !== "active") {
        throw new ApiError(404, "trip_not_found", "The active trip could not be found.");
      }

      const endedAt = parseEndDate(form.get("endedAt"), now);
      const durationHours = validateDuration(existing.started_at, endedAt, 36);
      const anglerCount = parseInteger(form.get("anglerCount"), "anglerCount", 1, 12, existing.angler_count);
      const keeperCount = parseInteger(form.get("keeperCount"), "keeperCount", 0, 25, 0);
      const shortReleasedCount = parseInteger(
        form.get("shortReleasedCount"),
        "shortReleasedCount",
        0,
        25,
        0,
      );
      if (keeperCount + shortReleasedCount > 40) {
        throw new ApiError(422, "invalid_counts", "Combined halibut encounters cannot exceed 40.");
      }
      if (form.has("consent")) assertConsent(form.get("consent"));
      const uploaded = await processPhoto(form.get("photo"), id, env);

      try {
        const completed = await store.completeTrip(id, await sha256(token), {
          endedAt,
          mode: parseMode(form.get("mode"), existing.mode),
          fishingMethod:
            optionalText(form.get("method") ?? form.get("fishingMethod"), "method", 80) ??
            existing.fishing_method,
          gear: optionalText(form.get("gear"), "gear", 300) ?? existing.gear,
          anglerCount,
          anglerHours: round(durationHours * anglerCount, 2),
          keeperCount,
          shortReleasedCount,
          halibutEncounters: keeperCount + shortReleasedCount,
          noCatch: keeperCount + shortReleasedCount === 0,
          notes: optionalText(form.get("notes"), "notes", 1000),
          consentAt: now.toISOString(),
          scoreInfluencedChoice:
            optionalBoolean(
              form.get("scoreInfluencedChoice") ?? form.get("contourCastInfluenced"),
              "scoreInfluencedChoice",
            ) ??
            (existing.score_influenced_choice === null
              ? null
              : Boolean(existing.score_influenced_choice)),
          photoKey: uploaded?.key ?? null,
          photoContentType: uploaded?.contentType ?? null,
          photoSizeBytes: uploaded?.size ?? null,
          updatedAt: now.toISOString(),
        });

        if (!completed) {
          throw new ApiError(404, "trip_not_found", "The active trip could not be found.");
        }
        options.onTripCompleted?.(completed);
        return jsonResponse({ trip: publicTrip(completed) });
      } catch (error) {
        if (uploaded) await env.TRIP_PHOTOS?.delete(uploaded.key).catch(() => undefined);
        throw error;
      }
    }

    if (url.pathname === "/api/trips/report") {
      assertContentType(request, "multipart/form-data");
      assertBodySize(request, MAX_MULTIPART_BYTES);
      const form = await request.formData();
      assertHoneypot(form.get("website"));
      assertConsent(form.get("consent"));

      const reporter = await getOrCreateReporter(request, form.get("reporterKey"));
      await store.assertSubmissionAllowed(reporter.hash, now);
      const site = getSite(siteMap, form.get("siteId"));
      const startedAt = parseHistoricalStartDate(form.get("startedAt"), now);
      const endedAt = parseEndDate(form.get("endedAt"), now);
      const durationHours = validateDuration(startedAt, endedAt, 36);
      const anglerCount = parseInteger(form.get("anglerCount"), "anglerCount", 1, 12, 1);
      const keeperCount = parseInteger(form.get("keeperCount"), "keeperCount", 0, 25, 0);
      const shortReleasedCount = parseInteger(
        form.get("shortReleasedCount"),
        "shortReleasedCount",
        0,
        25,
        0,
      );
      if (keeperCount + shortReleasedCount > 40) {
        throw new ApiError(422, "invalid_counts", "Combined halibut encounters cannot exceed 40.");
      }

      const id = `trip_${crypto.randomUUID()}`;
      const timestamp = now.toISOString();
      const uploaded = await processPhoto(form.get("photo"), id, env);

      try {
        const trip = await store.insertTrip({
          id,
          userId: options.accountId ?? null,
          status: "completed",
          source: "past_report",
          siteId: site.id,
          startedAt,
          endedAt,
          mode: parseMode(form.get("mode"), defaultMode(site)),
          fishingMethod: optionalText(form.get("method") ?? form.get("fishingMethod"), "method", 80),
          gear: optionalText(form.get("gear"), "gear", 300),
          anglerCount,
          anglerHours: round(durationHours * anglerCount, 2),
          keeperCount,
          shortReleasedCount,
          halibutEncounters: keeperCount + shortReleasedCount,
          noCatch: keeperCount + shortReleasedCount === 0,
          notes: optionalText(form.get("notes"), "notes", 1000),
          consent: true,
          consentAt: timestamp,
          moderationStatus: "pending",
          reporterKeyHash: reporter.hash,
          referralCode: parseReferralCode(form.get("referralCode")),
          tokenHash: null,
          ...parsePrediction(form),
          photoKey: uploaded?.key ?? null,
          photoContentType: uploaded?.contentType ?? null,
          photoSizeBytes: uploaded?.size ?? null,
          createdAt: timestamp,
          updatedAt: timestamp,
          completedAt: timestamp,
        });
        options.onTripCompleted?.(trip);
        return jsonResponse({ trip: publicTrip(trip) }, 201, reporter.setCookie);
      } catch (error) {
        if (uploaded) await env.TRIP_PHOTOS?.delete(uploaded.key).catch(() => undefined);
        throw error;
      }
    }

    return jsonResponse({ error: { code: "not_found", message: "API route not found." } }, 404);
  } catch (error) {
    if (error instanceof RateLimitError) {
      return jsonResponse(
        { error: { code: "rate_limited", message: error.message } },
        429,
        undefined,
        { "Retry-After": "3600" },
      );
    }
    if (error instanceof ApiError) {
      return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
    }
    console.error("Trip API request failed", error);
    return jsonResponse(
      { error: { code: "internal_error", message: "The trip could not be saved right now." } },
      500,
    );
  }
}

function publicTrip(row: TripRow) {
  return {
    id: row.id,
    status: row.status,
    source: row.source,
    siteId: row.site_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    mode: row.mode,
    fishingMethod: row.fishing_method,
    gear: row.gear,
    anglerCount: row.angler_count,
    anglerHours: row.angler_hours,
    keeperCount: row.keeper_count,
    shortReleasedCount: row.short_released_count,
    halibutEncounters: row.halibut_encounters,
    noCatch: row.no_catch === null ? null : Boolean(row.no_catch),
    notes: row.notes,
    consent: Boolean(row.consent),
    moderationStatus: row.moderation_status,
    referralCode: row.referral_code,
    opportunityWindowId: row.opportunity_window_id,
    opportunityScore: row.opportunity_score,
    habitatScore: row.habitat_score,
    seasonalityScore: row.seasonality_score,
    conditionsScore: row.conditions_score,
    modelVersion: row.model_version,
    scoreInfluencedChoice:
      row.score_influenced_choice === null ? null : Boolean(row.score_influenced_choice),
    hasPhoto: Boolean(row.photo_key),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parsePrediction(source: Record<string, unknown> | FormData) {
  const value = (key: string) => (source instanceof FormData ? source.get(key) : source[key]);
  const metadata = value("predictionMetadata");
  let predictionMetadataJson: string | null = null;
  if (metadata !== null && metadata !== undefined && metadata !== "") {
    try {
      const parsed = typeof metadata === "string" ? JSON.parse(metadata) : metadata;
      predictionMetadataJson = JSON.stringify(parsed);
      if (predictionMetadataJson.length > 4096) throw new Error("too long");
    } catch {
      throw new ApiError(422, "invalid_prediction_metadata", "predictionMetadata must be valid JSON under 4 KB.");
    }
  }

  return {
    opportunityWindowId: optionalText(value("opportunityWindowId"), "opportunityWindowId", 120),
    opportunityScore: optionalNumber(value("opportunityScore"), "opportunityScore", 0, 100),
    habitatScore: optionalNumber(value("habitatScore"), "habitatScore", 0, 100),
    seasonalityScore: optionalNumber(value("seasonalityScore"), "seasonalityScore", 0, 100),
    conditionsScore: optionalNumber(value("conditionsScore"), "conditionsScore", 0, 100),
    modelVersion: optionalText(value("modelVersion"), "modelVersion", 120),
    scoreInfluencedChoice: optionalBoolean(
      value("scoreInfluencedChoice") ?? value("contourCastInfluenced"),
      "scoreInfluencedChoice",
    ),
    predictionMetadataJson,
  };
}

async function processPhoto(entry: FormDataEntryValue | null, tripId: string, env: TripApiEnv) {
  if (entry === null || entry === "") return null;
  if (typeof entry === "string") {
    throw new ApiError(422, "invalid_photo", "photo must be an uploaded image.");
  }
  if (entry.size === 0) return null;
  if (entry.size > MAX_PHOTO_BYTES) {
    throw new ApiError(413, "photo_too_large", "Photos must be 5 MB or smaller.");
  }
  if (!ALLOWED_IMAGE_TYPES.has(entry.type)) {
    throw new ApiError(415, "invalid_photo_type", "Photos must be JPEG, PNG, or WebP.");
  }

  const signature = new Uint8Array(await entry.slice(0, 16).arrayBuffer());
  if (!matchesImageSignature(signature, entry.type)) {
    throw new ApiError(415, "invalid_photo_type", "The uploaded file does not match its image type.");
  }
  if (!env.IMAGES || !env.TRIP_PHOTOS) {
    throw new ApiError(503, "photo_storage_unavailable", "Photo uploads are temporarily unavailable.");
  }

  let transformed: Response;
  try {
    const output = await env.IMAGES.input(entry.stream()).transform({
      width: 2048,
      height: 2048,
      fit: "scale-down",
    }).output({ format: "image/webp", quality: 82 });
    transformed = output.response();
  } catch {
    throw new ApiError(422, "photo_processing_failed", "The photo could not be processed.");
  }

  if (!transformed.ok) {
    throw new ApiError(422, "photo_processing_failed", "The photo could not be processed.");
  }
  const bytes = await transformed.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PHOTO_BYTES) {
    throw new ApiError(422, "photo_processing_failed", "The processed photo is invalid or too large.");
  }

  const date = new Date();
  const key = `trip-photos/${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/${tripId}/${crypto.randomUUID()}.webp`;
  await env.TRIP_PHOTOS.put(key, bytes, {
    httpMetadata: { contentType: "image/webp" },
    customMetadata: { tripId, privacy: "exif-stripped" },
  });
  return { key, contentType: "image/webp", size: bytes.byteLength };
}

function matchesImageSignature(bytes: Uint8Array, type: string) {
  if (type === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === "image/png") {
    return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  }
  return (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

function assertSameOrigin(request: Request) {
  const origin = request.headers.get("Origin");
  let normalizedOrigin: string;
  try {
    normalizedOrigin = origin ? new URL(origin).origin : "";
  } catch {
    normalizedOrigin = "";
  }
  if (!normalizedOrigin || normalizedOrigin !== new URL(request.url).origin) {
    throw new ApiError(403, "invalid_origin", "Trip submissions must come from CastCompass.");
  }
}

function assertContentType(request: Request, expected: string) {
  const contentType = request.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.startsWith(expected)) {
    throw new ApiError(415, "unsupported_media_type", `Expected ${expected}.`);
  }
}

function assertBodySize(request: Request, maximum: number) {
  const contentLength = Number(request.headers.get("Content-Length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maximum) {
    throw new ApiError(413, "payload_too_large", "The trip submission is too large.");
  }
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "invalid_json", "Request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

function assertHoneypot(value: unknown) {
  if (value !== null && value !== undefined && String(value).trim() !== "") {
    throw new ApiError(422, "invalid_submission", "The trip submission could not be accepted.");
  }
}

function getSite(siteMap: Map<string, CuratedSite>, value: unknown) {
  const id = requiredText(value, "siteId", 120);
  const site = siteMap.get(id);
  if (!site) throw new ApiError(422, "invalid_site", "Choose a current CastCompass location.");
  return site;
}

function defaultMode(site: CuratedSite) {
  const type = site.type?.toLowerCase() ?? "shore";
  if (type.includes("pier")) return "pier";
  if (type.includes("beach")) return "beach";
  if (type.includes("jetty")) return "jetty";
  return "shore";
}

function parseMode(value: unknown, fallback: string) {
  if (value === null || value === undefined || value === "") return fallback;
  const mode = String(value).trim().toLowerCase();
  if (!ALLOWED_MODES.has(mode)) {
    throw new ApiError(422, "invalid_mode", "Choose a supported fishing mode.");
  }
  return mode;
}

function parseStartDate(value: unknown, now: Date, maximumPastHours: number) {
  const date = value === null || value === undefined || value === "" ? now : parseDate(value, "startedAt");
  if (date.getTime() > now.getTime() + 15 * 60 * 1000) {
    throw new ApiError(422, "invalid_started_at", "startedAt cannot be in the future.");
  }
  if (date.getTime() < now.getTime() - maximumPastHours * 60 * 60 * 1000) {
    throw new ApiError(422, "invalid_started_at", "Use Log a past trip for an older trip.");
  }
  return date.toISOString();
}

function parseHistoricalStartDate(value: unknown, now: Date) {
  const date = parseDate(value, "startedAt");
  if (date.getTime() > now.getTime() + 15 * 60 * 1000) {
    throw new ApiError(422, "invalid_started_at", "startedAt cannot be in the future.");
  }
  if (date.getTime() < now.getTime() - 5 * 365.25 * 24 * 60 * 60 * 1000) {
    throw new ApiError(422, "invalid_started_at", "Past reports are limited to the last five years.");
  }
  return date.toISOString();
}

function parseEndDate(value: unknown, now: Date) {
  const date = value === null || value === undefined || value === "" ? now : parseDate(value, "endedAt");
  if (date.getTime() > now.getTime() + 15 * 60 * 1000) {
    throw new ApiError(422, "invalid_ended_at", "endedAt cannot be in the future.");
  }
  return date.toISOString();
}

function parseDate(value: unknown, field: string) {
  if (typeof value !== "string" || value.length > 80) {
    throw new ApiError(422, `invalid_${field}`, `${field} must be an ISO date and time.`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new ApiError(422, `invalid_${field}`, `${field} must be an ISO date and time.`);
  }
  return date;
}

function validateDuration(startedAt: string, endedAt: string, maximumHours: number) {
  const durationHours = (new Date(endedAt).getTime() - new Date(startedAt).getTime()) / (60 * 60 * 1000);
  if (!Number.isFinite(durationHours) || durationHours < 1 / 60 || durationHours > maximumHours) {
    throw new ApiError(422, "invalid_duration", `Trip duration must be between 1 minute and ${maximumHours} hours.`);
  }
  return durationHours;
}

function requiredText(value: unknown, field: string, maximum: number) {
  if (typeof value !== "string" || value.trim() === "" || value.trim().length > maximum) {
    throw new ApiError(422, `invalid_${field}`, `${field} is required and must be under ${maximum} characters.`);
  }
  return value.trim();
}

function optionalText(value: unknown, field: string, maximum: number) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.trim().length > maximum) {
    throw new ApiError(422, `invalid_${field}`, `${field} must be under ${maximum} characters.`);
  }
  return value.trim() || null;
}

function parseInteger(value: unknown, field: string, minimum: number, maximum: number, fallback: number) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new ApiError(422, `invalid_${field}`, `${field} must be a whole number from ${minimum} to ${maximum}.`);
  }
  return number;
}

function optionalNumber(value: unknown, field: string, minimum: number, maximum: number) {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new ApiError(422, `invalid_${field}`, `${field} must be from ${minimum} to ${maximum}.`);
  }
  return number;
}

function optionalBoolean(value: unknown, field: string): boolean | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1" || value === "on") return true;
  if (value === "false" || value === "0" || value === "off") return false;
  throw new ApiError(422, `invalid_${field}`, `${field} must be true or false.`);
}

function assertConsent(value: unknown) {
  if (optionalBoolean(value, "consent") !== true) {
    throw new ApiError(422, "consent_required", "Consent is required to contribute a trip report.");
  }
}

function parseReferralCode(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value.trim())) {
    throw new ApiError(
      422,
      "invalid_referral_code",
      "referralCode must be a short link code using letters, numbers, hyphens, or underscores.",
    );
  }
  return value.trim().toLowerCase();
}

async function getOrCreateReporter(request: Request, suppliedKey?: unknown) {
  const cookies = parseCookies(request.headers.get("Cookie") ?? "");
  let raw: string | undefined;
  let setCookie: string | undefined;
  let supplied = false;
  if (suppliedKey !== null && suppliedKey !== undefined && suppliedKey !== "") {
    if (typeof suppliedKey !== "string" || !/^[A-Za-z0-9_-]{20,200}$/.test(suppliedKey)) {
      throw new ApiError(422, "invalid_reporter_key", "reporterKey is not a valid anonymous device key.");
    }
    raw = suppliedKey;
    supplied = true;
  } else {
    raw = cookies.get(REPORTER_COOKIE);
  }
  if (!supplied && (!raw || !/^[A-Za-z0-9_-]{40,160}$/.test(raw))) {
    raw = randomSecret();
    const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
    setCookie = `${REPORTER_COOKIE}=${raw}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict${secure}`;
  }
  if (!raw) throw new Error("Anonymous reporter key generation failed");
  return { hash: await sha256(raw), setCookie };
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

function randomSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function round(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function methodNotAllowed(allow: string) {
  return jsonResponse(
    { error: { code: "method_not_allowed", message: `Use ${allow} for this endpoint.` } },
    405,
    undefined,
    { Allow: allow },
  );
}

function jsonResponse(
  body: unknown,
  status = 200,
  setCookie?: string,
  extraHeaders: Record<string, string> = {},
) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  if (setCookie) headers.set("Set-Cookie", setCookie);
  return new Response(JSON.stringify(body), { status, headers });
}
