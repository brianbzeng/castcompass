#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyProductionChangeAuthorization } from "./verify-production-change-authorization.mjs";

const POLICY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_NPM_VERSION = "10.9.8";
const EXPECTED_WRANGLER_VERSION = "4.112.0";
const MODES = Object.freeze({
  normal: Object.freeze({
    action: "deploy:normal",
    variables: Object.freeze([]),
  }),
  maintenance: Object.freeze({
    action: "deploy:maintenance",
    variables: Object.freeze([
      "PUBLIC_DISCUSSIONS_ENABLED:false",
      "TRIP_PHOTO_UPLOADS_ENABLED:false",
      "TURNSTILE_ENABLED:false",
      "RELEASE_MAINTENANCE_MODE:true",
    ]),
  }),
  "safety-floor": Object.freeze({
    action: "deploy:safety-floor",
    variables: Object.freeze(["PUBLIC_DISCUSSIONS_ENABLED:false"]),
  }),
});

function isInside(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === ""
    || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot));
}

function childEnvironment(environment, outputDirectory) {
  const child = { ...environment };
  for (const name of Object.keys(child)) {
    if ([
      "NODE_OPTIONS",
      "NODE_PATH",
      "CASTINGCOMPASS_CLOUDFLARE_BUILD",
      "NEXT_PUBLIC_API_URL",
      "NEXT_PUBLIC_PHOTO_UPLOADS",
    ].includes(name) || /^WRANGLER_/u.test(name) || /^npm_config_/iu.test(name)) {
      delete child[name];
    }
  }
  const emptyConfig = process.platform === "win32" ? "NUL" : "/dev/null";
  child.NPM_CONFIG_USERCONFIG = emptyConfig;
  child.NPM_CONFIG_GLOBALCONFIG = emptyConfig;
  child.NPM_CONFIG_AUDIT = "false";
  child.NPM_CONFIG_FUND = "false";
  child.NPM_CONFIG_UPDATE_NOTIFIER = "false";
  child.WRANGLER_SEND_METRICS = "false";
  if (outputDirectory) child.WRANGLER_OUTPUT_FILE_DIRECTORY = outputDirectory;
  return child;
}

async function verifiedOutputDirectory(releaseRoot, requestedDirectory) {
  if (requestedDirectory === undefined) return null;
  if (!isAbsolute(requestedDirectory)) {
    throw new Error("Wrangler evidence output must use an absolute private directory.");
  }
  const symbolicMetadata = await lstat(requestedDirectory).catch(() => null);
  if (!symbolicMetadata || symbolicMetadata.isSymbolicLink() || !symbolicMetadata.isDirectory()) {
    throw new Error("Wrangler evidence output must be an existing non-symlink directory.");
  }
  const directory = await realpath(requestedDirectory);
  if (isInside(releaseRoot, directory) || isInside(POLICY_ROOT, directory)) {
    throw new Error("Wrangler evidence output must be outside every release checkout.");
  }
  const metadata = await stat(directory);
  if ((metadata.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
    throw new Error("Wrangler evidence output must be private and owned by the current operator.");
  }
  return directory;
}

function defaultRunner(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    shell: false,
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw new Error(`Release subprocess could not start: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = options.inherit ? "" : `: ${(result.stderr || result.stdout || "").trim()}`;
    throw new Error(`Release subprocess exited ${result.status}${detail}`);
  }
  return options.inherit ? "" : (result.stdout ?? "").trim();
}

async function verifiedNpmCli(releaseRoot, npmCli) {
  if (!isAbsolute(npmCli ?? "")) {
    throw new Error("Release must run through the locked npm CLI so npm_execpath is absolute.");
  }
  const npmPath = await realpath(npmCli).catch(() => null);
  if (!npmPath || !(await stat(npmPath)).isFile()) {
    throw new Error("Locked npm CLI could not be resolved.");
  }
  if (isInside(releaseRoot, npmPath)) {
    throw new Error("Locked npm CLI must be outside the release checkout.");
  }
  const npmPackageRoot = resolve(dirname(npmPath), "..");
  const npmPackage = JSON.parse(await readFile(resolve(npmPackageRoot, "package.json"), "utf8"));
  const declaredCli = await realpath(resolve(npmPackageRoot, npmPackage.bin?.npm ?? "")).catch(() => null);
  if (npmPackage.name !== "npm" || npmPackage.version !== EXPECTED_NPM_VERSION
    || declaredCli !== npmPath) {
    throw new Error(`Release npm must be exact package version ${EXPECTED_NPM_VERSION}.`);
  }
  return npmPath;
}

async function verifyLockedWrangler(releaseRoot) {
  const lock = JSON.parse(await readFile(resolve(releaseRoot, "package-lock.json"), "utf8"));
  const rootEntry = lock.packages?.[""];
  const wranglerEntry = lock.packages?.["node_modules/wrangler"];
  if (lock.lockfileVersion !== 3 || rootEntry?.devDependencies?.wrangler !== EXPECTED_WRANGLER_VERSION
    || wranglerEntry?.version !== EXPECTED_WRANGLER_VERSION
    || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(wranglerEntry?.integrity ?? "")) {
    throw new Error(`Release lock must bind Wrangler ${EXPECTED_WRANGLER_VERSION} with integrity.`);
  }
}

async function verifiedInstalledWrangler(releaseRoot) {
  const wranglerPath = await realpath(
    resolve(releaseRoot, "node_modules/wrangler/bin/wrangler.js"),
  ).catch(() => null);
  if (!wranglerPath || !isInside(releaseRoot, wranglerPath) || !(await stat(wranglerPath)).isFile()) {
    throw new Error("Release checkout does not contain its locked Wrangler CLI.");
  }
  const wranglerPackage = JSON.parse(await readFile(
    resolve(releaseRoot, "node_modules/wrangler/package.json"),
    "utf8",
  ));
  if (wranglerPackage.name !== "wrangler" || wranglerPackage.version !== EXPECTED_WRANGLER_VERSION) {
    throw new Error(`Release Wrangler must be exact version ${EXPECTED_WRANGLER_VERSION}.`);
  }
  return wranglerPath;
}

export async function releaseCloudflare({
  mode,
  releaseRoot,
  expectedCommit,
  expectedGateCommit = expectedCommit,
  authorizationFile,
  environment = process.env,
  npmCli = environment.npm_execpath,
  runner = defaultRunner,
  authorizationVerifier = verifyProductionChangeAuthorization,
}) {
  const contract = MODES[mode];
  if (!contract) throw new Error("Release mode must be normal, maintenance, or safety-floor.");
  const root = await realpath(resolve(releaseRoot));
  const authorizationOptions = {
    root,
    policyRoot: POLICY_ROOT,
    expectedCommit,
    expectedGateCommit,
    authorizationFile,
    action: contract.action,
  };
  const receipt = await authorizationVerifier(authorizationOptions);
  const npmPath = await verifiedNpmCli(root, npmCli);
  await verifyLockedWrangler(root);
  const outputDirectory = await verifiedOutputDirectory(
    root,
    environment.WRANGLER_OUTPUT_FILE_DIRECTORY,
  );
  const env = childEnvironment(environment, outputDirectory);
  const npmVersion = runner(process.execPath, [npmPath, "--version"], { cwd: root, env });
  if (npmVersion !== EXPECTED_NPM_VERSION) {
    throw new Error(`Release npm must be exact version ${EXPECTED_NPM_VERSION}.`);
  }
  runner(process.execPath, [npmPath, "ci", "--ignore-scripts"], { cwd: root, env, inherit: true });
  if (await verifiedNpmCli(root, npmCli) !== npmPath) {
    throw new Error("Release npm identity changed during the locked install.");
  }
  const wranglerPath = await verifiedInstalledWrangler(root);
  runner(process.execPath, [npmPath, "run", "build:cloudflare"], { cwd: root, env, inherit: true });
  const finalOutputDirectory = await verifiedOutputDirectory(
    root,
    environment.WRANGLER_OUTPUT_FILE_DIRECTORY,
  );
  if (finalOutputDirectory !== outputDirectory) {
    throw new Error("Wrangler evidence output identity changed during the release build.");
  }
  const finalReceipt = await authorizationVerifier(authorizationOptions);
  if (JSON.stringify(finalReceipt) !== JSON.stringify(receipt)) {
    throw new Error("Production authorization changed between build and deployment.");
  }
  const deployArguments = [wranglerPath, "deploy", "--config", "wrangler.jsonc"];
  for (const variable of contract.variables) deployArguments.push("--var", variable);
  runner(process.execPath, deployArguments, { cwd: root, env, inherit: true });
  return finalReceipt;
}

function parseArguments(args) {
  const options = {
    mode: undefined,
    releaseRoot: undefined,
    expectedCommit: undefined,
    expectedGateCommit: undefined,
    authorizationFile: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (["--mode", "--release-root", "--expected-commit", "--expected-gate-commit", "--authorization-file"].includes(value)) {
      const argument = args[index + 1];
      if (!argument) throw new Error(`${value} requires a value.`);
      const field = {
        "--mode": "mode",
        "--release-root": "releaseRoot",
        "--expected-commit": "expectedCommit",
        "--expected-gate-commit": "expectedGateCommit",
        "--authorization-file": "authorizationFile",
      }[value];
      options[field] = argument;
      index += 1;
    } else if (value === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: node scripts/release-cloudflare.mjs --mode normal|maintenance|safety-floor --release-root /ABSOLUTE/REVIEWED/WORKTREE --expected-commit COMMIT --expected-gate-commit GATE_COMMIT --authorization-file /PRIVATE/AUTHORIZATION.json\n",
    );
    return;
  }
  const receipt = await releaseCloudflare(options);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
