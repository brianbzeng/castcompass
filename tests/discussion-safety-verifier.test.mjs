import assert from "node:assert/strict";
import test from "node:test";
import {
  verifyLiveSafety,
  verifyRuntimeDiscussionWriterSource,
  verifySourceSafety,
} from "../scripts/verify-discussion-safety.mjs";

test("discussion safety source preflight covers the release invariants", async () => {
  const checks = await verifySourceSafety();
  assert.ok(checks.length >= 12);
  assert.ok(checks.includes("public discussions default off"));
  assert.ok(checks.includes("AI review must not reference the public table or writer"));
  assert.ok(checks.includes("runtime Worker has no public discussion writer"));
  assert.ok(checks.includes("safe rollback floor is documented"));
  assert.ok(checks.includes("patched safety-floor commit is pinned"));
  assert.ok(checks.includes("full release provenance precedes D1 work"));
  assert.ok(checks.includes("integrated mutations require private authorization"));
  assert.ok(checks.includes("release uses the guarded wrapper"));
  assert.ok(checks.includes("release rebuilds before deployment"));
  assert.ok(checks.includes("migration uses the guarded staged wrapper"));
  assert.ok(checks.includes("maintenance suppresses scheduled work"));
});

test("source preflight rejects a public discussion writer in any runtime Worker module", () => {
  assert.equal(
    verifyRuntimeDiscussionWriterSource("DELETE FROM site_discussion_posts WHERE trip_id = ?"),
    "runtime Worker has no public discussion writer",
  );
  assert.equal(
    verifyRuntimeDiscussionWriterSource("INSERT INTO site_discussion_posts_archive (id) VALUES (?)"),
    "runtime Worker has no public discussion writer",
  );
  for (const source of [
    "INSERT INTO site_discussion_posts (id) VALUES (?)",
    "insert or replace into `site_discussion_posts` (id) values (?)",
    "INSERT OR IGNORE INTO [site_discussion_posts] (id) VALUES (?)",
    "REPLACE\nINTO site_discussion_posts (id) VALUES (?)",
    "UPDATE OR FAIL site_discussion_posts SET summary = ?",
    'UPDATE main."site_discussion_posts" SET summary = ?',
  ]) {
    assert.throws(
      () => verifyRuntimeDiscussionWriterSource(source),
      /runtime Worker has no public discussion writer/,
      source,
    );
  }
});

test("live verifier checks every site plus mutation and invalid-site behavior", async () => {
  const requests = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    requests.push({ url: url.toString(), method });
    if (method !== "GET") {
      return new Response(JSON.stringify({ error: { code: "method_not_allowed" } }), {
        status: 405,
        headers: { "Content-Type": "application/json", Allow: "GET", "Cache-Control": "no-store" },
      });
    }
    if (url.pathname.endsWith("/not-a-curated-site")) {
      return new Response(JSON.stringify({ error: { code: "invalid_site" } }), {
        status: 404,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }
    return new Response(JSON.stringify({ posts: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  };

  const result = await verifyLiveSafety({
    baseUrls: ["https://castingcompass.test"],
    siteIds: ["site-a", "site-b"],
    fetchImpl,
  });
  assert.equal(result.requests, 4);
  assert.equal(requests.length, 4);
  assert.equal(requests.filter(({ method }) => method === "POST").length, 1);
});

test("live verifier checks redirect hosts without following and requires the exact canonical Location", async () => {
  const requests = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    requests.push({ url: url.toString(), redirect: init.redirect });
    if (url.hostname === "www.castingcompass.test") {
      const canonical = new URL(url);
      canonical.hostname = "castingcompass.test";
      return new Response(null, { status: 308, headers: { Location: canonical.toString() } });
    }
    if ((init.method ?? "GET") !== "GET") {
      return new Response(null, { status: 405, headers: { Allow: "GET" } });
    }
    if (url.pathname.endsWith("/not-a-curated-site")) return new Response(null, { status: 404 });
    return new Response(JSON.stringify({ posts: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  };

  const result = await verifyLiveSafety({
    baseUrls: ["https://castingcompass.test"],
    redirectBaseUrls: ["https://www.castingcompass.test"],
    canonicalBaseUrl: "https://castingcompass.test",
    siteIds: ["site-a"],
    fetchImpl,
  });
  assert.equal(result.requests, 4);
  assert.equal(requests.at(-1).redirect, "manual");
  assert.equal(requests.at(-1).url, "https://www.castingcompass.test/api/discussions/site-a?release-check=canonical-redirect");
});

test("live verifier binds direct-host behavior to the recorded Worker version", async () => {
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname === "/api/health") {
      return new Response(JSON.stringify({
        status: "ok",
        service: "castingcompass-web",
        workerVersionId: "version-123",
        releaseMaintenance: false,
      }), { status: 200, headers: { "Cache-Control": "no-store" } });
    }
    if ((init.method ?? "GET") !== "GET") {
      return new Response(null, { status: 405, headers: { Allow: "GET" } });
    }
    if (url.pathname.endsWith("/not-a-curated-site")) return new Response(null, { status: 404 });
    return new Response(JSON.stringify({ posts: [] }), {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  };

  const result = await verifyLiveSafety({
    baseUrls: ["https://castingcompass.test"],
    expectedWorkerVersionId: "version-123",
    siteIds: ["site-a"],
    fetchImpl,
  });
  assert.equal(result.requests, 4);
  assert.equal(result.expectedWorkerVersionId, "version-123");

  await assert.rejects(
    verifyLiveSafety({
      baseUrls: ["https://castingcompass.test"],
      expectedWorkerVersionId: "version-other",
      siteIds: ["site-a"],
      fetchImpl,
    }),
    /expected Worker version version-other, received version-123/,
  );

  await assert.rejects(
    verifyLiveSafety({
      baseUrls: ["https://castingcompass.test"],
      expectedWorkerVersionId: "version-123",
      siteIds: ["site-a"],
      fetchImpl: async (input, init = {}) => {
        const url = new URL(input);
        if (url.pathname === "/api/health") {
          return new Response(JSON.stringify({
            status: "ok",
            workerVersionId: "version-123",
            releaseMaintenance: true,
          }), { status: 200, headers: { "Cache-Control": "no-store" } });
        }
        return fetchImpl(input, init);
      },
    }),
    /expected release maintenance to be off/,
  );
});

test("live verifier rejects a redirect from a host declared direct", async () => {
  const redirects = [];
  await assert.rejects(
    verifyLiveSafety({
      baseUrls: ["https://preview.workers.dev"],
      siteIds: ["site-a"],
      fetchImpl: async (input, init = {}) => {
        redirects.push(init.redirect);
        return new Response(null, {
          status: 308,
          headers: { Location: new URL(input, "https://castingcompass.test").toString() },
        });
      },
    }),
    /expected 200, received 308/,
  );
  assert.deepEqual(redirects, ["manual"]);
});

test("live verifier rejects a non-permanent or inexact canonical redirect", async () => {
  const common = {
    baseUrls: ["https://castingcompass.test"],
    redirectBaseUrls: ["https://www.castingcompass.test"],
    canonicalBaseUrl: "https://castingcompass.test",
    siteIds: ["site-a"],
  };
  const directResponse = (input, init = {}) => {
    const url = new URL(input);
    if (url.hostname === "www.castingcompass.test") return null;
    if ((init.method ?? "GET") !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
    if (url.pathname.endsWith("/not-a-curated-site")) return new Response(null, { status: 404 });
    return new Response(JSON.stringify({ posts: [] }), { status: 200, headers: { "Cache-Control": "no-store" } });
  };

  await assert.rejects(
    verifyLiveSafety({
      ...common,
      fetchImpl: async (input, init) => directResponse(input, init) ?? new Response(null, {
        status: 302,
        headers: { Location: "https://castingcompass.test/" },
      }),
    }),
    /expected an un-followed 308 redirect/,
  );

  await assert.rejects(
    verifyLiveSafety({
      ...common,
      fetchImpl: async (input, init) => directResponse(input, init) ?? new Response(null, {
        status: 308,
        headers: { Location: "https://castingcompass.test/" },
      }),
    }),
    /expected Location https:\/\/castingcompass\.test\/api\/discussions\/site-a\?release-check=canonical-redirect/,
  );
});

test("live verifier fails closed on a visible post or cacheable response", async () => {
  await assert.rejects(
    verifyLiveSafety({
      baseUrls: ["https://castingcompass.test"],
      siteIds: ["site-a"],
      fetchImpl: async () => new Response(JSON.stringify({ posts: [{ id: "unexpected" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      }),
    }),
    /expected zero public posts/,
  );

  await assert.rejects(
    verifyLiveSafety({
      baseUrls: ["https://castingcompass.test"],
      siteIds: ["site-a"],
      fetchImpl: async () => new Response(JSON.stringify({ posts: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" },
      }),
    }),
    /expected Cache-Control no-store/,
  );
});
