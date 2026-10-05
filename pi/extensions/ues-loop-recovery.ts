import {
  AGENT_LOOP_LIMITS,
  AGENT_WATCHDOG_STATUS,
  createAgentProgressWatchdog,
} from "../../lib/agent-progress-watchdog.mjs";

export const UES_LOOP_RECOVERY_COMPAT_SCHEMA_VERSION = 1;

const ENGINEERING_HINT = /(?:^\/ues-|\b(?:code|repo|project|file|function|class|test|debug|fix|bug|error|implement|refactor|build|deploy|api|database|typescript|javascript|python|git)\b|(?:sửa|lỗi|dự án|kiểm tra|tối ưu|nâng cấp|mã nguồn))/iu;

function textFromAssistantMessage(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item && item.type === "text")
    .map((item) => String(item.text || ""))
    .join("\n");
}

export function isEngineeringTurnText(text) {
  const value = String(text || "").trim();
  return value.length >= 8 && ENGINEERING_HINT.test(value);
}

export function recoveryInstruction(attempt, maxRecoveries) {
  return [
    `UES loop recovery ${attempt}/${maxRecoveries}: the previous assistant generation was stopped after confirmed repetitive no-progress narration.`,
    "Continue from the CURRENT conversation and existing tool results.",
    "Do not restart the task, re-audit settled facts, or repeat completed reads/searches unless relevant evidence changed.",
    "Take the next concrete action now. If action is impossible, report the exact blocker concisely.",
  ].join(" ");
}

function terminalInstruction() {
  return [
    "UES stopped automatic continuation because the generation loop persisted through the bounded recovery budget.",
    "Current working state was not reset or discarded.",
    "Start a fresh Pi turn/session from the existing working tree instead of continuing the loop.",
  ].join(" ");
}

function customMessage(customType, content, details = {}, display = false) {
  return {
    type: "custom_message",
    customType,
    content,
    display,
    details: {
      schemaVersion: UES_LOOP_RECOVERY_COMPAT_SCHEMA_VERSION,
      ...details,
    },
  };
}

/**
 * Compatibility layer for Pi runtimes where a streaming `ctx.abort()` ends the
 * agent run before `agent_before_settle` can deliver UES's bounded recovery.
 * It does NOT decide when to abort; the shipped UES controller remains the
 * authority for that. This layer mirrors the proven watchdog signal and only
 * delivers a bounded continuation after the aborted run has fully settled.
 */
export default function uesLoopRecoveryCompat(pi) {
  if (!pi || typeof pi.on !== "function") return;

  const watchdog = createAgentProgressWatchdog({
    maxLoopRecoveries: Number(
      process.env.UES_AGENT_MAX_LOOP_RECOVERIES || AGENT_LOOP_LIMITS.maxLoopRecoveries,
    ),
  });

  let engineeringTurn = false;
  let pendingRecovery = false;
  let lastStopReason = "";
  let recoveryContinuation = false;

  const resetForUserTurn = () => {
    watchdog.reset();
    pendingRecovery = false;
    lastStopReason = "";
    recoveryContinuation = false;
  };

  pi.on("input", async (event) => {
    if (event?.source !== "interactive") return;
    resetForUserTurn();
    engineeringTurn = isEngineeringTurnText(event?.text);
  });

  pi.on("before_agent_start", async () => {
    if (recoveryContinuation) {
      recoveryContinuation = false;
      return;
    }
  });

  pi.on("message_start", async (event) => {
    if (event?.message?.role !== "assistant") return;
    watchdog.beginStream();
  });

  pi.on("message_update", async (event) => {
    if (!engineeringTurn || event?.message?.role !== "assistant") return;
    const streamEvent = event?.assistantMessageEvent;
    if (!streamEvent || streamEvent.type !== "text_delta") return;
    const delta = typeof streamEvent.delta === "string" ? streamEvent.delta : "";
    if (!delta) return;
    const decision = watchdog.observeStreamDelta(delta);
    if (decision.status === AGENT_WATCHDOG_STATUS.LOOP_DETECTED) {
      pendingRecovery = true;
    }
  });

  pi.on("message_end", async (event) => {
    if (event?.message?.role !== "assistant") return;
    lastStopReason = String(event?.message?.stopReason || "").toLowerCase();
    if (!engineeringTurn) return;
    const text = textFromAssistantMessage(event?.message).trim();
    if (!text) return;
    const decision = watchdog.observeTurn(text);
    if (decision.status === AGENT_WATCHDOG_STATUS.LOOP_DETECTED) {
      pendingRecovery = true;
    }
  });

  pi.on("tool_call", async () => {
    engineeringTurn = true;
    watchdog.observeAction("tool-call");
  });

  pi.on("tool_result", async () => {
    watchdog.observeAction("tool-completion");
  });

  // Completed-turn loop: return the REAL Pi BoundaryResult shape (`entries` +
  // `continue`) instead of the legacy `{ contextEdit }` shape ignored by Pi.
  pi.on("agent_before_settle", async (event) => {
    if (!engineeringTurn || !pendingRecovery || lastStopReason === "aborted") return undefined;
    pendingRecovery = false;
    const recovery = watchdog.beginRecovery();
    if (!recovery.allowed) {
      return {
        entries: [
          ...(event?.entries || []),
          customMessage(
            "ues-agent-loop-unrecovered",
            terminalInstruction(),
            { recoveryAttempt: recovery.attempt, maxRecoveries: recovery.maxRecoveries },
            true,
          ),
        ],
        continue: false,
      };
    }
    recoveryContinuation = true;
    return {
      entries: [
        ...(event?.entries || []),
        customMessage(
          "ues-agent-loop-recovery",
          recoveryInstruction(recovery.attempt, recovery.maxRecoveries),
          { recoveryAttempt: recovery.attempt, maxRecoveries: recovery.maxRecoveries },
          false,
        ),
      ],
      continue: true,
    };
  });

  // Streaming-abort loop: Pi skips agent_before_settle after ctx.abort(), so
  // deliver the recovery only AFTER the run is fully settled. `triggerTurn:true`
  // starts one bounded fresh continuation from the existing transcript/tool
  // results. The watchdog's recovery counter prevents restart loops.
  pi.on("agent_settled", async () => {
    if (!engineeringTurn || !pendingRecovery || lastStopReason !== "aborted") return;
    pendingRecovery = false;
    const recovery = watchdog.beginRecovery();
    if (!recovery.allowed) {
      pi.sendMessage?.(
        customMessage(
          "ues-agent-loop-unrecovered",
          terminalInstruction(),
          { recoveryAttempt: recovery.attempt, maxRecoveries: recovery.maxRecoveries },
          true,
        ),
        { triggerTurn: false },
      );
      return;
    }
    recoveryContinuation = true;
    pi.sendMessage?.(
      customMessage(
        "ues-agent-loop-recovery",
        recoveryInstruction(recovery.attempt, recovery.maxRecoveries),
        { recoveryAttempt: recovery.attempt, maxRecoveries: recovery.maxRecoveries },
        false,
      ),
      { triggerTurn: true },
    );
  });
}
