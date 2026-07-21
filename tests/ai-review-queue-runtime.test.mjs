import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  AI_REVIEW_QUEUE_MESSAGE_VERSION,
  aiReviewQueueMode,
  consumeAiReviewQueue,
  dispatchAiReviewBacklog,
  scheduleTripReview,
} from "../worker/trip-review-queue.ts";

class D1StatementAdapter {
  constructor(statement) {
    this.statement = statement;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    return this.statement.get(...this.values) ?? null;
  }

  async all() {
    return { results: this.statement.all(...this.values) };
  }

  async run() {
    const result = this.statement.run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class D1Adapter {
  constructor(sqlite) {
    this.sqlite = sqlite;
  }

  prepare(query) {
    return new D1StatementAdapter(this.sqlite.prepare(query));
  }

  async batch(statements) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

async function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE trips (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT,
      status TEXT NOT NULL,
      site_id TEXT,
      started_at TEXT,
      ended_at TEXT,
      completed_at TEXT,
      mode TEXT,
      fishing_method TEXT,
      gear TEXT,
      rod TEXT,
      reel TEXT,
      bait_lure TEXT,
      rig TEXT,
      angler_count INTEGER,
      angler_hours REAL,
      keeper_count INTEGER,
      short_released_count INTEGER,
      halibut_encounters INTEGER,
      no_catch INTEGER,
      other_catch_count INTEGER,
      other_species TEXT,
      observation_contract_version TEXT,
      taxon_catalog_version TEXT,
      target_taxon_id TEXT,
      contract_status TEXT,
      taxon_observations_json TEXT,
      outcome_class TEXT,
      target_encounter_count INTEGER,
      any_fish_encounter_count INTEGER,
      target_identification_confidence TEXT,
      observations_json TEXT,
      fishability_score REAL,
      notes TEXT,
      ai_review_status TEXT,
      ai_review_json TEXT,
      ai_review_model TEXT,
      ai_reviewed_at TEXT
    );
    CREATE TABLE privacy_deletion_jobs (
      id TEXT PRIMARY KEY NOT NULL,
      scope TEXT NOT NULL,
      subject_hash TEXT NOT NULL,
      owner_subject_hash TEXT NOT NULL
    );
  `);
  const migration = (await readFile(new URL("../drizzle/0018_ai_review_queue.sql", import.meta.url), "utf8"))
    .replaceAll("--> statement-breakpoint", "");
  sqlite.exec(migration);
  sqlite.prepare(`INSERT INTO trips (
      id, user_id, status, site_id, started_at, ended_at, completed_at, mode, fishing_method,
      gear, rod, reel, bait_lure, rig, angler_count, angler_hours, keeper_count,
      short_released_count, halibut_encounters, no_catch, other_catch_count, other_species,
      target_taxon_id, contract_status, target_encounter_count, any_fish_encounter_count,
      observations_json, fishability_score, notes, ai_review_status
    ) VALUES (
      'trip_queue', 'private_user', 'completed', 'ocean-beach',
      '2026-07-01T10:00:00.000Z', '2026-07-01T12:00:00.000Z',
      '2026-07-01T12:00:00.000Z', 'shore', 'artificial-lure', 'spinning', 'Rod',
      'Reel', 'Lure', 'Rig', 1, 2, 0, 0, 0, 1, 0, NULL, 'california-halibut',
      'legacy_unverified', NULL, 0, '{}', 60, 'private-note-never-in-queue', NULL
    )`).run();
  return { sqlite, d1: new D1Adapter(sqlite) };
}

function strictProviderResponse() {
  return Response.json({
    choices: [{
      message: {
        content: JSON.stringify({
          quality_score: 90,
          flags: [],
          summary: "Complete report.",
          needs_human_review: false,
          gear_analysis: {
            rod: { brand: null, series: null, model: null, confidence: "low" },
            reel: { brand: null, series: null, model: null, confidence: "low" },
            lure: { brand: null, series: null, model: null, confidence: "low" },
            setup_tags: [],
            compatibility_flags: [],
            technique_match_summary: null,
          },
          discussion: { publish: false, summary: "", gear_summary: null, technique_tags: [] },
        }),
      },
    }],
  });
}

function queueBinding() {
  return {
    sent: [],
    async send(body, options) {
      this.sent.push({ body: structuredClone(body), options });
      return {};
    },
  };
}

function queueMessage(body, attempts = 1) {
  return {
    id: `provider-${crypto.randomUUID()}`,
    body,
    attempts,
    acknowledgements: 0,
    retries: [],
    ack() { this.acknowledgements += 1; },
    retry(options) { this.retries.push(options ?? {}); },
  };
}

async function scheduledJob(sqlite, d1, overrides = {}) {
  const queue = queueBinding();
  const env = {
    DB: d1,
    MIMO_API_KEY: "test-key",
    AI_REVIEW_QUEUE_ENABLED: "true",
    AI_REVIEW_QUEUE: queue,
    ...overrides,
  };
  await scheduleTripReview(env, "trip_queue", [{ id: "ocean-beach", type: "Beach" }]);
  const job = sqlite.prepare("SELECT * FROM ai_review_jobs WHERE trip_id = 'trip_queue'").get();
  return { env, queue, job };
}

test("queue activation is exact, default-off, and an invalid value fails closed", () => {
  assert.equal(aiReviewQueueMode({}), "disabled");
  assert.equal(aiReviewQueueMode({ AI_REVIEW_QUEUE_ENABLED: "false" }), "disabled");
  assert.equal(aiReviewQueueMode({ AI_REVIEW_QUEUE_ENABLED: "true" }), "enabled");
  assert.equal(aiReviewQueueMode({ AI_REVIEW_QUEUE_ENABLED: "TRUE" }), "invalid");
});

test("enabled scheduling persists an outbox row and sends only an opaque contract identity", async () => {
  const { sqlite, d1 } = await database();
  const { queue, job } = await scheduledJob(sqlite, d1);
  assert.match(job.id, /^airj_[a-f0-9]{32}$/);
  assert.equal(job.state, "queued");
  assert.equal(job.attempts, 0);
  assert.equal(queue.sent.length, 1);
  assert.deepEqual(queue.sent[0].body, {
    version: AI_REVIEW_QUEUE_MESSAGE_VERSION,
    jobId: job.id,
  });
  assert.doesNotMatch(JSON.stringify(queue.sent), /trip_queue|private_user|private-note|ocean-beach/);
  assert.equal(sqlite.prepare("SELECT ai_review_status FROM trips WHERE id = 'trip_queue'").get().ai_review_status, null);
});

test("dispatch records queued state before send and preserves a retryable outbox on publish failure", async () => {
  const { sqlite, d1 } = await database();
  let stateDuringSend;
  const successfulQueue = {
    async send() {
      stateDuringSend = sqlite.prepare("SELECT state FROM ai_review_jobs").get().state;
    },
  };
  await scheduleTripReview({
    DB: d1,
    MIMO_API_KEY: "test-key",
    AI_REVIEW_QUEUE_ENABLED: "true",
    AI_REVIEW_QUEUE: successfulQueue,
  }, "trip_queue", []);
  assert.equal(stateDuringSend, "queued");

  sqlite.prepare("DELETE FROM ai_review_jobs").run();
  const originalError = console.error;
  const logs = [];
  console.error = (...values) => logs.push(values);
  try {
    await scheduleTripReview({
      DB: d1,
      MIMO_API_KEY: "test-key",
      AI_REVIEW_QUEUE_ENABLED: "true",
      AI_REVIEW_QUEUE: { async send() { throw new Error("private-publish-failure"); } },
    }, "trip_queue", []);
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(
    { ...sqlite.prepare("SELECT state, attempts, last_error_code FROM ai_review_jobs").get() },
    { state: "pending", attempts: 0, last_error_code: "queue_publish_failed" },
  );
  assert.match(JSON.stringify(logs), /queue_publish_failed/);
  assert.doesNotMatch(JSON.stringify(logs), /private-publish-failure|trip_queue|private_user|private-note/);
});

test("missing producer configuration preserves pending D1 work without provider dispatch", async () => {
  const { sqlite, d1 } = await database();
  const original = console.error;
  const logs = [];
  console.error = (...values) => logs.push(values);
  try {
    await scheduleTripReview(
      { DB: d1, MIMO_API_KEY: "test-key", AI_REVIEW_QUEUE_ENABLED: "true" },
      "trip_queue",
      [{ id: "ocean-beach" }],
    );
  } finally {
    console.error = original;
  }
  assert.equal(sqlite.prepare("SELECT state FROM ai_review_jobs").get().state, "pending");
  assert.match(JSON.stringify(logs), /producer_binding_missing/);
  assert.doesNotMatch(JSON.stringify(logs), /trip_queue|private_user|private-note/);
});

test("consumer claims once, stores a review, and acknowledges duplicate delivery idempotently", async () => {
  const { sqlite, d1 } = await database();
  const { env, queue, job } = await scheduledJob(sqlite, d1);
  let providerCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    providerCalls += 1;
    return strictProviderResponse();
  };
  try {
    const first = queueMessage(queue.sent[0].body);
    await consumeAiReviewQueue({ queue: "ai-review", messages: [first] }, env, [{ id: "ocean-beach" }]);
    assert.equal(first.acknowledgements, 1);
    assert.deepEqual(first.retries, []);
    assert.equal(sqlite.prepare("SELECT state FROM ai_review_jobs WHERE id = ?").get(job.id).state, "completed");
    assert.equal(sqlite.prepare("SELECT attempts FROM ai_review_jobs WHERE id = ?").get(job.id).attempts, 1);
    assert.equal(sqlite.prepare("SELECT ai_review_status FROM trips WHERE id = 'trip_queue'").get().ai_review_status, "reviewed");

    const duplicate = queueMessage(queue.sent[0].body, 2);
    await consumeAiReviewQueue({ queue: "ai-review", messages: [duplicate] }, env, [{ id: "ocean-beach" }]);
    assert.equal(duplicate.acknowledgements, 1);
    assert.deepEqual(duplicate.retries, []);
    assert.equal(providerCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("consumer rejects poison payloads and caps work per invocation", async () => {
  const { sqlite, d1 } = await database();
  const { env, queue } = await scheduledJob(sqlite, d1);
  const poison = queueMessage({ ...queue.sent[0].body, tripId: "trip_queue" });
  const extras = Array.from({ length: 5 }, (_, index) => queueMessage({ version: "wrong", jobId: `airj_${String(index).padStart(32, "0")}` }));
  const overflow = queueMessage(queue.sent[0].body);
  const original = console.warn;
  console.warn = () => undefined;
  try {
    await consumeAiReviewQueue({ queue: "ai-review", messages: [poison, ...extras, overflow] }, env, []);
  } finally {
    console.warn = original;
  }
  assert.equal(poison.acknowledgements, 1);
  assert.equal(extras.slice(0, 4).every((message) => message.acknowledgements === 1), true);
  assert.equal(extras[4].retries[0].delaySeconds, 60);
  assert.equal(overflow.retries[0].delaySeconds, 60);
  assert.equal(sqlite.prepare("SELECT attempts FROM ai_review_jobs").get().attempts, 0);
});

test("provider failures use bounded backoff and settle exhaustion in D1 attention state", async () => {
  const { sqlite, d1 } = await database();
  const { env, queue, job } = await scheduledJob(sqlite, d1);
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  console.error = () => undefined;
  globalThis.fetch = async () => new Response("untrusted-provider-body", { status: 503 });
  try {
    const first = queueMessage(queue.sent[0].body);
    await consumeAiReviewQueue({ queue: "ai-review", messages: [first] }, env, [{ id: "ocean-beach" }]);
    assert.equal(first.acknowledgements, 0);
    assert.equal(first.retries[0].delaySeconds, 60);
    assert.deepEqual(
      { ...sqlite.prepare("SELECT state, attempts, last_error_code FROM ai_review_jobs WHERE id = ?").get(job.id) },
      { state: "retry", attempts: 1, last_error_code: "provider_review_failed" },
    );
    await scheduleTripReview(env, "trip_queue", [], { expediteRetry: true });
    assert.equal(queue.sent.length, 2);
    assert.deepEqual(
      { ...sqlite.prepare("SELECT state, attempts FROM ai_review_jobs WHERE id = ?").get(job.id) },
      { state: "queued", attempts: 1 },
      "owner retry may expedite but must preserve the attempt count",
    );

    sqlite.prepare(`UPDATE ai_review_jobs SET state = 'queued', attempts = 4, available_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), job.id);
    const finalAttempt = queueMessage(queue.sent[0].body, 5);
    await consumeAiReviewQueue({ queue: "ai-review", messages: [finalAttempt] }, env, [{ id: "ocean-beach" }]);
    assert.equal(finalAttempt.acknowledgements, 1);
    assert.deepEqual(finalAttempt.retries, []);
    assert.deepEqual(
      { ...sqlite.prepare("SELECT state, attempts, last_error_code FROM ai_review_jobs WHERE id = ?").get(job.id) },
      { state: "needs_attention", attempts: 5, last_error_code: "provider_review_failed" },
    );
    assert.equal(
      sqlite.prepare("SELECT ai_review_status FROM trips WHERE id = 'trip_queue'").get().ai_review_status,
      "needs_attention",
    );
    await scheduleTripReview(env, "trip_queue", []);
    assert.equal(queue.sent.length, 2, "owner retry must not reset an exhausted job");
    assert.equal(sqlite.prepare("SELECT attempts FROM ai_review_jobs WHERE id = ?").get(job.id).attempts, 5);

    sqlite.prepare("UPDATE trips SET ai_review_status = 'retry' WHERE id = 'trip_queue'").run();
    await scheduleTripReview(env, "trip_queue", [], { resetForNewInput: true });
    assert.equal(queue.sent.length, 3, "genuinely edited input may create a fresh bounded attempt window");
    assert.deepEqual(
      { ...sqlite.prepare("SELECT state, attempts FROM ai_review_jobs WHERE id = ?").get(job.id) },
      { state: "queued", attempts: 0 },
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});

test("maintenance and a deliberate queue disable acknowledge messages without model work", async () => {
  for (const override of [
    { RELEASE_MAINTENANCE_MODE: "true" },
    { AI_REVIEW_QUEUE_ENABLED: "false" },
  ]) {
    const { sqlite, d1 } = await database();
    const { env, queue } = await scheduledJob(sqlite, d1);
    Object.assign(env, override);
    const message = queueMessage(queue.sent[0].body);
    let providerCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { providerCalls += 1; return strictProviderResponse(); };
    try {
      await consumeAiReviewQueue({ queue: "ai-review", messages: [message] }, env, [{ id: "ocean-beach" }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(message.acknowledgements, 1);
    assert.deepEqual(message.retries, []);
    assert.equal(providerCalls, 0);
    assert.equal(sqlite.prepare("SELECT state FROM ai_review_jobs").get().state, "pending");
    assert.equal(sqlite.prepare("SELECT attempts FROM ai_review_jobs").get().attempts, 0);
  }
});

test("trip deletion cascades through the queue ledger and makes stale delivery harmless", async () => {
  const { sqlite, d1 } = await database();
  const { env, queue } = await scheduledJob(sqlite, d1);
  sqlite.prepare("DELETE FROM trips WHERE id = 'trip_queue'").run();
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM ai_review_jobs").get().count, 0);
  const message = queueMessage(queue.sent[0].body);
  await consumeAiReviewQueue({ queue: "ai-review", messages: [message] }, env, []);
  assert.equal(message.acknowledgements, 1);
  assert.deepEqual(message.retries, []);
});

test("scheduled reconciliation recovers an expired application lease before redispatch", async () => {
  const { sqlite, d1 } = await database();
  const { env, queue, job } = await scheduledJob(sqlite, d1);
  sqlite.prepare(`UPDATE ai_review_jobs SET state = 'processing', available_at = ?, lease_expires_at = ?
    WHERE id = ?`).run("2026-01-01T00:00:00.000Z", "2026-01-01T00:01:00.000Z", job.id);
  const expiredTripClaim = JSON.stringify({
    version: "castingcompass.ai-review-claim/1.0.0",
    token: `airc_${"a".repeat(32)}`,
    leaseExpiresAt: "2026-01-01T00:01:00.000Z",
  });
  sqlite.prepare("UPDATE trips SET ai_review_status = 'processing', ai_review_json = ? WHERE id = 'trip_queue'")
    .run(expiredTripClaim);
  const dispatched = await dispatchAiReviewBacklog(env, [{ id: "ocean-beach" }]);
  assert.equal(dispatched, 1);
  assert.equal(queue.sent.length, 2);
  assert.equal(sqlite.prepare("SELECT state FROM ai_review_jobs WHERE id = ?").get(job.id).state, "queued");
  assert.deepEqual(
    { ...sqlite.prepare("SELECT ai_review_status, ai_review_json FROM trips WHERE id = 'trip_queue'").get() },
    { ai_review_status: "processing", ai_review_json: expiredTripClaim },
    "queue redispatch must not clobber the independently leased trip claim",
  );
});
