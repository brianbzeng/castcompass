import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createTripStore, processTripPhotoUploadReservations } from "../worker/trips.ts";

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
    if (this.owner.throwOnceAfterMutationSubstring
      && this.query.includes(this.owner.throwOnceAfterMutationSubstring)) {
      this.owner.throwOnceAfterMutationSubstring = null;
      throw new Error("simulated lost D1 mutation response");
    }
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class D1Adapter {
  constructor(sqlite) {
    this.sqlite = sqlite;
    this.throwOnceAfterMutationSubstring = null;
  }

  prepare(query) {
    return new D1StatementAdapter(this, query, this.sqlite.prepare(query));
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

class MemoryBucket {
  objects = new Map();
  deleteCalls = 0;
  failNextDelete = false;

  async put(key, bytes) {
    this.objects.set(key, new Uint8Array(bytes));
  }

  async delete(key) {
    this.deleteCalls += 1;
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw new Error("simulated R2 delete failure");
    }
    this.objects.delete(key);
  }
}

function objectKeyHash(key) {
  return createHash("sha256").update(`trip_photos\0${key}`).digest("hex");
}

async function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL);");
  const db = new D1Adapter(sqlite);
  const store = createTripStore(db);
  await store.initialize();
  const bucket = new MemoryBucket();
  return { sqlite, db, store, bucket };
}

function reservation(key, tripId, timestamp = "2026-07-21T18:00:00.000Z") {
  return {
    id: `photo_reservation_${crypto.randomUUID()}`,
    tripId,
    objectKey: key,
    objectKeyHash: objectKeyHash(key),
    availableAt: timestamp,
    createdAt: timestamp,
  };
}

function insertAttachedTrip(sqlite, tripId, key) {
  sqlite.prepare(`INSERT INTO trips (
      id, user_id, status, source, site_id, started_at, mode, angler_count,
      consent, moderation_status, reporter_key_hash, photo_key, created_at, updated_at)
    VALUES (?, NULL, 'active', 'live', 'crissy-field', '2026-07-21T17:00:00.000Z',
      'beach', 1, 0, 'pending', 'reporter-hash', ?,
      '2026-07-21T17:00:00.000Z', '2026-07-21T17:00:00.000Z')`)
    .run(tripId, key);
}

function insertCompletableTrip(sqlite, tripId, tokenHash) {
  sqlite.prepare(`INSERT INTO trips (
      id, user_id, status, source, site_id, started_at, mode, angler_count,
      consent, moderation_status, reporter_key_hash, token_hash, idempotency_key_hash,
      created_at, updated_at)
    VALUES (?, NULL, 'active', 'live', 'crissy-field', '2026-07-21T17:00:00.000Z',
      'beach', 1, 0, 'pending', 'reporter-hash', ?, ?,
      '2026-07-21T17:00:00.000Z', '2026-07-21T17:00:00.000Z')`)
    .run(tripId, tokenHash, tokenHash);
}

function completion(key, keyHash) {
  return {
    endedAt: "2026-07-21T18:00:00.000Z",
    mode: "beach",
    fishingMethod: null,
    gear: null,
    gearProfileId: null,
    rod: null,
    reel: null,
    baitLure: null,
    rig: null,
    anglerCount: 1,
    anglerHours: 1,
    keeperCount: 0,
    shortReleasedCount: 0,
    halibutEncounters: 0,
    noCatch: true,
    otherCatchCount: 0,
    otherSpecies: null,
    observationsJson: null,
    observationContractVersion: "castingcompass.observation/2.0.0",
    taxonCatalogVersion: "castingcompass.taxa/1.0.0",
    targetTaxonId: "california-halibut",
    contractStatus: "valid",
    taxonObservationsJson: JSON.stringify([{
      taxon_id: "california-halibut",
      encounter_count: 0,
      retained_count: 0,
      released_count: 0,
      disposition_unknown_count: 0,
      identification_confidence: "not_observed",
      identification_basis: "not-observed",
    }]),
    outcomeClass: "no_fish",
    targetEncounterCount: 0,
    anyFishEncounterCount: 0,
    targetIdentificationConfidence: "not_observed",
    notes: null,
    consentAt: "2026-07-21T18:00:00.000Z",
    photoKey: key,
    photoKeyHash: keyHash,
    photoContentType: "image/webp",
    photoSizeBytes: 3,
    updatedAt: "2026-07-21T18:00:00.000Z",
  };
}

test("a pre-upload reservation accepts a lost committed D1 response only through exact read-back", async () => {
  const { sqlite, db, store } = await fixture();
  const tripId = "trip_10000000-0000-4000-8000-000000000001";
  const key = `trip-photos/2026/07/${tripId}/candidate.webp`;
  db.throwOnceAfterMutationSubstring = "INSERT INTO trip_photo_upload_reservations";

  assert.equal(await store.reservePhotoUpload(reservation(key, tripId)), true);
  const row = sqlite.prepare(`SELECT trip_id, object_key, object_key_hash, state, attempts
    FROM trip_photo_upload_reservations`).get();
  assert.deepEqual({ ...row }, {
    trip_id: tripId,
    object_key: key,
    object_key_hash: objectKeyHash(key),
    state: "pending",
    attempts: 0,
  });
});

test("an attached object survives reconciliation while a lost terminal D1 response leaves no reservation", async () => {
  const { sqlite, db, store, bucket } = await fixture();
  const tripId = "trip_20000000-0000-4000-8000-000000000002";
  const key = `trip-photos/2026/07/${tripId}/attached.webp`;
  await store.reservePhotoUpload(reservation(key, tripId));
  bucket.objects.set(key, new Uint8Array([1, 2, 3]));
  insertAttachedTrip(sqlite, tripId, key);
  db.throwOnceAfterMutationSubstring = "DELETE FROM trip_photo_upload_reservations";

  assert.equal(await processTripPhotoUploadReservations(
    { DB: db, TRIP_PHOTOS: bucket },
    new Date("2026-07-21T18:01:00.000Z"),
  ), 1);
  assert.equal(bucket.objects.has(key), true);
  assert.equal(bucket.deleteCalls, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM trip_photo_upload_reservations").get().count, 0);
});

test("an unattached object remains durably retryable after R2 failure and is later deleted", async () => {
  const { sqlite, db, store, bucket } = await fixture();
  const tripId = "trip_30000000-0000-4000-8000-000000000003";
  const key = `trip-photos/2026/07/${tripId}/orphan.webp`;
  await store.reservePhotoUpload(reservation(key, tripId));
  bucket.objects.set(key, new Uint8Array([4, 5, 6]));
  bucket.failNextDelete = true;

  assert.equal(await processTripPhotoUploadReservations(
    { DB: db, TRIP_PHOTOS: bucket },
    new Date("2026-07-21T18:01:00.000Z"),
  ), 0);
  assert.equal(bucket.objects.has(key), true);
  assert.deepEqual({ ...sqlite.prepare(`SELECT state, attempts, last_error_code
    FROM trip_photo_upload_reservations`).get() }, {
    state: "pending",
    attempts: 1,
    last_error_code: "photo_cleanup_failed",
  });

  assert.equal(await processTripPhotoUploadReservations(
    { DB: db, TRIP_PHOTOS: bucket },
    new Date("2026-07-21T19:00:00.000Z"),
  ), 1);
  assert.equal(bucket.objects.has(key), false);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM trip_photo_upload_reservations").get().count, 0);
});

test("a reservation hash mismatch fails closed without touching R2", async () => {
  const { sqlite, db, store, bucket } = await fixture();
  const tripId = "trip_40000000-0000-4000-8000-000000000004";
  const key = `trip-photos/2026/07/${tripId}/tampered.webp`;
  await store.reservePhotoUpload(reservation(key, tripId));
  sqlite.prepare("UPDATE trip_photo_upload_reservations SET object_key_hash = ?")
    .run("f".repeat(64));
  bucket.objects.set(key, new Uint8Array([7, 8, 9]));

  assert.equal(await processTripPhotoUploadReservations(
    { DB: db, TRIP_PHOTOS: bucket },
    new Date("2026-07-21T18:01:00.000Z"),
  ), 0);
  assert.equal(bucket.deleteCalls, 0);
  assert.deepEqual({ ...sqlite.prepare(`SELECT state, last_error_code, object_key
    FROM trip_photo_upload_reservations`).get() }, {
    state: "needs_attention",
    last_error_code: "photo_locator_hash_mismatch",
    object_key: key,
  });
});

test("trip attachment and cleanup claim are serialized by the reservation state", async () => {
  const first = await fixture();
  const firstTripId = "trip_50000000-0000-4000-8000-000000000005";
  const firstToken = "1".repeat(64);
  const firstKey = `trip-photos/2026/07/${firstTripId}/adopted.webp`;
  const firstHash = objectKeyHash(firstKey);
  insertCompletableTrip(first.sqlite, firstTripId, firstToken);
  await first.store.reservePhotoUpload(reservation(firstKey, firstTripId));
  first.bucket.objects.set(firstKey, new Uint8Array([1, 2, 3]));

  assert.ok(await first.store.completeTrip(
    firstTripId,
    firstToken,
    null,
    completion(firstKey, firstHash),
  ));
  assert.equal(first.sqlite.prepare("SELECT COUNT(*) AS count FROM trip_photo_upload_reservations").get().count, 0);
  assert.equal(first.bucket.objects.has(firstKey), true);

  const second = await fixture();
  const secondTripId = "trip_60000000-0000-4000-8000-000000000006";
  const secondToken = "2".repeat(64);
  const secondKey = `trip-photos/2026/07/${secondTripId}/cleanup-owned.webp`;
  const secondHash = objectKeyHash(secondKey);
  insertCompletableTrip(second.sqlite, secondTripId, secondToken);
  await second.store.reservePhotoUpload(reservation(secondKey, secondTripId));
  second.bucket.objects.set(secondKey, new Uint8Array([4, 5, 6]));
  second.sqlite.prepare(`UPDATE trip_photo_upload_reservations
    SET state = 'leased', attempts = 1, lease_expires_at = ?, lease_token = ?`)
    .run("2026-07-21T19:00:00.000Z", "cleanup-lease-token");

  assert.equal(await second.store.completeTrip(
    secondTripId,
    secondToken,
    null,
    completion(secondKey, secondHash),
  ), null);
  assert.deepEqual({ ...second.sqlite.prepare("SELECT status, photo_key FROM trips WHERE id = ?").get(secondTripId) }, {
    status: "active",
    photo_key: null,
  });
  second.sqlite.prepare("UPDATE trip_photo_upload_reservations SET lease_expires_at = ?")
    .run("2026-07-21T18:00:00.000Z");
  assert.equal(await processTripPhotoUploadReservations(
    { DB: second.db, TRIP_PHOTOS: second.bucket },
    new Date("2026-07-21T20:00:00.000Z"),
  ), 1);
  assert.equal(second.bucket.objects.has(secondKey), false);
  assert.equal(second.sqlite.prepare("SELECT COUNT(*) AS count FROM trip_photo_upload_reservations").get().count, 0);
});
