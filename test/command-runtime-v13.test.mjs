import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  expandUesPromptAlias,
  normalizeUesPromptPaste,
  policyPromptForCli,
  UES_PROMPT_ALIASES,
} from "../global-config/plugins/ues-router/command-runtime.js"

test("V13 exposes every managed UES slash command as a V2 prompt alias", () => {
  assert.deepEqual(UES_PROMPT_ALIASES, [
    "ues-audit",
    "ues-critique",
    "ues-debug",
    "ues-feature",
    "ues-fix",
    "ues-plan",
    "ues-research",
    "ues-resume",
    "ues-review",
    "ues-run",
    "ues-verify",
  ])
})

test("V13 run template injects the user request only once", async () => {
  const source = await readFile(new URL("../global-config/commands/run.md", import.meta.url), "utf8")
  assert.equal((source.match(/\$ARGUMENTS/g) || []).length, 1)
})

test("V13 prompt alias expands command body and preserves arguments", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-command-runtime-"))
  try {
    await writeFile(
      path.join(dir, "run.md"),
      "---\ndescription: run\nagent: build\n---\n\nRun task: $ARGUMENTS\n",
      "utf8",
    )
    const result = expandUesPromptAlias("/ues-run fix payment race", dir)
    assert.equal(result.alias, "ues-run")
    assert.equal(result.arguments, "fix payment race")
    assert.equal(result.agent, "build")
    assert.match(result.text, /normal session\.prompt path/)
    assert.match(result.text, /Run task: fix payment race/)
    assert.doesNotMatch(result.text, /\$ARGUMENTS/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("V13 prompt alias accepts command on its own line before multiline content", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-command-runtime-newline-"))
  try {
    await writeFile(
      path.join(dir, "run.md"),
      "---\ndescription: run\nagent: build\n---\n\nRun task: $ARGUMENTS\n",
      "utf8",
    )
    const result = expandUesPromptAlias("/ues-run\n\nBạn đang làm việc trực tiếp trên repository:\nE:\\dev\\AgriMarket", dir)
    assert.equal(result.alias, "ues-run")
    assert.match(result.text, /Bạn đang làm việc trực tiếp trên repository:/)
    assert.ok(result.text.includes("E:\\dev\\AgriMarket"))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("V13 prompt alias supports multiline arguments and positional placeholders", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-command-runtime-multi-"))
  try {
    await writeFile(
      path.join(dir, "plan.md"),
      "---\ndescription: plan\nagent: ues-architect\n---\n\nTask=$ARGUMENTS\nFirst=$1\nSecond=$2\n",
      "utf8",
    )
    const result = expandUesPromptAlias("/ues-plan alpha beta\nmore detail", dir)
    assert.equal(result.agent, "ues-architect")
    assert.match(result.text, /Preferred specialist: ues-architect/)
    assert.match(result.text, /Task=alpha beta\nmore detail/)
    assert.match(result.text, /First=alpha/)
    assert.match(result.text, /Second=beta/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("V13 prompt alias ignores non-UES and unknown slash commands", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-command-runtime-ignore-"))
  try {
    assert.equal(expandUesPromptAlias("hello", dir), null)
    assert.equal(expandUesPromptAlias("/help", dir), null)
    assert.equal(expandUesPromptAlias("/ues-unknown test", dir), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})


test("V13 prompt alias accepts a ChatGPT-style outer markdown fence and BOM", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-command-runtime-fenced-"))
  try {
    await writeFile(
      path.join(dir, "run.md"),
      "---\ndescription: run\nagent: build\n---\n\nRun task: $ARGUMENTS\n",
      "utf8",
    )
    const pasted = "\uFEFF\`\`\`text\n/ues-run\n\nKiểm tra toàn bộ repository, không push.\n\`\`\`"
    assert.equal(
      normalizeUesPromptPaste(pasted).trim(),
      "/ues-run\n\nKiểm tra toàn bộ repository, không push.",
    )
    const result = expandUesPromptAlias(pasted, dir)
    assert.equal(result.alias, "ues-run")
    assert.match(result.text, /Kiểm tra toàn bộ repository, không push\./)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("V13 policy CLI input stays bounded for very large pasted prompts", () => {
  const giant = [
    "Refactor toàn bộ repository với long-horizon workflow.",
    "Không push, không publish, không destructive reset.",
    "x".repeat(70_000),
    "END: preserve dirty working tree and verify integration.",
  ].join("\n")
  const bounded = policyPromptForCli(giant)
  assert.equal(bounded.truncated, true)
  assert.ok(bounded.originalChars > 70_000)
  assert.ok(bounded.cliChars <= 12_000)
  assert.match(bounded.text, /UES_POLICY_INPUT_TRUNCATED_FOR_CLI/)
  assert.match(bounded.text, /preserve dirty working tree and verify integration\./)
})

test("V13 expands a very large multiline /ues-run prompt without duplicating the user payload", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-command-runtime-large-"))
  try {
    await writeFile(
      path.join(dir, "run.md"),
      "---\ndescription: run\nagent: build\n---\n\nRun task: $ARGUMENTS\n",
      "utf8",
    )
    const payload = "BEGIN\n" + "abc123 ".repeat(12_000) + "\nEND-SENTINEL"
    const result = expandUesPromptAlias("/ues-run\n\n" + payload, dir)
    assert.equal(result.alias, "ues-run")
    assert.equal((result.text.match(/END-SENTINEL/g) || []).length, 1)
    assert.equal((result.text.match(/BEGIN/g) || []).length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
