import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [accountFeature, styles] = await Promise.all([
  readFile(new URL("../app/components/AccountFeature.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
]);

test("gear writes stay local while offline and never replay after reconnection", () => {
  assert.match(accountFeature, /Gear changes cannot be submitted/);
  assert.match(accountFeature, /No gear change was submitted automatically/);
  assert.match(accountFeature, /Reconnect to save preset/);
  assert.match(accountFeature, /Reconnect to remove/);
  assert.doesNotMatch(accountFeature, /addEventListener\("online"[^]*(?:saveGearProfile|deleteGearProfile)/);
});

test("gear creation requires a matching 201 resource receipt", () => {
  assert.match(accountFeature, /response\.status !== 201/);
  assert.match(accountFeature, /\^gear_\[a-f0-9-\]\{36\}\$/);
  assert.match(accountFeature, /const expectedGearReceipt =/);
  assert.match(accountFeature, /body\.gearProfile\.name !== expectedGearReceipt\.name/);
  assert.match(accountFeature, /body\.gearProfile\.rod !== expectedGearReceipt\.rod/);
  assert.match(accountFeature, /body\.gearProfile\.reel !== expectedGearReceipt\.reel/);
  assert.match(accountFeature, /body\.gearProfile\.baitLure !== expectedGearReceipt\.baitLure/);
  assert.match(accountFeature, /body\.gearProfile\.rig !== expectedGearReceipt\.rig/);
  assert.match(accountFeature, /The gear-preset response could not be verified/);
  assert.ok(
    accountFeature.indexOf("response.status !== 201") < accountFeature.indexOf("setGearDraft(EMPTY_GEAR)"),
    "the draft must be cleared only after the creation receipt is verified",
  );
});

test("gear removal requires a matching deletion receipt", () => {
  assert.match(accountFeature, /body\?\.deleted !== true \|\| body\.id !== id/);
  assert.match(accountFeature, /The gear-removal response could not be verified/);
  assert.match(accountFeature, /Verify gear removal before retrying/);
});

test("slow and ambiguous gear writes remain visibly unconfirmed", () => {
  assert.match(accountFeature, /new gear preset has not been confirmed yet/);
  assert.match(accountFeature, /gear-preset removal has not been confirmed yet/);
  assert.match(accountFeature, /This preset may already be saved/);
  assert.match(accountFeature, /This preset may already be removed/);
  assert.match(accountFeature, /gearMutationAmbiguous/);
  assert.match(accountFeature, /profileActionBusy \|\| networkState === "offline" \|\| gearMutationAmbiguous/);
  assert.match(accountFeature, /profile-gear-controls" disabled=\{profileActionBusy \|\| gearMutationAmbiguous\}/);
  assert.match(styles, /\.mutation-request-status\.submitting/);
});

test("authoritative client errors remain correctable", () => {
  assert.match(accountFeature, /if \(response\.status >= 500\) \{[^]*throw new Error\(body\?\.error\?\.message/);
  assert.match(accountFeature, /state: ambiguous \? "ambiguous" : "error"/);
});
