        await completeDurableWave(waveResults);
        await cleanupSandboxes(input.root, prepared);
        break;
      } catch (error) {
        await failDurablePrepared(
          prepared,
          error instanceof Error ? error.message : String(error),
        );
        await cleanupSandboxes(input.root, prepared);
        lastWaveFailure = error instanceof Error ? error.message : String(error);
        if (attempt < input.maxAttempts) continue;
        return {
          passed: false,
          reason: "wave-runtime-failed",
          wave: waveIndex,
          attempt,
          failure: lastWaveFailure,
          validation,
          schedule: { safeWaves: safe.waves, serialized: safe.serialized, dynamic },
          results,
          integrations,
        };
      }
    }
  }

  return {
    passed: true,
    validation,
    schedule: { safeWaves: safe.waves, serialized: safe.serialized, dynamic },
    results,
    integrations,
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
  // Child Pi processes explicitly load ues-child-runtime.ts. Keep provider/MCP
  // extension discovery enabled, but do not recursively register the full UES
  // controller inside specialist workers.
  if (process.env.UES_CHILD_PROCESS === "1") return;

  pi.on("session_shutdown", async () => {
    CONTEXT_PACK_CACHE.clear();
    await RPC_POOL.stopAll().catch(() => {});
  });

  pi.on("input", async (event, ctx) => {
    if (process.env.UES_CHILD_PROCESS === "1") return { action: "continue" };
    if (event.source !== "interactive" || event.streamingBehavior !== "steer") {
      return { action: "continue" };
    }

    const text = String(event.text || "").trim();
    if (!text) return { action: "continue" };

    if (/^(?:stop|cancel|abort|dừng|dung|hủy|huy)(?:\s|$)/i.test(text)) {
      const result = await RPC_POOL.abortActive();
      if (result.aborted > 0) {
        try { ctx.ui.notify(`UES: aborted ${result.aborted} active child worker(s)`, "warning"); } catch {}
        return { action: "handled" };
      }
      return { action: "continue" };
    }

    const steered = await RPC_POOL.steerActive(text).catch(() => ({
      accepted: false,
      reason: "steer-failed",
      active: 0,
    }));
    if (steered.accepted) {
      try { ctx.ui.notify("UES: steering message forwarded to the active child", "info"); } catch {}
      return { action: "handled" };