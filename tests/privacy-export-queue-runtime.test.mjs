import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  PRIVACY_EXPORT_QUEUE_MESSAGE_VERSION,
  buildPrivacyExportPayload,
  consumePrivacyExportQueue,
  downloadPrivacyExport,
  privacyExportJobForOwner,
  privacyExportQueueMode,
  processExpiredPrivacyExports,
  publicPrivacyExportStatus,
  requestPrivacyExport,
} from "../worker/privacy-export.ts";

class D1StatementAdapter {
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

class TransactionalD1Adapter {
  constructor(sqlite) {
    this.sqlite = sqlite;
  }

  prepare(query) {
    return new D1StatementAdapter(this, query, this.sqlite.prepare(query));
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

async function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const directory = new URL("../drizzle/", import.meta.url);
  const migrations = (await readdir(directory)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  for (const migration of migrations) {
    const sql = (await readFile(new URL(migration, directory), "utf8")).replaceAll("--> statement-breakpoint", "");
    sqlite.exec(sql);
  }
  return { sqlite, d1: new TransactionalD1Adapter(sqlite) };
}

function addUser(sqlite, suffix) {
  const id = `user_${suffix}`;
  const timestamp = "2026-07-20T12:00:00.000Z";
  sqlite.prepare(`INSERT INTO users (
      id, email, password_salt, password_hash, age_eligibility_confirmed_at,
      terms_accepted_at, terms_version, privacy_accepted_at, privacy_version,
      created_at, updated_at)
    VALUES (?, ?, 'salt', 'hash', ?, ?, '2026-07-17.1', ?, '2026-07-17.1', ?, ?)`)
    .run(id, `${suffix}@example.test`, timestamp, timestamp, timestamp, timestamp, timestamp);
  return id;
}

function queueBinding() {
  return {
    sent: [],
    async send(body, options) {
      this.sent.push({ body: structuredClone(body), options });
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

function objectBucket({ onPut, deleteFailure } = {}) {
  return {
    objects: new Map(),
    deleted: [],
    async put(key, value, options) {
      this.objects.set(key, { value: value.slice(0), options: structuredClone(options) });
      await onPut?.(key, value, options);
    },
    async get(key) {
      const object = this.objects.get(key);
      if (!object) return null;
      return {
        size: object.value.byteLength,
        httpMetadata: object.options?.httpMetadata,
        customMetadata: object.options?.customMetadata,
        async arrayBuffer() { return object.value.slice(0); },
      };
    },
    async delete(key) {
      this.deleted.push(key);
      if (deleteFailure?.()) throw new Error("injected object delete failure");
      this.objects.delete(key);
    },
  };
}

async function scheduledExport(sqlite, d1, userId, overrides = {}) {
  const queue = queueBinding();
  const bucket = objectBucket();
  const env = {
    DB: d1,
    PRIVACY_EXPORT_QUEUE_ENABLED: "true",
    PRIVACY_EXPORT_QUEUE: queue,
    PRIVACY_EXPORTS: bucket,
    ...overrides,
  };
  const requested = await requestPrivacyExport(env, userId);
  assert.equal(requested.configurationError, null);
  return { env, queue, bucket, job: requested.job };
}

test("privacy export activation is exact, default-off, and configuration fails closed before a job exists", async () => {
  assert.equal(privacyExportQueueMode({}), "disabled");
  assert.equal(privacyExportQueueMode({ PRIVACY_EXPORT_QUEUE_ENABLED: "false" }), "disabled");
  assert.equal(privacyExportQueueMode({ PRIVACY_EXPORT_QUEUE_ENABLED: "true" }), "enabled");
  assert.equal(privacyExportQueueMode({ PRIVACY_EXPORT_QUEUE_ENABLED: "TRUE" }), "invalid");

  const { sqlite, d1 } = await database();
  const userId = addUser(sqlite, "configuration");
  const disabled = await requestPrivacyExport({ DB: d1 }, userId);
  assert.equal(disabled.configurationError, "feature_disabled");
  const missingBucket = await requestPrivacyExport({
    DB: d1,
    PRIVACY_EXPORT_QUEUE_ENABLED: "true",
    PRIVACY_EXPORT_QUEUE: queueBinding(),
  }, userId);
  assert.equal(missingBucket.configurationError, "object_storage_binding_missing");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM privacy_export_jobs").get().count, 0);
});

test("requesting an export writes one durable job and sends only its opaque identity", async () => {
  const { sqlite, d1 } = await database();
  const userId = addUser(sqlite, "opaque");
  const { env, queue, job } = await scheduledExport(sqlite, d1, userId);
  assert.match(job.id, /^pexj_[a-f0-9]{32}$/);
  assert.equal(job.state, "queued");
  assert.deepEqual(queue.sent[0].body, {
    version: PRIVACY_EXPORT_QUEUE_MESSAGE_VERSION,
    jobId: job.id,
  });
  assert.doesNotMatch(JSON.stringify(queue.sent), /user_opaque|opaque@example|password|saved|trip/i);

  const repeated = await requestPrivacyExport(env, userId);
  assert.equal(repeated.job.id, job.id);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM privacy_export_jobs").get().count, 1);
});

test("the consumer packages every legacy row, publishes a private owner-bound download, and handles duplicates", async () => {
  const { sqlite, d1 } = await database();
  const userId = addUser(sqlite, "complete");
  const otherUserId = addUser(sqlite, "other");
  for (let index = 0; index < 137; index += 1) {
    sqlite.prepare("INSERT INTO saved_sites (user_id, site_id, created_at) VALUES (?, ?, ?)")
      .run(userId, `legacy-site-${String(index).padStart(3, "0")}`, `2026-07-20T12:${String(index % 60).padStart(2, "0")}:00.000Z`);
  }
  const { env, queue, bucket, job } = await scheduledExport(sqlite, d1, userId);
  const message = queueMessage(queue.sent[0].body);
  await consumePrivacyExportQueue({ queue: "privacy-export", messages: [message] }, env);
  assert.equal(message.acknowledgements, 1);
  assert.deepEqual(message.retries, []);

  const completed = await privacyExportJobForOwner(d1, userId, job.id);
  assert.equal(completed.state, "completed");
  assert.equal(completed.attempts, 1);
  assert.equal(publicPrivacyExportStatus(completed).status, "ready");
  assert.equal(await privacyExportJobForOwner(d1, otherUserId, job.id), null);
  assert.equal(bucket.objects.size, 1);
  const stored = bucket.objects.get(completed.object_key);
  const payload = JSON.parse(new TextDecoder().decode(stored.value));
  assert.equal(payload.savedSites.length, 137, "rights exports must not inherit current product ceilings");
  assert.equal(payload.account.id, userId);
  assert.doesNotMatch(JSON.stringify(payload), /password_salt|password_hash|object_key|photo_key/);
  assert.equal(completed.record_count, 138);

  const download = await downloadPrivacyExport(env, userId, job.id);
  assert.equal(download.status, 200);
  assert.match(download.headers.get("Content-Disposition"), /attachment; filename="castingcompass-data-/);
  assert.equal(download.headers.get("Cache-Control"), "private, no-store, max-age=0");
  assert.equal(await downloadPrivacyExport(env, otherUserId, job.id), null);

  const duplicate = queueMessage(queue.sent[0].body, 2);
  await consumePrivacyExportQueue({ queue: "privacy-export", messages: [duplicate] }, env);
  assert.equal(duplicate.acknowledgements, 1);
  assert.equal(bucket.objects.size, 1);
  assert.equal(sqlite.prepare("SELECT attempts FROM privacy_export_jobs WHERE id = ?").get(job.id).attempts, 1);
});

test("downloads fail closed when the D1 locator or private-object integrity binding drifts", async () => {
  const { sqlite, d1 } = await database();
  const userId = addUser(sqlite, "integrity");
  const { env, queue, bucket, job } = await scheduledExport(sqlite, d1, userId);
  await consumePrivacyExportQueue(
    { queue: "privacy-export", messages: [queueMessage(queue.sent[0].body)] },
    env,
  );
  const completed = await privacyExportJobForOwner(d1, userId, job.id);
  const stored = bucket.objects.get(completed.object_key);
  const originalValue = stored.value;
  const originalMetadata = structuredClone(stored.options.customMetadata);
  assert.equal((await downloadPrivacyExport(env, userId, job.id)).status, 200);

  const loggedErrors = [];
  const originalError = console.error;
  console.error = (...args) => loggedErrors.push(args);
  try {
    stored.options.customMetadata.contentSha256 = "0".repeat(64);
    const digestMismatch = await downloadPrivacyExport(env, userId, job.id);
    assert.equal(digestMismatch.status, 503);
    assert.equal((await digestMismatch.json()).error.code, "privacy_export_integrity_mismatch");

    stored.options.customMetadata = structuredClone(originalMetadata);
    stored.options.customMetadata.contractVersion = "castingcompass.privacy-export/0.0.0";
    const contractMismatch = await downloadPrivacyExport(env, userId, job.id);
    assert.equal(contractMismatch.status, 503);
    assert.equal((await contractMismatch.json()).error.code, "privacy_export_integrity_mismatch");

    stored.options.customMetadata = structuredClone(originalMetadata);
    stored.value = new Uint8Array([...new Uint8Array(originalValue), 0]).buffer;
    const sizeMismatch = await downloadPrivacyExport(env, userId, job.id);
    assert.equal(sizeMismatch.status, 503);
    assert.equal((await sizeMismatch.json()).error.code, "privacy_export_integrity_mismatch");

    stored.value = originalValue;
    sqlite.prepare("UPDATE privacy_export_jobs SET object_key_hash = ? WHERE id = ?")
      .run("0".repeat(64), job.id);
    const locatorMismatch = await downloadPrivacyExport(env, userId, job.id);
    assert.equal(locatorMismatch.status, 503);
    const errorPayload = await locatorMismatch.json();
    assert.equal(errorPayload.error.code, "privacy_export_integrity_mismatch");
    assert.doesNotMatch(
      JSON.stringify(errorPayload),
      /privacy-exports|pexj_|user_integrity|integrity@example\.test/,
    );
  } finally {
    console.error = originalError;
  }
  assert.equal(loggedErrors.length, 4);
  assert.deepEqual(
    [...new Set(loggedErrors.map(([entry]) => entry.event))],
    ["privacy_export.download.integrity_rejected"],
  );
  assert.doesNotMatch(
    JSON.stringify(loggedErrors),
    /privacy-exports|pexj_|user_integrity|integrity@example\.test/,
  );
});

test("poison queue messages are acknowledged without database or object work", async () => {
  const { sqlite, d1 } = await database();
  const userId = addUser(sqlite, "poison");
  const { env, queue, bucket } = await scheduledExport(sqlite, d1, userId);
  const poison = queueMessage({ ...queue.sent[0].body, userId });
  const wrongVersion = queueMessage({ version: "wrong", jobId: queue.sent[0].body.jobId });
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    await consumePrivacyExportQueue({ queue: "privacy-export", messages: [poison, wrongVersion] }, env);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(poison.acknowledgements, 1);
  assert.equal(wrongVersion.acknowledgements, 1);
  assert.equal(bucket.objects.size, 0);
  assert.equal(sqlite.prepare("SELECT attempts FROM privacy_export_jobs").get().attempts, 0);
});

test("account cancellation during object write prevents completion and removes the uncommitted object", async () => {
  const { sqlite, d1 } = await database();
  const userId = addUser(sqlite, "race-clean");
  const queue = queueBinding();
  const bucket = objectBucket({
    onPut: async () => {
      sqlite.prepare(`UPDATE privacy_export_jobs
        SET state = 'canceled', user_id = NULL, lease_expires_at = NULL,
          lease_token = NULL, last_error_code = 'account_deleted'
        WHERE user_id = ?`).run(userId);
    },
  });
  const env = { DB: d1, PRIVACY_EXPORT_QUEUE_ENABLED: "true", PRIVACY_EXPORT_QUEUE: queue, PRIVACY_EXPORTS: bucket };
  const requested = await requestPrivacyExport(env, userId);
  const message = queueMessage(queue.sent[0].body);
  await consumePrivacyExportQueue({ queue: "privacy-export", messages: [message] }, env);
  assert.equal(message.acknowledgements, 1);
  assert.equal(bucket.objects.size, 0);
  const row = sqlite.prepare("SELECT state, user_id, object_key FROM privacy_export_jobs WHERE id = ?").get(requested.job.id);
  assert.deepEqual({ ...row }, { state: "canceled", user_id: null, object_key: null });
});

test("a failed race cleanup retains the locator until bounded scheduled cleanup succeeds", async () => {
  const { sqlite, d1 } = await database();
  const userId = addUser(sqlite, "race-retry");
  const queue = queueBinding();
  let failDelete = true;
  const bucket = objectBucket({
    onPut: async () => {
      sqlite.prepare(`UPDATE privacy_export_jobs
        SET state = 'canceled', user_id = NULL, lease_expires_at = NULL,
          lease_token = NULL, last_error_code = 'account_deleted'
        WHERE user_id = ?`).run(userId);
    },
    deleteFailure: () => failDelete,
  });
  const env = { DB: d1, PRIVACY_EXPORT_QUEUE_ENABLED: "true", PRIVACY_EXPORT_QUEUE: queue, PRIVACY_EXPORTS: bucket };
  const requested = await requestPrivacyExport(env, userId);
  await consumePrivacyExportQueue({ queue: "privacy-export", messages: [queueMessage(queue.sent[0].body)] }, env);
  const retained = sqlite.prepare(`SELECT state, user_id, object_key, object_key_hash, last_error_code
    FROM privacy_export_jobs WHERE id = ?`).get(requested.job.id);
  assert.equal(retained.state, "needs_attention");
  assert.equal(retained.user_id, null);
  assert.match(retained.object_key, /^privacy-exports\/pexj_[a-f0-9]{32}\/[a-f0-9]{48}\.json$/);
  assert.match(retained.object_key_hash, /^[a-f0-9]{64}$/);
  assert.equal(retained.last_error_code, "uncommitted_object_delete_failed");

  failDelete = false;
  assert.equal(await processExpiredPrivacyExports(env), 1);
  const expired = sqlite.prepare("SELECT state, object_key, object_key_hash FROM privacy_export_jobs WHERE id = ?").get(requested.job.id);
  assert.deepEqual({ ...expired }, { state: "expired", object_key: null, object_key_hash: null });
  assert.equal(bucket.objects.size, 0);
});

test("stale attempt cleanup cannot delete a newer export and preserves every failed cleanup locator", async () => {
  const { sqlite, d1 } = await database();
  const userId = addUser(sqlite, "stale-attempt");
  const queue = queueBinding();
  let releaseFirstPut;
  let announceFirstPut;
  const firstPutStarted = new Promise((resolve) => { announceFirstPut = resolve; });
  const firstPutGate = new Promise((resolve) => { releaseFirstPut = resolve; });
  let putCount = 0;
  let firstObjectKey = null;
  let failDeletes = false;
  const bucket = objectBucket({
    onPut: async (key) => {
      putCount += 1;
      if (putCount !== 1) return;
      firstObjectKey = key;
      announceFirstPut();
      await firstPutGate;
    },
    deleteFailure: () => failDeletes,
  });
  const env = { DB: d1, PRIVACY_EXPORT_QUEUE_ENABLED: "true", PRIVACY_EXPORT_QUEUE: queue, PRIVACY_EXPORTS: bucket };
  const requested = await requestPrivacyExport(env, userId);
  const staleMessage = queueMessage(queue.sent[0].body);
  const staleConsumer = consumePrivacyExportQueue({ queue: "privacy-export", messages: [staleMessage] }, env);
  await firstPutStarted;

  sqlite.prepare("UPDATE privacy_export_jobs SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?")
    .run(requested.job.id);
  assert.equal(await processExpiredPrivacyExports(env), 1);
  const recovered = sqlite.prepare("SELECT state, object_key FROM privacy_export_jobs WHERE id = ?").get(requested.job.id);
  assert.deepEqual({ ...recovered }, { state: "retry", object_key: null });

  const redispatched = await requestPrivacyExport(env, userId);
  assert.equal(redispatched.job.id, requested.job.id);
  assert.equal(queue.sent.length, 2);
  const currentMessage = queueMessage(queue.sent[1].body);
  await consumePrivacyExportQueue({ queue: "privacy-export", messages: [currentMessage] }, env);
  const completed = sqlite.prepare("SELECT state, object_key FROM privacy_export_jobs WHERE id = ?").get(requested.job.id);
  assert.equal(completed.state, "completed");
  assert.notEqual(completed.object_key, firstObjectKey);
  assert.equal(bucket.objects.has(completed.object_key), true);

  failDeletes = true;
  releaseFirstPut();
  await staleConsumer;
  assert.equal(staleMessage.acknowledgements, 1);
  assert.deepEqual(
    { ...sqlite.prepare("SELECT state, object_key FROM privacy_export_jobs WHERE id = ?").get(requested.job.id) },
    { state: "completed", object_key: completed.object_key },
  );
  const cleanup = sqlite.prepare(`SELECT id, user_id, state, object_key
    FROM privacy_export_jobs WHERE id != ?`).get(requested.job.id);
  assert.equal(cleanup.user_id, null);
  assert.equal(cleanup.state, "needs_attention");
  assert.equal(cleanup.object_key, firstObjectKey);

  failDeletes = false;
  assert.equal(await processExpiredPrivacyExports(env), 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM privacy_export_jobs WHERE object_key IS NOT NULL").get().count, 1);
  assert.equal(bucket.objects.size, 1);
  assert.equal(bucket.objects.has(completed.object_key), true);
});

test("completed files expire at the exact boundary and their tombstone no longer owns an account", async () => {
  const { sqlite, d1 } = await database();
  const userId = addUser(sqlite, "expiry");
  const { env, queue, bucket, job } = await scheduledExport(sqlite, d1, userId);
  await consumePrivacyExportQueue({ queue: "privacy-export", messages: [queueMessage(queue.sent[0].body)] }, env);
  sqlite.prepare("UPDATE privacy_export_jobs SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(job.id);
  assert.equal(await processExpiredPrivacyExports(env), 1);
  const expired = sqlite.prepare(`SELECT state, user_id, object_key, content_sha256, size_bytes, record_count
    FROM privacy_export_jobs WHERE id = ?`).get(job.id);
  assert.deepEqual({ ...expired }, {
    state: "expired",
    user_id: null,
    object_key: null,
    content_sha256: null,
    size_bytes: null,
    record_count: null,
  });
  assert.equal(bucket.objects.size, 0);
  assert.equal(await privacyExportJobForOwner(d1, userId, job.id), null);
});

test("the reusable payload builder reports a complete record count without cardinality LIMIT clauses", async () => {
  const { sqlite, d1 } = await database();
  const userId = addUser(sqlite, "builder");
  const built = await buildPrivacyExportPayload({ DB: d1 }, userId, "2026-07-20T13:00:00.000Z");
  assert.equal(built.payload.exportedAt, "2026-07-20T13:00:00.000Z");
  assert.equal(built.recordCount, 1);
  const source = await readFile(new URL("../worker/privacy-export.ts", import.meta.url), "utf8");
  const builder = source.slice(
    source.indexOf("export async function buildPrivacyExportPayload"),
    source.indexOf("async function buildPhotoExportManifest"),
  );
  assert.doesNotMatch(builder, /\bLIMIT\s+(?!1\b)\d+\b/i);
});
