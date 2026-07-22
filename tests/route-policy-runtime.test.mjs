import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  API_ROUTE_POLICIES,
  allowedApiMethodsForPath,
  apiRoutePolicyForRequest,
  apiRouteRejectionForRequest,
  isKnownApiPath,
  rateLimitClassesForRequest,
} from "../worker/route-policy.ts";

const origin = "https://castingcompass.com";
const request = (path, method = "GET", headers) => new Request(`${origin}${path}`, { method, headers });

test("every declared API route example resolves to its exact executable policy", () => {
  assert.equal(new Set(API_ROUTE_POLICIES.map((policy) => policy.id)).size, API_ROUTE_POLICIES.length);

  for (const policy of API_ROUTE_POLICIES) {
    assert.match(policy.id, /^[a-z][a-z0-9_.]+$/);
    assert.match(policy.pathTemplate, /^\/api\//);
    assert.equal(policy.matches(policy.examplePath), true, policy.id);
    const method = policy.methods[0] === "*" ? "OPTIONS" : policy.methods[0];
    assert.equal(apiRoutePolicyForRequest(request(policy.examplePath, method))?.id, policy.id, policy.id);
    const mutates = policy.methods.some((method) => ["POST", "PUT", "PATCH", "DELETE"].includes(method));
    if (mutates && policy.id !== "auth.signup_retired") {
      assert.equal(policy.sameOriginRequired, true, policy.id);
    }
    if (policy.currentLegalAcceptanceRequired) {
      assert.equal(policy.authorization, "owner", policy.id);
    }
    if (policy.deletionFenceAccessAllowed) {
      assert.equal(policy.authorization, "owner", policy.id);
    }
    if (policy.authorization === "owner" && !policy.currentLegalAcceptanceRequired) {
      assert.equal(
        [
          "auth.eligibility",
          "profile.export_photo",
          "profile.export_status",
          "profile.export_download",
          "profile.export",
          "profile.export_request",
          "profile.delete",
        ].includes(policy.id),
        true,
        policy.id,
      );
    }
  }

  assert.deepEqual(
    API_ROUTE_POLICIES.filter((policy) => policy.deletionFenceAccessAllowed).map((policy) => policy.id),
    [
      "profile.export_photo",
      "profile.export_status",
      "profile.export_download",
      "profile.export",
      "profile.read",
      "profile.delete",
    ],
  );
  assert.deepEqual(
    API_ROUTE_POLICIES.filter((policy) => policy.authorization === "receipt").map((policy) => policy.id),
    ["privacy.deletion_status.read"],
  );
  assert.deepEqual(
    API_ROUTE_POLICIES.filter((policy) => policy.authorization === "optional_session").map((policy) => policy.id),
    ["auth.session", "auth.logout"],
  );
});

test("route policy records actor, CSRF, legal, and abuse controls for representative boundaries", () => {
  const cases = [
    ["/api/health", "GET", "health", "public", false, false, []],
    ["/api/auth/session", "GET", "auth.session", "optional_session", false, false, ["read"]],
    ["/api/auth/login", "POST", "auth.login", "public", true, false, ["auth"]],
    ["/api/auth/signup/request", "POST", "auth.signup_request", "public", true, false, ["auth", "email"]],
    ["/api/privacy/deletion-status", "GET", "privacy.deletion_status.read", "receipt", false, false, ["read"]],
    ["/api/privacy/deletion-status", "DELETE", "privacy.deletion_status.clear", "public", true, false, ["write"]],
    ["/api/profile/export", "GET", "profile.export", "owner", false, false, ["read", "sensitive"]],
    ["/api/profile/export", "POST", "profile.export_request", "owner", true, false, ["sensitive", "write"]],
    [
      "/api/profile/exports/pexj_00000000000000000000000000000000",
      "GET",
      "profile.export_status",
      "owner",
      false,
      false,
      ["read"],
    ],
    [
      "/api/profile/exports/pexj_00000000000000000000000000000000/download",
      "GET",
      "profile.export_download",
      "owner",
      false,
      false,
      ["read", "sensitive"],
    ],
    ["/api/profile", "DELETE", "profile.delete", "owner", true, false, ["sensitive", "write"]],
    ["/api/gear-profiles", "POST", "gear_profiles.create", "owner", true, true, ["write"]],
    [
      "/api/profile/trips/trip_00000000-0000-4000-8000-000000000000",
      "DELETE",
      "profile.trip_delete",
      "owner",
      true,
      true,
      ["sensitive", "write"],
    ],
    ["/api/trips/start", "POST", "trips.start", "owner", true, true, ["write"]],
    ["/api/discussions/ocean-beach", "GET", "discussions.site", "public", false, false, ["read"]],
  ];

  for (const [path, method, id, authorization, sameOrigin, legal, rateLimits] of cases) {
    const policy = apiRoutePolicyForRequest(request(path, method));
    assert.equal(policy?.id, id, `${method} ${path}`);
    assert.equal(policy?.authorization, authorization, id);
    assert.equal(policy?.sameOriginRequired, sameOrigin, id);
    assert.equal(policy?.currentLegalAcceptanceRequired, legal, id);
    assert.deepEqual(rateLimitClassesForRequest(request(path, method)), rateLimits, id);
  }
});

test("unclassified and malformed API paths fail route discovery closed", () => {
  for (const path of [
    "/api/admin",
    "/api/authentication/login",
    "/api/profile/export/photos/not-a-trip",
    "/api/profile/exports/not-a-job",
    "/api/profile/exports/pexj_0000000000000000000000000000000g",
    "/api/profile/exports/pexj_00000000000000000000000000000000/extra",
    "/api/profile/exports/pexj_00000000000000000000000000000000/download/extra",
    "/api/profile/trips/trip_00000000-0000-4000-8000-000000000000/extra",
    "/api/trips/start/extra",
    "/api//health",
  ]) {
    assert.equal(isKnownApiPath(path), false, path);
    assert.equal(apiRoutePolicyForRequest(request(path)), null, path);
  }

  assert.equal(isKnownApiPath("/api/trips/start"), true);
  assert.equal(apiRoutePolicyForRequest(request("/api/trips/start", "GET")), null);
  assert.deepEqual(allowedApiMethodsForPath("/api/trips/start"), ["POST"]);
  assert.deepEqual(allowedApiMethodsForPath("/api/profile/export"), ["GET", "POST"]);
  assert.deepEqual(allowedApiMethodsForPath("/api/auth/signup"), ["*"]);
  assert.deepEqual(allowedApiMethodsForPath("/api/unclassified"), []);
  assert.deepEqual(rateLimitClassesForRequest(request("/api/unclassified", "POST")), ["write"]);
});

test("every unclassified method on a known API path has an exact central Allow contract", () => {
  const candidateMethods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "PROPFIND"];
  const examples = new Set(API_ROUTE_POLICIES.map((policy) => policy.examplePath));

  for (const path of examples) {
    const declared = allowedApiMethodsForPath(path);
    assert.ok(declared.length > 0, path);
    for (const method of candidateMethods) {
      const policy = apiRoutePolicyForRequest(request(path, method));
      if (declared.includes("*") || declared.includes(method)) {
        assert.ok(policy, `${method} ${path} should resolve`);
        const admitted = request(path, method, policy.sameOriginRequired ? { Origin: origin } : undefined);
        assert.equal(apiRouteRejectionForRequest(admitted), null, `${method} ${path}`);
      } else {
        assert.equal(policy, null, `${method} ${path} must remain unclassified`);
        assert.deepEqual(apiRouteRejectionForRequest(request(path, method)), {
          status: 405,
          code: "method_not_allowed",
          message: "That method is not available for this API route.",
          allowedMethods: declared,
        }, `${method} ${path}`);
      }
    }
  }

  assert.deepEqual(apiRouteRejectionForRequest(request("/api/unclassified", "POST")), {
    status: 404,
    code: "not_found",
    message: "API route not found.",
    allowedMethods: [],
  });
  assert.equal(apiRouteRejectionForRequest(request("/privacy", "POST")), null);
});

test("every same-origin policy rejects missing, opaque, malformed, noncanonical, and cross-site origins", () => {
  const rejection = {
    status: 403,
    code: "invalid_origin",
    message: "State-changing requests must come from CastingCompass.",
    allowedMethods: [],
  };
  let protectedPolicies = 0;

  for (const policy of API_ROUTE_POLICIES) {
    const method = policy.methods[0] === "*" ? "OPTIONS" : policy.methods[0];
    if (!policy.sameOriginRequired) {
      assert.equal(apiRouteRejectionForRequest(request(policy.examplePath, method)), null, policy.id);
      continue;
    }
    protectedPolicies += 1;
    for (const suppliedOrigin of [
      undefined,
      "null",
      "://invalid",
      `${origin}/path`,
      "https://attacker.example",
      "http://castingcompass.com",
      "https://castingcompass.com.evil.example",
    ]) {
      const headers = suppliedOrigin === undefined ? undefined : { Origin: suppliedOrigin };
      assert.deepEqual(
        apiRouteRejectionForRequest(request(policy.examplePath, method, headers)),
        rejection,
        `${policy.id}: ${suppliedOrigin ?? "missing"}`,
      );
    }
    assert.equal(
      apiRouteRejectionForRequest(request(policy.examplePath, method, { Origin: origin })),
      null,
      policy.id,
    );
  }

  assert.ok(protectedPolicies > 0);
  assert.deepEqual(apiRouteRejectionForRequest(request("/api/unclassified", "POST", {
    Origin: "https://attacker.example",
  })), {
    status: 404,
    code: "not_found",
    message: "API route not found.",
    allowedMethods: [],
  });
});

test("overlapping policies fail closed instead of granting first-match precedence", () => {
  const tripStart = API_ROUTE_POLICIES.find((policy) => policy.id === "trips.start");
  assert.ok(tripStart);
  const conflicting = {
    ...tripStart,
    id: "synthetic.conflicting_trip_start",
    authorization: "public",
    handler: "account",
    sameOriginRequired: false,
    currentLegalAcceptanceRequired: false,
    rateLimitTags: ["sensitive"],
  };
  const registry = [...API_ROUTE_POLICIES, conflicting];
  const post = request("/api/trips/start", "POST");

  assert.equal(apiRoutePolicyForRequest(post, registry), null);
  assert.deepEqual(apiRouteRejectionForRequest(post, registry), {
    status: 503,
    code: "route_unavailable",
    message: "This API route is temporarily unavailable.",
    allowedMethods: [],
  });
  assert.deepEqual(allowedApiMethodsForPath("/api/trips/start", registry), ["POST"]);
  assert.deepEqual(rateLimitClassesForRequest(post, registry), ["sensitive", "write"]);

  const retiredSignup = API_ROUTE_POLICIES.find((policy) => policy.id === "auth.signup_retired");
  assert.ok(retiredSignup);
  const conflictingSignup = {
    ...retiredSignup,
    id: "synthetic.conflicting_signup",
    methods: ["POST"],
    authorization: "owner",
    sameOriginRequired: true,
    rateLimitTags: ["auth"],
  };
  const signupRegistry = [retiredSignup, conflictingSignup];

  assert.deepEqual(apiRouteRejectionForRequest(request("/api/auth/signup", "POST"), signupRegistry), {
    status: 503,
    code: "route_unavailable",
    message: "This API route is temporarily unavailable.",
    allowedMethods: [],
  });
  assert.equal(
    apiRoutePolicyForRequest(request("/api/auth/signup", "OPTIONS"), signupRegistry)?.id,
    "auth.signup_retired",
  );
  assert.deepEqual(rateLimitClassesForRequest(request("/api/auth/signup", "POST"), signupRegistry), ["auth"]);
});

test("every literal route branch in Worker handlers is represented in the policy registry", async () => {
  const files = ["auth.ts", "trips.ts", "turnstile.ts", "security.ts"];
  for (const file of files) {
    const source = await readFile(new URL(`../worker/${file}`, import.meta.url), "utf8");
    const paths = [...source.matchAll(/url\.pathname\s*[!=]==?\s*"(\/api\/[^"]+)"/g)].map((match) => match[1]);
    for (const path of paths) assert.equal(isKnownApiPath(path), true, `${file}: ${path}`);
  }
});

test("the Worker entry point centrally denies unknown paths and unclassified methods", async () => {
  const source = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  assert.match(source, /apiRouteRejectionForRequest\(request\)/);
  assert.match(source, /if \(apiRejection\)/);
  assert.match(source, /status: apiRejection\.status/);
  assert.match(source, /Allow: apiRejection\.allowedMethods\.join\(", "\)/);
  assert.doesNotMatch(source, /!apiPolicy && !isKnownApiPath/);
  assert.match(source, /const protectedTripMutation = apiPolicy\.authorization === "owner"/);
  assert.match(source, /if \(apiPolicy\?\.authorization === "owner"\)/);
  assert.match(source, /authorizeOwnerRequest\(request, env/);
  assert.match(source, /if \(apiPolicy\?\.authorization === "receipt"\)/);
  assert.match(source, /apiPolicy\.id !== "privacy\.deletion_status\.read"/);
  assert.match(source, /authorizeDeletionReceiptRequest\(request, env\)/);
  assert.doesNotMatch(source, /url\.pathname\.startsWith\("\/api\/trips\/"\)/);

  const rejection = source.indexOf("apiRouteRejectionForRequest(request)");
  const ownerAuthorization = source.indexOf("authorizeOwnerRequest(request, env");
  const receiptAuthorization = source.indexOf("authorizeDeletionReceiptRequest(request, env");
  const bodyGuard = source.indexOf("guardRequestBody(request)");
  assert.ok(rejection >= 0);
  assert.ok(ownerAuthorization > rejection, "owner authorization must follow central route rejection");
  assert.ok(receiptAuthorization > rejection, "receipt authorization must follow central route rejection");
  assert.ok(bodyGuard > ownerAuthorization, "body reads must follow owner authorization");
  assert.ok(bodyGuard > receiptAuthorization, "body reads must follow receipt authorization");
  for (const dispatch of [
    "handleTurnstileConfigRequest(request, env)",
    "healthResponse(request, env)",
    "handleDiscussionRequest(request, env, sites)",
    "handleAccountRequest(request, env, sites",
    "handleTripRequest(request, env, sites",
  ]) {
    assert.ok(source.indexOf(dispatch) > rejection, `${dispatch} must follow the central rejection`);
  }
});

test("the route registry exclusively selects API handlers and handler drift fails closed", async () => {
  const source = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  const routeStart = source.indexOf("async function routeRequest(");
  const apiBoundary = source.indexOf('if (url.pathname.startsWith("/api/"))', routeStart);
  const dispatchStart = source.indexOf("switch (apiPolicy.handler)", apiBoundary);
  const driftFallback = source.indexOf("return apiResponse ?? routePolicyUnavailableResponse();", dispatchStart);
  const imageBoundary = source.indexOf('if (url.pathname === "/_vinext/image")', dispatchStart);
  const staticFallback = source.indexOf("handler.fetch(request, env, ctx)", imageBoundary);

  assert.ok(routeStart >= 0);
  assert.ok(apiBoundary > routeStart);
  assert.ok(dispatchStart > apiBoundary);
  assert.ok(driftFallback > dispatchStart);
  assert.ok(imageBoundary > driftFallback, "API dispatch must return before image handling");
  assert.ok(staticFallback > imageBoundary, "API dispatch must return before the static application");
  assert.match(source.slice(apiBoundary, dispatchStart), /if \(!apiPolicy\) return routePolicyUnavailableResponse\(\)/);
  assert.match(source.slice(dispatchStart, driftFallback), /default:\s+return routePolicyUnavailableResponse\(\)/);
  assert.match(source, /status: 503/);
  assert.match(source, /code: "route_unavailable"/);
  assert.match(source, /"Cache-Control": "no-store"/);

  const handlers = [
    ["turnstile", "handleTurnstileConfigRequest(request, env)"],
    ["health", "healthResponse(request, env)"],
    ["discussions", "handleDiscussionRequest(request, env, sites)"],
    ["account", "handleAccountRequest(request, env, sites"],
    ["trips", "handleTripRequest(request, env, sites"],
  ];
  const dispatchSource = source.slice(dispatchStart, driftFallback);
  for (const [index, [handler, call]] of handlers.entries()) {
    const handlerCase = dispatchSource.indexOf(`case "${handler}":`);
    const handlerCall = dispatchSource.indexOf(call);
    const nextHandler = handlers[index + 1]?.[0];
    const nextCase = nextHandler
      ? dispatchSource.indexOf(`case "${nextHandler}":`)
      : dispatchSource.indexOf("default:");
    assert.ok(handlerCase >= 0, `${handler} must have a registry dispatch case`);
    assert.ok(handlerCall > handlerCase, `${handler} can only run from its registry dispatch case`);
    assert.ok(handlerCall < nextCase, `${handler} cannot borrow a later handler's dispatch call`);
    assert.equal(dispatchSource.indexOf(call, handlerCall + call.length), -1, `${handler} must have one dispatch call`);
  }
});

test("the production bundle dispatches representative API policies without static fallthrough", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("route-policy-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  let assetFetches = 0;
  const baseEnv = {
    ASSETS: {
      fetch: async () => {
        assetFetches += 1;
        return new Response("static-fallback", { status: 418 });
      },
    },
  };
  const ctx = { waitUntil() {}, passThroughOnException() {} };

  const turnstile = await worker.fetch(request("/api/auth/turnstile-config"), baseEnv, ctx);
  assert.equal(turnstile.status, 200);
  assert.deepEqual(await turnstile.json(), { turnstile: { enabled: false } });

  const health = await worker.fetch(request("/api/health"), {
    ...baseEnv,
    DB: {
      prepare(statement) {
        assert.equal(statement, "SELECT 1 AS ok");
        return { first: async () => ({ ok: 1 }) };
      },
    },
  }, ctx);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, "ok");

  const discussions = await worker.fetch(request("/api/discussions/limantour-beach"), baseEnv, ctx);
  assert.equal(discussions.status, 200);
  assert.deepEqual(await discussions.json(), { posts: [] });

  for (const [path, expectedCode] of [
    ["/api/auth/session", "storage_unavailable"],
    ["/api/privacy/deletion-status", "storage_unavailable"],
    ["/api/trips/summary", "storage_unavailable"],
  ]) {
    const response = await worker.fetch(request(path), baseEnv, ctx);
    assert.equal(response.status, 503, path);
    assert.equal((await response.json()).error.code, expectedCode, path);
  }

  const clearReceipt = await worker.fetch(request("/api/privacy/deletion-status", "DELETE", {
    Origin: origin,
  }), baseEnv, ctx);
  assert.equal(clearReceipt.status, 200);
  assert.deepEqual(await clearReceipt.json(), { cleared: true });
  assert.match(clearReceipt.headers.get("set-cookie") ?? "", /cc_deletion_receipt=;.*Max-Age=0/u);

  const protectedBody = request("/api/trips/start", "POST", {
    Origin: origin,
    "Content-Type": "application/json",
  });
  const protectedRequest = new Request(protectedBody, { body: JSON.stringify({ siteId: "ocean-beach" }) });
  const protectedResponse = await worker.fetch(protectedRequest, baseEnv, ctx);
  assert.equal(protectedResponse.status, 503);
  assert.equal((await protectedResponse.json()).error.code, "storage_unavailable");
  assert.equal(protectedRequest.bodyUsed, false, "owner storage/auth rejection must precede body parsing");

  const unknown = await worker.fetch(request("/api/not-registered"), baseEnv, ctx);
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, "not_found");
  assert.equal(assetFetches, 0, "no API response may fall through to static assets");
});
