import { spawnSync } from "node:child_process"
import path from "node:path"

function probe(engine) {
  const result = spawnSync(engine, ["--version"], { encoding: "utf8", timeout: 5000 })
  return {
    engine,
    available: result.status === 0,
    version: result.status === 0 ? String(result.stdout || result.stderr || "").trim() : null,
    error: result.status === 0 ? null : String(result.stderr || result.stdout || "").trim() || "unavailable",
  }
}

export function containerSandboxCapability(preferred = null) {
  const names = preferred ? [preferred] : ["docker", "podman"]
  const probes = names.map(probe)
  const selected = probes.find((item) => item.available) || null
  return {
    schemaVersion: 1,
    available: Boolean(selected),
    selected,
    probes,
    guarantees: selected ? [
      "network disabled by default",
      "Linux capabilities dropped",
      "no-new-privileges",
      "read-only container root",
      "bounded pids/memory/cpu",
      "only requested workspace bind-mounted read-write",
      "no host environment secrets forwarded by default",
    ] : [],
    limitation: "This isolates deterministic verification commands, not the OpenCode model session itself.",
  }
}

function validImage(image) {
  return /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,240}$/.test(String(image || ""))
}

export function buildContainerSandboxArgs(root, image, command, commandArgs = [], options = {}) {
  if (!validImage(image)) throw new Error("container image is required and must be a concrete image reference")
  if (!command) throw new Error("sandbox command is required")
  root = path.resolve(root)
  const memory = String(options.memory || "2g")
  const cpus = String(options.cpus || "2")
  const pids = String(options.pids || "256")
  const args = [
    "run", "--rm", "--init",
    "--network", options.network === "bridge" ? "bridge" : "none",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--read-only",
    "--pids-limit", pids,
    "--memory", memory,
    "--cpus", cpus,
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m",
    "--mount", "type=bind,source=" + root + ",target=/workspace",
    "--workdir", "/workspace",
    "--env", "CI=true",
  ]
  if (process.platform !== "win32" && typeof process.getuid === "function" && typeof process.getgid === "function") {
    args.push("--user", process.getuid() + ":" + process.getgid())
  }
  args.push(image, command, ...commandArgs)
  return args
}

export function runContainerSandbox(root, input = {}) {
  const capability = containerSandboxCapability(input.engine || null)
  if (!capability.available) {
    const error = new Error("container sandbox requested but Docker/Podman is unavailable")
    error.capability = capability
    throw error
  }
  const args = buildContainerSandboxArgs(root, input.image, input.command, input.args || [], input)
  const started = Date.now()
  const result = spawnSync(capability.selected.engine, args, {
    cwd: path.resolve(root),
    encoding: "utf8",
    maxBuffer: Math.max(1024 * 1024, Number(input.maxBuffer || 8 * 1024 * 1024)),
    timeout: Math.max(1000, Number(input.timeoutMs || 10 * 60_000)),
    env: {
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      PATH: process.env.PATH,
      PATHEXT: process.env.PATHEXT,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
    },
  })
  return {
    schemaVersion: 1,
    engine: capability.selected,
    args,
    status: result.status ?? 1,
    signal: result.signal || null,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    durationMs: Date.now() - started,
    timedOut: Boolean(result.error?.code === "ETIMEDOUT"),
  }
}
