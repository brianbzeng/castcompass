import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [accountFeature, opportunityApp, styles, authWorker] = await Promise.all([
  readFile(new URL("../app/components/AccountFeature.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/components/OpportunityApp.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  readFile(new URL("../worker/auth.ts", import.meta.url), "utf8"),
]);

test("saved-location writes stay local while offline and never replay after reconnection", () => {
  assert.match(accountFeature, /networkState === "offline" \|\| savedSiteMutationBlocked/);
  assert.match(accountFeature, /No saved-location change was submitted/);
  assert.match(accountFeature, /nothing will be submitted automatically after reconnection/);
  assert.match(accountFeature, /Reconnect to (?:remove saved location|save location)/);
  assert.doesNotMatch(accountFeature, /addEventListener\("online"[^]*toggleSavedSite/);
});

test("saved-location changes require an exact action and site receipt", () => {
  assert.match(authWorker, /jsonResponse\(\{ saved: true, siteId \}\)/);
  assert.match(authWorker, /jsonResponse\(\{ saved: false, siteId \}\)/);
  assert.match(accountFeature, /response\.status !== 200 \|\| !isExactSavedSiteReceipt\(body, siteId, desiredSaved\)/);
  assert.match(accountFeature, /keys\.length === 2 && keys\[0\] === "saved" && keys\[1\] === "siteId"/);
  const receiptCheck = accountFeature.indexOf("!isExactSavedSiteReceipt(body, siteId, desiredSaved)");
  assert.ok(
    receiptCheck >= 0 && receiptCheck < accountFeature.indexOf("setSavedSiteIds((current)", receiptCheck),
    "the visible saved state must change only after the exact receipt is verified",
  );
});

test("slow and ambiguous saved-location writes remain visibly unconfirmed", () => {
  assert.match(accountFeature, /saved-location change has not been confirmed yet/);
  assert.match(accountFeature, /This location may already have changed/);
  assert.match(accountFeature, /Do not submit another saved-location change/);
  assert.match(accountFeature, /savedSiteMutationBlocked = savedSiteRequest\?\.state === "submitting" \|\| savedSiteRequest\?\.state === "ambiguous"/);
  assert.match(opportunityApp, /<SavedSiteControls account=\{account\} siteId=\{selectedSite\.id\} \/>/);
  assert.match(styles, /\.saved-site-controls \.mutation-request-status/);
  assert.match(styles, /\.save-site-button:disabled/);
});

test("ambiguous saved-location writes permit only exact read-only reconciliation", () => {
  assert.match(accountFeature, /Checking the saved-location list without repeating the write/);
  assert.match(accountFeature, /fetch\("\/api\/saved-sites", \{ cache: "no-store" \}\)/);
  assert.match(accountFeature, /savedSiteIdsFromReceipt\(body\)/);
  assert.match(accountFeature, /next\.has\(unresolved\.siteId\) === unresolved\.desiredSaved/);
  assert.match(accountFeature, /previous change did not complete\. You can retry it now/);
  assert.match(accountFeature, /Check saved-location status/);
  assert.match(accountFeature, /Reconnect to check saved-location status/);
});

test("authoritative client errors remain retryable without changing confirmed local state", () => {
  assert.match(accountFeature, /if \(response\.status >= 500\) throw new AmbiguousMutationError/);
  assert.match(accountFeature, /state: ambiguous \? "ambiguous" : "error"/);
  assert.match(accountFeature, /Retry save location/);
  assert.match(accountFeature, /Retry remove saved location/);
});
