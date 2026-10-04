#!/usr/bin/env node

// V16.4 Slice I (part 2): release test coordinator.
//
// `release:verify` historically runs `npm test` plus a chain of focused evals
// with heavy file overlap. This coordinator reads the required test files from
// package.json eval scripts, runs each file ONCE, saves a per-file receipt,
// and derives every eval verdict from the union run.
//
// Focused commands (`npm run eval:v16`, ...) are untouched and still run
// standalone. If the mapping cannot be parsed deterministically the
// coordinator fails closed and tells the caller to run the legacy chain.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const pkg = require(path.join(root, "package.json"));

const COORDINATED_EVALS = [
  "eval:v15",
  "eval:v15.4",
  "eval:v15.5",
  "eval:v15.6",
  "eval:v15.7",
  "eval:v15.8",
  "eval:v15.9",
  "eval:v16",
  "eval:v16.3",
  "eval:v16.4",
];

export function extractEvalFiles(scripts = {}) {
  const mapping = {};
  for (const name of COORDINATED_EVALS) {
    const command = String(scripts[name] || "");
    if (!command.includes("scripts/run-test-suite.mjs")) {
      return { ok: false, reason: `${name}: not a bounded-runner command` };
    }
    const files = command.split(/\s+/).filter((token) => token.startsWith("test/") && token.endsWith(".test.mjs"));
    if (!files.length) return { ok: false, reason: `${name}: no test files found` };
    mapping[name] = files;
  }
  return { ok: true, mapping };
}

export function unionFiles(mapping = {}) {
  const seen = new Set();
  const union = [];
  for (const name of COORDINATED_EVALS) {
    for (const file of mapping[name] || []) {
      if (!seen.has(file)) {
        seen.add(file);
        union.push(file);
      }
    }
  }
  return union;
}

export function deriveEvalVerdicts(mapping = {}, failedFiles = new Set()) {
  const verdicts = {};
  for (const [name, files] of Object.entries(mapping)) {
    const failed = files.filter((file) => failedFiles.has(file));
    verdicts[name] = failed.length ? { pass: false, failed } : { pass: true, failed: [] };
  }
  return verdicts;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dryRun = process.argv.includes("--dry-run");
  const parsed = extractEvalFiles(pkg.scripts || {});
  if (!parsed.ok) {
    console.error(`Release coordinator mapping uncertain (${parsed.reason}); fail closed to the legacy eval chain.`);
    process.exit(2);
  }
  const union = unionFiles(parsed.mapping);
  const total = Object.values(parsed.mapping).reduce((sum, files) => sum + files.length, 0);
  console.log(`Coordinated evals: ${Object.keys(parsed.mapping).join(", ")}`);
  console.log(`Union: ${union.length} files (legacy chain would run ${total} file-slots, saving ${total - union.length}).`);
  if (dryRun) {
    for (const file of union) console.log(`  - ${file}`);
    process.exit(0);
  }
  const started = Date.now();
  const result = spawnSync(
    process.execPath,
    ["scripts/run-test-suite.mjs", "--concurrency=4", "--timeout-ms=90000", ...union],
    { cwd: root, encoding: "utf8" },
  );
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  const failed = new Set();
  for (const line of String(result.stdout || "").split("\n")) {
    const match = line.match(/^\[\d+\/\d+\]\s+(FAIL|TIMEOUT|ERROR)\s+(\S+)/);
    if (match) failed.add(match[2].replace(/\\/g, "/"));
  }
  const verdicts = deriveEvalVerdicts(parsed.mapping, failed);
  const receiptDir = path.join(root, ".ues-work", "release-coordinator");
  await mkdir(receiptDir, { recursive: true });
  const receipt = {
    schemaVersion: 1,
    at: new Date().toISOString(),
    unionFiles: union,
    unionSize: union.length,
    legacySlots: total,
    slotsSaved: total - union.length,
    wallMs: Date.now() - started,
    exitCode: result.status,
    failedFiles: [...failed],
    verdicts,
  };
  await writeFile(path.join(receiptDir, "latest.json"), JSON.stringify(receipt, null, 2));
  console.log("Per-eval verdicts:");
  for (const [name, verdict] of Object.entries(verdicts)) {
    console.log(`  ${verdict.pass ? "PASS" : "FAIL"} ${name}${verdict.failed.length ? ` (failed: ${verdict.failed.join(", ")})` : ""}`);
  }
  const allPass = Object.values(verdicts).every((v) => v.pass) && result.status === 0;
  process.exit(allPass ? 0 : 1);
}
