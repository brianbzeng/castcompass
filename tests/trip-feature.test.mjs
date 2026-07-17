import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const featurePath = new URL("../app/components/TripReportFeature.tsx", import.meta.url);
const appPath = new URL("../app/components/OpportunityApp.tsx", import.meta.url);
const gearFieldsPath = new URL("../app/components/GearCatalogFields.tsx", import.meta.url);

test("trip validation UI uses the first-party API contract", async () => {
  const source = await readFile(featurePath, "utf8");

  assert.match(source, /fetch\("\/api\/trips\/start"/);
  assert.match(source, /`\/api\/trips\/\$\{encodeURIComponent\(activeTrip\.id\)\}\/complete`/);
  assert.match(source, /fetch\("\/api\/trips\/report"/);
  assert.match(source, /fetch\("\/api\/trips\/summary"/);
  assert.match(source, /formData\.set\("website", ""\)/);
  assert.match(source, /formData\.set\("referralCode", referralCodeRef\.current\)/);
  assert.match(source, /authoritativeStartedAt = typeof trip\.startedAt === "string" \? trip\.startedAt : startedAt/);
  assert.match(source, /startedAt: authoritativeStartedAt/);
  assert.match(source, /const startedAt = new Date\(\)\.toISOString\(\)/);
  assert.match(source, /Starts when you tap Start trip/);
  assert.match(source, /use Log a past trip for an earlier attempt/);
  assert.match(source, /formData\.set\("endedAt", new Date\(\)\.toISOString\(\)\)/);
  assert.match(source, /Finish time is recorded when you submit/);
  assert.match(source, /<TripCompletionFields[^>]+hideTimes \/>/);
});

test("active reports are recoverable without collecting social identity or GPS", async () => {
  const source = await readFile(featurePath, "utf8");

  assert.match(source, /contourcast\.active-trip\.v1/);
  assert.match(source, /contourcast\.reporter-key\.v1/);
  assert.match(source, /No live GPS or social profile is collected/);
  assert.doesNotMatch(source, /facebookHandle|latitude|longitude/);
});

test("trip UX distinguishes no fish, target encounters, and unresolved non-target catch", async () => {
  const source = await readFile(featurePath, "utf8");

  assert.match(source, /Record no-fish trip/);
  assert.match(source, /California halibut is the fixed observation target/);
  assert.match(source, /unresolved non-target fish/);
  assert.match(source, /anyFishEncounters = targetEncounters \+ fields\.otherCatchCount/);
  assert.match(source, /nothing enters training automatically/);
  assert.match(source, /Model use requires separate protocol activation/);
  assert.match(source, /observational secondary or context only/);
  assert.match(source, /scoreInfluencedChoice: "" \| "yes" \| "no"/);
  assert.match(source, /primaryTargetConfirmed/);
  assert.match(source, /completeAttempt/);
  assert.match(source, /Choose mode/);
  assert.match(source, /formData\.set\("mode", fields\.mode\)/);
  assert.match(source, /If the mode changed after you started/);
  assert.doesNotMatch(source, /No — independent trip/);
  assert.match(source, /Trip reports do not change the current score/);
  assert.doesNotMatch(source, /same validation value as a catch/);
  assert.match(source, /image\/jpeg,image\/png,image\/webp/);
  assert.match(source, /MAX_PHOTO_BYTES = 5 \* 1024 \* 1024/);
  assert.match(source, /role="dialog"/);
  assert.match(source, /role=\{state === "error" \|\| state === "ambiguous" \? "alert" : "status"\}/);
  assert.match(source, /aria-live=\{state === "error" \|\| state === "ambiguous" \? undefined : "polite"\}/);
});

test("trip entry points are present in the top bar, forecast detail, and validation section", async () => {
  const [feature, app] = await Promise.all([
    readFile(featurePath, "utf8"),
    readFile(appPath, "utf8"),
  ]);

  assert.match(app, />Log trip<\/button>/);
  assert.match(app, /Fish this window/);
  assert.match(app, /<TripReportFeature/);
  assert.match(app, /sites=\{sites\}/);
  assert.match(app, /canSubmit=\{Boolean\(account\.user\?\.legalAccepted\)\}/);
  assert.doesNotMatch(app, /training data can be checked/);
  assert.match(feature, /id="validation"/);
  assert.match(feature, /The skunks/);
  assert.match(app, /22 inches total length/);
  assert.match(app, /contourcast\.respect-water\.v1/);
  assert.match(feature, /whether it’s a skunk or not are useful and genuinely appreciated/);
});

test("forecast controls offer practical preset and custom location radii", async () => {
  const app = await readFile(appPath, "utf8");

  assert.match(app, /Within 5 mi/);
  assert.match(app, /Within 15 mi/);
  assert.match(app, /Within 30 mi/);
  assert.match(app, /Custom radius in miles/);
  assert.match(app, /site\.distanceMiles <= activeRadiusMiles/);
});

test("trip reports use searchable catalog gear, saved presets, and clear human-gated publishing disclosure", async () => {
  const [feature, gearFields] = await Promise.all([
    readFile(featurePath, "utf8"),
    readFile(gearFieldsPath, "utf8"),
  ]);

  assert.match(feature, /Saved gear preset/);
  assert.match(feature, /<GearCatalogFields/);
  assert.match(gearFields, /Other \/ not listed/);
  assert.match(gearFields, /role="combobox"/);
  assert.match(gearFields, /Bait or unlisted lure/);
  assert.match(feature, /It is not posted automatically/);
  assert.match(feature, /must be approved by a human moderator/);
});
