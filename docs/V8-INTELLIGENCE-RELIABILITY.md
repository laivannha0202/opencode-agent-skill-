# UES 8.0 Intelligence & Reliability

UES 8.0 focuses on runtime reliability, stronger evidence gates, context quality, safe parallelism and measurable learning. It does not change the underlying model; it improves how engineering work is selected, executed, verified, recovered and evaluated.

## 1. Hard evidence gates

Long-horizon and high-risk work uses strict evidence policy.

Plan approval requires a structured `plan-verification` receipt bound to the current `PLAN.json` hash:

```bash
ocskill work gate-receipt checkout plan .   --verifier ues-plan-checker   --evidence "plan checker PASS"   --out .ues-work/checkout/reports/plan-receipt.json

ocskill work approve-plan checkout .   --evidence "plan checker PASS"   --receipt-file .ues-work/checkout/reports/plan-receipt.json
```

Task completion requires a successful verification receipt for the active `runId`. In strict mode, the receipt's `workspaceAfter` must also equal the current workspace fingerprint.

Integration PASS requires an `integration-verification` receipt bound to the current workspace fingerprint. `finalize` still rejects any later workspace change.

## 2. Durable runtime journal

Each long work item now includes:

```text
.ues-work/<slug>/
  SPEC.md
  PLAN.json
  STATE.json
  EVIDENCE.json
  EVENTS.jsonl
  tasks/
  reports/
```

`EVENTS.jsonl` is append-only runtime evidence for:

- work initialization;
- plan import and approval;
- task start/session binding/heartbeat;
- verification receipts;
- failure and stale recovery;
- task completion;
- integration verification;
- finalization.

Read recent events with:

```bash
ocskill work events <slug> . --limit 100
```

## 3. Bounded executor lifecycle

The OpenCode V2 dispatcher probes capabilities instead of assuming them from a version string.

A fresh executor has:

- a durable `runId`;
- attached OpenCode session ID;
- heartbeat and lease expiry;
- bounded runtime;
- `session.interrupt` on timeout/cancel;
- task-scoped stale recovery;
- process-tree cancellation for external eval processes.

On Unix, timed-out external process trees receive SIGTERM followed by SIGKILL after a bounded grace period if necessary. Windows uses `taskkill /T /F`.

The V2 plugin exposes task cancellation/recovery tools when the runtime supports session interruption.

## 4. Context manifest v3

Context selection now combines:

- declared task files;
- local imports and reverse importers;
- likely related tests;
- nearby repository instructions/manifests;
- current Git-changed files;
- multilingual task terms;
- symbol hits;
- TF-IDF-style content relevance;
- centered source excerpts around matched terms;
- accepted benchmark-validated lessons.

The context remains bounded by a per-task budget rather than dumping the whole repository.

## 5. Safer parallel writes

Safe-wave analysis still serializes declared read/write conflicts.

Writer tasks are isolated in Git worktrees by default when the root checkout is clean (unless isolation is explicitly disabled). This keeps the first writer off the canonical root as well as later concurrent writers. Integration:

- captures tracked and untracked sandbox changes;
- rejects overlap with dirty files in the root checkout;
- applies the patch to the root only after explicit integration;
- cleans temporary UES worktree branches;
- refuses to delete non-UES branches.

Manual flow:

```bash
ocskill sandbox create <slug> <task-id> .
ocskill sandbox integrate <worktree-path> .
ocskill sandbox list .
```

## 6. Learning v2

Evaluation failures are clustered into recurring patterns and candidate rules.

```bash
ocskill learn analyze . --eval-dir .ues-evals
ocskill learn accept <proposal-id> .
```

Acceptance alone does not make a shadow-required lesson active. Promotion additionally requires measured benchmark improvement:

```bash
ocskill learn promote <proposal-id> . --report .ues-evals/matrix/matrix-summary-<timestamp>.json
```

Promotion reads the benchmark matrix artifact itself, verifies complete/equal baseline-vs-UES coverage, hashes the artifact, and refuses caller-supplied pass-rate claims. Only promoted lessons are eligible for future context retrieval.

## 7. Benchmark matrix

Run standard, long-horizon and polyglot baseline-vs-UES evaluations:

```bash
npm run evals:matrix -- --model provider/model --trials 3
```

The matrix checks expected baseline/UES coverage before producing a summary. Options include:

```text
--long-only
--standard-only
--polyglot-only
--without-polyglot
```

The polyglot suite adds eight tasks covering Python authorization, Java money validation, .NET authorization, Next.js API error handling, React Native platform logic, safe SQL migration, monorepo dependency boundaries and generated-contract discipline.

Benchmark results are evidence for the measured tasks only. They are not evidence that UES converts one model into another model.

## 8. Control Center

```bash
ocskill dashboard . --serve --port 4177
```

V8 adds:

- runtime event visibility;
- verification-receipt inspection;
- stale-task recovery action;
- existing work/learning/eval summaries.

Executor cancellation remains a runtime operation because a standalone dashboard server cannot safely interrupt an OpenCode session it does not own.

## 9. Package migration

The npm package remains:

```text
opencode-agent-skill
```

Users already on 7.7.0 can update normally:

```bash
ocskill update
```

The installer now writes:

```text
<!-- managed-by: opencode-agent-skill -->
```

It still recognizes the former scoped package owner and marker, then migrates them during re-sync.

## 10. Release and supply-chain checks

V8 adds:

- CodeQL workflow;
- dependency-review workflow;
- Dependabot for GitHub Actions and npm;
- package/tag version consistency guard;
- tag-only npm publish workflow;
- OIDC-only npm Trusted Publishing permissions (no long-lived NODE_AUTH_TOKEN);
- fail-closed tag/version guard;
- exact plain global-install compatibility smoke in addition to packed-install smoke.

Trusted Publishing still requires the npm account-side trust relationship to be configured for `laivannha0202/opencode-agent-skill-` and `publish.yml`.

## Validation before release

Run:

```bash
npm run ci
```

Then run a real benchmark matrix with the target model. Merge/publish only after local CI is green and benchmark output has been inspected.
