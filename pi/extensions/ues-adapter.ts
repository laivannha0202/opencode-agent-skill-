import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DANGEROUS_PATTERNS: Array<[string, RegExp]> = [
  ["git-force", /\bgit\s+(?:push\b[^\n]*(?:--force(?:-with-lease)?|(?:^|\s)-f(?:\s|$))|reset\s+--hard|clean\s+-[^\n]*f)/i],
  ["history-rewrite", /\bgit\s+(?:rebase\b|filter-branch\b|filter-repo\b)/i],
  ["publish", /\b(?:npm\s+publish|pnpm\s+publish|yarn\s+npm\s+publish)\b/i],
  ["destructive-files", /(?:^|[;&|]\s*)(?:rm\s+-[^\n]*r[^\n]*f|rmdir\s+\/s|del\s+\/s|remove-item\b[^\n]*-recurse[^\n]*-force)/i],
  ["database-drop", /\b(?:drop\s+(?:database|schema|table)|truncate\s+table)\b/i],
  ["deployment", /\b(?:kubectl\s+(?:delete|apply)|terraform\s+(?:apply|destroy)|helm\s+(?:install|upgrade|uninstall))\b/i],
];

export default function uesPiAdapter(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;
    const command = String((event.input as { command?: unknown }).command ?? "");
    const matched = DANGEROUS_PATTERNS.find(([, pattern]) => pattern.test(command));
    if (!matched) return undefined;

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `UES blocked high-risk command without interactive approval: ${matched[0]}`,
      };
    }

    const choice = await ctx.ui.select(
      `UES safety gate (\${matched[0]}):\n\n\${command}\n\nAllow this command?`,
      ["Allow once", "Block"],
    );
    if (choice !== "Allow once") {
      return { block: true, reason: `Blocked by UES safety gate: ${matched[0]}` };
    }
    return undefined;
  });

  pi.registerTool({
    name: "ues_fresh_agent",
    label: "UES Fresh Pi Agent",
    description:
      "Run one bounded task in a fresh Pi process with an isolated context. Use read-only mode for research/review/verifier work and write mode only for a clearly scoped implementation task.",
    parameters: Type.Object({
      prompt: Type.String({ description: "Self-contained task brief with acceptance criteria and required output." }),
      mode: Type.Optional(
        Type.Union([Type.Literal("read-only"), Type.Literal("write")], {
          description: "read-only disables editing tools; write allows normal Pi tools.",
        }),
      ),
      thinking: Type.Optional(
        Type.Union([
          Type.Literal("off"),
          Type.Literal("minimal"),
          Type.Literal("low"),
          Type.Literal("medium"),
          Type.Literal("high"),
          Type.Literal("xhigh"),
          Type.Literal("max"),
        ]),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const args = ["-p", "--no-session"];
      if (params.mode === "read-only") {
        args.push("--tools", "read,grep,find,ls");
      } else {
        args.push("--exclude-tools", "ues_fresh_agent");
      }
      if (params.thinking) args.push("--thinking", params.thinking);
      args.push(params.prompt);

      const result = await pi.exec("pi", args, { timeout: 20 * 60 * 1000 });
      const text = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      if (result.code !== 0) {
        throw new Error(`Fresh Pi agent failed with exit code ${result.code}: ${text.slice(0, 8000)}`);
      }

      return {
        content: [{ type: "text", text: text || "Fresh Pi agent completed without text output." }],
        details: {
          exitCode: result.code,
          mode: params.mode ?? "write",
        },
      };
    },
  });

  pi.registerCommand("ues-doctor", {
    description: "Check the UES CLI from the current Pi project",
    handler: async (_args, ctx) => {
      const result = await pi.exec("ocskill", ["doctor"]);
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      if (ctx.hasUI) {
        ctx.ui.notify(output || `ocskill doctor exited ${result.code}`, result.code === 0 ? "info" : "error");
      }
    },
  });
}
