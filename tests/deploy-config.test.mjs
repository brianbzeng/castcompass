import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const config = JSON.parse(await readFile("dist/server/wrangler.json", "utf8"));

test("generated Cloudflare configuration has unique compatibility flags", () => {
  const flags = config.compatibility_flags ?? [];
  assert.deepEqual(flags, [...new Set(flags)]);
  assert.equal(flags.filter((flag) => flag === "nodejs_compat").length, 1);
});

test("generated Cloudflare configuration has one production D1 binding", () => {
  const databases = config.d1_databases ?? [];
  assert.equal(databases.length, 1);
  assert.equal(databases[0].binding, "DB");
  assert.equal(databases[0].database_name, "contourcast-trips");
});

test("generated Cloudflare configuration keeps discussions off and exposes version metadata", () => {
  assert.equal(config.vars?.PUBLIC_DISCUSSIONS_ENABLED, "false");
  assert.equal(config.vars?.TRIP_PHOTO_UPLOADS_ENABLED, "false");
  assert.equal(config.vars?.TURNSTILE_ENABLED, "false");
  assert.equal(config.vars?.AI_REVIEW_QUEUE_ENABLED, "false");
  assert.equal(config.vars?.PRIVACY_EXPORT_QUEUE_ENABLED, "false");
  assert.equal(config.vars?.TURNSTILE_SITE_KEY, undefined);
  assert.equal(config.vars?.TURNSTILE_SECRET_KEY, undefined);
  assert.equal(config.version_metadata?.binding, "CF_VERSION_METADATA");
  assert.deepEqual(config.queues, { producers: [], consumers: [] });
});

test("production build omits disabled photo controls and preserves static header rules", async () => {
  const assetNames = await readdir("dist/client/assets", { recursive: true });
  const javascript = await Promise.all(
    assetNames
      .filter((name) => name.endsWith(".js"))
      .map((name) => readFile(`dist/client/assets/${name}`, "utf8")),
  );
  assert.doesNotMatch(javascript.join("\n"), /Verification photo|image\/jpeg,image\/png,image\/webp/);
  assert.doesNotMatch(javascript.join("\n"), /TURNSTILE_SECRET_KEY|TURNSTILE_ALLOWED_HOSTNAMES/);
  assert.equal(
    await readFile("dist/client/_headers", "utf8"),
    await readFile("public/_headers", "utf8"),
  );
});
