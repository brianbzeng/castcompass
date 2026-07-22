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
const request = (path, method = "GET") => new Request(`${origin}${path}`, { method });

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
});

test("route policy records actor, CSRF, legal, and abuse controls for representative boundaries", () => {
  const cases = [
    ["/api/health", "GET", "health", "public", false, false, []],
    ["/api/auth/session", "GET", "auth.session", "optional_session", false, false, ["read"]],
    ["/api/auth/login", "POST", "auth.login", "public", true, false, ["auth"]],
    ["/api/auth/signup/request", "POST", "auth.signup_request", "public", true, false, ["auth", "email"]],
    ["/api/privacy/deletion-status", "GET", "privacy.deletion_status.read", "receipt", false, false, ["read"]],
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
        assert.equal(apiRouteRejectionForRequest(request(path, method)), null, `${method} ${path}`);
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
  assert.match(source, /apiPolicy\?\.handler === "trips" && apiPolicy\.authorization === "owner"/);
  assert.doesNotMatch(source, /url\.pathname\.startsWith\("\/api\/trips\/"\)/);

  const rejection = source.indexOf("apiRouteRejectionForRequest(request)");
  assert.ok(rejection >= 0);
  assert.ok(source.indexOf("guardRequestBody(request)") > rejection, "body reads must follow central rejection");
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
