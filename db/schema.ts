import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    passwordSalt: text("password_salt").notNull(),
    passwordHash: text("password_hash").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("users_email_unique").on(table.email)],
);

export const authSessions = sqliteTable(
  "auth_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("auth_sessions_user_idx").on(table.userId, table.expiresAt)],
);

export const savedSites = sqliteTable(
  "saved_sites",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    siteId: text("site_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.siteId] })],
);

export const authAttempts = sqliteTable(
  "auth_attempts",
  {
    id: text("id").primaryKey(),
    emailHash: text("email_hash").notNull(),
    attemptedAt: text("attempted_at").notNull(),
    successful: integer("successful", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [index("auth_attempts_email_time_idx").on(table.emailHash, table.attemptedAt)],
);

export const trips = sqliteTable(
  "trips",
  {
    id: text("id").primaryKey(),
    status: text("status").notNull(),
    source: text("source").notNull(),
    siteId: text("site_id").notNull(),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    mode: text("mode").notNull(),
    fishingMethod: text("fishing_method"),
    gear: text("gear"),
    anglerCount: integer("angler_count").notNull(),
    anglerHours: real("angler_hours"),
    keeperCount: integer("keeper_count"),
    shortReleasedCount: integer("short_released_count"),
    halibutEncounters: integer("halibut_encounters"),
    noCatch: integer("no_catch", { mode: "boolean" }),
    notes: text("notes"),
    consent: integer("consent", { mode: "boolean" }).notNull(),
    consentAt: text("consent_at"),
    moderationStatus: text("moderation_status").notNull(),
    reporterKeyHash: text("reporter_key_hash").notNull(),
    referralCode: text("referral_code"),
    tokenHash: text("token_hash"),
    opportunityWindowId: text("opportunity_window_id"),
    opportunityScore: real("opportunity_score"),
    habitatScore: real("habitat_score"),
    seasonalityScore: real("seasonality_score"),
    conditionsScore: real("conditions_score"),
    modelVersion: text("model_version"),
    scoreInfluencedChoice: integer("score_influenced_choice", { mode: "boolean" }),
    predictionMetadataJson: text("prediction_metadata_json"),
    photoKey: text("photo_key"),
    photoContentType: text("photo_content_type"),
    photoSizeBytes: integer("photo_size_bytes"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [
    check("trips_status_check", sql`${table.status} in ('active', 'completed')`),
    check("trips_source_check", sql`${table.source} in ('live', 'past_report')`),
    check(
      "trips_moderation_status_check",
      sql`${table.moderationStatus} in ('pending', 'approved', 'rejected')`,
    ),
    check("trips_angler_count_check", sql`${table.anglerCount} between 1 and 12`),
    index("trips_status_started_idx").on(table.status, table.startedAt),
    index("trips_site_started_idx").on(table.siteId, table.startedAt),
    index("trips_reporter_created_idx").on(table.reporterKeyHash, table.createdAt),
    index("trips_referral_created_idx").on(table.referralCode, table.createdAt),
  ],
);
