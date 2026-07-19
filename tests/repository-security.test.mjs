import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { scanText } from "../scripts/check-secrets.mjs";

test("secret scanner detects representative provider credentials without storing fixtures", () => {
  const candidates = [
    [
      "named secret assignment",
      `${["CLOUDFLARE", "_API_TOKEN"].join("")}=${"A".repeat(32)}`,
    ],
    ["private key", ["-----BEGIN ", "PRIVATE KEY-----"].join("")],
    ["GitHub token", ["gh", "p_", "A".repeat(36)].join("")],
    ["GitHub fine-grained token", ["github_", "pat_", "A".repeat(48)].join("")],
    ["npm access token", ["npm_", "A".repeat(36)].join("")],
    ["OpenAI-style API key", ["s", "k-", "A".repeat(32)].join("")],
    ["Resend API key", ["re", "_", "A".repeat(32)].join("")],
    [
      "named secret assignment",
      `${["TURNSTILE", "_SECRET_KEY"].join("")}=${"A".repeat(32)}`,
    ],
    [
      "named secret assignment",
      `${["\"", "TURNSTILE", "_SECRET_KEY", "\""].join("")}: "${"A".repeat(32)}"`,
    ],
    ["AWS access key", ["A", "KIA", "A".repeat(16)].join("")],
    ["Google API key", ["AI", "za", "A".repeat(35)].join("")],
    ["Slack token", ["xo", "xb-", "A".repeat(24)].join("")],
    ["Stripe live secret key", ["sk_", "live_", "A".repeat(24)].join("")],
  ];

  for (const [expectedName, candidate] of candidates) {
    assert.deepEqual(scanText(`value=${candidate}`), [{ name: expectedName, line: 1 }]);
  }
});

test("secret scanner accepts documentation placeholders", () => {
  const placeholders = [
    "OPENAI_API_KEY=replace-me",
    "CLOUDFLARE_API_TOKEN=your-token-here",
    "AWS_ACCESS_KEY_ID=example",
    "token=your-token-here",
    "-----BEGIN PUBLIC KEY-----",
  ].join("\n");

  assert.deepEqual(scanText(placeholders), []);
});

test("published security.txt copies are identical and advertise a private contact", () => {
  const rootCopy = readFileSync("public/security.txt", "utf8");
  const wellKnownCopy = readFileSync("public/.well-known/security.txt", "utf8");

  assert.equal(rootCopy, wellKnownCopy);
  assert.match(rootCopy, /^Contact: mailto:/m);
  assert.match(
    rootCopy,
    /^Canonical: https:\/\/castingcompass\.com\/\.well-known\/security\.txt$/m,
  );
  assert.match(rootCopy, /^Preferred-Languages: en$/m);

  const expires = rootCopy.match(/^Expires: (.+)$/m)?.[1];
  assert.ok(expires, "security.txt must include an expiry");
  assert.ok(new Date(expires).getTime() > Date.now(), "security.txt must not be expired");
});

test("third-party GitHub Actions are pinned to immutable commits", () => {
  const actions = readdirSync(".github/workflows")
    .filter((name) => /\.ya?ml$/.test(name))
    .flatMap((name) => {
      const workflow = readFileSync(`.github/workflows/${name}`, "utf8");
      return [...workflow.matchAll(/^\s*- uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)]
        .map((match) => match[1]);
    });

  assert.ok(actions.length > 0, "CI should declare at least one action");
  for (const action of actions) {
    assert.match(action, /^[^@]+@[0-9a-f]{40}$/i, `${action} must use a full commit SHA`);
  }
});

test("production release scripts cannot apply migrations implicitly or bypass the staged wrapper", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  for (const name of [
    "deploy:cloudflare",
    "deploy:cloudflare:worker-only",
    "release:cloudflare",
    "release:cloudflare:maintenance",
    "release:cloudflare:safety-floor",
  ]) {
    const command = packageJson.scripts[name];
    assert.equal(typeof command, "string", `${name} must exist`);
    assert.doesNotMatch(command, /\bmigrations\s+apply\b/, `${name} must be Worker-only`);
  }
  assert.match(packageJson.scripts["migrate:cloudflare:remote"], /integrated-release\.mjs apply/);
  assert.doesNotMatch(packageJson.scripts["migrate:cloudflare:remote"], /\bwrangler\b/);
  assert.doesNotMatch(packageJson.scripts["migrate:cloudflare:remote"], /confirm-(primary|bookmark)/);
  assert.doesNotMatch(packageJson.scripts["reconcile:cloudflare:0007"], /confirm-(primary|bookmark)/);
});

test("every deploy and migration entry point requires private exact-action authorization", () => {
  const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;

  assert.match(scripts["verify:release-checkout"], /verify-release-checkout\.mjs/);
  assert.match(scripts["verify:release-checkout"], /\$RELEASE_COMMIT/);
  assert.match(scripts["verify:production-change"], /verify-production-change-authorization\.mjs verify/);
  assert.match(scripts["verify:production-change"], /\$RELEASE_COMMIT/);
  assert.match(scripts["verify:production-change"], /--expected-gate-commit "\$RELEASE_COMMIT"/);
  assert.match(scripts["verify:production-change"], /\$RELEASE_AUTHORIZATION_FILE/);
  assert.match(scripts["deploy:cloudflare"], /release:cloudflare/);
  assert.match(scripts["deploy:cloudflare:worker-only"], /release:cloudflare/);
  assert.match(
    scripts["release:cloudflare"],
    /release-cloudflare\.mjs.*--mode normal.*\$RELEASE_COMMIT.*\$RELEASE_AUTHORIZATION_FILE/,
  );
  assert.match(
    scripts["release:cloudflare:maintenance"],
    /release-cloudflare\.mjs.*--mode maintenance.*\$RELEASE_COMMIT.*\$RELEASE_AUTHORIZATION_FILE/,
  );
  assert.match(
    scripts["release:cloudflare:safety-floor"],
    /release-cloudflare\.mjs.*--mode safety-floor.*\$RELEASE_ROOT.*\$RELEASE_COMMIT.*\$RELEASE_GATE_COMMIT.*\$RELEASE_AUTHORIZATION_FILE/,
  );
  const releaseWrapper = readFileSync("scripts/release-cloudflare.mjs", "utf8");
  assert.match(releaseWrapper, /await authorizationVerifier\([\s\S]+npmPath, "ci", "--ignore-scripts"[\s\S]+npmPath, "run", "build:cloudflare"[\s\S]+await authorizationVerifier\([\s\S]+wranglerPath, "deploy"/);
  assert.match(releaseWrapper, /shell: false/);
  assert.match(scripts["migrate:cloudflare:remote"], /integrated-release\.mjs apply/);
  assert.match(scripts["reconcile:cloudflare:0007"], /integrated-release\.mjs reconcile-0007/);
  const integratedRelease = readFileSync("scripts/integrated-release.mjs", "utf8");
  assert.match(integratedRelease, /verifyProductionChangeAuthorization/);
  assert.match(integratedRelease, /RELEASE_AUTHORIZATION_FILE/);
  assert.match(integratedRelease, /await authorizeProductionMutation\(root, options\)/);
  assert.match(integratedRelease, /runPreflight\(root, runner\)[\s\S]+await authorizeProductionMutation\(root, options\)[\s\S]+executeMutationFile/);
  assert.match(integratedRelease, /requireMigrationArray\([\s\S]+await reauthorize\(root, options\)[\s\S]+"migrations", "apply"/);
});

test("release maintenance is default-off and suppresses scheduled database work", () => {
  const config = readFileSync("wrangler.jsonc", "utf8");
  const worker = readFileSync("worker/index.ts", "utf8");
  assert.match(config, /"RELEASE_MAINTENANCE_MODE"\s*:\s*"false"/);
  assert.match(worker, /if \(releaseMaintenanceEnabled\(env\)\) return;/);
  assert.match(worker, /releaseMaintenanceResponse\(request, env\)/);
});

test("Cloudflare builds override every public environment input", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  const build = packageJson.scripts["build:cloudflare"];
  const applicationSource = [
    readFileSync("app/components/OpportunityApp.tsx", "utf8"),
    readFileSync("app/components/TripReportFeature.tsx", "utf8"),
  ].join("\n");
  const publicInputs = new Set(
    [...applicationSource.matchAll(/process\.env\.(NEXT_PUBLIC_[A-Z0-9_]+)/g)]
      .map((match) => match[1]),
  );

  assert.deepEqual(
    [...publicInputs].sort(),
    ["NEXT_PUBLIC_API_URL", "NEXT_PUBLIC_PHOTO_UPLOADS"],
  );
  for (const name of publicInputs) {
    assert.match(build, new RegExp(`(?:^|\\s)${name}=`), `${name} must be overridden`);
  }
  assert.match(build, /NEXT_PUBLIC_API_URL=\s/);
  assert.match(build, /NEXT_PUBLIC_PHOTO_UPLOADS=false/);
  assert.match(packageJson.scripts.test, /build:cloudflare/);
});

test("asset-first responses receive the same baseline browser hardening", () => {
  const headers = readFileSync("public/_headers", "utf8");
  for (const name of [
    "Content-Security-Policy",
    "Permissions-Policy",
    "Referrer-Policy",
    "Strict-Transport-Security",
    "X-Content-Type-Options",
    "X-Frame-Options",
    "X-Permitted-Cross-Domain-Policies",
  ]) {
    assert.match(headers, new RegExp(`^\\s+${name}:`, "m"));
  }
  assert.match(headers, /workers\.dev\/\*[\s\S]*X-Robots-Tag: noindex, nofollow/);
  assert.match(headers, /\/sw\.js[\s\S]*Cache-Control: no-cache, no-store, must-revalidate/);
});

test("application output uses React encoding and the only raw script context escapes tag openings", () => {
  const applicationFiles = readdirSync("app", { recursive: true })
    .filter((name) => typeof name === "string" && /\.(?:ts|tsx)$/.test(name));
  const rawHtmlFiles = [];
  for (const name of applicationFiles) {
    const path = `app/${name}`;
    const source = readFileSync(path, "utf8");
    if (source.includes("dangerouslySetInnerHTML")) rawHtmlFiles.push(path);
    assert.doesNotMatch(source, /\b(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval)\b/);
  }

  assert.deepEqual(rawHtmlFiles, ["app/page.tsx"]);
  const home = readFileSync("app/page.tsx", "utf8");
  assert.match(home, /JSON\.stringify\(websiteStructuredData\)\.replace\(\/<\/g/);
  assert.match(home, /\\\\u003c/);
});

test("scheduled snapshot refreshes require review instead of pushing the default branch", () => {
  const workflow = readFileSync(".github/workflows/refresh-snapshot.yml", "utf8");

  assert.match(workflow, /automation\/refresh-public-forecast-snapshot/);
  assert.match(workflow, /gh pr create/);
  assert.match(workflow, /gh pr list --head "\$BRANCH" --state open/);
  assert.match(workflow, /select\(\.isCrossRepository == false\)/);
  assert.match(workflow, /gh pr edit "\$OPEN_PR"/);
  assert.match(workflow, /git push --force-with-lease origin "HEAD:refs\/heads\/\$BRANCH"/);
  assert.doesNotMatch(workflow, /^\s+git push\s*$/m);
});

test("manual snapshot publication has an owner, cadence, and truthful stale response", () => {
  const deployment = readFileSync("docs/CLOUDFLARE_DEPLOYMENT.md", "utf8");
  const freshness = readFileSync("app/lib/forecast-freshness.ts", "utf8");

  assert.match(deployment, /operator:primary/);
  assert.match(deployment, /maximum unattended interval is six hours/i);
  assert.match(deployment, /change from `fresh` to\s+`stale`/);
  assert.match(deployment, /Long-lived tide or seasonal data cannot\s+keep the badge `Live`/);
  assert.match(freshness, /freshness limit exceeded/);
});

test("patched build-tool versions are exact and remain above the reviewed advisory floors", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));

  assert.equal(packageJson.devDependencies["@cloudflare/vite-plugin"], "1.45.1");
  assert.equal(packageJson.devDependencies["@vitejs/plugin-react"], "6.0.3");
  assert.equal(packageJson.devDependencies.vite, "8.1.5");
  assert.equal(packageJson.devDependencies.wrangler, "4.112.0");
  assert.equal(lock.packages["node_modules/miniflare"].version, "4.20260714.0");
  assert.equal(lock.packages["node_modules/workerd"].version, "1.20260714.1");
  assert.equal(lock.packages["node_modules/undici"].version, "7.28.0");
  assert.equal(lock.packages["node_modules/ws"].version, "8.21.0");
});
