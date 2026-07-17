import assert from "node:assert/strict";
import test from "node:test";
import { realpath } from "node:fs/promises";
import { verifyReleaseCheckout } from "../scripts/verify-release-checkout.mjs";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

function fakeGitRunner({ head = HEAD, expected = HEAD, status = "" } = {}) {
  return async (root, args) => {
    if (args.join(" ") === "rev-parse --show-toplevel") return root;
    if (args.join(" ") === "rev-parse HEAD") return head;
    if (args[0] === "rev-parse" && args[1] === "--verify") return expected;
    if (args[0] === "status") return status;
    throw new Error(`Unexpected git arguments: ${args.join(" ")}`);
  };
}

test("release checkout verifier binds a clean tree to one immutable commit", async () => {
  const root = await realpath(process.cwd());
  const result = await verifyReleaseCheckout({
    root,
    expectedCommit: HEAD.slice(0, 12),
    gitRunner: fakeGitRunner(),
  });
  assert.deepEqual(result, { root, head: HEAD, expectedCommit: HEAD, clean: true, overrides: [] });
});

test("release checkout verifier rejects the wrong commit", async () => {
  await assert.rejects(
    verifyReleaseCheckout({
      root: process.cwd(),
      expectedCommit: HEAD.slice(0, 12),
      gitRunner: fakeGitRunner({ head: "f".repeat(40) }),
    }),
    /not expected commit/,
  );
});

test("release checkout verifier rejects tracked or untracked changes", async () => {
  await assert.rejects(
    verifyReleaseCheckout({
      root: process.cwd(),
      expectedCommit: HEAD,
      gitRunner: fakeGitRunner({ status: "?? release-notes.txt" }),
    }),
    /not clean/,
  );
});

test("release checkout verifier rejects ignored environment overrides", async () => {
  await assert.rejects(
    verifyReleaseCheckout({
      root: process.cwd(),
      expectedCommit: HEAD,
      gitRunner: fakeGitRunner(),
      overrideFinder: async () => [".env.production.local", ".dev.vars"],
    }),
    /local environment overrides: \.dev\.vars, \.env\.production\.local/,
  );
});
