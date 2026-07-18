import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const threatModel = readFileSync("docs/THREAT_MODEL.md", "utf8");
const roadmap = readFileSync("docs/PRODUCT_ROADMAP.md", "utf8");
const dashboard = readFileSync("docs/GOAL_STATUS.md", "utf8");
const readme = readFileSync("README.md", "utf8");

const EXPECTED_LAYERS = [
  "Security-first prompts",
  "IDE and repository scanning",
  "Dependency integrity",
  "Static application security testing",
  "AI post-generation review",
  "Managed authentication",
  "Strict access controls / RBAC / ABAC",
  "Input sanitization and parameterized queries",
  "Secrets management",
  "Dynamic application security testing",
  "API rate limiting",
  "DDoS and traffic filtering",
  "Runtime threat defense",
];

test("owner-supplied security references retain integrity receipts and all 13 layers", () => {
  for (const digest of [
    "6c903ecfb6841f84902847bf35eb91c8a776bf6d0c31950ccfea4f85dc65e535",
    "439bdec67066301258b306b94f1d4ae4e78a1e804a53f1e90c11b6e9b26f7795",
    "2fceefee494a36222b6c6a02b723da18c8b1a37f917dbd3468ca460f31886996",
  ]) {
    assert.match(threatModel, new RegExp(`\\b${digest}\\b`));
  }

  const sections = [...threatModel.matchAll(/^### L(\d{2}) — (.+)$/gm)];
  assert.deepEqual(
    sections.map((match) => match[1]),
    Array.from({ length: 13 }, (_, index) => String(index + 1).padStart(2, "0")),
  );
  assert.deepEqual(sections.map((match) => match[2]), EXPECTED_LAYERS);
});

test("every security layer records owner, state, evidence, alert, recovery, residual risk, and next gate", () => {
  const sections = [...threatModel.matchAll(/^### L(\d{2}) — (.+)$/gm)];

  for (const [index, section] of sections.entries()) {
    const start = section.index;
    const end = sections[index + 1]?.index ?? threatModel.indexOf("\n## Attack register", start);
    const body = threatModel.slice(start, end);
    for (const field of [
      "Reference intent",
      "Owner",
      "State",
      "Evidence",
      "Alert",
      "Recovery",
      "Residual risk",
      "Next gate",
    ]) {
      assert.match(body, new RegExp(`^- \\*\\*${field}:\\*\\*`, "m"), `L${section[1]} missing ${field}`);
    }
    assert.match(
      body,
      /^- \*\*State:\*\* (?:accepted-local|provider-evidenced|partial|open)\.$/m,
      `L${section[1]} has an unknown state`,
    );
  }
});

test("threat model keeps unexercised production controls visibly open", () => {
  assert.match(threatModel, /Cloudflare remains paused/i);
  assert.match(threatModel, /### L10 — Dynamic application security testing[\s\S]+?- \*\*State:\*\* open\./);
  assert.match(threatModel, /### L12 — DDoS and traffic filtering[\s\S]+?- \*\*State:\*\* open\./);
  assert.match(threatModel, /Never target `castingcompass\.com`/);
  assert.match(threatModel, /does \*\*not\*\* complete the parent defense-in-depth/);
});

test("roadmap and owner dashboard link the completed mapping without closing production security", () => {
  assert.match(roadmap, /- \[x\] Map the owner's security-layer reference images into the threat model/);
  assert.match(
    roadmap,
    /L10\s+dynamic testing, L12 edge filtering, and L13 live detection remain open or partial/i,
  );
  assert.match(
    dashboard,
    /13-layer owner reference mapping and zero-execution\s+npm install-script boundary are locally complete/i,
  );
  assert.match(dashboard, /production\/provider\/staging gates remain/i);
  assert.match(readme, /\[threat model and 13-layer security map\]\(docs\/THREAT_MODEL\.md\)/);
});
