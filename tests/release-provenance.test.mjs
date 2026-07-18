import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  createReleaseArtifacts,
  verifyReleaseArtifacts,
} from "../scripts/build-release-artifacts.mjs";

const COMMIT = "1".repeat(40);
const REPOSITORY = "brianbzeng/castingcompass";

test("release bundles are deterministic, lock-bound, and fail closed on tampering", () => {
  const directory = mkdtempSync(join(tmpdir(), "castingcompass-release-provenance-"));
  chmodSync(directory, 0o700);
  try {
    const first = join(directory, "first");
    const second = join(directory, "second");
    const input = {
      sourceRoot: fileURLToPath(new URL("..", import.meta.url)),
      commitSha: COMMIT,
      repository: REPOSITORY,
      nodeVersion: "22.23.1",
      npmVersion: "10.9.8",
    };
    const firstManifest = createReleaseArtifacts({ ...input, outputDirectory: first });
    const secondManifest = createReleaseArtifacts({ ...input, outputDirectory: second });
    assert.equal(firstManifest.bundle_sha256, secondManifest.bundle_sha256);
    assert.equal(firstManifest.sbom_sha256, secondManifest.sbom_sha256);
    assert.equal(
      firstManifest.sbom_sha256,
      createHash("sha256")
        .update(readFileSync(new URL("../security/release-sbom.cdx.json", import.meta.url)))
        .digest("hex"),
    );
    assert.equal(firstManifest.package_lock_sha256, secondManifest.package_lock_sha256);
    assert.equal(firstManifest.archived_file_count, secondManifest.archived_file_count);

    const bundleName = `castingcompass-worker-${COMMIT}.tar.gz`;
    assert.deepEqual(readFileSync(join(first, bundleName)), readFileSync(join(second, bundleName)));
    assert.deepEqual(
      verifyReleaseArtifacts({ outputDirectory: first, commitSha: COMMIT, repository: REPOSITORY }),
      firstManifest,
    );

    const tampered = readFileSync(join(first, bundleName));
    tampered[tampered.byteLength - 1] ^= 1;
    writeFileSync(join(first, bundleName), tampered);
    assert.throws(
      () => verifyReleaseArtifacts({ outputDirectory: first, commitSha: COMMIT, repository: REPOSITORY }),
      /bundle digest does not match/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("release signing stays main-only and isolated from dependency execution", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release-provenance.yml", import.meta.url), "utf8");
  assert.match(workflow, /attest-release:\n\s+if: github\.event_name == 'push'[\s\S]*github\.ref == 'refs\/heads\/main'[\s\S]*github\.repository == 'brianbzeng\/castingcompass'/u);
  assert.match(workflow, /attest-release:[\s\S]*permissions:\n\s+contents: read\n\s+id-token: write\n\s+attestations: write/u);
  assert.match(workflow, /Verify the untrusted handoff without running repository code[\s\S]*sha256sum --check --strict SHA256SUMS/u);
  assert.match(workflow, /\.repository == \$repository[\s\S]+\.commit_sha == \$commit[\s\S]+gzip --test "\$bundle"/u);
  assert.match(workflow, /\.serialNumber \| test\("\^urn:uuid:/u);
  assert.match(workflow, /\.metadata\.component\.name == "castingcompass-release"/u);
  assert.match(workflow, /\.type == "container"[\s\S]+\.type == "operating-system"[\s\S]+pkg:pypi\//u);
  assert.match(workflow, /Cloudflare Workers Runtime/u);
  assert.match(workflow, /actions\/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6 # v4\.2\.0/u);
  assert.match(workflow, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7\.0\.1/u);
  assert.match(workflow, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8\.0\.1/u);
  const signingJob = workflow.slice(workflow.indexOf("  attest-release:"));
  assert.doesNotMatch(signingJob, /actions\/checkout|actions\/setup-node|npm (?:ci|run)|node scripts\//u);
  assert.match(signingJob, /subject-path:[\s\S]*sbom-path:/u);
});
