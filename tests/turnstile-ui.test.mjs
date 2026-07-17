import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [component, account, css, worker, auth] = await Promise.all([
  readFile(new URL("../app/components/TurnstileChallenge.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/components/AccountFeature.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  readFile(new URL("../worker/turnstile.ts", import.meta.url), "utf8"),
  readFile(new URL("../worker/auth.ts", import.meta.url), "utf8"),
]);

test("client gets only runtime public config and explicitly renders the official managed widget", () => {
  assert.match(component, /fetch\("\/api\/auth\/turnstile-config"/);
  assert.match(component, /cache: "no-store"/);
  assert.match(component, /challenges\.cloudflare\.com\/turnstile\/v0\/api\.js\?render=explicit/);
  assert.match(component, /window\.turnstile\.render/);
  assert.match(component, /action,/);
  assert.match(component, /appearance: "always"/);
  assert.match(component, /"response-field": false/);
  assert.match(component, /retry: "never"/);
  assert.match(component, /"feedback-enabled": false/);
  assert.match(component, /theme: "dark"/);
  assert.match(component, /tabindex: 0/);
  assert.doesNotMatch(component, /process\.env|TURNSTILE_SECRET_KEY|remoteip|cData|cdata/);
});

test("challenge UI is accessible, responsive, and truthful when unavailable", () => {
  assert.match(component, /role="group" aria-label=\{accessibleLabel\}/);
  assert.match(component, /"Resend security verification"/);
  assert.match(component, /role="status"/);
  assert.match(component, /role="alert"/);
  assert.match(component, /Security verification could not load/);
  assert.match(component, /no account information was submitted/);
  assert.match(component, /Retry security verification/);
  assert.match(component, /catch \{[\s\S]*resetStalledTurnstileScript\(\);[\s\S]*update\("unavailable"\)/);
  assert.match(component, /RUNTIME_CONFIG_TIMEOUT_MS = 5_000/);
  assert.match(component, /fetch\("\/api\/auth\/turnstile-config"[\s\S]*signal: controller\.signal/);
  assert.match(component, /resetStalledTurnstileScript[\s\S]*turnstileScriptPromise = null/);
  assert.match(component, /finally \{[\s\S]*runtimeConfigPromise === pending[\s\S]*runtimeConfigPromise = null/);
  assert.match(component, /max-width: 400px/);
  assert.match(component, /\? "compact" : "flexible"/);
  assert.match(css, /\.turnstile-challenge\s*\{[^}]*min-width:\s*0/s);
  assert.match(css, /\.turnstile-widget\s*\{[^}]*max-width:\s*100%/s);
});

test("every account attempt carries a fresh action-bound token and resets it", () => {
  for (const action of [
    "signup_eligibility",
    "signup_request",
    "signup_verify",
    "password_request",
    "password_reset",
    "login",
  ]) assert.match(account, new RegExp(`"${action}"`));
  assert.match(account, /action="challenge_resend"/);
  assert.match(account, /body: JSON\.stringify\(\{ challengeId, turnstileToken: resendTurnstileToken \}\)/);
  assert.match(account, /resetTurnstile\(\);[\s\S]*setBusy\(false\)/);
  assert.match(account, /resetResendTurnstile\(\);[\s\S]*setBusy\(false\)/);
  assert.match(account, /changeMode\(mode === "signupDetails" \? "verify" : "reset"\)/);
  assert.match(account, /disabled=\{busy \|\| !turnstileCanSubmit\}/);
  assert.match(account, /disabled=\{busy \|\| resendCooldown > 0 \|\| !resendTurnstileCanSubmit\}/);
  assert.match(component, /window\.turnstile\.remove/);
  assert.match(component, /\[action, onStateChange, onTokenChange, resetKey, retryKey\]/);
});

test("server and client action names agree while privacy-right routes remain outside the gate", () => {
  for (const action of [
    "signup_eligibility",
    "signup_request",
    "signup_verify",
    "challenge_resend",
    "password_request",
    "password_reset",
    "login",
  ]) {
    assert.match(component, new RegExp(`"${action}"`));
    assert.match(worker, new RegExp(`"${action}"`));
  }
  const mapping = auth.slice(
    auth.indexOf("export function turnstileActionForAccountRequest"),
    auth.indexOf("function accountRequestErrorResponse"),
  );
  assert.doesNotMatch(mapping, /\/api\/profile|\/api\/privacy|account_delete/);
});
