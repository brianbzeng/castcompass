import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [review, discussions, worker, app, migration] = await Promise.all([
  readFile(new URL("../worker/trip-review.ts", import.meta.url), "utf8"),
  readFile(new URL("../worker/discussions.ts", import.meta.url), "utf8"),
  readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/components/OpportunityApp.tsx", import.meta.url), "utf8"),
  readFile(new URL("../drizzle/0006_moderated_location_discussions.sql", import.meta.url), "utf8"),
]);

test("MiMo normalizes gear and prepares a bounded anonymous discussion draft", () => {
  assert.match(review, /Normalize recognizable rod, reel, and lure brands\/series\/models/);
  assert.match(review, /do not rank brands/i);
  assert.match(review, /Remove names, handles, contact details, exact sub-location clues/);
  assert.match(review, /normalizeGearAnalysis/);
  assert.match(review, /normalizeDiscussion/);
  assert.match(review, /publishTripDiscussion/);
});

test("public location discussions expose summaries without raw notes or identity", () => {
  assert.match(worker, /handleDiscussionRequest/);
  assert.match(discussions, /\/api\\\/discussions/);
  assert.match(discussions, /SELECT id, site_id, summary, gear_summary, technique_tags_json/);
  assert.doesNotMatch(discussions, /SELECT[^;]*\bnotes\b/s);
  assert.doesNotMatch(discussions, /SELECT[^;]*\baccount_id\b/s);
  assert.match(discussions, /sanitizePublicText/);
  assert.match(app, /Recent CastCompass trip notes/);
  assert.match(app, /raw notes, identity, photos, and exact coordinates remain private/i);
  assert.match(migration, /CREATE TABLE `site_discussion_posts`/);
  assert.match(migration, /UNIQUE INDEX `site_discussion_posts_trip_unique`/);
});
