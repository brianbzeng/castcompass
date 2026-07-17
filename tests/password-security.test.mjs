import assert from "node:assert/strict";
import test from "node:test";
import { assertNewPasswordAllowed, parseNewPassword } from "../worker/auth.ts";

async function sha1(value) {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("hex").toUpperCase();
}

test("new passwords use length, not character-class composition rules", () => {
  assert.throws(
    () => parseNewPassword("fourteen-chars!".slice(0, 14)),
    (error) => error?.status === 422 && error?.code === "invalid_password",
  );
  assert.equal(parseNewPassword("fifteen-chars!!"), "fifteen-chars!!");
  assert.equal(parseNewPassword("a long password with spaces"), "a long password with spaces");
  assert.equal(parseNewPassword("🎣".repeat(15)), "🎣".repeat(15));
  assert.throws(
    () => parseNewPassword("x".repeat(129)),
    (error) => error?.status === 422 && error?.code === "invalid_password",
  );
});

test("context-specific passwords fail before any provider request", async () => {
  let providerCalls = 0;
  const fetcher = async () => {
    providerCalls += 1;
    throw new Error("provider should not be called");
  };
  await assert.rejects(
    assertNewPasswordAllowed("CastingCompass-2026!", "angler@example.com", fetcher),
    (error) => error?.status === 422 && error?.code === "context_specific_password",
  );
  await assert.rejects(
    assertNewPasswordAllowed("angler-123456", "angler@example.com", fetcher),
    (error) => error?.status === 422 && error?.code === "context_specific_password",
  );
  assert.equal(providerCalls, 0);
});

test("breached-password lookup sends only a padded five-character hash prefix", async () => {
  const password = "unique test password for a breach match";
  const email = "private.angler@example.com";
  const fullHash = await sha1(password);
  const calls = [];
  const fetcher = async (input, init) => {
    calls.push({ input: String(input), init });
    return new Response(`${fullHash.slice(5)}:42\r\n${"F".repeat(35)}:0\r\n`);
  };

  await assert.rejects(
    assertNewPasswordAllowed(password, email, fetcher),
    (error) => error?.status === 422 && error?.code === "compromised_password",
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, `https://api.pwnedpasswords.com/range/${fullHash.slice(0, 5)}`);
  assert.equal(new Headers(calls[0].init.headers).get("Add-Padding"), "true");
  assert.equal(new Headers(calls[0].init.headers).get("User-Agent"), "CastingCompass password safety/1.0");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.body, undefined);
  const serializedCall = JSON.stringify(calls[0]);
  assert.doesNotMatch(serializedCall, /private\.angler|example\.com|unique test password/i);
  assert.ok(!serializedCall.includes(fullHash));
});

test("padding entries are ignored and safe whole-password results pass", async () => {
  const password = "another unique test passphrase";
  const fullHash = await sha1(password);
  await assert.doesNotReject(assertNewPasswordAllowed(
    password,
    "safe@example.com",
    async () => new Response(`${fullHash.slice(5)}:0\n${"A".repeat(35)}:3\n`),
  ));
});

test("provider errors and malformed or oversized ranges fail closed", async () => {
  const password = "provider failure test passphrase";
  const email = "safe@example.com";
  const unavailable = (promise) => assert.rejects(
    promise,
    (error) => error?.status === 503 && error?.code === "password_screening_unavailable",
  );

  await unavailable(assertNewPasswordAllowed(password, email, async () => new Response("unavailable", { status: 503 })));
  await unavailable(assertNewPasswordAllowed(password, email, async () => new Response("not-a-range")));
  await unavailable(assertNewPasswordAllowed(
    password,
    email,
    async () => new Response(`${"A".repeat(35)}:0\n`.repeat(2_000)),
  ));
  await unavailable(assertNewPasswordAllowed(password, email, async () => { throw new Error("network secret"); }));
});
