import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const featurePath = new URL("../app/components/TripReportFeature.tsx", import.meta.url);
const stylesPath = new URL("../app/globals.css", import.meta.url);
const workflowPath = new URL("../.github/workflows/ci.yml", import.meta.url);

test("trip photos are fail-closed and remain bound to the current one-photo contract", async () => {
  const source = await readFile(featurePath, "utf8");

  assert.match(source, /NEXT_PUBLIC_PHOTO_UPLOADS === "true"/);
  assert.doesNotMatch(source, /NEXT_PUBLIC_PHOTO_UPLOADS !== "false"/);
  assert.match(source, /type="file" accept="image\/jpeg,image\/png,image\/webp"/);
  assert.doesNotMatch(source, /type="file"[^>]+multiple/);
  assert.match(source, /Current storage supports one private photo per trip/);
  assert.match(source, /server strips metadata and re-encodes accepted files before storage/);
});

test("trip photo UI discloses selected, rejected, pending, confirmed, failed, and ambiguous states", async () => {
  const source = await readFile(featurePath, "utf8");

  assert.match(source, /"idle" \| "selected" \| "sending" \| "confirmed" \| "failed" \| "ambiguous"/);
  assert.match(source, /Selected only—nothing has uploaded yet/);
  assert.match(source, /No attachment is confirmed yet/);
  assert.match(source, /exact trip receipt confirms a private stored photo/);
  assert.match(source, /Not confirmed\. Correct any report error, then retry the whole report explicitly/);
  assert.match(source, /Outcome unknown\. Keep this file selected and use the same safe report retry/);
  assert.match(source, /Retry report with this photo/);
  assert.match(source, /cancel control is intentionally unavailable after submission starts because the server may already have committed/);
});

test("photo progress and receipts never invent byte completion or stored-photo success", async () => {
  const [source, styles] = await Promise.all([
    readFile(featurePath, "utf8"),
    readFile(stylesPath, "utf8"),
  ]);

  assert.match(source, /role="progressbar"/);
  assert.match(source, /aria-valuetext="Sending with the report; byte progress is unavailable"/);
  assert.doesNotMatch(source, /aria-valuenow/);
  assert.doesNotMatch(source, /\b100% complete\b/i);
  assert.match(source, /trip\.hasPhoto !== expectedHasPhoto/);
  assert.match(source, /exactTripReceipt\(payload, "past"[^\n]+Boolean\(photo\)\)/);
  assert.match(source, /exactTripReceipt\(payload, "complete"[^\n]+Boolean\(photo\)\)/);
  assert.match(styles, /@keyframes photo-progress/);
});

test("browser acceptance exercises the explicit feature-on bundle before the production-off build", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  const featureBuild = workflow.indexOf("NEXT_PUBLIC_PHOTO_UPLOADS=true npm run build");
  const featureTest = workflow.indexOf("npm run test:photo-ui:browser");
  const productionBuild = workflow.indexOf("npm run build:cloudflare", featureTest);
  const mobileTest = workflow.indexOf("npm run test:mobile", productionBuild);
  assert.ok(featureBuild >= 0, "CI must compile the explicit feature-on bundle");
  assert.ok(featureTest > featureBuild, "feature-on browser acceptance must follow its build");
  assert.ok(productionBuild > featureTest, "CI must restore the production-off bundle after feature tests");
  assert.ok(mobileTest > productionBuild, "mobile acceptance must run against the production-off bundle");
});
