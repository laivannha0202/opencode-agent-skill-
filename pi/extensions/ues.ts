import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { destructiveShellRisk } from "../../lib/safety.mjs";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OCSKILL_BIN = path.join(PACKAGE_ROOT, "bin", "ocskill.mjs");
const AGENT_DIR = path.join(PACKAGE_ROOT, "global-config", "agents");
const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const OUTPUT_LIMIT = 512 * 1024;

const AGENTS = {
  "ues-architect": { file: "architect.md", tools: ["read", "grep", "find", "ls", "bash"] },
  "ues-codebase-mapper": { file: "codebase-mapper.md", tools: ["read", "grep", "find", "ls", "bash"] },
  "ues-critic": { file: "critic.md", tools: ["read", "grep", "find", "ls", "bash"] },
  "ues-debugger": { file: "debugger.md" },
  "ues-executor": { file: "executor.md" },
  "ues-integration-verifier": { file: "integration-verifier.md", tools: ["read", "grep", "find", "ls", "bash"] },
  "ues-merge-arbiter": { file: "merge-arbiter.md" },
  "ues-plan-checker": { file: "plan-checker.md", tools: ["read", "grep", "find", "ls", "bash"] },
  "ues-researcher": { file: "researcher.md", tools: ["read", "grep", "find", "ls", "bash"] },
  "ues-reviewer": { file: "reviewer.md", tools: ["read", "grep", "find", "ls", "bash"] },
  "ues-verifier": { file: "verifier.md", tools: ["read", "grep", "find", "ls", "bash"] },
  "ues-visual-verifier": { file: "visual-verifier.md", tools: ["read", "grep", "find", "ls", "bash"] },
} as const;

const WRITE_AGENTS = new Set(["ues-executor", "ues-debugger", "ues-merge-arbiter"]);

type AgentName = keyof typeof AGENTS;
type RunResult = {
  agent: string;
  task: string;
  cwd: string;
  exitCode: number;
  output: string;
  stderr: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
};

function cap(text: string, limit = OUTPUT_LIMIT) {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + "\n...[truncated by UES Pi adapter]";
}

function stripFrontmatter(raw: string) {
  return raw.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/, "").trim();
}

function getAgentPrompt(agent: AgentName) {
  const original = stripFrontmatter(
    fs.readFileSync(path.join(AGENT_DIR, AGENTS[agent].file), "utf8"),
  );
  const fallbackCli = `node ${JSON.stringify(OCSKILL_BIN)}`;
  const bridge = [
    "## Pi host bridge",
    "",
    "- You are running as a fresh UES specialist inside Pi, not OpenCode.",
    "- When the inherited UES instructions say to run \`ocskill ...\`, prefer the \`ues_cli\` tool with the equivalent argument array.",
    `- If \`ues_cli\` is unavailable, invoke the bundled CLI as \`${fallbackCli} ...\`; do not assume a global \`ocskill\` binary exists.`,
    "- Do not call OpenCode-only dispatch tools such as \`ues.dispatch_task\` or \`ues.dispatch_parallel\`.",
    "- Respect the original role's edit/read-only boundary and return evidence to the parent Pi session.",
    "",
  ].join("\\n");
  return bridge + original;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return { command: process.execPath, args };
  return { command: "pi", args };
}

function extractAssistantText(message: any): string {
  if (!message || message.role !== "assistant") return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n");
}

async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, stdout: cap(stdout), stderr: cap(stderr, 128 * 1024) });
    };

    proc.stdout.on("data", (data) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += data.toString();
    });
    proc.stderr.on("data", (data) => {
      if (stderr.length < 128 * 1024) stderr += data.toString();
    });
    proc.on("error", (error) => {
      stderr += `\n${error instanceof Error ? error.message : String(error)}`;
      finish(1);
    });
    proc.on("close", (code) => finish(code ?? 0));

    if (signal) {
      const kill = () => {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000).unref?.();
      };
      if (signal.aborted) kill();
      else signal.addEventListener("abort", kill, { once: true });
    }
  });
}

async function runOcskill(args: string[], cwd: string, signal?: AbortSignal) {
  return runProcess(process.execPath, [OCSKILL_BIN, ...args], cwd, signal);
}

async function runAgent(
  agent: AgentName,
  task: string,
  cwd: string,
  model: string | undefined,
  thinkingLevel: string | undefined,
  signal?: AbortSignal,
): Promise<RunResult> {
  const config = AGENTS[agent];
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (model) args.push("--model", model);
  if (thinkingLevel) args.push("--thinking", thinkingLevel);
  if ("tools" in config && config.tools?.length) args.push("--tools", config.tools.join(","));

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ues-pi-"));
  const promptPath = path.join(tempDir, `${agent}.md`);
  await fs.promises.writeFile(promptPath, getAgentPrompt(agent), { encoding: "utf8", mode: 0o600 });
  args.push("--append-system-prompt", promptPath, `Task: ${task}`);

  let output = "";
  let stderr = "";
  let exitCode = 1;
  let stopReason: string | undefined;
  let errorMessage: string | undefined;
  let seenModel: string | undefined;

  try {
    const invocation = getPiInvocation(args);
    await new Promise<void>((resolve) => {
      const proc = spawn(invocation.command, invocation.args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let buffer = "";
      let settled = false;

      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        exitCode = code;
        resolve();
      };

      const processLine = (line: string) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line);
          if (event.type === "message_end" && event.message) {
            const text = extractAssistantText(event.message);
            if (text) output = text;
            if (event.message.role === "assistant") {
              seenModel = event.message.model || seenModel;
              stopReason = event.message.stopReason || stopReason;
              errorMessage = event.message.errorMessage || errorMessage;
            }
          }
        } catch {
          // Ignore non-JSON diagnostic lines from child Pi.
        }
      };

      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });
      proc.stderr.on("data", (data) => {
        if (stderr.length < 128 * 1024) stderr += data.toString();
      });
      proc.on("error", (error) => {
        stderr += `\n${error instanceof Error ? error.message : String(error)}`;
        finish(1);
      });
      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        finish(code ?? 0);
      });

      if (signal) {
        const kill = () => {
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000).unref?.();
        };
        if (signal.aborted) kill();
        else signal.addEventListener("abort", kill, { once: true });
      }
    });
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }

  if (!output) output = stderr || "(no assistant output)";
  return {
    agent,
    task,
    cwd,
    exitCode,
    output: cap(output, 100 * 1024),
    stderr: cap(stderr, 64 * 1024),
    model: seenModel || model,
    stopReason,
    errorMessage,
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>) {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function approveRisk(ctx: any, command: string, reason: string) {
  if (!ctx.hasUI) return false;
  return await ctx.ui.confirm(
    "UES safety gate",
    `Potentially destructive command detected (${reason}):\n\n${command}\n\nAllow this command?`,
  );
}

const TaskItem = Type.Object({
  agent: Type.String({ description: "Bundled UES agent name" }),
  task: Type.String({ description: "Task delegated to the child Pi process" }),
  cwd: Type.Optional(Type.String({ description: "Working directory. Required for parallel writer agents." })),
});

const ChainItem = Type.Object({
  agent: Type.String({ description: "Bundled UES agent name" }),
  task: Type.String({ description: "Task, optionally containing {previous}" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for this chain step" })),
});

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash" && event.toolName !== "powershell") return undefined;
    const command = String((event.input as any)?.command || "");
    const risk = destructiveShellRisk(command);
    if (!risk.risky) return undefined;

    const allowed = await approveRisk(ctx, command, risk.id || "destructive");
    if (!allowed) return { block: true, reason: `Blocked by UES safety gate: ${risk.id}` };
    return undefined;
  });

  pi.registerTool({
    name: "ues_cli",
    label: "UES CLI",
    description:
      "Run the bundled ocskill deterministic CLI without shell interpolation. Use this for task-policy, inspect, repo-graph, work state/gates, verification receipts, evidence, recovery and other UES CLI operations.",
    parameters: Type.Object({
      args: Type.Array(Type.String(), { minItems: 1, maxItems: 64 }),
      cwd: Type.Optional(Type.String({ description: "Working directory; defaults to the current Pi cwd" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = path.resolve(params.cwd || ctx.cwd);
      const separator = params.args.indexOf("--");
      if (separator >= 0 && separator < params.args.length - 1) {
        const command = params.args.slice(separator + 1).join(" ");
        const risk = destructiveShellRisk(command);
        if (risk.risky) {
          const allowed = await approveRisk(ctx, command, risk.id || "destructive");
          if (!allowed) {
            return {
              content: [{ type: "text", text: `Blocked by UES safety gate: ${risk.id}` }],
              details: { exitCode: 1, blocked: true, risk: risk.id },
              isError: true,
            };
          }
        }
      }

      const result = await runOcskill(params.args, cwd, signal);
      const text = [
        `exitCode: ${result.exitCode}`,
        result.stdout.trim(),
        result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : "",
      ].filter(Boolean).join("\n");

      return {
        content: [{ type: "text", text }],
        details: { ...result, cwd, args: params.args },
        isError: result.exitCode !== 0,
      };
    },
  });

  pi.registerTool({
    name: "ues_dispatch",
    label: "UES Dispatch",
    description:
      "Run bundled UES specialist agents in isolated child Pi processes. Supports single, parallel, or chain mode. Parallel writer agents fail closed unless each writer has an explicit distinct cwd/worktree. Available agents: " +
      Object.keys(AGENTS).join(", "),
    parameters: Type.Object({
      agent: Type.Optional(Type.String({ description: "Agent name for single mode" })),
      task: Type.Optional(Type.String({ description: "Task for single mode" })),
      cwd: Type.Optional(Type.String({ description: "Working directory for single mode" })),
      tasks: Type.Optional(Type.Array(TaskItem, { maxItems: MAX_PARALLEL_TASKS })),
      chain: Type.Optional(Type.Array(ChainItem, { maxItems: 12 })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const hasSingle = Boolean(params.agent && params.task);
      const hasParallel = Boolean(params.tasks?.length);
      const hasChain = Boolean(params.chain?.length);
      if (Number(hasSingle) + Number(hasParallel) + Number(hasChain) !== 1) {
        return {
          content: [{ type: "text", text: "Provide exactly one mode: agent+task, tasks, or chain." }],
          details: { mode: "invalid" },
          isError: true,
        };
      }

      const validateAgent = (name: string): name is AgentName => name in AGENTS;
      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const thinking = ctx.thinkingLevel as string | undefined;
      const baseCwd = ctx.cwd;

      if (hasSingle) {
        if (!validateAgent(params.agent!)) {
          return {
            content: [{ type: "text", text: `Unknown UES agent: ${params.agent}` }],
            details: { available: Object.keys(AGENTS) },
            isError: true,
          };
        }
        const cwd = path.resolve(params.cwd || baseCwd);
        const result = await runAgent(params.agent!, params.task!, cwd, model, thinking, signal);
        return {
          content: [{ type: "text", text: result.output }],
          details: { mode: "single", results: [result] },
          isError: result.exitCode !== 0 || result.stopReason === "error",
        };
      }

      if (hasChain) {
        const results: RunResult[] = [];
        let previous = "";
        for (const step of params.chain!) {
          if (!validateAgent(step.agent)) {
            return {
              content: [{ type: "text", text: `Unknown UES agent: ${step.agent}` }],
              details: { mode: "chain", results, available: Object.keys(AGENTS) },
              isError: true,
            };
          }
          const task = step.task.replace(/\{previous\}/g, previous);
          const result = await runAgent(
            step.agent,
            task,
            path.resolve(step.cwd || baseCwd),
            model,
            thinking,
            signal,
          );
          results.push(result);
          previous = result.output;
          onUpdate?.({
            content: [{ type: "text", text: `Chain: ${results.length}/${params.chain!.length} complete` }],
            details: { mode: "chain", results },
          });
          if (result.exitCode !== 0 || result.stopReason === "error") {
            return {
              content: [{ type: "text", text: `Chain stopped at ${step.agent}:\n\n${result.output}` }],
              details: { mode: "chain", results },
              isError: true,
            };
          }
        }
        return {
          content: [{ type: "text", text: results.at(-1)?.output || "(no output)" }],
          details: { mode: "chain", results },
        };
      }

      const tasks = params.tasks!;
      for (const item of tasks) {
        if (!validateAgent(item.agent)) {
          return {
            content: [{ type: "text", text: `Unknown UES agent: ${item.agent}` }],
            details: { mode: "parallel", available: Object.keys(AGENTS) },
            isError: true,
          };
        }
      }

      const writerDirs = tasks
        .filter((item) => WRITE_AGENTS.has(item.agent))
        .map((item) => item.cwd ? path.resolve(item.cwd) : null);
      if (writerDirs.some((dir) => !dir)) {
        return {
          content: [{
            type: "text",
            text: "Parallel writer agents require an explicit cwd for each writer. Create isolated worktrees/directories first, or run writers serially.",
          }],
          details: { mode: "parallel", blocked: "writer-without-isolated-cwd" },
          isError: true,
        };
      }
      const concreteWriterDirs = writerDirs.filter((dir): dir is string => Boolean(dir));
      if (new Set(concreteWriterDirs).size !== concreteWriterDirs.length) {
        return {
          content: [{
            type: "text",
            text: "Parallel writer agents must use distinct cwd values. Shared writer directories are blocked to prevent file races.",
          }],
          details: { mode: "parallel", blocked: "shared-writer-cwd" },
          isError: true,
        };
      }

      let completed = 0;
      const results = await mapLimit(tasks, MAX_CONCURRENCY, async (item) => {
        const result = await runAgent(
          item.agent as AgentName,
          item.task,
          path.resolve(item.cwd || baseCwd),
          model,
          thinking,
          signal,
        );
        completed++;
        onUpdate?.({
          content: [{ type: "text", text: `Parallel: ${completed}/${tasks.length} complete` }],
          details: { mode: "parallel", completed, total: tasks.length },
        });
        return result;
      });

      const success = results.filter((r) => r.exitCode === 0 && r.stopReason !== "error").length;
      const summary = results.map((r) =>
        `### [${r.agent}] ${r.exitCode === 0 && r.stopReason !== "error" ? "completed" : "failed"}\n\n${r.output}`
      ).join("\n\n---\n\n");

      return {
        content: [{ type: "text", text: `Parallel: ${success}/${results.length} succeeded\n\n${summary}` }],
        details: { mode: "parallel", results },
        isError: success !== results.length,
      };
    },
  });
}
