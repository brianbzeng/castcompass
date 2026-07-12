import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [authSource, workerSource, appSource, tripSource, migration] = await Promise.all([
  readFile(new URL("../worker/auth.ts", import.meta.url), "utf8"),
  readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/components/OpportunityApp.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/components/TripReportFeature.tsx", import.meta.url), "utf8"),
  readFile(new URL("../drizzle/0001_accounts_and_saved_sites.sql", import.meta.url), "utf8"),
]);

test("uses hardened server-side sessions for beta accounts", () => {
  assert.match(authSource, /PBKDF2/);
  assert.match(authSource, /210_000/);
  assert.match(authSource, /HttpOnly; SameSite=Lax/);
  assert.match(authSource, /auth_sessions/);
  assert.match(workerSource, /getAuthenticatedUser/);
  assert.match(workerSource, /protectedTripMutation/);
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
