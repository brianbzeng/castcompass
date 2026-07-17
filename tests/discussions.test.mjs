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

test("MiMo normalizes gear and prepares a bounded human-gated discussion draft", () => {
  assert.match(review, /Normalize recognizable rod, reel, and lure brands\/series\/models/);
  assert.match(review, /do not rank brands/i);
  assert.match(review, /Remove names, handles, contact details, exact sub-location clues/);
  assert.match(review, /You cannot publish or approve it/);
  assert.match(review, /normalizeGearAnalysis/);
  assert.match(review, /normalizeDiscussion/);
  assert.doesNotMatch(review, /publishTripDiscussion|site_discussion_posts/);
  assert.match(review, /reviewTripBacklog/);
  assert.match(worker, /scheduled/);
  assert.match(worker, /reviewTripBacklog/);
});

test("public location discussions expose summaries without raw notes or identity", () => {
  assert.match(worker, /handleDiscussionRequest/);
  assert.match(discussions, /\/api\\\/discussions/);
  assert.match(discussions, /SELECT post\.id AS id, post\.site_id AS site_id/);
  assert.match(discussions, /post\.summary AS summary, post\.gear_summary AS gear_summary/);
  assert.doesNotMatch(discussions, /SELECT[^;]*\bnotes\b/s);
  assert.doesNotMatch(discussions, /SELECT[^;]*\baccount_id\b/s);
  assert.match(discussions, /sanitizePublicText/);
  assert.match(discussions, /PUBLIC_DISCUSSIONS_ENABLED/);
  assert.match(discussions, /trip\.moderation_status = 'approved'/);
  assert.match(discussions, /post\.site_id = trip\.site_id/);
  assert.match(discussions, /length\(trim\(post\.approved_at\)\) > 0/);
  assert.match(discussions, /length\(trim\(post\.approved_by\)\) > 0/);
  assert.match(discussions, /length\(trim\(post\.source_ai_reviewed_at\)\) > 0/);
  assert.match(discussions, /post\.source_ai_reviewed_at = trip\.ai_reviewed_at/);
  assert.match(discussions, /trip\.ai_review_status = 'reviewed'/);
  assert.match(discussions, /substr\(post\.observed_at, 1, 10\)/);
  assert.match(app, /Human-reviewed CastingCompass trip notes/);
  assert.match(app, /human moderator must approve it before publication/i);
  assert.match(migration, /CREATE TABLE `site_discussion_posts`/);
  assert.match(migration, /UNIQUE INDEX `site_discussion_posts_trip_unique`/);
});
