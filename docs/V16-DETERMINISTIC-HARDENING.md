# V16.0 Deterministic Trust & Correctness Hardening

V16 hardens UES around correctness, durable evidence, external-data trust boundaries,
Windows cleanup reliability and measured model economics. It deliberately preserves
the V15.9 routing/context architecture instead of replacing mature subsystems.

## 1. Static Completeness Gate V2

Turbo FAST verification still requires a fresh behavioral receipt, but typed/source
files now receive an independent runtime diagnostics probe before a deterministic
PASS may skip the verifier model turn.

A required static probe must be both:

- `complete === true`; and
- free of error diagnostics.

Timeout, unavailable provider, incomplete module graph, probe failure, multiple typed
mutation targets, or real diagnostics errors disable the deterministic shortcut and
fall back to the normal independent verifier. Incomplete diagnostics are never
laundered into a clean result.

## 2. Durable Evidence Pinning + Resume Integrity

Evidence Store GC now protects evidence hashes reachable from active `.ues-work`
JSON state, in addition to verified-memory references. Context/document/spec evidence
also receives a bounded grace window so a recently compacted context cannot disappear
during active work merely because the store crosses an entry/byte cap.

Checkpoints persist concrete `evidence:sha256:...` references when present. The
compaction resume guard audits those refs and reports:

- `OK` when all referenced blobs exist;
- `DEGRADED` when any referenced blob is missing;
- `NOT_APPLICABLE` when no concrete refs are recorded.

A degraded resume packet explicitly requires fresh evidence instead of inferred
completion.

## 3. External Data Provenance Boundary

External/MCP output has an explicit provenance contract:

- `trustClass: external-data`
- `instructionAuthority: none`

Flagged prompt-injection-like content keeps the stronger warning path. Benign external
content can also receive a compact data-boundary marker so embedded text never acquires
authority to change the user's goal, permissions, verification policy, or authorize
secret/network/system actions.

This complements heuristic injection detection; it does not claim semantic prompt
injection is solved by regex.

A narrow capability-level exfiltration guard also blocks shell/service commands only
when all three facts are present together: an outbound network-transfer primitive, an
explicit credential/secret source, and an outbound payload operation. Ordinary public
network reads and ordinary local reads are not denied by this guard.

## 4. Windows-safe Cleanup Barrier

A shared `safeRemovePath` primitive retries bounded transient filesystem failures
(`EBUSY`, `EPERM`, `ENOTEMPTY`, `EMFILE`, `ENFILE`) with backoff and Node's
native recursive-removal retry support.

Worktree cleanup and workspace hygiene use this primitive. Process tree teardown
remains owned by the existing process supervisor (`taskkill /T /F` on Windows and
process-group TERM/KILL on POSIX).

## 5. Cost-aware empirical model routing

Measured routing now accounts for retry-amplified expected token work after the
existing minimum sample floor. Correctness evidence remains primary; token cost cannot
reorder models from one noisy observation.

The empirical candidate surface exposes:

- `empiricalExpectedWorkTokens`
- `empiricalTokenPenalty`

This lets UES avoid a nominally cheap model when repeated retries make it more
expensive overall.

## Non-goals

V16 does not rewrite the LSP pool, durable task lease system, process supervisor,
semantic-index GC, worktree integration, independent verifier, or V15.9 context ABI.
Those systems remain authoritative.

V16 also does not claim the model session itself is fully container isolated. Existing
container verification remains a deterministic verification sandbox; broader execution
isolation is a separate trust boundary and must not be implied by this release.

## Focused verification

`npm run eval:v16` covers:

- fast static completeness gating;
- active durable evidence GC protection;
- missing-evidence resume degradation;
- bounded filesystem cleanup retries;
- external-data provenance;
- retry/token-aware empirical model routing;
- V15.9 runtime regressions.
