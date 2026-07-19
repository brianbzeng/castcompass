import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { releaseCloudflare } from "../scripts/release-cloudflare.mjs";

const ROOT = resolve(new URL("../", import.meta.url).pathname);
const HEAD = "0123456789abcdef0123456789abcdef01234567";

async function fakeNpmCli(directory) {
  const bin = join(directory, "bin");
  await mkdir(bin, { recursive: true });
  const path = join(bin, "npm-cli.js");
  await writeFile(path, "// test-only npm CLI identity\n", { mode: 0o600 });
  await writeFile(join(directory, "package.json"), `${JSON.stringify({
    name: "npm",
    version: "10.9.8",
    bin: { npm: "bin/npm-cli.js" },
  }, null, 2)}\n`, { mode: 0o600 });
  return path;
}

async function freshReleaseRoot(directory) {
  const root = join(directory, "release");
  await mkdir(root);
  await writeFile(join(root, "package-lock.json"), `${JSON.stringify({
    name: "castingcompass-test",
    version: "0.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { devDependencies: { wrangler: "4.112.0" } },
      "node_modules/wrangler": {
        version: "4.112.0",
        integrity: "sha512-dGVzdA==",
      },
    },
  }, null, 2)}\n`, { mode: 0o600 });
  return root;
}

test("release wrapper authorizes before locked install, build, and exact normal deploy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "castingcompass-release-wrapper-"));
  try {
    const events = [];
    const receipt = await releaseCloudflare({
      mode: "normal",
      releaseRoot: ROOT,
      expectedCommit: HEAD,
      expectedGateCommit: HEAD,
      authorizationFile: "/private/authorization.json",
      npmCli: await fakeNpmCli(directory),
      environment: {
        PATH: process.env.PATH,
        NODE_OPTIONS: "--inspect",
        WRANGLER_CONFIG: "/untrusted/config.json",
        WRANGLER_LOG_LEVEL: "debug",
        NEXT_PUBLIC_API_URL: "https://untrusted.invalid",
        npm_config_registry: "https://untrusted.invalid",
        CLOUDFLARE_API_TOKEN: "test-only-not-a-real-token",
      },
      authorizationVerifier: async (options) => {
        events.push({ type: "authorization", options });
        return { authorized: true, action: options.action };
      },
      runner: (command, args, options) => {
        events.push({ type: "subprocess", command, args, options });
        return args.at(-1) === "--version" ? "10.9.8" : "";
      },
    });
    assert.deepEqual(receipt, { authorized: true, action: "deploy:normal" });
    const authorizations = events.filter(({ type }) => type === "authorization");
    assert.equal(authorizations.length, 2);
    assert.deepEqual(authorizations[0].options, {
      root: ROOT,
      policyRoot: ROOT,
      expectedCommit: HEAD,
      expectedGateCommit: HEAD,
      authorizationFile: "/private/authorization.json",
      action: "deploy:normal",
    });
    assert.deepEqual(authorizations[1], authorizations[0]);
    const subprocesses = events.filter(({ type }) => type === "subprocess");
    assert.equal(subprocesses.length, 4);
    assert.deepEqual(subprocesses[1].args.slice(-2), ["ci", "--ignore-scripts"]);
    assert.deepEqual(subprocesses[2].args.slice(-2), ["run", "build:cloudflare"]);
    assert.deepEqual(subprocesses[3].args.slice(-3), ["deploy", "--config", "wrangler.jsonc"]);
    assert.ok(events.indexOf(authorizations[1]) > events.indexOf(subprocesses[2]));
    assert.ok(events.indexOf(authorizations[1]) < events.indexOf(subprocesses[3]));
    for (const event of subprocesses) {
      assert.equal(event.command, process.execPath);
      assert.equal(event.options.cwd, ROOT);
      assert.equal("NODE_OPTIONS" in event.options.env, false);
      assert.equal("WRANGLER_CONFIG" in event.options.env, false);
      assert.equal("WRANGLER_LOG_LEVEL" in event.options.env, false);
      assert.equal("NEXT_PUBLIC_API_URL" in event.options.env, false);
      assert.equal("npm_config_registry" in event.options.env, false);
      assert.equal(event.options.env.CLOUDFLARE_API_TOKEN, "test-only-not-a-real-token");
      assert.equal(event.options.env.NPM_CONFIG_USERCONFIG, "/dev/null");
      assert.equal(event.options.env.NPM_CONFIG_GLOBALCONFIG, "/dev/null");
      assert.equal(event.options.env.WRANGLER_SEND_METRICS, "false");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release wrapper maps maintenance and safety-floor variables without shell expansion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "castingcompass-release-modes-"));
  try {
    const npmCli = await fakeNpmCli(directory);
    for (const [mode, action, variables] of [
      ["maintenance", "deploy:maintenance", [
        "PUBLIC_DISCUSSIONS_ENABLED:false",
        "TRIP_PHOTO_UPLOADS_ENABLED:false",
        "TURNSTILE_ENABLED:false",
        "RELEASE_MAINTENANCE_MODE:true",
      ]],
      ["safety-floor", "deploy:safety-floor", ["PUBLIC_DISCUSSIONS_ENABLED:false"]],
    ]) {
      const calls = [];
      await releaseCloudflare({
        mode,
        releaseRoot: ROOT,
        expectedCommit: HEAD,
        expectedGateCommit: HEAD,
        authorizationFile: "/private/authorization.json",
        npmCli,
        environment: { PATH: process.env.PATH },
        authorizationVerifier: async ({ action: received }) => {
          assert.equal(received, action);
          return { authorized: true };
        },
        runner: (command, args, options) => {
          calls.push({ command, args, options });
          return args.at(-1) === "--version" ? "10.9.8" : "";
        },
      });
      const deploy = calls.at(-1);
      assert.deepEqual(deploy.args.slice(1), [
        "deploy",
        "--config",
        "wrangler.jsonc",
        ...variables.flatMap((value) => ["--var", value]),
      ]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release wrapper refusal occurs before any install, build, or Wrangler process", async () => {
  let subprocesses = 0;
  await assert.rejects(
    releaseCloudflare({
      mode: "normal",
      releaseRoot: ROOT,
      expectedCommit: HEAD,
      expectedGateCommit: HEAD,
      authorizationFile: "/missing/authorization.json",
      npmCli: "/missing/npm-cli.js",
      authorizationVerifier: async () => { throw new Error("authorization refused"); },
      runner: () => { subprocesses += 1; },
    }),
    /authorization refused/,
  );
  assert.equal(subprocesses, 0);
  await assert.rejects(
    releaseCloudflare({
      mode: "unreviewed",
      releaseRoot: ROOT,
      expectedCommit: HEAD,
      expectedGateCommit: HEAD,
      authorizationFile: "/private/authorization.json",
    }),
    /mode must be normal, maintenance, or safety-floor/,
  );
});

test("release wrapper supports a fresh checkout with no preinstalled Wrangler", async () => {
  const directory = await mkdtemp(join(tmpdir(), "castingcompass-fresh-release-"));
  try {
    const releaseRoot = await freshReleaseRoot(directory);
    const events = [];
    await releaseCloudflare({
      mode: "normal",
      releaseRoot,
      expectedCommit: HEAD,
      expectedGateCommit: HEAD,
      authorizationFile: "/private/authorization.json",
      npmCli: await fakeNpmCli(join(directory, "npm")),
      environment: { PATH: process.env.PATH },
      authorizationVerifier: async () => ({ authorized: true }),
      runner: (_command, args) => {
        events.push(args);
        if (args.at(-1) === "--version") return "10.9.8";
        if (args.includes("ci")) {
          mkdirSync(join(releaseRoot, "node_modules/wrangler/bin"), { recursive: true });
          writeFileSync(join(releaseRoot, "node_modules/wrangler/bin/wrangler.js"), "// installed\n");
          writeFileSync(join(releaseRoot, "node_modules/wrangler/package.json"), `${JSON.stringify({
            name: "wrangler",
            version: "4.112.0",
          })}\n`);
        }
        return "";
      },
    });
    assert.equal(events.length, 4);
    assert.equal(events.some((args) => args.includes("ci")), true);
    assert.equal(events.at(-1).includes("deploy"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release wrapper accepts only private evidence output outside every checkout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "castingcompass-release-evidence-"));
  try {
    let subprocesses = 0;
    await assert.rejects(
      releaseCloudflare({
        mode: "normal",
        releaseRoot: ROOT,
        expectedCommit: HEAD,
        expectedGateCommit: HEAD,
        authorizationFile: "/private/authorization.json",
        npmCli: await fakeNpmCli(join(directory, "npm")),
        environment: {
          PATH: process.env.PATH,
          WRANGLER_OUTPUT_FILE_DIRECTORY: ROOT,
        },
        authorizationVerifier: async () => ({ authorized: true }),
        runner: () => { subprocesses += 1; },
      }),
      /outside every release checkout/,
    );
    assert.equal(subprocesses, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
