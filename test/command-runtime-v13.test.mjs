import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  expandUesPromptAlias,
  normalizeUesPromptPaste,
  policyPromptForCli,
  policySourceForPromptAlias,
  promptAliasTextForPolicy,
  UES_PROMPT_ALIASES,
} from "../global-config/plugins/ues-router/command-runtime.js"
import { classifyEngineeringTask } from "../lib/orchestrator-policy.mjs"

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


test("V13 /ues-run classifies the actual user request instead of forcing long-horizon", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-command-runtime-policy-"))
  try {
    await writeFile(
      path.join(dir, "run.md"),
      "---\ndescription: run\nagent: build\n---\n\nRun adaptive task: $ARGUMENTS\n",
      "utf8",
    )
    const alias = expandUesPromptAlias("/ues-run\n\nChỉ trả lời đúng một từ: OK", dir)
    const source = policySourceForPromptAlias(alias, alias.text)
    assert.equal(source, "Chỉ trả lời đúng một từ: OK")

    const policy = classifyEngineeringTask(source)
    assert.equal(policy.mode, "inline")
    assert.equal(policy.executionProfile, "fast")
    assert.equal(policy.profile.durableState, false)

    const runtimePrompt = promptAliasTextForPolicy(alias, policy)
    assert.match(runtimePrompt, /selected FAST/)
    assert.match(runtimePrompt, /Chỉ trả lời đúng một từ: OK/)
    assert.doesNotMatch(runtimePrompt, /long-horizon workflow/)
    assert.doesNotMatch(runtimePrompt, /ocskill work init/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("V13 /ues-run keeps STANDARD work compact and escalates real large work to DEEP", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-command-runtime-adaptive-"))
  try {
    await writeFile(
      path.join(dir, "run.md"),
      "---\ndescription: run\nagent: build\n---\n\nDEEP CONTRACT\nRun task: $ARGUMENTS\nocskill work init\n",
      "utf8",
    )

    const standardRequest = [
      "Fix this failing helper test and verify the affected behavior.",
      "Inspect the direct caller and nearest test, preserve the existing public behavior,",
      "make only the bounded change required by the failure, and run the affected test after the edit.",
      "Do not broaden the task beyond the named helper unless deterministic evidence requires it.",
    ].join(" ")
    const standardAlias = expandUesPromptAlias("/ues-run " + standardRequest, dir)
    const standardSource = policySourceForPromptAlias(standardAlias, standardAlias.text)
    const standardPolicy = classifyEngineeringTask(standardSource)
    assert.equal(standardPolicy.executionProfile, "standard")
    const standardPrompt = promptAliasTextForPolicy(standardAlias, standardPolicy)
    assert.match(standardPrompt, /selected STANDARD/)
    assert.doesNotMatch(standardPrompt, /DEEP CONTRACT/)
    assert.doesNotMatch(standardPrompt, /ocskill work init/)

    const deepAlias = expandUesPromptAlias(
      "/ues-run Refactor toàn bộ repository qua nhiều module và giữ trạng thái để tiếp tục công việc.",
      dir,
    )
    const deepSource = policySourceForPromptAlias(deepAlias, deepAlias.text)
    const deepPolicy = classifyEngineeringTask(deepSource)
    assert.equal(deepPolicy.mode, "long-horizon")
    assert.equal(deepPolicy.executionProfile, "deep")
    assert.equal(promptAliasTextForPolicy(deepAlias, deepPolicy), deepAlias.text)
    assert.match(deepAlias.text, /DEEP CONTRACT/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("V13 /ues-resume retains explicit durable resume semantics", async () => {
  const alias = {
    alias: "ues-resume",
    arguments: "checkout-migration",
    text: "resume contract",
  }
  const source = policySourceForPromptAlias(alias, alias.text)
  assert.match(source, /Resume an existing durable UES execution/)
  assert.match(source, /checkout-migration/)
  assert.equal(classifyEngineeringTask(source).mode, "long-horizon")
  assert.equal(promptAliasTextForPolicy(alias, classifyEngineeringTask(source)), "resume contract")
})

test("V13 bundled /ues-run template is adaptive and does not declare every task long-horizon", async () => {
  const source = await readFile(new URL("../global-config/commands/run.md", import.meta.url), "utf8")
  assert.match(source, /UES adaptive workflow/)
  assert.match(source, /answer it directly and stop/i)
  assert.match(source, /FAST \/ inline/)
  assert.match(source, /STANDARD/)
  assert.match(source, /DEEP \/ long-horizon \/ high-risk/)
  assert.doesNotMatch(source, /Run this task using the UES long-horizon workflow/)
})


test("V13 adaptive prompt derives FAST/STANDARD from mode when profile metadata is absent", () => {
  const alias = {
    alias: "ues-run",
    arguments: "Check the named helper.",
    text: "DEEP CONTRACT",
  }
  const fast = promptAliasTextForPolicy(alias, { mode: "inline", risk: "low" })
  assert.match(fast, /selected FAST/)
  assert.doesNotMatch(fast, /DEEP CONTRACT/)

  const standard = promptAliasTextForPolicy(alias, { mode: "standard", risk: "medium" })
  assert.match(standard, /selected STANDARD/)
  assert.doesNotMatch(standard, /DEEP CONTRACT/)

  const deep = promptAliasTextForPolicy(alias, { mode: "standard", risk: "high" })
  assert.equal(deep, "DEEP CONTRACT")
})
