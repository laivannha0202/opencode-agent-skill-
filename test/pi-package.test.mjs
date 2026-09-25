import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { lintSkillCatalog, validateFrontmatterSource } from "../lib/skill-quality.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("Pi package manifest exposes UES resources", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
  assert.equal(pkg.bin?.ues, "bin/ocskill.mjs")
  assert.equal(pkg.bin?.ocskill, "bin/ocskill.mjs")
  assert.equal(pkg.scripts?.["eval:pi"], "node scripts/eval-pi.mjs")
  assert.ok(pkg.files.includes("scripts/"))
  assert.ok(pkg.files.includes("evals/"))
  assert.ok(pkg.files.includes("global-config/plugins/"))
  assert.ok(pkg.files.includes("global-config/AGENTS.md"))
  assert.equal(pkg.scripts?.["smoke:packed"], "node scripts/smoke-packed-install.mjs")
  assert.match(pkg.scripts?.ci || "", /npm run smoke:packed/)
  assert.equal(pkg.scripts?.["runtime:exports"], "node scripts/check-runtime-exports.mjs")
  assert.match(pkg.scripts?.ci || "", /npm run runtime:exports/)
  assert.equal(pkg.scripts?.postinstall, undefined)
  assert.equal(pkg.scripts?.preuninstall, undefined)
  assert.equal(pkg.pi.extensions[0], "./pi/extensions/ues.ts")
  assert.deepEqual(pkg.pi.skills, ["./global-config/skills"])
  assert.deepEqual(pkg.pi.prompts, ["./pi/prompts/*.md"])
  assert.ok(pkg.keywords.includes("pi-package"))
  assert.equal(pkg.peerDependencies["@earendil-works/pi-coding-agent"], "*")
  assert.equal(pkg.peerDependencies.typebox, "*")
  assert.equal(pkg.peerDependenciesMeta["@earendil-works/pi-coding-agent"].optional, true)
  assert.equal(pkg.peerDependenciesMeta.typebox.optional, true)
})

test("Pi adapter and prompt resources are packaged", () => {
  const extensionPath = path.join(root, "pi", "extensions", "ues.ts")
  assert.ok(fs.existsSync(extensionPath))

  const source = fs.readFileSync(extensionPath, "utf8")
  assert.ok(source.length > 80_000, "UES controller appears truncated")
  assert.ok(source.split(/\r?\n/).length > 2_000, "UES controller lost most of its source lines")
  assert.match(source, /name:\s*"ues_cli"/)
  assert.match(source, /name:\s*"ues_dispatch"/)
  assert.match(source, /name:\s*"ues_execute"/)
  assert.match(source, /buildAdaptiveTaskContext/)
  assert.match(source, /compactReversibleOutput/)
  assert.match(source, /MODEL_VISIBLE_OUTPUT_LIMIT/)
  assert.match(source, /deterministicReadOnly/)
  assert.match(source, /fastPath: "deterministic-read-only"/)
  assert.match(source, /resolveCapabilityModel/)
  assert.match(source, /computeSafeWaves/)
  assert.match(source, /createTaskSandbox/)
  assert.match(source, /UES_PLAN_JSON/)
  assert.match(source, /recordModelPerformance/)
  assert.match(source, /destructiveShellRisk/)
  assert.match(source, /writer agents require an explicit cwd/i)
  assert.doesNotMatch(source, /args\.push\("--append-system-prompt",\s*promptPath,\s*`Task:/)
  assert.match(source, /stdio:\s*\["pipe",\s*"pipe",\s*"pipe"\]/)
  assert.match(source, /proc\.stdin\.end\(taskInput\)/)
  assert.match(source, /const taskInput = `Task:/)
  assert.doesNotMatch(source, /"--no-extensions"/)
  assert.match(source, /const READ_TOOLS = \["read", "grep", "find", "ls", "bash", "powershell"\]/)
  assert.match(source, /const WRITE_TOOLS = \[\.\.\.READ_TOOLS, "edit", "write"\]/)
  assert.match(source, /args\.push\("--tools", allowedTools\.join\(","\)\)/)
  assert.match(source, /CHILD_RUNTIME_EXTENSION/)
  assert.match(source, /ues-child-runtime\.ts/)
  assert.match(source, /UES_CHILD_HARD_TIMEOUT_MS/)
  assert.match(source, /UES_CHILD_IDLE_TIMEOUT_MS/)
  assert.match(source, /UES_CHILD_HEARTBEAT_MS/)
  assert.match(source, /pi\.on\("input"/)
  assert.match(source, /RPC_POOL\.steerActive/)
  assert.match(source, /RPC_POOL\.abortActive/)
  assert.match(source, /ACTIVE_CLI_CHILDREN/)
  assert.match(source, /verificationTimeoutSec/)
  assert.match(source, /uesRpcPhase/)
  assert.match(source, /terminateProcessTree/)
  assert.match(source, /stopChildTree\(proc\)/)
  const supervisorSource = fs.readFileSync(path.join(root, "lib", "process-supervisor.mjs"), "utf8")
  assert.match(supervisorSource, /taskkill/)
  assert.match(supervisorSource, /drainTimeoutMs/)
  const rpcPoolSource = fs.readFileSync(path.join(root, "lib", "pi-rpc-pool.mjs"), "utf8")
  assert.match(rpcPoolSource, /activeAbort/)
  assert.match(rpcPoolSource, /abortTransport/)
  assert.match(rpcPoolSource, /uesRpcPhase/)
  assert.match(source, /UES controller: \$\{progress\.agent\} running/)
  assert.match(source, /shouldRunDedicatedDiagnosis\(policy, 1\)/)
  assert.match(source, /runtimeFailureNeedsDiagnosis/)
  assert.match(source, /shouldRunDedicatedDiagnosis\(policy, attempt\)/)
  assert.match(source, /"steer", "followUp"/)
  assert.match(source, /UES scheduler: \$\{item\.task\.id\} \$\{progress\.agent\} running/)

  const childRuntimePath = path.join(root, "pi", "extensions", "ues-child-runtime.ts")
  assert.ok(fs.existsSync(childRuntimePath))
  const childRuntimeSource = fs.readFileSync(childRuntimePath, "utf8")
  assert.ok(childRuntimeSource.length > 6_000, "UES child runtime appears truncated")
  assert.ok(childRuntimeSource.startsWith("import type { ExtensionAPI }"), "UES child runtime lost its source prefix")
  assert.ok(childRuntimeSource.split(/\r?\n/).length > 150, "UES child runtime lost most of its source lines")
  assert.match(childRuntimeSource, /export default function \(pi: ExtensionAPI\)/)
  assert.match(childRuntimeSource, /name:\s*"ues_evidence_get"/)
  assert.match(childRuntimeSource, /tool_result/)
  assert.match(childRuntimeSource, /compactReversibleOutput/)
  assert.match(childRuntimeSource, /recordVerification/)
  assert.match(childRuntimeSource, /canonicalVerificationCommand/)
  assert.match(childRuntimeSource, /runtimeWorkspaceFingerprint/)
  assert.match(childRuntimeSource, /workspaceBefore/)
  assert.match(childRuntimeSource, /session_start/)
  assert.match(childRuntimeSource, /session_shutdown/)
  assert.match(childRuntimeSource, /destructiveShellRisk/)
  assert.match(childRuntimeSource, /fullOutputPath/)
  assert.match(childRuntimeSource, /UES_CHILD_VERIFICATION_TIMEOUT_SEC/)

  const evalSource = fs.readFileSync(path.join(root, "scripts", "eval-pi.mjs"), "utf8")
  assert.match(evalSource, /"--no-extensions"/)
  assert.match(evalSource, /for \(const extension of providerExtensions\)/)
  assert.match(evalSource, /piArgs\.push\("--extension", extension\)/)
  assert.match(evalSource, /git:github\.com\/Kilo-Org\/kilo-pi-provider/)
  assert.match(evalSource, /piArgs\.push\("--extension", path\.join\(root, "pi", "extensions", "ues\.ts"\)\)/)
  assert.match(evalSource, /--provider-extension/)
  assert.match(evalSource, /providerExtensionCount/)
  assert.match(evalSource, /baselineIsolated/)
  assert.match(evalSource, /pairedBenchmarkConfidence/)

  const packedSmokeSource = fs.readFileSync(path.join(root, "scripts", "smoke-packed-install.mjs"), "utf8")
  assert.match(packedSmokeSource, /"install", "-g", tarball, "--prefix", prefix, "--ignore-scripts"/)
  assert.match(packedSmokeSource, /\[cli, "install"\]/)
  assert.match(packedSmokeSource, /explicit legacy OpenCode sync from packed copy/)
  assert.match(packedSmokeSource, /UES_CONFIG_DIR:\s*uesConfigDir/)
  assert.match(packedSmokeSource, /packed smoke must not read the user's real UES model policy/)
  assert.doesNotMatch(packedSmokeSource, /automatic OpenCode sync/)

  const smokeSource = fs.readFileSync(path.join(root, "scripts", "smoke-pi-extension.mjs"), "utf8")
  assert.match(smokeSource, /sanitizedNpmChildEnv/)
  assert.match(smokeSource, /npm_config_allow_scripts/)
  assert.match(smokeSource, /cwd:\s*tempDir/)

  const requiredPrompts = [
    "ues-run.md",
    "ues-plan.md",
    "ues-resume.md",
    "ues-verify.md",
    "ues-review.md",
    "ues-debug.md",
    "ues-fix.md",
    "ues-feature.md",
    "ues-audit.md",
    "ues-research.md",
    "ues-critique.md",
  ]

  for (const file of requiredPrompts) {
    const promptPath = path.join(root, "pi", "prompts", file)
    assert.ok(fs.existsSync(promptPath), `missing Pi prompt: ${file}`)
    const content = fs.readFileSync(promptPath, "utf8")
    assert.match(content, /^---\n/)
    assert.match(content, /description:/)
  }
})

test("existing UES skills remain Agent Skills compatible for Pi", async () => {
  const skillsDir = path.join(root, "global-config", "skills")
  const skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  assert.ok(skillDirs.length >= 40)

  for (const entry of skillDirs) {
    const skillFile = path.join(skillsDir, entry.name, "SKILL.md")
    assert.ok(fs.existsSync(skillFile), `missing SKILL.md for ${entry.name}`)
    const content = fs.readFileSync(skillFile, "utf8")
    assert.match(content, /^---\n/)
    assert.match(content, /\nname:\s*[^\n]+/)
    assert.match(content, /\ndescription:\s*[^\n]+/)
    const yaml = validateFrontmatterSource(content, { file: skillFile })
    assert.equal(yaml.valid, true, JSON.stringify(yaml.errors))
  }

  const lint = await lintSkillCatalog(root)
  assert.equal(lint.valid, true, JSON.stringify(lint.errors))
})

test("Pi prompt frontmatter rejects unquoted colon scalars", () => {
  const promptsDir = path.join(root, "pi", "prompts")
  for (const file of fs.readdirSync(promptsDir).filter((name) => name.endsWith(".md"))) {
    const prompt = path.join(promptsDir, file)
    const content = fs.readFileSync(prompt, "utf8")
    const yaml = validateFrontmatterSource(content, { file: prompt })
    assert.equal(yaml.valid, true, JSON.stringify(yaml.errors))
  }

  const invalid = validateFrontmatterSource("---\nname: demo\ndescription: bad: nested scalar\n---\n")
  assert.equal(invalid.valid, false)
  assert.ok(invalid.errors.some((error) => error.issue === "unquoted-colon-in-scalar"))
})