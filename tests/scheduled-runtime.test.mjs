import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  runScheduledLane,
  scheduledLaneFor,
  SCHEDULED_D1_QUERY_CEILING,
  SCHEDULED_INTERVAL_MILLISECONDS,
  SCHEDULED_LANES,
  SCHEDULED_LANE_D1_QUERY_BUDGET,
} from "../worker/scheduled.ts";

class CountingStatement {
  constructor(owner, query, statement) {
    this.owner = owner;
    this.query = query;
    this.statement = statement;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    this.owner.queryExecutions += 1;
    return this.statement.get(...this.values) ?? null;
  }

  async all() {
    this.owner.queryExecutions += 1;
    return { results: this.statement.all(...this.values) };
  }

  async run() {
    this.owner.queryExecutions += 1;
    const result = this.statement.run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class CountingD1 {
  constructor(sqlite) {
    this.sqlite = sqlite;
    this.queryExecutions = 0;
  }

  prepare(query) {
    return new CountingStatement(this, query, this.sqlite.prepare(query));
  }

  async batch(statements) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

class MemoryBucket {
  constructor() {
    this.deleted = [];
  }

  async delete(key) {
    this.deleted.push(key);
  }
}

function queueBinding() {
  return {
    sent: [],
    async send(body) {
      this.sent.push(structuredClone(body));
    },
  };
}

async function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const directory = new URL("../drizzle/", import.meta.url);
  const migrations = (await readdir(directory)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  for (const migration of migrations) {
    const sql = (await readFile(new URL(migration, directory), "utf8"))
      .replaceAll("--> statement-breakpoint", "");
    sqlite.exec(sql);
  }
  return { sqlite, d1: new CountingD1(sqlite) };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function addUser(sqlite, suffix) {
  const timestamp = "2026-07-20T12:00:00.000Z";
  const id = `user_schedule_${suffix}`;
  sqlite.prepare(`INSERT INTO users (
      id, email, password_salt, password_hash, age_eligibility_confirmed_at,
      terms_accepted_at, terms_version, privacy_accepted_at, privacy_version,
      created_at, updated_at)
    VALUES (?, ?, 'salt', 'hash', ?, ?, '2026-07-17.1', ?, '2026-07-17.1', ?, ?)`)
    .run(id, `${suffix}@example.test`, timestamp, timestamp, timestamp, timestamp, timestamp);
  return id;
}

function addCompletedTrip(sqlite, id) {
  const timestamp = "2026-07-20T12:00:00.000Z";
  sqlite.prepare(`INSERT INTO trips (
      id, status, source, site_id, started_at, ended_at, completed_at, mode,
      angler_count, consent, moderation_status, reporter_key_hash, target_taxon_id,
      contract_status, created_at, updated_at)
    VALUES (?, 'completed', 'past_report', 'ocean-beach', ?, ?, ?, 'shore',
      1, 1, 'pending', ?, 'california-halibut', 'legacy_unverified', ?, ?)`)
    .run(id, timestamp, timestamp, timestamp, `reporter-${id}`, timestamp, timestamp);
}

test("the five-minute cron rotates exactly one starvation-safe lane", () => {
  assert.equal(new Set(SCHEDULED_LANES).size, SCHEDULED_LANES.length);
  for (let index = 0; index < SCHEDULED_LANES.length * 2; index += 1) {
    assert.equal(
      scheduledLaneFor({ scheduledTime: index * SCHEDULED_INTERVAL_MILLISECONDS }),
      SCHEDULED_LANES[index % SCHEDULED_LANES.length],
    );
  }
  for (const lane of SCHEDULED_LANES) {
    assert.ok(SCHEDULED_LANE_D1_QUERY_BUDGET[lane] <= SCHEDULED_D1_QUERY_CEILING);
  }
});

test("queue dispatch saturation stays under its declared D1 invocation budget", async () => {
  const { sqlite, d1 } = await database();
  addCompletedTrip(sqlite, "trip_schedule_review");
  const exportQueue = queueBinding();
  const aiQueue = queueBinding();
  const timestamp = "2026-07-20T12:00:00.000Z";
  for (let index = 0; index < 6; index += 1) {
    const userId = addUser(sqlite, `export-${index}`);
    sqlite.prepare(`INSERT INTO privacy_export_jobs (
        id, user_id, owner_subject_hash, state, attempts, available_at,
        requested_at, updated_at)
      VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`)
      .run(`pexj_${String(index).padStart(32, "0")}`, userId, "a".repeat(64), timestamp, timestamp, timestamp);
  }

  await runScheduledLane("queue_dispatch", {
    DB: d1,
    AI_REVIEW_QUEUE_ENABLED: "true",
    AI_REVIEW_QUEUE: aiQueue,
    PRIVACY_EXPORT_QUEUE_ENABLED: "true",
    PRIVACY_EXPORT_QUEUE: exportQueue,
    PRIVACY_EXPORTS: new MemoryBucket(),
  }, [{ id: "ocean-beach", type: "Beach" }], new Date("2026-07-21T12:00:00.000Z"));

  assert.equal(aiQueue.sent.length, 1);
  assert.equal(exportQueue.sent.length, 5);
  assert.ok(d1.queryExecutions <= SCHEDULED_LANE_D1_QUERY_BUDGET.queue_dispatch,
    `queue lane used ${d1.queryExecutions} D1 queries`);
});

test("photo reservation saturation processes seven and stays below 50 D1 queries", async () => {
  const { sqlite, d1 } = await database();
  const bucket = new MemoryBucket();
  const timestamp = "2026-07-20T12:00:00.000Z";
  for (let index = 0; index < 8; index += 1) {
    const key = `trip-photos/scheduled-${index}.webp`;
    sqlite.prepare(`INSERT INTO trip_photo_upload_reservations (
        id, trip_id, owner_subject_hash, object_key, object_key_hash, state,
        attempts, available_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`)
      .run(
        `photo_reservation_${String(index).padStart(32, "0")}`,
        `trip_schedule_photo_${index}`,
        "b".repeat(64),
        key,
        sha256(`trip_photos\0${key}`),
        timestamp,
        timestamp,
        timestamp,
      );
  }

  await runScheduledLane("trip_photo_reservations", { DB: d1, TRIP_PHOTOS: bucket }, [],
    new Date("2026-07-21T12:00:00.000Z"));

  assert.equal(bucket.deleted.length, 7);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM trip_photo_upload_reservations").get().count, 1);
  assert.ok(d1.queryExecutions <= SCHEDULED_LANE_D1_QUERY_BUDGET.trip_photo_reservations,
    `photo lane used ${d1.queryExecutions} D1 queries`);
});

test("expired export saturation processes seven and stays below 50 D1 queries", async () => {
  const { sqlite, d1 } = await database();
  const bucket = new MemoryBucket();
  const completedAt = "2026-07-19T12:00:00.000Z";
  const expiresAt = "2026-07-20T12:00:00.000Z";
  for (let index = 0; index < 8; index += 1) {
    const userId = addUser(sqlite, `expired-${index}`);
    const key = `privacy-exports/scheduled-${index}.json`;
    sqlite.prepare(`INSERT INTO privacy_export_jobs (
        id, user_id, owner_subject_hash, state, attempts, available_at,
        object_key, object_key_hash, content_sha256, size_bytes, record_count,
        requested_at, updated_at, completed_at, expires_at)
      VALUES (?, ?, ?, 'completed', 1, ?, ?, ?, ?, 2, 1, ?, ?, ?, ?)`)
      .run(
        `pexj_${String(100 + index).padStart(32, "0")}`,
        userId,
        "c".repeat(64),
        completedAt,
        key,
        sha256(`privacy_exports\0${key}`),
        "d".repeat(64),
        completedAt,
        completedAt,
        completedAt,
        expiresAt,
      );
  }

  await runScheduledLane("privacy_export_expiry", { DB: d1, PRIVACY_EXPORTS: bucket }, [],
    new Date("2026-07-21T12:00:00.000Z"));

  assert.equal(bucket.deleted.length, 7);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM privacy_export_jobs WHERE object_key IS NOT NULL").get().count, 1);
  assert.ok(d1.queryExecutions <= SCHEDULED_LANE_D1_QUERY_BUDGET.privacy_export_expiry,
    `expiry lane used ${d1.queryExecutions} D1 queries`);
});

test("retention and deletion saturation processes three and stays below 50 D1 queries", async () => {
  const { sqlite, d1 } = await database();
  const bucket = new MemoryBucket();
  const timestamp = "2026-07-20T12:00:00.000Z";
  const expiredTimestamp = "2000-01-01T00:00:00.000Z";
  sqlite.prepare(`INSERT INTO privacy_deletion_jobs (
      id, receipt_hash, scope, subject_hash, owner_subject_hash, state,
      objects_total, objects_deleted, requested_at, active_data_removed_at,
      completed_at, updated_at)
    VALUES ('deletion_job_retention_heavy', 'receipt-retention-heavy', 'account',
      'subject-retention-heavy', 'owner-retention-heavy', 'completed', 101, 101,
      ?, ?, ?, ?)`).run(expiredTimestamp, expiredTimestamp, expiredTimestamp, expiredTimestamp);
  const insertCompletedTask = sqlite.prepare(`INSERT INTO privacy_deletion_tasks (
      id, job_id, object_key, object_key_hash, object_store, state, attempts,
      available_at, created_at, updated_at, completed_at)
    VALUES (?, 'deletion_job_retention_heavy', NULL, ?, 'trip_photos',
      'completed', 1, ?, ?, ?, ?)`);
  for (let index = 0; index < 101; index += 1) {
    const suffix = String(index).padStart(3, "0");
    insertCompletedTask.run(
      `deletion_task_retention_${suffix}`,
      sha256(`retention-task-${suffix}`),
      expiredTimestamp,
      expiredTimestamp,
      expiredTimestamp,
      expiredTimestamp,
    );
  }
  for (let index = 0; index < 4; index += 1) {
    const jobId = `deletion_job_schedule_${index}`;
    const key = `trip-photos/deletion-${index}.webp`;
    sqlite.prepare(`INSERT INTO privacy_deletion_jobs (
        id, receipt_hash, scope, subject_hash, owner_subject_hash, state,
        objects_total, objects_deleted, requested_at, active_data_removed_at, updated_at)
      VALUES (?, ?, 'trip', ?, ?, 'active_data_removed', 1, 0, ?, ?, ?)`)
      .run(jobId, `receipt-${index}`, `subject-${index}`, `owner-${index}`, timestamp, timestamp, timestamp);
    sqlite.prepare(`INSERT INTO privacy_deletion_tasks (
        id, job_id, object_key, object_key_hash, object_store, state, attempts,
        available_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'trip_photos', 'pending', 0, ?, ?, ?)`)
      .run(
        `deletion_task_schedule_${index}`,
        jobId,
        key,
        sha256(`trip_photos\0${key}`),
        timestamp,
        timestamp,
        timestamp,
      );
  }

  await runScheduledLane("auth_retention_and_deletion", { DB: d1, TRIP_PHOTOS: bucket }, [],
    new Date("2026-07-21T12:00:00.000Z"));

  assert.equal(bucket.deleted.length, 3);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM privacy_deletion_tasks WHERE state = 'pending'").get().count, 1);
  assert.deepEqual({ ...sqlite.prepare(`SELECT objects_total, objects_deleted, last_error_code
      FROM privacy_deletion_jobs WHERE id = 'deletion_job_retention_heavy'`).get() }, {
    objects_total: 1,
    objects_deleted: 1,
    last_error_code: null,
  });
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM privacy_deletion_tasks
    WHERE job_id = 'deletion_job_retention_heavy'`).get().count, 1);
  assert.ok(d1.queryExecutions <= SCHEDULED_LANE_D1_QUERY_BUDGET.auth_retention_and_deletion,
    `retention lane used ${d1.queryExecutions} D1 queries`);
});
