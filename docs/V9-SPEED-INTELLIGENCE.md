# UES 9.0 Speed & Intelligence

UES 9.0 builds on the V8 evidence and reliability gates. The goal is not to make the underlying model generate tokens faster; it is to reduce time-to-correct-result by finding the right code sooner, shrinking unnecessary context, avoiding unsafe retries and requiring evidence before completion.

## Execution profiles

UES classifies work into three execution profiles:

- **FAST**: small/low-risk work, up to 2 skills, 12k context budget, targeted verification, no durable worktree/critic overhead by default.
- **STANDARD**: medium work, up to 4 skills, 24k context budget, semantic+Git context and targeted/affected verification.
- **DEEP**: long-horizon or high-risk work, up to 5 skills, 48k context budget, durable state, worktree isolation, critic/integration verification and full CI.

Risk still overrides speed. Authentication, security, payment, schema/migration, production/deploy and public-contract work remains fail-closed.

## Incremental evidence index

The V9 index caches bounded source metadata under `.ues-cache/semantic-index-v1.json`. Unchanged files reuse cached evidence while changed files are reparsed. It records:

- concrete source paths;
- bounded symbol definitions with line numbers;
- lexical identifier counts;
- cache reuse/reparse statistics.

This is intentionally labelled **syntax-aware lexical evidence**. It must not be presented as proof of program semantics or as a full AST/LSP call graph.

Commands:

```bash
ocskill index status .
ocskill index build .
ocskill index rebuild .
ocskill aci search "checkout total" .
ocskill aci refs calculateTotal .
ocskill aci view src/checkout.ts . --line 120 --lines 80
ocskill aci text "exact marker" .
```

## Weak-model ACI

The ACI keeps search/view output bounded and evidence-first. Path traversal outside the repository is rejected. Large/binary files are refused by the bounded viewer. Reference results distinguish lexical references from concrete definition lines so an agent cannot honestly claim deeper semantic certainty than the tool measured.

## Runtime traces

Operational trace events are appended under `.ues-traces/*.jsonl`. Common credentials/tokens are redacted before persistence, oversized payloads are hashed/truncated, and traces explicitly exclude hidden chain-of-thought.

```bash
ocskill trace show <trace-id> .
```

## Verification sandbox

When Docker or Podman is available, deterministic verification commands can run with:

- network disabled by default;
- Linux capabilities dropped;
- no-new-privileges;
- read-only container root;
- bounded PIDs/memory/CPU;
- only the requested workspace bind-mounted;
- no host secrets forwarded by default.

This protects verification commands; it does **not** claim to sandbox the OpenCode model process itself.

## Benchmark confidence gate

The matrix now embeds paired baseline/UES evidence and computes:

- paired wins/losses/ties;
- pass-rate delta;
- exact two-sided sign-test p-value;
- per-suite regression checks;
- mean duration ratio;
- optional cost ratio.

Normal reporting:

```bash
npm run evals:matrix -- --model provider/model --trials 3
```

Fail-closed release gate:

```bash
npm run evals:matrix:gate -- --model provider/model --trials 3
```

The gate requires enough paired samples, positive uplift, more UES wins than losses, statistical support, no suite regression and acceptable speed. This is evidence for the measured benchmark only; it is not evidence that UES turns a weaker model into a different model.

## Lock and Windows hardening

State locking now uses owner tokens and heartbeats. Stale takeover renames the old lock before removal, and release only removes a lock whose token still belongs to the caller. Windows CLI/router invocation resolves Node-backed shims and refuses unrecognized batch shims rather than falling back to shell execution.

## Release validation

Before publishing 9.0.0:

```bash
npm run ci
npm run evals:matrix:gate -- --model provider/model --trials 3
```

If GitHub-hosted Actions still fails before the first workflow step, treat that as an infrastructure/repository-action issue rather than test evidence; local CI and the paired benchmark remain required release gates.
