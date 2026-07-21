import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyPrivacyExportQueuePolicy } from "../scripts/verify-privacy-export-queue-policy.mjs";

test("locked privacy export policy remains default-off and provider-free", async () => {
  const result = await verifyPrivacyExportQueuePolicy();
  assert.deepEqual(result, {
    schemaVersion: "castingcompass.privacy-export-queue-policy/1.0.0",
    messageContract: "castingcompass.privacy-export-queue/1.0.0",
    productionDefault: "false",
    providerBindingsPresent: false,
    retentionSeconds: 86400,
    maximumAttempts: 5,
    deadLetterQueueRequired: true,
  });
});

test("policy verification rejects provider activation in repository config", async () => {
  const root = await mkdtemp(join(tmpdir(), "castingcompass-export-policy-"));
  try {
    for (const path of ["security", "contracts", "worker", "drizzle"]) {
      await import("node:fs/promises").then(({ mkdir }) => mkdir(join(root, path), { recursive: true }));
    }
    const files = [
      "security/privacy-export-queue-policy.json",
      "contracts/privacy-export-queue-message.schema.json",
      "worker/privacy-export.ts",
      "worker/auth.ts",
      "worker/route-policy.ts",
      "drizzle/0019_async_privacy_exports.sql",
    ];
    for (const file of files) await writeFile(join(root, file), await readFile(new URL(`../${file}`, import.meta.url)));
    const wrangler = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
    wrangler.r2_buckets = [{ binding: "PRIVACY_EXPORTS", bucket_name: "private" }];
    await writeFile(join(root, "wrangler.jsonc"), `${JSON.stringify(wrangler, null, 2)}\n`);
    await assert.rejects(() => verifyPrivacyExportQueuePolicy({ projectRoot: root }), /separate reviewed activation/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
