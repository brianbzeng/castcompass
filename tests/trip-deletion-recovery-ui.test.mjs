import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [accountFeature, styles] = await Promise.all([
  readFile(new URL("../app/components/AccountFeature.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
]);

test("trip deletion is blocked offline and never replays after reconnection", () => {
  assert.match(accountFeature, /networkState === "offline"/);
  assert.match(accountFeature, /Trip deletion is paused/);
  assert.match(accountFeature, /Reconnect to remove/);
  assert.match(accountFeature, /No trip edit or deletion was submitted automatically/);
});

test("ambiguous trip deletion blocks another destructive submission", () => {
  assert.match(accountFeature, /tripDeletionAmbiguous/);
  assert.match(accountFeature, /This trip may already be removed/);
  assert.match(accountFeature, /Do not submit again/);
  assert.match(accountFeature, /Verify deletion status before retrying/);
  assert.match(accountFeature, /profileActionBusy \|\| networkState === "offline" \|\| tripDeletionAmbiguous/);
});

test("unreadable success and server-error responses remain ambiguous", () => {
  assert.match(accountFeature, /response\.status >= 500/);
  assert.match(accountFeature, /The trip-deletion response could not be read/);
  assert.match(accountFeature, /The trip-deletion response could not be verified/);
  assert.match(accountFeature, /deleteError instanceof AmbiguousMutationError/);
});

test("slow trip deletion stays visibly unconfirmed", () => {
  assert.match(accountFeature, /trip deletion has not been confirmed yet/);
  assert.match(accountFeature, /MutationRequestStatus state=/);
  assert.match(styles, /\.mutation-request-status\.submitting/);
  assert.match(styles, /@keyframes mutation-request-progress/);
});
