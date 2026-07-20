#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const modulePath = fileURLToPath(import.meta.url);
const root = resolve(dirname(modulePath), "..");
const outputPath = resolve(root, "security/d1-query-inventory.json");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return walk(path);
      return entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name) ? [path] : [];
    })
    .sort();
}

function sourceLine(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function enclosingFunction(sourceFile, node) {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isMethodDeclaration(current) && current.name) return current.name.getText(sourceFile);
    if (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) {
      const parent = current.parent;
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
      if (ts.isPropertyAssignment(parent)) return parent.name.getText(sourceFile);
      if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression)) {
        return `${parent.expression.name.text}-callback`;
      }
    }
    current = current.parent;
  }
  return "module";
}

function executionMode(node) {
  let current = node.parent;
  while (current) {
    if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
      const name = current.expression.name.text;
      if (["all", "batch", "first", "raw", "run"].includes(name)) return name;
    }
    if (ts.isReturnStatement(current)) return "returned-statement";
    if (ts.isVariableStatement(current) || ts.isExpressionStatement(current)) break;
    current = current.parent;
  }
  return "prepared-statement";
}

function normalizedSql(argument) {
  if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
    return argument.text.replace(/\s+/gu, " ").trim();
  }
  return null;
}

function statementClass(sql) {
  return sql?.match(/^([A-Za-z]+)/u)?.[1]?.toUpperCase() ?? "UNRESOLVED";
}

function referencedTables(sql) {
  if (!sql) return [];
  const tables = new Set();
  const pattern = /\b(?:DELETE\s+FROM|FROM|INSERT(?:\s+OR\s+IGNORE)?\s+INTO|JOIN|UPDATE|TABLE(?:\s+IF\s+NOT\s+EXISTS)?)\s+[`"]?([A-Za-z_][A-Za-z0-9_]*)/giu;
  for (const match of sql.matchAll(pattern)) tables.add(match[1]);
  return [...tables].sort();
}

function declarationReference(sourceFile, argument, declarations) {
  if (!ts.isIdentifier(argument)) return null;
  const candidates = declarations
    .filter(({ name, position }) => name === argument.text && position < argument.getStart(sourceFile))
    .sort((left, right) => right.position - left.position);
  const declaration = candidates[0];
  if (!declaration) return { name: argument.text, declarationLine: null, initializerSha256: null };
  return {
    name: argument.text,
    declarationLine: declaration.line,
    initializerSha256: declaration.initializer ? sha256(declaration.initializer) : null,
  };
}

export function discoverInventory(rootDirectory = root) {
  const workerRoot = resolve(rootDirectory, "worker");
  const discoveredFiles = [];
  const records = [];

  for (const absolutePath of walk(workerRoot)) {
    const file = relative(rootDirectory, absolutePath).replaceAll("\\", "/");
    const source = readFileSync(absolutePath, "utf8");
    const scriptKind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind);
    const declarations = [];

    function collectDeclarations(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        declarations.push({
          name: node.name.text,
          position: node.getStart(sourceFile),
          line: sourceLine(sourceFile, node),
          initializer: node.initializer?.getText(sourceFile) ?? null,
        });
      }
      ts.forEachChild(node, collectDeclarations);
    }
    collectDeclarations(sourceFile);

    const fileRecords = [];
    function visit(node) {
      if (ts.isElementAccessExpression(node)
        && (ts.isStringLiteral(node.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))
        && node.argumentExpression.text === "prepare") {
        throw new Error(`${file}:${sourceLine(sourceFile, node)} uses computed D1 prepare access; use an auditable .prepare() call`);
      }
      if (ts.isPropertyAccessExpression(node) && node.name.text === "prepare"
        && (!ts.isCallExpression(node.parent) || node.parent.expression !== node)) {
        throw new Error(`${file}:${sourceLine(sourceFile, node)} aliases D1 prepare; call .prepare() directly so the SQL remains auditable`);
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "prepare") {
        const argument = node.arguments[0];
        if (!argument || node.arguments.length !== 1) {
          throw new Error(`${file}:${sourceLine(sourceFile, node)} must call prepare() with exactly one SQL argument`);
        }
        const expression = argument.getText(sourceFile);
        const sql = normalizedSql(argument);
        const klass = statementClass(sql);
        const line = sourceLine(sourceFile, node);
        const occurrence = fileRecords.length + 1;
        const expressionSha256 = sha256(expression);
        const record = {
          callSiteId: sha256(`${file}\0${occurrence}\0${enclosingFunction(sourceFile, node)}\0${expressionSha256}`).slice(0, 24),
          file,
          line,
          containingFunction: enclosingFunction(sourceFile, node),
          occurrence,
          executionMode: executionMode(node),
          argumentKind: sql === null ? "reviewed-nonliteral" : "literal",
          expression,
          expressionSha256,
          declarationReference: declarationReference(sourceFile, argument, declarations),
          statementClass: klass,
          sql,
          sqlSha256: sql ? sha256(sql) : null,
          tables: referencedTables(sql),
          placeholderCount: sql ? [...sql.matchAll(/\?/gu)].length : null,
          hasWhere: sql ? /\bWHERE\b/iu.test(sql) : null,
          hasOrderBy: sql ? /\bORDER\s+BY\b/iu.test(sql) : null,
          hasLimit: sql ? /\bLIMIT\b/iu.test(sql) : null,
        };
        fileRecords.push(record);
        records.push(record);
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    if (fileRecords.length > 0) {
      discoveredFiles.push({ file, sha256: sha256(source), prepareCallCount: fileRecords.length });
    }
  }

  const policyBytes = readFileSync(resolve(rootDirectory, "security/d1-query-inventory-policy.json"));
  const policy = JSON.parse(policyBytes.toString("utf8"));
  return {
    policy,
    inventory: {
      schemaVersion: "castingcompass.d1-query-inventory/1.0.0",
      generatedFrom: "TypeScript AST; no runtime or provider query executed",
      policySha256: sha256(policyBytes),
      sourceFiles: discoveredFiles,
      summary: {
        prepareCallCount: records.length,
        literalCallCount: records.filter(({ argumentKind }) => argumentKind === "literal").length,
        nonLiteralCallCount: records.filter(({ argumentKind }) => argumentKind === "reviewed-nonliteral").length,
        multiRowLiteralWithoutLimitCount: records.filter((record) => (
          record.executionMode === "all" && record.statementClass === "SELECT" && !record.hasLimit
        )).length,
      },
      queries: records,
    },
  };
}

function policyKey(entry) {
  return `${entry.file}\0${entry.expressionSha256}`;
}

export function validatePolicy(policy, inventory) {
  if (policy.schemaVersion !== "castingcompass.d1-query-inventory-policy/1.0.0") {
    throw new Error("D1 query inventory policy version is not accepted");
  }
  const expectedFiles = [...policy.sourceFiles].sort();
  const actualFiles = inventory.sourceFiles.map(({ file }) => file).sort();
  if (JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles)) {
    throw new Error(`D1 query source file inventory drifted: expected ${expectedFiles.join(", ")}; got ${actualFiles.join(", ")}`);
  }
  for (const [name, actual] of Object.entries(inventory.summary)) {
    if (policy.expectedSummary[name] !== actual) {
      throw new Error(`D1 query inventory ${name} drifted: expected ${policy.expectedSummary[name]}; got ${actual}`);
    }
  }

  const actualNonLiteral = new Map(inventory.queries
    .filter(({ argumentKind }) => argumentKind === "reviewed-nonliteral")
    .map((entry) => [policyKey(entry), entry]));
  if (actualNonLiteral.size !== inventory.summary.nonLiteralCallCount) {
    throw new Error("nonliteral D1 expressions must be unique per file so every reviewed policy entry maps to one call site");
  }
  const allowedNonLiteral = new Map(policy.allowedNonLiteralExpressions.map((entry) => [policyKey(entry), entry]));
  if (allowedNonLiteral.size !== policy.allowedNonLiteralExpressions.length) {
    throw new Error("D1 query inventory policy contains duplicate nonliteral expression entries");
  }
  for (const [key, query] of actualNonLiteral) {
    const accepted = allowedNonLiteral.get(key);
    if (!accepted) throw new Error(`${query.file}:${query.line} has an unreviewed nonliteral SQL expression`);
    if (!accepted.rationale || !accepted.staticAuthority || !accepted.executionContract) {
      throw new Error(`${query.file}:${query.line} has an incomplete nonliteral SQL review`);
    }
  }
  for (const [key, accepted] of allowedNonLiteral) {
    if (!actualNonLiteral.has(key)) throw new Error(`stale nonliteral SQL review for ${accepted.file}:${accepted.expressionSha256}`);
  }

  const unsafeWrites = inventory.queries.filter((query) => (
    ["DELETE", "UPDATE"].includes(query.statementClass) && !query.hasWhere
  ));
  if (unsafeWrites.length > 0) {
    throw new Error(`unscoped D1 write query: ${unsafeWrites.map(({ file, line }) => `${file}:${line}`).join(", ")}`);
  }

  const actualMultiRow = new Map(inventory.queries
    .filter((query) => query.executionMode === "all" && query.statementClass === "SELECT" && !query.hasLimit)
    .map((query) => [query.callSiteId, query]));
  const acceptedMultiRow = new Map(policy.multiRowReadContracts.map((entry) => [entry.callSiteId, entry]));
  if (acceptedMultiRow.size !== policy.multiRowReadContracts.length) {
    throw new Error("D1 query inventory policy contains duplicate multi-row read entries");
  }
  for (const [callSiteId, query] of actualMultiRow) {
    const contract = acceptedMultiRow.get(callSiteId);
    if (!contract) throw new Error(`${query.file}:${query.line} has an unreviewed multi-row read without LIMIT`);
    if (!contract.boundPredicate || !contract.scope || !contract.rationale || !contract.rowBoundStatus) {
      throw new Error(`${query.file}:${query.line} has an incomplete multi-row read contract`);
    }
    if (!["complete-rights-export", "open-account-cardinality", "owner-lifecycle-cleanup"].includes(contract.rowBoundStatus)) {
      throw new Error(`${query.file}:${query.line} has an unknown multi-row read bound status`);
    }
    if (contract.sqlSha256 !== query.sqlSha256) {
      throw new Error(`${query.file}:${query.line} multi-row read SQL identity drifted`);
    }
    if (!query.hasWhere || !query.sql.includes(contract.boundPredicate)) {
      throw new Error(`${query.file}:${query.line} does not contain its reviewed bound predicate`);
    }
  }
  for (const [callSiteId] of acceptedMultiRow) {
    if (!actualMultiRow.has(callSiteId)) throw new Error(`stale multi-row D1 read contract for ${callSiteId}`);
  }
}

function discoveryPayload(inventory) {
  return {
    acceptance: false,
    inventory,
    nonLiteralPolicyTemplate: inventory.queries
      .filter(({ argumentKind }) => argumentKind === "reviewed-nonliteral")
      .map(({ file, line, expressionSha256, expression, executionMode }) => ({
        file, line, expressionSha256, expression, executionMode,
      })),
    multiRowReadPolicyTemplate: [...new Map(inventory.queries
      .filter((query) => query.executionMode === "all" && query.statementClass === "SELECT" && !query.hasLimit)
      .map((query) => [query.callSiteId, query])).values()]
      .map(({ callSiteId, file, line, containingFunction, sqlSha256, sql, tables }) => ({
        callSiteId, file, line, containingFunction, sqlSha256, sql, tables,
      })),
  };
}

export function run(mode = process.argv[2] ?? "--stdout") {
  if (!["--check", "--discover", "--stdout", "--write"].includes(mode) || process.argv.length > 3) {
    throw new Error("Usage: node scripts/generate-d1-query-inventory.mjs [--check|--discover|--stdout|--write]");
  }
  const { policy, inventory } = discoverInventory();
  if (mode === "--discover") {
    process.stdout.write(canonicalJson(discoveryPayload(inventory)));
    return;
  }

  validatePolicy(policy, inventory);
  const output = canonicalJson(inventory);
  if (mode === "--check") {
    const existing = readFileSync(outputPath, "utf8");
    if (existing !== output) {
      console.error("D1 query inventory is stale; run npm run security:d1-query-inventory:write");
      process.exit(1);
    }
  } else if (mode === "--write") {
    writeFileSync(outputPath, output, { encoding: "utf8", mode: 0o644 });
  } else {
    process.stdout.write(output);
  }

  if (mode === "--check") {
    console.log(`D1 query inventory verified: ${inventory.summary.prepareCallCount} prepare sites, ${inventory.summary.nonLiteralCallCount} reviewed nonliteral expressions, ${inventory.summary.multiRowLiteralWithoutLimitCount} reviewed multi-row reads.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === modulePath) {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
