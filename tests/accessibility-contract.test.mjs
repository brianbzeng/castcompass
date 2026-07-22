import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the forecast exposes a skip target and truthful grouped selection controls", async () => {
  const source = await read("app/components/OpportunityApp.tsx");

  assert.match(source, /className="skip-link" href="#main-content"/);
  assert.match(source, /<main id="main-content" tabIndex=\{-1\}>/);
  assert.match(source, /className="time-tabs" role="group" aria-label="Forecast period"/);
  assert.match(source, /aria-pressed=\{timeFilter === value\}/);
  assert.doesNotMatch(source, /role="tablist"|role="tab"/);
  assert.match(source, /role="group" aria-label="Forecast presentation"/);
  assert.match(source, /aria-label="Map and list view" aria-pressed=\{view === "map"\}/);
  assert.match(source, /aria-label="List-only view" aria-pressed=\{view === "list"\}/);
});

test("all product dialogs use the shared nested focus boundary", async () => {
  const [hook, opportunity, account, trip] = await Promise.all([
    read("app/lib/use-modal-dialog.ts"),
    read("app/components/OpportunityApp.tsx"),
    read("app/components/AccountFeature.tsx"),
    read("app/components/TripReportFeature.tsx"),
  ]);

  assert.match(hook, /const modalStack: HTMLElement\[\] = \[\]/);
  assert.match(hook, /modalStack\.at\(-1\) !== dialog/);
  assert.match(hook, /event\.key === "Escape"/);
  assert.match(hook, /event\.key !== "Tab"/);
  assert.match(hook, /document\.addEventListener\("focusin"/);
  assert.match(hook, /restoreTarget\.focus\(\{ preventScroll: true \}\)/);

  for (const source of [opportunity, account, trip]) {
    assert.match(source, /useModalDialog/);
  }
  assert.match(opportunity, /closeOnEscape: false/);
  assert.match(account, /ref=\{accountDialogRef\}/);
  assert.match(account, /ref=\{tripEditDialogRef\}/);
  assert.match(trip, /ref=\{dialogRef\}/);
});

test("the map advertises its list alternative and honors reduced motion in JavaScript", async () => {
  const source = await read("app/components/ContourMap.tsx");

  assert.match(source, /role="region"/);
  assert.match(source, /aria-describedby="map-alternative-description"/);
  assert.match(source, /keyboard-accessible ranked list after the map/);
  assert.match(source, /matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches/);
  assert.equal((source.match(/duration: mapMotionDuration\(/g) ?? []).length, 3);
});

test("focus and skip-link styles remain visible while reduced motion stays global", async () => {
  const styles = await read("app/globals.css");

  assert.match(styles, /:where\(a, button, input, select, textarea, summary, \[tabindex\]\):focus-visible/);
  assert.match(styles, /\.skip-link:focus-visible[\s\S]*transform: translateY\(0\)/);
  assert.match(styles, /\.sr-only[\s\S]*clip: rect\(0, 0, 0, 0\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});
