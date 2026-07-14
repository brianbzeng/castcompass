import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [authSource, workerSource, appSource, tripSource, accountSource, siteComboboxSource, gearFieldsSource, migration] = await Promise.all([
  readFile(new URL("../worker/auth.ts", import.meta.url), "utf8"),
  readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/components/OpportunityApp.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/components/TripReportFeature.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/components/AccountFeature.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/components/SiteCombobox.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/components/GearCatalogFields.tsx", import.meta.url), "utf8"),
  readFile(new URL("../drizzle/0001_accounts_and_saved_sites.sql", import.meta.url), "utf8"),
]);

test("uses hardened server-side sessions for beta accounts", () => {
  assert.match(authSource, /PBKDF2/);
  assert.match(authSource, /100_000/);
  assert.match(authSource, /HttpOnly; SameSite=Lax/);
  assert.match(authSource, /auth_sessions/);
  assert.match(workerSource, /getAuthenticatedUser/);
  assert.match(workerSource, /protectedTripMutation/);
});

test("gear presets and pending-trip edits share the searchable product catalog", () => {
  assert.match(accountSource, /Gear presets/);
  assert.match(accountSource, /Save gear preset/);
  assert.match(accountSource, /<GearCatalogFields/);
  assert.match(gearFieldsSource, /Search company/);
  assert.match(gearFieldsSource, /SearchChoice/);
});

test("persists saved locations and gates trip entry points", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS `saved_sites`/);
  assert.match(appSource, /Save location/);
  assert.match(appSource, /savedSiteIds/);
  assert.match(tripSource, /canSubmit/);
  assert.match(tripSource, /onRequireLogin/);
});

test("offers expandable reports and licensed structure examples", () => {
  assert.match(appSource, /Expand to full-screen report/);
  assert.match(appSource, /See an example/);
  assert.match(appSource, /Reference example—not this exact spot/);
});

test("keeps unfinished trip entry recoverable and makes locations searchable", () => {
  assert.match(tripSource, /castcompass\.trip-draft\.v1/);
  assert.match(tripSource, /Draft saved on this device as you type/);
  assert.match(tripSource, /SiteCombobox/);
  assert.match(siteComboboxSource, /role="combobox"/);
  assert.match(siteComboboxSource, /Matching fishing locations/);
  assert.match(tripSource, /localStorage\.setItem/);
});

test("allows owners to edit or remove pending reports only", () => {
  assert.match(authSource, /\/api\/profile\/trips\//);
  assert.match(authSource, /trip\.moderation_status !== "pending"/);
  assert.match(authSource, /request\.method === "PATCH"/);
  assert.match(authSource, /request\.method === "DELETE"/);
  assert.match(accountSource, />Edit</);
  assert.match(accountSource, />Remove</);
  assert.match(accountSource, /castcompass\.profile-trip-draft\.v1/);
});
