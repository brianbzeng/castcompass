import assert from "node:assert/strict";
import test from "node:test";
import { verifyReleaseMaintenance } from "../scripts/verify-release-maintenance.mjs";

function maintenanceFetch({ version = "version-123", maintenance = true } = {}) {
  return async (input) => {
    const url = new URL(input);
    if (url.pathname === "/api/health") {
      return new Response(JSON.stringify({
        status: "ok",
        workerVersionId: version,
        releaseMaintenance: maintenance,
      }), { status: 200, headers: { "Cache-Control": "no-store" } });
    }
    return new Response(JSON.stringify({ error: { code: "release_maintenance" } }), {
      status: 503,
      headers: { "Cache-Control": "no-store", "Retry-After": "300" },
    });
  };
}

test("maintenance verifier binds every blocked probe to the active Worker version", async () => {
  const result = await verifyReleaseMaintenance({
    baseUrls: ["https://castingcompass.test", "https://preview.workers.dev"],
    expectedWorkerVersionId: "version-123",
    fetchImpl: maintenanceFetch(),
  });
  assert.equal(result.requests, 6);
  assert.deepEqual(result.baseUrls, ["https://castingcompass.test", "https://preview.workers.dev"]);
});

test("maintenance verifier rejects a wrong version or inactive gate", async () => {
  await assert.rejects(verifyReleaseMaintenance({
    baseUrls: ["https://castingcompass.test"],
    expectedWorkerVersionId: "version-other",
    fetchImpl: maintenanceFetch(),
  }), /expected Worker version version-other/);

  await assert.rejects(verifyReleaseMaintenance({
    baseUrls: ["https://castingcompass.test"],
    expectedWorkerVersionId: "version-123",
    fetchImpl: maintenanceFetch({ maintenance: false }),
  }), /release maintenance is not active/);
});

test("maintenance verifier rejects cacheable or unblocked APIs", async () => {
  await assert.rejects(verifyReleaseMaintenance({
    baseUrls: ["https://castingcompass.test"],
    expectedWorkerVersionId: "version-123",
    fetchImpl: async (input) => {
      const url = new URL(input);
      if (url.pathname === "/api/health") return maintenanceFetch()(input);
      return new Response("{}", { status: 200, headers: { "Cache-Control": "public" } });
    },
  }), /expected 503/);
});
