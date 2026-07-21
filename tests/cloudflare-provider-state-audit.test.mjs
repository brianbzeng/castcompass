import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  READ_ONLY_CONFIRMATION,
  ProviderStateRefusal,
  analyzeProviderState,
  assertPublicReceipt,
  buildExpectedBindings,
  loadRepositoryContract,
  parseBoundedJson,
  runLiveAudit,
  validatePolicy,
} from "../scripts/audit-cloudflare-provider-state.mjs";

const NOW = new Date("2026-07-19T18:00:00.000Z");
const ACTIVE_VERSION = "01234567-89ab-4cde-8f01-23456789abcd";
const OTHER_VERSION = "fedcba98-7654-4321-8fed-cba987654321";
const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/u, "");

function deploymentStatus(overrides = {}) {
  return {
    id: "deployment-private-identifier",
    author_email: "private@example.test",
    strategy: "percentage",
    versions: [{ version_id: ACTIVE_VERSION, percentage: 100 }],
    ...overrides,
  };
}

function versionFromContract(contract, overrides = {}) {
  const bindings = buildExpectedBindings(contract.config, contract.policy).map((binding) => (
    structuredClone(binding)
  ));
  return {
    id: ACTIVE_VERSION,
    metadata: {
      author_email: "private@example.test",
      author_id: "private-author-identifier",
    },
    resources: {
      bindings: [
        ...bindings,
        { name: "PRIVATE_RUNTIME_SECRET", type: "secret_text" },
      ],
      script: {
        etag: "private-script-etag",
        last_deployed_from: "private-provider-source-metadata",
      },
      script_runtime: {
        compatibility_date: contract.config.compatibility_date,
        compatibility_flags: [...contract.config.compatibility_flags],
      },
    },
    ...overrides,
  };
}

function currentDriftVersion(contract) {
  const allowedNames = new Set([
    "PUBLIC_DISCUSSIONS_ENABLED",
    "TRIP_PHOTO_UPLOADS_ENABLED",
    "TURNSTILE_ENABLED",
    "RELEASE_MAINTENANCE_MODE",
    contract.config.assets.binding,
    contract.config.version_metadata.binding,
    ...contract.config.d1_databases.map(({ binding }) => binding),
  ]);
  const bindings = buildExpectedBindings(contract.config, contract.policy)
    .filter(({ name }) => allowedNames.has(name))
    .map((binding) => (
      binding.name === "RELEASE_MAINTENANCE_MODE"
        ? { ...binding, text: "false" }
        : structuredClone(binding)
    ));
  return {
    id: ACTIVE_VERSION,
    metadata: { author_email: "private@example.test" },
    resources: {
      bindings: [
        ...bindings,
        { name: "PRIVATE_RUNTIME_SECRET", type: "secret_text" },
      ],
      script: { etag: "private-etag", last_deployed_from: "wrangler" },
      script_runtime: {
        compatibility_date: contract.config.compatibility_date,
        compatibility_flags: [...contract.config.compatibility_flags],
      },
    },
  };
}

function successfulResult(value) {
  return { status: 0, signal: null, error: null, stdout: JSON.stringify(value), stderr: "" };
}

test("the locked policy binds the repository Worker, hold, Wrangler, and read-only commands", () => {
  const contract = loadRepositoryContract();
  assert.equal(contract.policy.worker.name, contract.config.name);
  assert.equal(contract.policy.worker.wrangler_version,
    contract.packageManifest.devDependencies.wrangler);
  assert.equal(contract.policy.production_hold.required, true);
  assert.equal(contract.policy.production_hold.live_host_verification_required, true);
  assert.equal(contract.policy.source_binding.provider_metadata_is_sufficient, false);

  const deploy = structuredClone(contract.policy);
  deploy.commands.version_view[0] = "deploy";
  assert.throws(() => validatePolicy(deploy), /locked policy/u);
  const weakened = structuredClone(contract.policy);
  weakened.production_hold.required = false;
  assert.throws(() => validatePolicy(weakened), /weakened/u);
});

test("current provider drift produces only aggregate blockers and never leaks private identifiers", () => {
  const contract = loadRepositoryContract();
  const receipt = analyzeProviderState(
    deploymentStatus(), currentDriftVersion(contract), contract, { now: NOW },
  );
  assert.deepEqual(receipt.blockers, [
    "binding-drift",
    "live-host-verification-missing",
    "maintenance-mode-inactive",
    "reviewed-commit-unbound",
  ]);
  assert.deepEqual(receipt.configuration.missing_binding_names, [
    "RATE_LIMITING_ENABLED",
    "AI_REVIEW_QUEUE_ENABLED",
    "PRIVACY_EXPORT_QUEUE_ENABLED",
    ...contract.config.ratelimits.map(({ name }) => name),
  ]);
  assert.deepEqual(receipt.configuration.mismatched_binding_names,
    ["RELEASE_MAINTENANCE_MODE"]);
  assert.equal(receipt.configuration.compatibility_matches, true);
  assert.equal(receipt.maintenance.configured_value_matches, false);
  assert.equal(receipt.production_hold_proven, false);
  assert.equal(receipt.release_ready, false);

  const publicJson = JSON.stringify(receipt);
  for (const privateValue of [
    ACTIVE_VERSION,
    "deployment-private-identifier",
    "private@example.test",
    "private-author-identifier",
    "private-script-etag",
    "private-provider-source-metadata",
    contract.config.d1_databases[0].database_id,
    ...contract.config.ratelimits.map(({ namespace_id: namespaceId }) => namespaceId),
    "PRIVATE_RUNTIME_SECRET",
  ]) {
    assert.equal(publicJson.includes(privateValue), false);
  }
});

test("a matching maintenance candidate still cannot self-prove live hold or source identity", () => {
  const contract = loadRepositoryContract();
  const receipt = analyzeProviderState(
    deploymentStatus(), versionFromContract(contract), contract, { now: NOW },
  );
  assert.equal(receipt.traffic.one_version_at_100_percent, true);
  assert.equal(receipt.maintenance.configured_value_matches, true);
  assert.equal(receipt.configuration.bindings_match, true);
  assert.equal(receipt.configuration.compatibility_matches, true);
  assert.equal(receipt.source_identity.provider_metadata_present, true);
  assert.equal(receipt.source_identity.provider_metadata_is_sufficient, false);
  assert.equal(receipt.source_identity.reviewed_commit_bound, false);
  assert.deepEqual(receipt.blockers, [
    "live-host-verification-missing",
    "reviewed-commit-unbound",
  ]);
  assert.equal(receipt.production_hold_proven, false);
  assert.equal(receipt.release_ready, false);
});

test("split traffic fails closed before querying a version", () => {
  const contract = loadRepositoryContract();
  const calls = [];
  const receipt = runLiveAudit({
    confirmation: READ_ONLY_CONFIRMATION,
    contract,
    now: NOW,
    runCommand(command, args) {
      calls.push({ command, args });
      return successfulResult(deploymentStatus({
        versions: [
          { version_id: ACTIVE_VERSION, percentage: 50 },
          { version_id: OTHER_VERSION, percentage: 50 },
        ],
      }));
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(receipt.traffic.one_version_at_100_percent, false);
  assert.equal(receipt.configuration.evaluated, false);
  assert.deepEqual(receipt.blockers, [
    "live-host-verification-missing",
    "provider-config-not-evaluated",
    "reviewed-commit-unbound",
    "traffic-not-single-100",
  ]);
});

test("the live runner requires confirmation and executes only the two exact read-only commands", () => {
  const contract = loadRepositoryContract();
  const calls = [];
  const runCommand = (command, args, options) => {
    calls.push({ command, args, options });
    return successfulResult(calls.length === 1
      ? deploymentStatus()
      : versionFromContract(contract));
  };
  assert.throws(
    () => runLiveAudit({ contract, runCommand }),
    (error) => error instanceof ProviderStateRefusal && error.code === "confirmation-required",
  );
  assert.equal(calls.length, 0);

  const receipt = runLiveAudit({
    confirmation: READ_ONLY_CONFIRMATION,
    contract,
    runCommand,
    now: NOW,
  });
  assert.equal(receipt.read_only, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, [
    "deployments", "status", "--name", "contourcast-halibut",
    "--config", "wrangler.jsonc", "--json",
  ]);
  assert.deepEqual(calls[1].args, [
    "versions", "view", ACTIVE_VERSION, "--name", "contourcast-halibut",
    "--config", "wrangler.jsonc", "--json",
  ]);
  for (const call of calls) {
    assert.equal(call.options.shell, false);
    assert.equal(call.options.cwd, REPOSITORY_ROOT);
    assert.equal(call.options.env.WRANGLER_LOG_PATH, undefined);
    assert.equal(call.options.env.NODE_OPTIONS, undefined);
    assert.equal(call.options.env.WRANGLER_SEND_METRICS, "false");
    assert.equal(call.args.some((argument) => (
      /deploy|secret|route|domain|d1|delete|put/iu.test(argument)
      && argument !== "deployments"
    )), false);
  }
});

test("the public receipt rejects nested schema widening and untrusted binding names", () => {
  const contract = loadRepositoryContract();
  const receipt = analyzeProviderState(
    deploymentStatus(), versionFromContract(contract), contract, { now: NOW },
  );
  const widened = structuredClone(receipt);
  widened.source_identity.email = "private@example.test";
  assert.throws(() => assertPublicReceipt(widened, contract.policy), /unexpected fields/u);
  const untrustedName = structuredClone(receipt);
  untrustedName.configuration.missing_binding_names = ["PRIVATE_RUNTIME_SECRET"];
  assert.throws(() => assertPublicReceipt(untrustedName, contract.policy), /overstates/u);
});

test("malformed, oversized, ambiguous, and unbound provider output is rejected", () => {
  const contract = loadRepositoryContract();
  assert.throws(() => parseBoundedJson("{", 1024, "fixture"), /valid JSON/u);
  assert.throws(() => parseBoundedJson("x".repeat(1025), 1024, "fixture"), /byte limit/u);

  assert.throws(() => analyzeProviderState(
    deploymentStatus({ versions: [{ version_id: "--unsafe", percentage: 100 }] }),
    versionFromContract(contract), contract, { now: NOW },
  ), /traffic data/u);
  assert.throws(() => analyzeProviderState(
    deploymentStatus(), { ...versionFromContract(contract), id: OTHER_VERSION },
    contract, { now: NOW },
  ), /unbound/u);

  const duplicate = versionFromContract(contract);
  duplicate.resources.bindings.push(structuredClone(duplicate.resources.bindings[0]));
  assert.throws(() => analyzeProviderState(
    deploymentStatus(), duplicate, contract, { now: NOW },
  ), /duplicate/u);
});

test("CI and release provenance verify only the offline policy", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const release = readFileSync(
    new URL("../.github/workflows/release-provenance.yml", import.meta.url), "utf8",
  );
  assert.equal(
    manifest.scripts["security:cloudflare-provider-state"],
    "node scripts/audit-cloudflare-provider-state.mjs verify-policy",
  );
  assert.equal(
    manifest.scripts["audit:cloudflare:state"],
    "node scripts/audit-cloudflare-provider-state.mjs audit-live",
  );
  for (const workflow of [ci, release]) {
    assert.match(workflow, /npm run security:cloudflare-provider-state/u);
    assert.doesNotMatch(workflow, /audit:cloudflare:state|audit-live|wrangler deployments/u);
  }
});
