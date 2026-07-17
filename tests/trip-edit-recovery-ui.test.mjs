import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [accountFeature, styles] = await Promise.all([
  readFile(new URL("../app/components/AccountFeature.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
]);

test("trip edits remain local while offline and never replay after reconnection", () => {
  assert.match(accountFeature, /The trip edit was not submitted, and your draft remains on this device/);
  assert.match(accountFeature, /No trip edit was submitted automatically/);
  assert.match(accountFeature, /Reconnect to save changes/);
  assert.match(accountFeature, /profileActionBusy \|\| networkState === "offline" \|\| tripEditAmbiguous \|\| tripDeletionAmbiguous/);
  assert.doesNotMatch(accountFeature, /addEventListener\("online"[^]*saveTripEdit/);
});

test("slow trip edits stay visibly unconfirmed and cannot be changed mid-request", () => {
  assert.match(accountFeature, /trip update has not been confirmed yet/);
  assert.match(accountFeature, /aria-busy=\{activeTripEditRequest\?\.state === "submitting"\}/);
  assert.match(accountFeature, /profile-trip-editor-controls" disabled=\{profileActionBusy \|\| tripEditAmbiguous\}/);
  assert.match(accountFeature, /MutationRequestStatus state=\{displayedTripEditState\}/);
  assert.match(styles, /\.mutation-request-status\.submitting/);
  assert.match(styles, /@keyframes mutation-request-progress/);
});

test("trip edits require an authoritative matching success response", () => {
  assert.match(accountFeature, /body\.updated !== true \|\| body\.tripId !== submittedTripId \|\| body\.validationEvidenceExcluded !== true/);
  assert.match(accountFeature, /The trip-update response could not be read/);
  assert.match(accountFeature, /The trip-update response could not be verified/);
  assert.match(accountFeature, /response\.status >= 500/);
  assert.match(accountFeature, /editError instanceof AmbiguousMutationError/);
  assert.match(accountFeature, /These trip changes may already be saved/);
  assert.match(accountFeature, /Do not submit again/);
});

test("ambiguous edits retain the draft and block every conflicting trip mutation", () => {
  assert.match(accountFeature, /setTripEditRequest\(\{[^]*state: ambiguous \? "ambiguous" : "error"/);
  assert.match(accountFeature, /tripDeletionDisabled = profileActionBusy \|\| networkState === "offline" \|\| tripDeletionAmbiguous \|\| tripEditAmbiguous/);
  assert.match(accountFeature, /tripEditDisabled = profileActionBusy \|\| tripDeletionAmbiguous \|\| tripEditAmbiguous/);
  assert.match(accountFeature, /Verify saved trip before retrying/);
  assert.match(accountFeature, /window\.localStorage\.removeItem\(`\$\{PROFILE_TRIP_DRAFT_PREFIX\}\$\{submittedTripId\}`\);/);
  assert.ok(
    accountFeature.indexOf("body.updated !== true") < accountFeature.indexOf("window.localStorage.removeItem(`${PROFILE_TRIP_DRAFT_PREFIX}${submittedTripId}`)"),
    "the draft must be removed only after the success receipt is verified",
  );
});

test("authoritative client errors stay correctable", () => {
  assert.match(accountFeature, /if \(response\.status >= 500\) \{[^]*throw new Error\(body\?\.error\?\.message/);
  assert.match(accountFeature, /state: ambiguous \? "ambiguous" : "error"/);
  assert.match(accountFeature, /setTripEditRequest\(null\);[^]*setEditingTrip\(trip\)/);
});
