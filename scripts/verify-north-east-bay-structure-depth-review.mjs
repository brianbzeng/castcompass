#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createNorthEastBayStructureDepthReviewTemplate,
  evaluateNorthEastBayStructureDepthReview,
  loadStructureDepthReviewSources,
  validateNorthEastBayStructureDepthReview,
  writeNorthEastBayStructureDepthReviewTemplate,
} from "./verify-santa-barbara-structure-depth-review.mjs";
import { requirePrivateEvidenceFile } from "./verify-santa-barbara-access-review.mjs";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function parseFlag(args, name) {
  const index = args.indexOf(name);
  requireCondition(
    index >= 0 && typeof args[index + 1] === "string" && !args[index + 1].startsWith("--"),
    `${name} is required.`,
  );
  return args[index + 1];
}

async function main() {
  const command = process.argv[2] ?? "verify-policy";
  const args = process.argv.slice(3);
  const sources = await loadStructureDepthReviewSources("north-east-bay", DEFAULT_ROOT);

  if (command === "verify-policy") {
    requireCondition(args.length === 0, "verify-policy does not accept arguments.");
    process.stdout.write(`${JSON.stringify(validateNorthEastBayStructureDepthReview(sources), null, 2)}\n`);
    return;
  }
  if (command === "print-template") {
    requireCondition(args.length === 2, "print-template requires only --expected-commit.");
    const reviewedCommit = parseFlag(args, "--expected-commit");
    process.stdout.write(`${JSON.stringify(createNorthEastBayStructureDepthReviewTemplate({
      ...sources,
      reviewedCommit,
    }), null, 2)}\n`);
    return;
  }
  if (command === "write-template") {
    requireCondition(args.length === 4, "write-template requires --output-file and --expected-commit.");
    const outputFile = parseFlag(args, "--output-file");
    const reviewedCommit = parseFlag(args, "--expected-commit");
    const receipt = await writeNorthEastBayStructureDepthReviewTemplate({
      root: DEFAULT_ROOT,
      sources,
      reviewedCommit,
      outputFile,
    });
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    return;
  }
  if (command === "evaluate") {
    requireCondition(args.length === 4, "evaluate requires --evidence-file and --expected-commit.");
    const evidenceFile = parseFlag(args, "--evidence-file");
    const expectedCommit = parseFlag(args, "--expected-commit");
    const evidenceSource = await requirePrivateEvidenceFile(DEFAULT_ROOT, evidenceFile);
    const receipt = evaluateNorthEastBayStructureDepthReview({
      ...sources,
      evidence: JSON.parse(evidenceSource.toString("utf8")),
      evidenceSource,
      expectedCommit,
    });
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    if (!receipt.structure_depth_review_accepted) process.exitCode = 1;
    return;
  }
  throw new Error(
    "Usage: verify-north-east-bay-structure-depth-review.mjs verify-policy | print-template --expected-commit <sha> | write-template --output-file <absolute-path> --expected-commit <sha> | evaluate --evidence-file <absolute-path> --expected-commit <sha>",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
