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

// V16.6.1: extended through V16.6. V16.7: extended through V16.7. This list is
// the ONLY place that decides which evals are coordinated, so adding a release
// means adding its name here and nowhere else.
export const COORDINATED_EVALS = [
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
  "eval:v16.5",
  "eval:v16.6",
  "eval:v16.7",
];

/**
 * Behaviour-specific NON-test steps carried by a few eval commands
 * (`&& node scripts/eval-*.mjs > /dev/null`). The coordinator runs the shared
 * test union ONCE and then re-executes exactly these steps, so no
 * behaviour-specific eval is lost. Anything unparseable is refused.
 */
export function extractCompanionScripts(command = "") {
  const scripts = [];
  const pattern = /node\s+(scripts\/[\w./-]+\.mjs)/g;
  for (const match of String(command).matchAll(pattern)) {
    // The bounded runner is not a companion: the coordinator already runs the
    // whole union through it, and re-running it would defeat the deduplication.
    if (match[1].endsWith("run-test-suite.mjs")) continue;
    if (!scripts.includes(match[1])) scripts.push(match[1]);
  }
  return scripts;
}

export function runCompanionScripts(scripts = []) {
  const results = [];
  const safe = new RegExp("^scripts/" + String.fromCharCode(92) + "[w./-]+" + String.fromCharCode(92) + ".mjs$");
  for (const file of scripts) {
    if (!safe.test(file)) {
      results.push({ file, ran: false, ok: false, reason: "refusing-unparseable-script" });
      continue;
    }
    const result = spawnSync(process.execPath, [file], { cwd: root, encoding: "utf8" });
    results.push({ file, ran: true, exitCode: result.status, ok: result.status === 0 });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  return results;
}

export function extractEvalFiles(scripts = {}) {
  const mapping = {};
  const companions = {};
  for (const name of COORDINATED_EVALS) {
    const command = String(scripts[name] || "");
    if (!command.includes("scripts/run-test-suite.mjs")) {
      return { ok: false, reason: `${name}: not a bounded-runner command` };
    }
    const files = command.split(/\s+/).filter((token) => token.startsWith("test/") && token.endsWith(".test.mjs"));
    if (!files.length) return { ok: false, reason: `${name}: no test files found` };
    mapping[name] = files;
    companions[name] = extractCompanionScripts(command);
  }
  // The public mapping shape is unchanged from V16.4 (`name -> string[]`).
  // Companion (non-test) scripts are exposed alongside it rather than inside it,
  // so an existing consumer can never break on the shape change.
  return { ok: true, mapping, companions };
}

/**
 * Accept BOTH mapping shapes: the legacy `{ name: string[] }` and the V16.6.1
 * `{ name: { files, companions } }`. Normalizing here keeps every existing
 * consumer (and the V16.4 contract test) working without weakening anything.
 */
function entryOf(entry) {
  if (Array.isArray(entry)) return { files: entry, companions: [] };
  return { files: entry?.files || [], companions: entry?.companions || [] };
}

export function unionFiles(mapping = {}) {
  const seen = new Set();
  const union = [];
  for (const name of COORDINATED_EVALS) {
    for (const file of entryOf(mapping[name]).files) {
      if (!seen.has(file)) {
        seen.add(file);
        union.push(file);
      }
    }
  }
  return union;
}

export function deriveEvalVerdicts(mapping = {}, failedFiles = new Set(), companionResults = [], companionMap = null) {
  const companionFailures = new Map();
  for (const row of companionResults) {
    if (row && row.ran === true && row.ok !== true) companionFailures.set(row.file, row);
  }
  const verdicts = {};
  for (const [name, rawEntry] of Object.entries(mapping)) {
    const declared = companionMap?.[name];
    const entry = entryOf(rawEntry);
    if (Array.isArray(declared) && declared.length) entry.companions = declared;
    const files = entry.files;
    const failed = files.filter((file) => failedFiles.has(file));
    // A behaviour-specific companion eval is PART of its parent eval's verdict.
    // Losing it would silently drop coverage, so it fails the parent.
    const companions = entry.companions.map((file) => ({
      file,
      pass: !companionFailures.has(file),
    }));
    const companionFailed = companions.filter((row) => !row.pass);
    verdicts[name] = {
      pass: failed.length === 0 && companionFailed.length === 0,
      failed,
      companions,
      files: files.length,
    };
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
  const total = Object.values(parsed.mapping).reduce((sum, files) => sum + entryOf(files).files.length, 0);
  const companionScripts = [...new Set(Object.values(parsed.companions || {}).flat())];
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
  console.log(`Companion (non-test) evals: ${companionScripts.length ? companionScripts.join(", ") : "none"}`);
  const companionResults = runCompanionScripts(companionScripts);
  const verdicts = deriveEvalVerdicts(parsed.mapping, failed, companionResults, parsed.companions || {});
  const receiptDir = path.join(root, ".ues-work", "release-coordinator");
  await mkdir(receiptDir, { recursive: true });
  const receipt = {
    schemaVersion: 1,
    at: new Date().toISOString(),
    unionFiles: union,
    unionSize: union.length,
    companionScripts,
    companionResults,
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
    const detail = [
      verdict.failed.length ? `failed: ${verdict.failed.join(", ")}` : "",
      (verdict.companions || []).filter((row) => !row.pass).map((row) => `companion failed: ${row.file}`).join(", "),
    ].filter(Boolean).join("; ");
    console.log(`  ${verdict.pass ? "PASS" : "FAIL"} ${name} (${verdict.files} files)${detail ? ` - ${detail}` : ""}`);
  }
  const allPass = Object.values(verdicts).every((v) => v.pass) && result.status === 0;
  process.exit(allPass ? 0 : 1);
}
