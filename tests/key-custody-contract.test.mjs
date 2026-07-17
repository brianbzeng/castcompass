import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { scanText } from "../scripts/check-secrets.mjs";

const RUNTIME_SECRET_NAMES = [
  "MIMO_API_KEY",
  "OBSERVABILITY_PSEUDONYM_SECRET",
  "RATE_LIMIT_KEY_SECRET",
  "RESEND_API_KEY",
  "TURNSTILE_SECRET_KEY",
  "VALIDATION_PARTICIPANT_HMAC_SECRET",
  "VALIDATION_RECRUITMENT_HMAC_SECRET",
];

test("every Worker runtime secret is inventoried, scanned, and absent from Wrangler vars", () => {
  const worker = [
    "worker/auth.ts",
    "worker/observability.ts",
    "worker/rate-limit.ts",
    "worker/trip-review.ts",
    "worker/turnstile.ts",
    "worker/validation-feasibility.ts",
  ].map((path) => readFileSync(path, "utf8")).join("\n");
  const configText = readFileSync("wrangler.jsonc", "utf8");
  const config = JSON.parse(configText);
  const policy = readFileSync("docs/KEY-CUSTODY-AND-ENCRYPTION.md", "utf8");

  for (const name of RUNTIME_SECRET_NAMES) {
    assert.match(worker, new RegExp(`\\b${name}\\??:\\s*string\\b`), `${name} must remain typed in Worker code`);
    assert.deepEqual(
      scanText(`${name}=${"Z".repeat(32)}`),
      [{ name: "named secret assignment", line: 1 }],
      `${name} must be covered by the repository scanner`,
    );
    assert.equal(config.vars?.[name], undefined, `${name} must not be a Wrangler var`);
    assert.doesNotMatch(configText, new RegExp(`"${name}"\\s*:`), `${name} must not be checked into Wrangler config`);
    assert.ok(policy.includes("| `" + name + "` |"), `${name} must be inventoried`);
  }
});

test("local secret files are ignored and committed examples contain no runtime values", () => {
  const ignore = readFileSync(".gitignore", "utf8");
  const example = readFileSync(".env.example", "utf8");

  assert.match(ignore, /^\.env\*$/m);
  assert.match(ignore, /^\.dev\.vars\*$/m);

  for (const name of RUNTIME_SECRET_NAMES) {
    const assignment = example.match(new RegExp(`^${name}=(.*)$`, "m"));
    if (assignment) assert.equal(assignment[1], "", `${name} example must be blank`);
  }
  for (const expectedPlaceholder of ["MIMO_API_KEY", "RESEND_API_KEY", "TURNSTILE_SECRET_KEY"]) {
    assert.match(example, new RegExp(`^${expectedPlaceholder}=$`, "m"));
  }
});

test("encryption policy preserves managed-service and local-backup boundaries", () => {
  const policy = readFileSync("docs/KEY-CUSTODY-AND-ENCRYPTION.md", "utf8");
  const storagePolicy = readFileSync("docs/VALIDATION-STORAGE.md", "utf8");
  const storageTool = readFileSync("scripts/validation-storage.mjs", "utf8");

  assert.match(policy, /repository contract and local controls are reviewed; production account\s+evidence remains open/i);
  assert.match(policy, /Cloudflare-managed\s+keys/i);
  assert.match(policy, /does \*\*not\*\* implement field-level or end-to-end encryption/i);
  assert.match(policy, /ordinary `wrangler secret put` creates and immediately deploys a new\s+Worker version/i);
  assert.match(policy, /Never reuse material across providers, environments, or purposes/i);
  assert.match(policy, /Never rotate during an activation/i);
  assert.match(policy, /Never rotate during an active campaign/i);
  assert.match(policy, /Photo upload storage remains disabled/i);

  for (const keyPath of [
    "castingcompass-d1.key",
    "castingcompass-ledger.key",
    "validation-snapshot.key",
    "validation-suppression.key",
  ]) {
    assert.match(storagePolicy, new RegExp(keyPath.replace(".", "\\.")), `${keyPath} must remain distinct`);
  }
  assert.match(storageTool, /const KEY_BYTES = 32;/);
  assert.match(storageTool, /const NONCE_BYTES = 12;/);
  assert.match(storageTool, /createCipheriv\("aes-256-gcm"/);
  assert.match(storageTool, /assertPrivateFile\(path, "Encryption key"/);
});
