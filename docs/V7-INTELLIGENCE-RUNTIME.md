# UES 7.7 Intelligence Runtime

UES 7.7 upgrades the V6 long-horizon harness into a more observable, crash-safe and adaptive engineering runtime. The model is still the model; UES improves how work is decomposed, bounded, verified, recovered and learned from.

## V7.0 — Runtime reliability

- live evals use an async process runner with periodic heartbeats
- hard timeout and idle timeout are separate
- Ctrl+C aborts the active OpenCode process tree instead of leaving an orphan
- durable tasks carry `runId`, owner metadata, heartbeat time and lease expiry
- stale running tasks can be recovered with `ocskill work recover`
- `ocskill work resume` performs stale-lease recovery before reporting ready work
- the V2 plugin probes actual session/runtime capabilities before fresh dispatch

Example:

```bash
ocskill work status checkout .
ocskill work recover checkout .
ocskill work heartbeat checkout T1 . --run-id <run-id>
```

## V7.1 — Structured evidence

`ocskill work verify-command` executes a concrete verification command and records a receipt in `EVIDENCE.json`.

A receipt contains:

- command and arguments
- exit code and pass/fail
- start/end/duration
- SHA-256 of stdout/stderr rather than full output
- workspace fingerprint before and after
- task/runId binding

This complements narrative evidence. Task state reports whether completed work is `receipt-backed` or `narrative`.

```bash
ocskill work verify-command checkout T1 . --run-id <run-id> -- npm test
```

## V7.2 — Context intelligence

Fresh executor context packs now include a bounded context manifest:

- declared task files
- local import neighbors and reverse importers
- likely related tests
- top-level repository instruction/manifests
- bounded source excerpts
- repository graph hotspots
- accepted learning items relevant to the task

The goal is to reduce rediscovery cost without dumping the whole repository into one prompt.

## V7.3 — Adaptive orchestration/model policy

`ocskill task-policy <text>` deterministically classifies work by complexity/risk and recommends:

- `inline`, `standard` or `long-horizon`
- light/standard/heavy model tier
- context budget
- retry budget
- whether plan/integration gates are required

`ocskill model-policy <role> --attempt N --text <task>` combines role defaults, task risk and retry escalation.

## V7.4 — Isolated parallel execution primitives

The task graph distinguishes reads from writes:

- read/read overlap can share a safe wave
- write/read and write/write conflicts serialize

For parallel writers UES provides Git worktree sandboxes:

```bash
ocskill sandbox create <slug> <task-id> .
ocskill sandbox list .
ocskill sandbox remove <worktree-path> . --force
```

Sandbox creation is deterministic infrastructure. Integration/merging remains an explicit parent responsibility; UES does not silently merge branches.

## V7.5 — Evidence-gated learning loop

UES can mine its own eval traces for recurring failure patterns:

```bash
ocskill learn analyze . --eval-dir .ues-evals
ocskill learn status .
ocskill learn accept <proposal-id> .
```

Accepted lessons can appear in later context packs when relevant. UES never auto-edits skills or promotes a lesson from a single run without an explicit accept step.

Current deterministic proposal classes include:

- hard timeout
- idle timeout
- agent process failure
- hidden grader failure
- orchestration failure
- telemetry parse drift

## V7.6 — Optional Hermes bridge

Hermes is treated as an optional external executor, not embedded as another runtime layer.

```bash
ocskill hermes status
ocskill hermes prompt <slug> <task-id> .
```

The bridge emits a bounded UES delegation prompt. Hermes must not independently mutate durable UES state, merge, push, publish or deploy.

## V7.7 — Control Center

Generate a zero-dependency local dashboard:

```bash
ocskill dashboard .
ocskill dashboard . --serve --port 4177
```

When served with `--serve`, the Control Center refreshes its data every few seconds without requiring a frontend build.

The Control Center summarizes:

- long-horizon work items and task status
- attempts, blockers and receipt count
- learning proposals/accepted lessons
- recent baseline/UES evaluation summaries

Generated state lives under `.ues-dashboard/` and is git-ignored.

## Live benchmark observability

The live harness accepts:

```bash
node scripts/eval-live.mjs \
  --suite long \
  --model provider/model \
  --mode both \
  --trials 3 \
  --heartbeat-ms 30000 \
  --idle-timeout-ms 300000 \
  --timeout-ms 900000
```

Every active trial prints a start line and periodic heartbeat rather than appearing frozen.

## Safety boundaries

V7.7 deliberately keeps these actions explicit:

- merging sandbox branches
- forceful Git/history actions
- publishing/releases
- deployment
- destructive database/filesystem operations
- automatic promotion of learned rules
- automatic execution through Hermes

The goal is a stronger runtime without removing human control over irreversible side effects.
