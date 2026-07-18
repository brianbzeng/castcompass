#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_SCHEMA_VERSION = "castingcompass.release-artifact/1.0.0";
const RELEASE_IDENTITY_VERSION = "castingcompass.release-identity/1.0.0";
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const TAR_BLOCK_BYTES = 512;
const RELEASE_PREFIX = "castingcompass-release";

const sourcePaths = [
  ["dist", "dist"],
  ["drizzle", "drizzle"],
  [".openai/hosting.json", ".openai/hosting.json"],
  [".node-version", ".node-version"],
  [".python-version", ".python-version"],
  ["package-lock.json", "package-lock.json"],
  ["package.json", "package.json"],
  ["pipeline/requirements-ci.lock", "pipeline/requirements-ci.lock"],
  ["security/release-sbom.cdx.json", "security/release-sbom.cdx.json"],
  ["security/sbom.cdx.json", "security/sbom.cdx.json"],
  ["services/api/Dockerfile", "services/api/Dockerfile"],
  ["services/api/requirements-runtime.lock", "services/api/requirements-runtime.lock"],
  ["wrangler.jsonc", "wrangler.jsonc"],
];
const releaseSbomInputs = [
  ".node-version",
  ".python-version",
  "package-lock.json",
  "package.json",
  "pipeline/requirements-ci.lock",
  "security/sbom.cdx.json",
  "services/api/Dockerfile",
  "services/api/requirements-runtime.lock",
  "wrangler.jsonc",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} fields are invalid`);
  }
}

function strictCommit(value) {
  if (!COMMIT_PATTERN.test(value ?? "")) throw new Error("Release commit must be a full lowercase SHA-1");
  return value;
}

function strictRepository(value) {
  if (!REPOSITORY_PATTERN.test(value ?? "")) throw new Error("Release repository identity is invalid");
  return value;
}

function strictVersion(value, label) {
  if (!/^\d+\.\d+\.\d+$/u.test(value ?? "")) throw new Error(`${label} must be an exact semantic version`);
  return value;
}

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function archiveName(relativePath) {
  const normalized = relativePath.split(sep).join("/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error("Release archive path is invalid");
  }
  return `${RELEASE_PREFIX}/${normalized}`;
}

function collectEntries(sourceRoot, sourcePath, targetPath, entries) {
  const absolute = resolve(sourceRoot, sourcePath);
  const rootRelative = relative(sourceRoot, absolute);
  if (!rootRelative || rootRelative.startsWith(`..${sep}`) || rootRelative === "..") {
    throw new Error("Release source path escapes the repository");
  }
  const metadata = lstatSync(absolute, { throwIfNoEntry: false });
  if (!metadata) throw new Error(`Release source is missing: ${sourcePath}`);
  if (metadata.isDirectory()) {
    entries.push({ name: `${archiveName(targetPath)}/`, type: "directory", bytes: Buffer.alloc(0) });
    for (const child of readdirSync(absolute).sort(compareNames)) {
      collectEntries(sourceRoot, join(sourcePath, child), join(targetPath, child), entries);
    }
    return;
  }
  if (!metadata.isFile()) throw new Error(`Release source is not a regular file: ${sourcePath}`);
  entries.push({ name: archiveName(targetPath), type: "file", bytes: readFileSync(absolute) });
}

function splitTarName(name) {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: "" };
  for (let index = name.lastIndexOf("/"); index > 0; index = name.lastIndexOf("/", index - 1)) {
    const prefix = name.slice(0, index);
    const suffix = name.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(suffix) <= 100) {
      return { name: suffix, prefix };
    }
  }
  throw new Error(`Release archive path is too long for ustar: ${name}`);
}

function writeString(header, value, offset, length, label) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength > length) throw new Error(`${label} is too long for ustar`);
  bytes.copy(header, offset);
}

function octal(value, length, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
  const encoded = value.toString(8);
  if (encoded.length > length - 1) throw new Error(`${label} is too large for ustar`);
  return `${encoded.padStart(length - 1, "0")}\0`;
}

function tarHeader(entry) {
  const header = Buffer.alloc(TAR_BLOCK_BYTES, 0);
  const names = splitTarName(entry.name);
  writeString(header, names.name, 0, 100, "Archive name");
  writeString(header, octal(entry.type === "directory" ? 0o755 : 0o644, 8, "Archive mode"), 100, 8, "Archive mode");
  writeString(header, octal(0, 8, "Archive uid"), 108, 8, "Archive uid");
  writeString(header, octal(0, 8, "Archive gid"), 116, 8, "Archive gid");
  writeString(header, octal(entry.bytes.byteLength, 12, "Archive size"), 124, 12, "Archive size");
  writeString(header, octal(0, 12, "Archive mtime"), 136, 12, "Archive mtime");
  header.fill(0x20, 148, 156);
  header[156] = entry.type === "directory" ? 0x35 : 0x30;
  writeString(header, "ustar\0", 257, 6, "Archive magic");
  writeString(header, "00", 263, 2, "Archive version");
  writeString(header, "root", 265, 32, "Archive owner");
  writeString(header, "root", 297, 32, "Archive group");
  writeString(header, octal(0, 8, "Archive device major"), 329, 8, "Archive device major");
  writeString(header, octal(0, 8, "Archive device minor"), 337, 8, "Archive device minor");
  writeString(header, names.prefix, 345, 155, "Archive prefix");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeString(header, `${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "Archive checksum");
  return header;
}

function createTar(entries) {
  const chunks = [];
  for (const entry of [...entries].sort((left, right) => compareNames(left.name, right.name))) {
    chunks.push(tarHeader(entry));
    if (entry.bytes.byteLength > 0) {
      chunks.push(entry.bytes);
      const padding = (TAR_BLOCK_BYTES - (entry.bytes.byteLength % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
      if (padding) chunks.push(Buffer.alloc(padding, 0));
    }
  }
  chunks.push(Buffer.alloc(TAR_BLOCK_BYTES * 2, 0));
  return Buffer.concat(chunks);
}

function createGzip(tar) {
  const archive = gzipSync(tar, { level: 9, mtime: 0 });
  archive.writeUInt32LE(0, 4);
  archive[9] = 255;
  return archive;
}

function parseOctal(header, offset, length, label) {
  const raw = header.subarray(offset, offset + length).toString("ascii").replace(/[\0 ]+$/u, "");
  if (!/^[0-7]+$/u.test(raw)) throw new Error(`${label} is not valid octal`);
  return Number.parseInt(raw, 8);
}

function parseTar(tar) {
  const entries = new Map();
  let offset = 0;
  let zeroBlocks = 0;
  while (offset + TAR_BLOCK_BYTES <= tar.byteLength) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_BYTES);
    offset += TAR_BLOCK_BYTES;
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      if (zeroBlocks === 2) break;
      continue;
    }
    zeroBlocks = 0;
    const expectedChecksum = parseOctal(header, 148, 8, "Archive checksum");
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (actualChecksum !== expectedChecksum) throw new Error("Release archive checksum is invalid");
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/su, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/su, "");
    const fullName = prefix ? `${prefix}/${name}` : name;
    if (!fullName.startsWith(`${RELEASE_PREFIX}/`) || fullName.split("/").includes("..")) {
      throw new Error("Release archive contains an unsafe path");
    }
    if (entries.has(fullName)) throw new Error("Release archive contains a duplicate path");
    const type = String.fromCharCode(header[156]);
    if (!["0", "5"].includes(type)) throw new Error("Release archive contains an unsupported entry type");
    if (parseOctal(header, 108, 8, "Archive uid") !== 0
      || parseOctal(header, 116, 8, "Archive gid") !== 0
      || parseOctal(header, 136, 12, "Archive mtime") !== 0) {
      throw new Error("Release archive identity fields are not normalized");
    }
    const size = parseOctal(header, 124, 12, "Archive size");
    if (type === "5" && size !== 0) throw new Error("Release archive directory has content");
    if (offset + size > tar.byteLength) throw new Error("Release archive is truncated");
    const bytes = Buffer.from(tar.subarray(offset, offset + size));
    entries.set(fullName, { type, bytes });
    offset += size + ((TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES);
  }
  if (zeroBlocks !== 2 || offset !== tar.byteLength) throw new Error("Release archive trailer is invalid");
  return entries;
}

function readSbomInputHash(sbom, path) {
  const prefix = `${path}:`;
  const property = sbom?.metadata?.component?.properties?.find((candidate) =>
    candidate?.name === "castingcompass:input-sha256"
      && typeof candidate.value === "string"
      && candidate.value.startsWith(prefix));
  const value = property?.value?.slice(prefix.length);
  if (!/^[a-f0-9]{64}$/u.test(value ?? "")) {
    throw new Error(`Release SBOM is not bound to ${path}`);
  }
  return value;
}

function outputNames(commitSha) {
  return {
    bundle: `castingcompass-worker-${commitSha}.tar.gz`,
    manifest: `castingcompass-worker-${commitSha}.manifest.json`,
    sbom: `castingcompass-worker-${commitSha}.sbom.cdx.json`,
    checksums: "SHA256SUMS",
  };
}

function assertOutputDirectory(outputDirectory) {
  const parent = dirname(outputDirectory);
  mkdirSync(parent, { recursive: true, mode: 0o755 });
  if (existsSync(outputDirectory)) {
    if (!lstatSync(outputDirectory).isDirectory() || readdirSync(outputDirectory).length !== 0) {
      throw new Error("Release output directory must be absent or empty");
    }
  } else {
    mkdirSync(outputDirectory, { mode: 0o755 });
  }
}

export function createReleaseArtifacts({
  sourceRoot = root,
  outputDirectory,
  commitSha,
  repository,
  nodeVersion,
  npmVersion,
}) {
  const source = resolve(sourceRoot);
  const output = resolve(outputDirectory);
  const commit = strictCommit(commitSha);
  const repo = strictRepository(repository);
  const exactNode = strictVersion(nodeVersion, "Node version");
  const exactNpm = strictVersion(npmVersion, "npm version");
  assertOutputDirectory(output);

  const packageLock = readFileSync(join(source, "package-lock.json"));
  const sbomBytes = readFileSync(join(source, "security/release-sbom.cdx.json"));
  let sbom;
  try {
    sbom = JSON.parse(sbomBytes.toString("utf8"));
  } catch {
    throw new Error("Release SBOM is not valid JSON");
  }
  const packageLockSha256 = sha256(packageLock);
  for (const path of releaseSbomInputs) {
    if (readSbomInputHash(sbom, path) !== sha256(readFileSync(join(source, path)))) {
      throw new Error(`Release SBOM does not match ${path}`);
    }
  }

  const entries = [];
  entries.push({ name: `${RELEASE_PREFIX}/`, type: "directory", bytes: Buffer.alloc(0) });
  for (const [sourcePath, targetPath] of sourcePaths) {
    collectEntries(source, sourcePath, targetPath, entries);
  }
  const identity = {
    schema_version: RELEASE_IDENTITY_VERSION,
    repository: repo,
    commit_sha: commit,
    node_version: exactNode,
    npm_version: exactNpm,
    source_date_epoch: 0,
    cloudflare_build: {
      CASTINGCOMPASS_CLOUDFLARE_BUILD: "1",
      NEXT_PUBLIC_API_URL: "",
      NEXT_PUBLIC_PHOTO_UPLOADS: "false",
    },
  };
  entries.push({
    name: `${RELEASE_PREFIX}/release-identity.json`,
    type: "file",
    bytes: Buffer.from(stableJson(identity), "utf8"),
  });

  const tar = createTar(entries);
  const bundle = createGzip(tar);
  const names = outputNames(commit);
  const fileEntries = entries.filter((entry) => entry.type === "file");
  const manifest = {
    schema_version: RELEASE_SCHEMA_VERSION,
    repository: repo,
    commit_sha: commit,
    bundle_filename: names.bundle,
    bundle_sha256: sha256(bundle),
    bundle_bytes: bundle.byteLength,
    uncompressed_tar_sha256: sha256(tar),
    archived_file_count: fileEntries.length,
    sbom_filename: names.sbom,
    sbom_sha256: sha256(sbomBytes),
    package_lock_sha256: packageLockSha256,
    node_version: exactNode,
    npm_version: exactNpm,
  };
  const manifestBytes = Buffer.from(stableJson(manifest), "utf8");
  const outputFiles = new Map([
    [names.bundle, bundle],
    [names.manifest, manifestBytes],
    [names.sbom, sbomBytes],
  ]);
  const checksumLines = [...outputFiles.entries()]
    .sort(([left], [right]) => compareNames(left, right))
    .map(([filename, bytes]) => `${sha256(bytes)} *${filename}`);
  outputFiles.set(names.checksums, Buffer.from(`${checksumLines.join("\n")}\n`, "utf8"));
  for (const [filename, bytes] of outputFiles) {
    const path = join(output, filename);
    writeFileSync(path, bytes, { flag: "wx", mode: 0o644 });
    chmodSync(path, 0o644);
  }
  return verifyReleaseArtifacts({ outputDirectory: output, commitSha: commit, repository: repo });
}

export function verifyReleaseArtifacts({ outputDirectory, commitSha, repository }) {
  const output = resolve(outputDirectory);
  const commit = strictCommit(commitSha);
  const repo = strictRepository(repository);
  const names = outputNames(commit);
  const expectedFiles = Object.values(names).sort(compareNames);
  const actualFiles = readdirSync(output).sort(compareNames);
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error("Release artifact file set is invalid");
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(output, names.manifest), "utf8"));
  } catch {
    throw new Error("Release artifact manifest is not valid JSON");
  }
  exactKeys(manifest, [
    "schema_version", "repository", "commit_sha", "bundle_filename", "bundle_sha256",
    "bundle_bytes", "uncompressed_tar_sha256", "archived_file_count", "sbom_filename",
    "sbom_sha256", "package_lock_sha256", "node_version", "npm_version",
  ], "Release artifact manifest");
  if (manifest.schema_version !== RELEASE_SCHEMA_VERSION
    || manifest.repository !== repo
    || manifest.commit_sha !== commit
    || manifest.bundle_filename !== names.bundle
    || manifest.sbom_filename !== names.sbom) {
    throw new Error("Release artifact manifest identity is invalid");
  }
  for (const field of ["bundle_sha256", "uncompressed_tar_sha256", "sbom_sha256", "package_lock_sha256"]) {
    if (!/^[a-f0-9]{64}$/u.test(manifest[field] ?? "")) throw new Error(`Release artifact ${field} is invalid`);
  }
  strictVersion(manifest.node_version, "Node version");
  strictVersion(manifest.npm_version, "npm version");

  const bundle = readFileSync(join(output, names.bundle));
  const sbomBytes = readFileSync(join(output, names.sbom));
  const manifestBytes = readFileSync(join(output, names.manifest));
  if (bundle.byteLength !== manifest.bundle_bytes || sha256(bundle) !== manifest.bundle_sha256) {
    throw new Error("Release bundle digest does not match its manifest");
  }
  if (sha256(sbomBytes) !== manifest.sbom_sha256) throw new Error("Release SBOM digest does not match its manifest");
  if (bundle.readUInt32LE(4) !== 0 || bundle[9] !== 255) throw new Error("Release gzip header is not normalized");

  let tar;
  try {
    tar = gunzipSync(bundle);
  } catch {
    throw new Error("Release bundle is not valid gzip data");
  }
  if (sha256(tar) !== manifest.uncompressed_tar_sha256) throw new Error("Release tar digest does not match its manifest");
  const entries = parseTar(tar);
  const identityEntry = entries.get(`${RELEASE_PREFIX}/release-identity.json`);
  if (!identityEntry || identityEntry.type !== "0") throw new Error("Release identity is missing from the bundle");
  let identity;
  try {
    identity = JSON.parse(identityEntry.bytes.toString("utf8"));
  } catch {
    throw new Error("Release identity is not valid JSON");
  }
  exactKeys(identity, [
    "schema_version", "repository", "commit_sha", "node_version", "npm_version",
    "source_date_epoch", "cloudflare_build",
  ], "Release identity");
  exactKeys(identity.cloudflare_build, [
    "CASTINGCOMPASS_CLOUDFLARE_BUILD", "NEXT_PUBLIC_API_URL", "NEXT_PUBLIC_PHOTO_UPLOADS",
  ], "Release build environment");
  if (identity.schema_version !== RELEASE_IDENTITY_VERSION
    || identity.repository !== repo
    || identity.commit_sha !== commit
    || identity.node_version !== manifest.node_version
    || identity.npm_version !== manifest.npm_version
    || identity.source_date_epoch !== 0
    || identity.cloudflare_build.CASTINGCOMPASS_CLOUDFLARE_BUILD !== "1"
    || identity.cloudflare_build.NEXT_PUBLIC_API_URL !== ""
    || identity.cloudflare_build.NEXT_PUBLIC_PHOTO_UPLOADS !== "false") {
    throw new Error("Release identity does not match its manifest or reviewed build configuration");
  }
  const requiredEntries = [
    `${RELEASE_PREFIX}/dist/server/index.js`,
    `${RELEASE_PREFIX}/dist/client/robots.txt`,
    `${RELEASE_PREFIX}/dist/client/sitemap.xml`,
    `${RELEASE_PREFIX}/drizzle/0017_trip_idempotency.sql`,
    `${RELEASE_PREFIX}/.node-version`,
    `${RELEASE_PREFIX}/.python-version`,
    `${RELEASE_PREFIX}/package-lock.json`,
    `${RELEASE_PREFIX}/pipeline/requirements-ci.lock`,
    `${RELEASE_PREFIX}/security/release-sbom.cdx.json`,
    `${RELEASE_PREFIX}/security/sbom.cdx.json`,
    `${RELEASE_PREFIX}/services/api/Dockerfile`,
    `${RELEASE_PREFIX}/services/api/requirements-runtime.lock`,
    `${RELEASE_PREFIX}/wrangler.jsonc`,
  ];
  for (const required of requiredEntries) {
    if (entries.get(required)?.type !== "0") throw new Error(`Release bundle is missing ${required}`);
  }
  const archivedSbom = entries.get(`${RELEASE_PREFIX}/security/release-sbom.cdx.json`).bytes;
  if (!archivedSbom.equals(sbomBytes)) throw new Error("Release bundle SBOM does not match the attested SBOM");
  const archivedLock = entries.get(`${RELEASE_PREFIX}/package-lock.json`).bytes;
  if (sha256(archivedLock) !== manifest.package_lock_sha256) throw new Error("Release bundle lock does not match its manifest");
  if ([...entries.values()].filter((entry) => entry.type === "0").length !== manifest.archived_file_count) {
    throw new Error("Release bundle file count does not match its manifest");
  }

  const checksumInputs = new Map([
    [names.bundle, bundle],
    [names.manifest, manifestBytes],
    [names.sbom, sbomBytes],
  ]);
  const expectedChecksums = [...checksumInputs.entries()]
    .sort(([left], [right]) => compareNames(left, right))
    .map(([filename, bytes]) => `${sha256(bytes)} *${filename}`)
    .join("\n") + "\n";
  if (readFileSync(join(output, names.checksums), "utf8") !== expectedChecksums) {
    throw new Error("Release checksums are invalid");
  }
  return manifest;
}

function parseArguments(argv) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["--write", "--verify"].includes(argument)) {
      flags.add(argument);
      continue;
    }
    if (!argument.startsWith("--") || index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
      throw new Error(`Invalid release-artifact argument: ${argument}`);
    }
    if (values.has(argument)) throw new Error(`Duplicate release-artifact argument: ${argument}`);
    values.set(argument, argv[index + 1]);
    index += 1;
  }
  if (flags.size !== 1) throw new Error("Choose exactly one of --write or --verify");
  return { values, mode: [...flags][0] };
}

function required(values, name) {
  const value = values.get(name);
  if (!value) throw new Error(`Missing required argument: ${name}`);
  return value;
}

async function main() {
  const { values, mode } = parseArguments(process.argv.slice(2));
  const common = {
    outputDirectory: required(values, "--output-dir"),
    commitSha: required(values, "--commit"),
    repository: required(values, "--repository"),
  };
  const result = mode === "--write"
    ? createReleaseArtifacts({
      ...common,
      nodeVersion: required(values, "--node-version"),
      npmVersion: required(values, "--npm-version"),
    })
    : verifyReleaseArtifacts(common);
  console.log(JSON.stringify({
    schemaVersion: result.schema_version,
    repository: result.repository,
    commitSha: result.commit_sha,
    bundleFilename: result.bundle_filename,
    bundleSha256: result.bundle_sha256,
    sbomSha256: result.sbom_sha256,
    archivedFileCount: result.archived_file_count,
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
