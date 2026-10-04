import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(path.join(root, "README.md"), "utf8");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const lines = readme.split(/\r?\n/);

test("README: the current package version is stated and matches package.json", () => {
  assert.ok(readme.includes(`version **${pkg.version}**`), "README must state the current package version");
  assert.ok(readme.includes(`<!-- ues-version: ${pkg.version} -->`), "README must carry a machine-readable version marker");
});

test("README: answers what/why/how-to-start in the documented order", () => {
  const order = ["## What is UES?", "## Why UES?", "## Highlights", "## Architecture", "## Quick Start"];
  const positions = order.map((heading) => readme.indexOf(heading));
  for (let i = 0; i < positions.length; i += 1) {
    assert.ok(positions[i] > 0, `${order[i]} is missing`);
    if (i > 0) assert.ok(positions[i] > positions[i - 1], `${order[i]} must come after ${order[i - 1]}`);
  }
  // The landing page must reach the install + verify commands early.
  const quickStartLine = lines.findIndex((line) => line === "## Quick Start");
  assert.ok(quickStartLine > 0 && quickStartLine < lines.length * 0.45, `Quick Start at line ${quickStartLine}`);
  const quickStart = readme.slice(positions[4], readme.indexOf("## How It Works"));
  assert.ok(quickStart.includes("npm install -g opencode-agent-skill"), "install command must be in Quick Start");
  assert.ok(quickStart.includes("ues version"), "verify command must be in Quick Start");
  assert.ok(quickStart.includes("pi package add opencode-agent-skill"));
  assert.ok(quickStart.includes("Node.js **>= 22.19**"));
});

test("README: the required professional sections are present exactly once", () => {
  const required = [
    "## What is UES?",
    "## Why UES?",
    "## Highlights",
    "## Architecture",
    "## Quick Start",
    "## How It Works",
    "## DeepSeek Web Reasoning",
    "## Safety Model",
    "## Performance & Measurement",
    "## Commands",
    "## Project Structure",
    "## Documentation",
    "## Development",
    "## Release Philosophy",
    "## License",
  ];
  for (const heading of required) {
    const count = lines.filter((line) => line === heading).length;
    assert.equal(count, 1, `${heading} appears ${count} times`);
  }
});

test("README: is a professional landing page, not project archaeology", () => {
  assert.ok(lines.length <= 450, `README has ${lines.length} lines; target is 250-450`);
  // No per-version release dump, no giant table of contents.
  const releaseBullets = lines.filter((line) => /^>\s*\*\*\d+\.\d+\.\d+/.test(line));
  assert.equal(releaseBullets.length, 0, "README must not contain per-version release bullets");
  assert.ok(!readme.includes("## Mục lục"), "Vietnamese table of contents must be gone");
  assert.equal(/^- \[\d+\. /.test(readme) === false && readme.includes("1. [UES"), false);
  // Table of contents style numbered link lists are gone.
  assert.ok(!/\n\d+\.\s+\[[^\]]+\]\(#[^)]+\)/.test(readme), "README must not contain a numbered TOC list");
});

test("README: keeps truthful capability statements and drops hype", () => {
  const banned = [
    "makes weak models as strong",
    "guaranteed",
    "zero bugs",
    "perfect",
    "magically equivalent",
  ];
  for (const phrase of banned) {
    assert.ok(!readme.toLowerCase().includes(phrase), `README must not claim: ${phrase}`);
  }
  assert.ok(readme.includes("does **not** make a weaker model equivalent to a frontier model"));
});

test("README: measurement provenance is explicit", () => {
  for (const token of ["MEASURED", "DERIVED_FROM_MEASURED", "NOT_MEASURED"]) {
    assert.ok(readme.includes(token), token);
  }
  assert.ok(readme.includes("Deterministic tests are **not** a model-performance proof"));
  assert.ok(!/\d+% faster/i.test(readme), "README must not claim an unmeasured speedup");
});

test("README: every relative link resolves", () => {
  const links = [...readme.matchAll(/\]\((\.[^)]+)\)/g)].map((match) => match[1]);
  assert.ok(links.length > 5, "expected documentation links");
  for (const link of links) {
    const target = path.resolve(root, link);
    assert.ok(existsSync(target), `broken README link: ${link}`);
  }
});

test("README: install and verify commands are correct", () => {
  assert.ok(readme.includes("npm install -g opencode-agent-skill"));
  assert.ok(readme.includes("Node.js **>= 22.19**") || readme.includes(">= 22.19"));
  assert.ok(readme.includes("ues version"));
  assert.ok(readme.includes("ues doctor --reasoning"));
  assert.ok(readme.includes("pi package add opencode-agent-skill"));
  for (const command of ["ues status", "ues optimize-report", "ues trial", "npm run eval:v16.5"]) {
    assert.ok(readme.includes(command), `README must document ${command}`);
  }
});

test("README: badges are accurate for this repository", () => {
  const badges = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]);
  assert.ok(badges.length <= 5, `README has ${badges.length} badges; keep the badge wall small`);
  assert.ok(badges.some((url) => url.includes("npm/v/opencode-agent-skill")));
  assert.ok(badges.some((url) => url.includes("node")));
  assert.ok(badges.some((url) => url.includes("license")));
  for (const url of badges) {
    assert.ok(url.startsWith("http") || url.startsWith("./"), url);
  }
});

test("README: documents the V16.5 design doc and the research notes", () => {
  assert.ok(readme.includes("docs/V16.5-AGENT-SKILL-DELEGATION.md"));
  assert.ok(existsSync(path.join(root, "docs", "V16.5-AGENT-SKILL-DELEGATION.md")));
  assert.ok(existsSync(path.join(root, "docs", "V16.5-RESEARCH-NOTES.md")));
});

test("CHANGELOG and history were preserved, not deleted", () => {
  const changelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  assert.ok(changelog.includes("## [16.4.0]"));
  assert.ok(changelog.includes("## [16.3.0]"));
  assert.ok(changelog.includes("## [16.0.0]"));
  assert.ok(changelog.includes("## [15.6.0]"));
  assert.ok(changelog.includes("## [15.0.0]"));
  for (const doc of [
    "docs/V7-INTELLIGENCE-RUNTIME.md",
    "docs/V11-PERCEPTION-ADAPTIVE.md",
    "docs/V14-CONTEXT-MEMORY-FABRIC.md",
    "docs/V15-MANAGED-RUNTIME.md",
    "docs/V16-DETERMINISTIC-HARDENING.md",
    "docs/V16.3-BROWSER-WEB-REASONING.md",
    "docs/V16.4-MEASURED-ADAPTIVE-RUNTIME.md",
  ]) {
    assert.ok(existsSync(path.join(root, doc)), `historical doc must remain: ${doc}`);
  }
});
