import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [account, profilePage, opportunityApp, styles] = await Promise.all([
  readFile(new URL("../app/components/AccountFeature.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/components/ProfilePage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/components/OpportunityApp.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
]);

test("profile failures preserve the last good data and expose an explicit retry", () => {
  const loadStart = account.indexOf("const loadProfile = useCallback");
  const loadEnd = account.indexOf("useEffect(() =>", loadStart);
  const loadProfile = account.slice(loadStart, loadEnd);

  assert.match(loadProfile, /isProfileData\(body\)/);
  assert.match(account, /candidate\.savedSites\.every/);
  assert.match(account, /candidate\.trips\.every/);
  assert.match(account, /candidate\.gearProfiles\.every/);
  assert.match(loadProfile, /setProfileLoadError\("Profile data could not be loaded\."\)/);
  assert.doesNotMatch(loadProfile, /setProfile\(\{ savedSites: \[\], trips: \[\], gearProfiles: \[\] \}\)/);
  assert.match(account, /The latest profile refresh failed\. The information below is the last successfully loaded copy\./);
  assert.match(account, /CastingCompass is not treating the account as empty\./);
  assert.match(account, /"Retry profile"/);
});

test("last-good profile state is scoped to the current account", () => {
  const accountScopedKey = /key=\{account\.user\?\.id \?\? "anonymous"\}/;
  assert.match(profilePage, accountScopedKey);
  assert.match(opportunityApp, accountScopedKey);
});

test("unknown profile counts and sections never masquerade as verified empty data", () => {
  assert.match(account, /profile \? profile\.savedSites\.length : "—"/);
  assert.match(account, /profile \? profile\.trips\.length : "—"/);
  assert.match(account, /profile \? <p>No saved locations yet/);
  assert.match(account, /profile \? <p>No gear presets yet/);
  assert.match(account, /profile \? <p>No completed trip logs/);
  assert.match(account, /Saved locations are unavailable\. Retry the profile above\./);
  assert.match(account, /Gear presets are unavailable\. Retry the profile above\./);
  assert.match(account, /Trip history is unavailable\. Retry the profile above\./);
});

test("profile loading uses accessible skeletons and reduced motion", () => {
  assert.match(account, /function ProfileSectionLoading/);
  assert.match(account, /role="status" aria-label=\{label\}/);
  assert.match(account, /aria-hidden="true"/);
  assert.match(styles, /@keyframes profile-loading-shimmer/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});
