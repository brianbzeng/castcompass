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
  assert.match(authSource, /__Host-cc_session/);
  assert.match(authSource, /SameSite=Lax; Secure/);
  assert.match(authSource, /auth_sessions/);
  assert.doesNotMatch(accountSource, /localStorage[^\n]*cc_session|cc_session[^\n]*localStorage/);
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
  assert.match(tripSource, /castingcompass\.trip-draft\.v1/);
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
  assert.match(accountSource, /tripEditButtonLabel = tripEditAmbiguous \? "Update unresolved" : "Edit"/);
  assert.match(accountSource, />\{tripEditButtonLabel\}<\/button>/);
  assert.match(accountSource, /const tripDeletionButtonLabel =/);
  assert.match(accountSource, /: "Remove";/);
  assert.match(accountSource, />\{tripDeletionButtonLabel\}<\/button>/);
  assert.match(accountSource, /castingcompass\.profile-trip-draft\.v1/);
  assert.match(accountSource, /not a structured v2 observation/);
  assert.match(accountSource, /does not silently convert older counts/);
  assert.match(accountSource, /valid observation contract means a report is internally structured, not that it has been admitted to model training/);
  assert.match(authSource, /hasServerControlledObservationFields\(body\)/);
  assert.match(authSource, /trip\.contract_status === "valid"/);
  assert.match(accountSource, /Changing the location, start, finish, or fishing mode clears/);
  assert.match(authSource, /forecastAttributionChanged/);
  assert.match(authSource, /validationEvidenceExcluded: true/);
  assert.match(authSource, /post_completion_profile_edit/);
  assert.match(accountSource, /validationEvidenceExcluded !== true/);
  assert.match(accountSource, /remains useful as descriptive context but cannot re-enter prospective validation evidence/);
  assert.match(accountSource, /Saving any edit permanently keeps this report out of prospective validation evidence/);
  assert.match(accountSource, /Saved\. Because this completed report was edited, it remains context-only and cannot enter prospective validation evidence\./);
  assert.match(accountSource, /profileActionNotice && !editingTrip \? <p role="status">/);
  assert.match(authSource, /moderation_status = 'pending'/);
});
