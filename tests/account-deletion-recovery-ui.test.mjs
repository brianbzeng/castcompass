import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [accountFeature, networkStateHook, styles] = await Promise.all([
  readFile(new URL("../app/components/AccountFeature.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/lib/use-client-network-state.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
]);

test("account deletion is blocked while the browser reports offline", () => {
  assert.match(networkStateHook, /window\.navigator\.onLine/);
  assert.match(accountFeature, /networkState === "offline"/);
  assert.match(accountFeature, /Account deletion has not been submitted/);
  assert.match(accountFeature, /Reconnect to delete account/);
  assert.match(accountFeature, /No deletion request was submitted automatically/);
});

test("a dropped deletion response is treated as potentially committed", () => {
  assert.match(accountFeature, /isConnectionFailure\(deleteError\)/);
  assert.match(accountFeature, /accountDeletionState === "ambiguous"/);
  assert.match(accountFeature, /Verify deletion status before retrying/);
  assert.match(accountFeature, /Account access may already be removed/);
  assert.match(accountFeature, /Do not submit again/);
  assert.match(accountFeature, /deletion-status receipt/);
  assert.doesNotMatch(accountFeature, /isConnectionFailure\(deleteError\)[\s\S]{0,400}deleteAccount\(/);
});

test("unreadable success and server-error responses also block destructive resubmission", () => {
  assert.match(accountFeature, /response\.status >= 500/);
  assert.match(accountFeature, /if \(!body\)/);
  assert.match(accountFeature, /AmbiguousMutationError/);
});

test("slow account deletion remains visibly unconfirmed", () => {
  assert.match(accountFeature, /SLOW_MUTATION_NOTICE_MS = 4_000/);
  assert.match(accountFeature, /account removal has not been confirmed yet/);
  assert.match(accountFeature, /state === "submitting" \? <i aria-hidden="true"/);
  assert.match(styles, /@keyframes mutation-request-progress/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});
