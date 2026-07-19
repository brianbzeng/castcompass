import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { readdir, realpath } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFile = promisify(execFileCallback);
const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OFFICIAL_REPOSITORY = "brianbzeng/castingcompass";
const OFFICIAL_ORIGIN_URLS = new Set([
  "https://github.com/brianbzeng/castingcompass.git",
  "https://github.com/brianbzeng/castingcompass",
  "git@github.com:brianbzeng/castingcompass.git",
  "ssh://git@github.com/brianbzeng/castingcompass.git",
]);
const REVIEWED_MAIN_REF = "refs/remotes/origin/main";

async function defaultGitRunner(root, args) {
  const { stdout } = await execFile("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function defaultOverrideFinder(root) {
  const entries = await readdir(root);
  return entries.filter((name) =>
    (name === ".dev.vars" || name.startsWith(".dev.vars.")) ||
    ((name === ".env" || name.startsWith(".env.")) && name !== ".env.example"));
}

export async function verifyReleaseCheckout({
  root = DEFAULT_ROOT,
  expectedCommit,
  gitRunner = defaultGitRunner,
  overrideFinder = defaultOverrideFinder,
}) {
  if (!/^[0-9a-f]{40}$/.test(expectedCommit ?? "")) {
    throw new Error("--expected-commit must be a full lowercase 40-character commit ID.");
  }

  const requestedRoot = await realpath(resolve(root));
  const repositoryRoot = await realpath(await gitRunner(requestedRoot, ["rev-parse", "--show-toplevel"]));
  if (requestedRoot !== repositoryRoot) {
    throw new Error(`Release root must be the repository root: expected ${repositoryRoot}, received ${requestedRoot}`);
  }

  const head = await gitRunner(repositoryRoot, ["rev-parse", "HEAD"]);
  const expected = await gitRunner(repositoryRoot, ["rev-parse", "--verify", `${expectedCommit}^{commit}`]);
  if (head !== expected) {
    throw new Error(`Release checkout is at ${head}, not expected commit ${expected}`);
  }

  const originUrl = await gitRunner(repositoryRoot, ["remote", "get-url", "origin"]);
  if (!OFFICIAL_ORIGIN_URLS.has(originUrl)) {
    throw new Error(`Release origin must be the official ${OFFICIAL_REPOSITORY} repository.`);
  }
  const originMain = await gitRunner(repositoryRoot, ["rev-parse", "--verify", `${REVIEWED_MAIN_REF}^{commit}`]);
  try {
    await gitRunner(repositoryRoot, ["merge-base", "--is-ancestor", expected, REVIEWED_MAIN_REF]);
  } catch {
    throw new Error("Release commit is not reachable from the locally reviewed official origin/main ref.");
  }

  const status = await gitRunner(repositoryRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ]);
  if (status) {
    throw new Error(`Release checkout is not clean:\n${status}`);
  }

  const overrides = await overrideFinder(repositoryRoot);
  if (overrides.length > 0) {
    throw new Error(
      `Release checkout contains local environment overrides: ${overrides.sort().join(", ")}`,
    );
  }

  return {
    root: repositoryRoot,
    head,
    expectedCommit: expected,
    officialRepository: OFFICIAL_REPOSITORY,
    originMain,
    clean: true,
    overrides: [],
  };
}

function parseArguments(args) {
  let root = DEFAULT_ROOT;
  let expectedCommit;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--root") {
      root = args[index + 1];
      if (!root) throw new Error("--root requires a path");
      index += 1;
    } else if (value === "--expected-commit") {
      expectedCommit = args[index + 1];
      if (!expectedCommit) throw new Error("--expected-commit requires a commit ID");
      index += 1;
    } else if (value === "--help") {
      return { help: true, root, expectedCommit };
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return { help: false, root, expectedCommit };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("Usage: node scripts/verify-release-checkout.mjs --root /absolute/worktree --expected-commit FULL_40_CHARACTER_COMMIT_ID\n");
    return;
  }
  const result = await verifyReleaseCheckout(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
