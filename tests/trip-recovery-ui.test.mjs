import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [tripFeature, networkStateHook, styles] = await Promise.all([
  readFile(new URL("../app/components/TripReportFeature.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/lib/use-client-network-state.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
]);

test("trip writes pause while the browser reports offline", () => {
  assert.match(networkStateHook, /window\.navigator\.onLine/);
  assert.match(networkStateHook, /addEventListener\("offline"/);
  assert.match(networkStateHook, /addEventListener\("online"/);
  assert.match(tripFeature, /trip submissions are paused/);
  assert.match(tripFeature, /networkState === "offline"/);
  assert.match(tripFeature, /Reconnect to save report/);
});

test("reconnection never automatically replays an ambiguous write", () => {
  const onlineHandlerStart = tripFeature.indexOf("const handleOnline");
  const onlineHandlerEnd = tripFeature.indexOf("window.addEventListener", onlineHandlerStart);
  const onlineHandler = tripFeature.slice(onlineHandlerStart, onlineHandlerEnd);
  assert.doesNotMatch(onlineHandler, /fetch\(/);
  assert.match(tripFeature, /Nothing was resubmitted automatically/);
  assert.match(tripFeature, /server may already have accepted the report/);
  assert.match(tripFeature, /check your Profile before retrying to avoid a duplicate/);
});

test("slow trip writes show honest indeterminate progress and retain drafts", () => {
  assert.match(tripFeature, /SLOW_SUBMISSION_NOTICE_MS = 4_000/);
  assert.match(tripFeature, /no completed report is confirmed yet/);
  assert.match(tripFeature, /no report is confirmed yet/);
  assert.match(tripFeature, /state === "submitting" \? <i aria-hidden="true"/);
  assert.match(styles, /@keyframes trip-request-progress/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});
