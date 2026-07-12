import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const featurePath = new URL("../app/components/TripReportFeature.tsx", import.meta.url);
const appPath = new URL("../app/components/OpportunityApp.tsx", import.meta.url);

test("trip validation UI uses the first-party API contract", async () => {
  const source = await readFile(featurePath, "utf8");

  assert.match(source, /fetch\("\/api\/trips\/start"/);
  assert.match(source, /`\/api\/trips\/\$\{encodeURIComponent\(activeTrip\.id\)\}\/complete`/);
  assert.match(source, /fetch\("\/api\/trips\/report"/);
  assert.match(source, /fetch\("\/api\/trips\/summary"/);
  assert.match(source, /formData\.set\("website", ""\)/);
  assert.match(source, /formData\.set\("referralCode", referralCodeRef\.current\)/);
});

test("active reports are recoverable without collecting social identity or GPS", async () => {
  const source = await readFile(featurePath, "utf8");

  assert.match(source, /contourcast\.active-trip\.v1/);
  assert.match(source, /contourcast\.reporter-key\.v1/);
  assert.match(source, /No live GPS or social profile is collected/);
  assert.doesNotMatch(source, /facebookHandle|latitude|longitude/);
});

test("trip UX treats zero catch and photo validation as first-class states", async () => {
  const source = await readFile(featurePath, "utf8");

  assert.match(source, /Record no-catch trip/);
  assert.match(source, /image\/jpeg,image\/png,image\/webp/);
  assert.match(source, /MAX_PHOTO_BYTES = 5 \* 1024 \* 1024/);
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-live="polite"/);
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
  assert.match(app, /canSubmit=\{Boolean\(account\.user\)\}/);
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
