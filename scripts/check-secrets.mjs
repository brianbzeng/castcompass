import { execFileSync } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  readlinkSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;

// Build signatures from fragments so this scanner and its tests can be scanned too.
// Rules intentionally target provider-specific formats instead of generic passwords,
// which create noisy false positives in documentation and fixtures.
const signature = (...parts) => new RegExp(parts.join(""));
const rules = [
  {
    name: "named secret assignment",
    pattern: signature(
      "\\b(?:CLOUDFLARE_API_TOKEN|CF_API_TOKEN|MIMO_API_KEY|OBSERVABILITY_PSEUDONYM_SECRET|RESEND_API_KEY|TURNSTILE_SECRET_KEY|RATE_LIMIT_KEY_SECRET|VALIDATION_PARTICIPANT_HMAC_SECRET|VALIDATION_RECRUITMENT_HMAC_SECRET|OPENAI_API_KEY|AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|NPM_TOKEN)",
      "[\\\"']?[\\t ]*[:=][\\t ]*[\\\"']?",
      "(?!(?:replace|example|test|your)\\b)",
      "[A-Za-z0-9_./+=-]{20,}",
    ),
  },
  {
    name: "private key",
    pattern: signature("-{5}BEGIN ", "(?:(?:RSA|EC|OPENSSH|DSA) )?", "PRIVATE KEY-{5}"),
  },
  {
    name: "GitHub token",
    pattern: signature("\\bgh", "(?:p|o|u|s|r)_", "[A-Za-z0-9]{30,255}\\b"),
  },
  {
    name: "GitHub fine-grained token",
    pattern: signature("\\bgithub_", "pat_", "[A-Za-z0-9_]{40,255}\\b"),
  },
  {
    name: "npm access token",
    pattern: signature("\\bnpm_", "[A-Za-z0-9]{36}\\b"),
  },
  {
    name: "OpenAI-style API key",
    pattern: signature("\\bsk", "-(?:proj-)?", "[A-Za-z0-9_-]{24,255}\\b"),
  },
  {
    name: "Resend API key",
    pattern: signature("\\bre_", "[A-Za-z0-9]{32,255}\\b"),
  },
  {
    name: "AWS access key",
    pattern: signature("\\bA", "(?:KI|SI)A", "[0-9A-Z]{16}\\b"),
  },
  {
    name: "Google API key",
    pattern: signature("\\bAI", "za", "[A-Za-z0-9_-]{35}\\b"),
  },
  {
    name: "Slack token",
    pattern: signature("\\bxox", "[aboprs]-", "[A-Za-z0-9-]{20,255}\\b"),
  },
  {
    name: "Stripe live secret key",
    pattern: signature("\\bsk_", "live_", "[A-Za-z0-9]{16,255}\\b"),
  },
];

function lineNumberAt(content, index) {
  return content.slice(0, index).split("\n").length;
}

export function scanText(content) {
  const findings = [];
  for (const { name, pattern } of rules) {
    const match = pattern.exec(content);
    if (match) {
      findings.push({ name, line: lineNumberAt(content, match.index) });
    }
  }
  return findings;
}

function repositoryRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

function repositoryFiles(root) {
  return execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean);
}

function readReviewableText(path) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) {
    return readlinkSync(path, "utf8");
  }
  if (!metadata.isFile() || metadata.size > MAX_TEXT_FILE_BYTES) return null;

  const bytes = readFileSync(path);
  if (bytes.includes(0)) return null;
  return bytes.toString("utf8");
}

export function scanRepository(root = repositoryRoot()) {
  const files = repositoryFiles(root);
  const findings = [];
  let scannedFiles = 0;

  for (const file of files) {
    let content;
    try {
      content = readReviewableText(resolve(root, file));
    } catch (error) {
      findings.push({
        file,
        name: `unable to scan (${error instanceof Error ? error.code ?? error.name : "unknown error"})`,
      });
      continue;
    }

    if (content === null) continue;
    scannedFiles += 1;
    for (const finding of scanText(content)) {
      findings.push({ file, ...finding });
    }
  }

  return { files, findings, scannedFiles };
}

function main() {
  const { files, findings, scannedFiles } = scanRepository();
  if (findings.length > 0) {
    console.error("Potential repository secrets detected (values intentionally hidden):");
    for (const finding of findings) {
      const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
      console.error(`- ${location}: ${finding.name}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `Secret scan passed: ${scannedFiles} text files checked (${files.length} repository files considered).`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) main();
