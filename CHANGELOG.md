# Changelog

## [Unreleased]

## [16.12.0] - 2026-10-07

### Added

- Verification Receipt Cache V16.12 (`lib/verification-receipt-cache-v16-12.mjs`): a receipt is reusable as a PASS **only** when the workspace content fingerprint AND the full gate identity (name, command, args, cwd, env policy digest, Node runtime identity, verification policy version) match. Any source/test/`package-lock.json`/config/runtime/policy change is a MISS; `FAIL`/`ABORT`/`TIMEOUT`/`PARTIAL`/`UNVERIFIED` are never reusable; a corrupt entry is a MISS; final-release mode disables reuse entirely. Windows-safe `atomicWriteJson` retries `EBUSY`/`EPERM`/`EACCES`/`EEXIST` and degrades a failed write to a miss, never a wrong answer.
- Task DAG Scheduler V16.12 (`lib/task-dag-scheduler-v16-12.mjs`): declares node effects (`PURE`/`READ_ONLY`/`CACHE_WRITE_SAFE`/`SOURCE_WRITE`/`PROCESS_MUTATION`), overlaps only what is safely independent, and **never overlaps a `SOURCE_WRITE`**. Every node settles to exactly one terminal status (`DONE`/`FAILED`/`CANCELLED`/`STALE`/`SKIPPED`); a critical failure cancels dependents; a deadlock guard reports `DAG_DEADLOCK` instead of spinning.
- Tool Result Reuse V16.12 (`lib/tool-result-reuse-v16-12.mjs`): a repeated identical read/search is a `CACHE_HIT`; a changed content hash/range/query/path/root is a MISS; a caller can force a fresh reread; large values spill to the Evidence Store (`spillBytes`) so a giant raw evidence blob is not duplicated in memory.
- Incremental Verification V16.12 (`lib/incremental-verification-v16-12.mjs`): **composes and evolves** the V16.10 Verification Ladder (the ladder stays the escalation authority). It classifies the task shape (`TINY`/`NORMAL`/`DEEP`/`RELEASE`) and asks the ladder for the cheapest sufficient rung; uncertainty escalates; a failure delta is compacted through the V16.10 Tool Output Budgeter.
- Warm Service Reuse V16.12 (`lib/warm-service-reuse-v16-12.mjs`): services are **lazy** (a registry with no use starts nothing), reuse is bounded (per-kind + total capacity, LRU eviction), a warm handle that fails its health check is evicted, idle handles are cleaned up, and concurrent cold starts for the same key are single-flight. No always-on LSP, no browser pool owner (browser ownership stays with V16.11).
- Waste Detector + Wall Attribution V16.12 (`lib/waste-detector-v16-12.mjs`): tracks repeated reads, repeated gate executions, repo-index rebuilds, unnecessary browser starts and full-suite counts, each with a provenance (`MEASURED`/`DERIVED`/`ESTIMATED`/`NOT_MEASURED`). It **feeds Metrics V2** via `wallAttributionToEfficiencyEvents()` and is **not a second metrics authority**.
- Execution Acceleration Runtime V16.12 (`lib/execution-acceleration-v16-12.mjs`): the single **composition owner**. It picks a deterministic fast path (`TINY_FAST_PATH`/`NORMAL_PATH`/`DEEP_PATH`/`RELEASE_PATH`), wires the capabilities into one bounded execution, and holds no cache/ladder/ledger of its own. **The release path is sacred**: `receiptReuse` is disabled, `freshGatesRequired` is true, and `assertFreshGateAllowed()` refuses any release gate backed by a cached receipt.
- `npm run bench:v16.12` (`scripts/bench-v16-12-acceleration.mjs`): a deterministic benchmark over the real production composition. It is labelled `SIMULATED_ONLY` / `synthetic: true` and `providerTokens: "NOT_MEASURED"`; per-scenario timings are never summed into a task-level speedup.
- `npm run eval:v16.12`: the V16.12 capability + source-integrity suites.

### Changed

- `lib/efficiency-metrics-v16-10.mjs`: `CAPABILITY_EVENT_KINDS` gains an `executionAcceleration` entry so Metrics V2 can aggregate the V16.12 `execution-acceleration` observations. This **extends** the single metrics authority; it does not add a second one.
- `lib/lazy-runtime.mjs`: registers `EXECUTION_ACCELERATION`, `VERIFICATION_RECEIPT_CACHE`, `TOOL_RESULT_REUSE` and `WASTE_DETECTOR` as lazy modules. A local-only run hydrates none of them and PI_ONLY spawns zero browser.
- `pi/extensions/ues.ts`: hydrates the acceleration stack lazily; the read-only `ues_code` `verification-plan` action prefers the V16.12 incremental plan and **falls back to the raw V16.10 ladder** if the module cannot hydrate; `/ues-status` reports the acceleration plan + receipt-cache stats. V16.11 lifecycle/epochs/recovery/poll fallback/submit guard are preserved unchanged.
- `scripts/check-source-integrity.mjs` adds the V16.12 source contracts; V16.8/V16.9/V16.10/V16.11 remain byte-stable.

## [16.11.0] - 2026-10-07

### Added

- Advisor Lifecycle V16.11 (`lib/advisor-lifecycle-v16-11.mjs`): a PURE identity primitive for the three advisor lifecycles (BrowserWorker / Conversation / AdvisorRun). It owns `workerEpoch` / `profileEpoch` / `conversationEpoch` / `runGeneration`, the stale-event classifier (`classifyStaleness` / `isEventOwned`) and the fail-closed conversation-reuse decision (`evaluateConversationReuse` / `conversationReuseKey`). A worker recycle bumps the worker epoch AND the conversation epoch and clears the conversation id; a run generation is never touched by a recycle.
- Browser Transport V2 (`lib/browser-transport-v16-11.mjs`): a typed `request` / `response` / `event` envelope that is a SUPERSET of the legacy V1 messages, so an old worker keeps working. It negotiates the protocol version, gates the event channel on a worker-advertised capability, never throws on a malformed message (fail-closed value), and bounds + redacts every text-bearing event. `createCoalescingEventSink` keeps only the latest delta in a window while always delivering terminal events.
- Event-First Answer Bridge (`lib/advisor-event-bridge-v16-11.mjs`): the single place that decides, per consult, whether the event channel or the bounded poll fallback drives the observation. It feeds decoded events straight into the proven `advisor-answer-observer` and reports the honest channel (`event` / `poll` / `event-then-poll` / `none`). An advertised-but-silent channel reports `poll`, never a fabricated event win.
- Advisor Recovery (`lib/advisor-recovery-v16-11.mjs`): bounded recovery (`RECOVERY_MAX_TOTAL_ATTEMPTS = 3`, `RECOVERY_MAX_PER_KIND = 2`, fail-closed on an unknown kind) and `createSubmitGuard`, a single-flight epoch-scoped idempotency gate that refuses re-claiming an in-flight or completed submit (`submit-in-flight`).
- Latency Metrics V16.11 (`lib/advisor-latency-metrics-v16-11.mjs`): an honest aggregation that never averages across `workerState` (cold/warm) or `channel` (event/poll). A cell with no MEASURED sample is `NOT_MEASURED`; a cold→warm speedup is only computed when BOTH sides have a MEASURED sample; a simulated run reports `SIMULATED_ONLY` and never claims a live-provider win.
- Windows Resource Hygiene (`lib/windows-resource-hygiene-v16-11.mjs`): an ordered teardown (kill the process tree BEFORE file removal, then release locks) that returns a receipt (`COMPLETE` / `PARTIAL` / `FAILED` / `NOTHING_TO_DO`) plus `detectRetainedResources`, so cleanup is proven instead of assumed.
- Advisor Runtime V16.11 (`lib/advisor-runtime-v16-11.mjs`): the single per-run composition. It owns ONE session manager and threads the event bridge, recovery and metrics into it, exposing `beginConsult` / `observeEvent` / `pollOnce` / `completeConsult` / `claimSubmit` / `onFailure` / `shutdown`.
- `npm run bench:v16.11` (`scripts/bench-v16-11-runtime.mjs`): a deterministic cold/warm + event/poll benchmark over the real composition. It is labelled `SIMULATED_ONLY` and `providerTokens: "NOT_MEASURED"`; a live claim requires an operator-run authenticated profile.

### Changed

- `lib/advisor-session-manager.mjs` is now the SINGLE production owner of all three advisor lifecycles (BrowserWorker / Conversation / AdvisorRun), not just the conversation. It keeps the byte-stable V16.9 policy id (`advisor-session-manager-v16-9`) and the `single-writer` invariant, and evolves via `ADVISOR_SESSION_MANAGER_SCHEMA_VERSION = 2` + `ADVISOR_SESSION_MANAGER_IMPLEMENTATION = "advisor-session-manager-v16-11"`.
- `pi/extensions/ues.ts` wires the advisor runtime lazily through the new `ADVISOR_LIFECYCLE` stack. `ACTIVE_WEB_WORKERS` becomes a PROCESS REGISTRY (handles only) and `ACTIVE_ADVISOR_RUNTIMES` remembers the per-run owner; the browser process is injected as `acquireWorker` / `releaseWorker` / `healthCheck` callbacks, so the lifecycle is deterministically testable while the process stays owned by the extension. The V16.7.1 lazy-launch and teardown contracts are preserved verbatim.
- `lib/lazy-runtime.mjs` registers the V16.11 advisor lifecycle stack (lifecycle, session manager, transport, bridge, recovery, latency metrics, hygiene, runtime) so a run that never consults never loads any of it.

### Performance

- Event-first answers remove the per-answer poll round-trip when the worker advertises the event channel; the bounded poll fallback is always enforced. Cold/warm reuse is measured in separate cells and never averaged, so the warm-reuse win is reported honestly (or NOT_MEASURED) rather than fabricated.

### Security

- No change to trust: DeepSeek remains an UNTRUSTED advisor, Pi remains the sole executor and the local verifier remains the correctness authority. Every text-bearing transport event is bounded and redacted; no browser credential is ever surfaced.

## [16.10.0] - 2026-10-07

### Added

- Context Kernel V2 (`lib/context-kernel-v16-10.mjs`): the single owner of the context ALLOCATION decision. Given a task and a hard char budget it decides, per tier (pinned/task/evidence/memory/history), what rides inline, what is compacted and what is dropped. Deterministic compaction runs first (whitespace -> dedupe-lines -> structural head/tail) and an optional model summarizer is consulted LAST. Compaction that is not strictly smaller is refused (`applied: false`), pinned content is never dropped, and a pinned-overflow is reported as `overBudget` rather than silently cut.
- Tool Output Budgeter (`lib/tool-output-budgeter-v16-10.mjs`): a PURE shaping primitive that replaces ad-hoc per-tool truncation with strategy-aware shaping (read-file / search / test / diff / generic). Every bounded view carries original/visible/omitted counts and a retrieval handle, so truncation is honest and expandable. It owns no store, no fs and no model call; `lib/tool-output-governor.mjs` remains the single governor and delegates shaping to it.
- Repo Intelligence V2 (`lib/repo-intelligence-v16-10.mjs` + `lib/repo-intelligence-cache-v16-10.mjs`): one orchestrator that composes `repo-graph`, `semantic-index`, `repo-map` and `affected-tests` through a fingerprint-scoped persistent cache. The cache writes atomically (temp + rename, Windows retry), coalesces in-flight computation per key, evicts by count AND bytes, validates schema version, and degrades corruption to a MISS rather than a wrong answer.
- Semantic Tool Router (`lib/semantic-tool-router-v16-10.mjs`): an ADVISORY, deterministic ranker over the caller's existing tool universe. It is never a second surface owner (`compileToolSurface` still decides what is advertised), never widens the universe, never advertises a denied tool, and caps the discovery dispatcher below any concrete match. Confidence is DERIVED from the score margin, never fabricated.
- Verification Ladder (`lib/verification-ladder-v16-10.mjs`): orchestrates the existing verifiers (`verification-broker`, `fast-static-verification`, `affected-tests`) into a cheapest-sufficient rung order (reuse -> static -> affected -> suite -> independent). A rung that PASSES but is too weak is recorded as `passed-insufficient` and the ladder keeps escalating; absence of evidence is UNVERIFIED, never PASS, and only a rung that actually ran and failed yields FAIL.
- Metrics V2 (`lib/efficiency-metrics-v16-10.mjs`): the single aggregation owner for the V16.10 capability receipts. It sums only over MEASURED rows, refuses a ratio unless its denominator is fully measured, labels char->token savings ESTIMATED, and keeps headline token savings explicitly NOT_MEASURED. It is pure-read: it never writes a ledger and never runs a task.

### Changed

- `pi/extensions/ues.ts` now builds the runtime context pack through Context Kernel V2 (`compactContextPack` delegates the budget decision to `planContextKernel` + `compactDeterministically`), orders candidate tools through the Semantic Tool Router (`mergeRouteIntoPriorities`, ordering-only), surfaces Metrics V2 in the `/ues-status` digest, and exposes two new read-only `ues_code` actions: `repo-intelligence` and `verification-plan`.

### Performance

- Capability benchmark (`npm run bench:v16.10`, `scripts/bench-v16-10-capabilities.mjs`): on a 175 KB repetitive test log the Tool Output Budgeter collapses 175,013 chars to 2,146 (~98.8%) and the Context Kernel to 4,100 chars (~97.7%), both strictly smaller and honest. Wall-clock, char counts and call counts are MEASURED; provider tokens stay `NOT_MEASURED`.

## [16.9.0] - 2026-10-06

### Added

- Stateful DeepSeek advisor lifecycle: single owner for the advisor session, a dialogue coordinator enforcing the single-flight turn invariant, and a dialogue-aware capsule owner.
- Evidence broker: the single owner of the "advisor ASKS for local evidence" loop, wrapping the V16.6 request primitives behind one bounded `serve()` with a source registry and an honest unavailable-kind receipt.
- Shared-context ledger: the broker now consumes a run-scoped seen-evidence ledger (keyed by stable request identity, marked with an `evidence_id` content hash) so evidence the advisor already saw is referenced by marker or a bounded line-delta instead of being re-sent. It NEVER forbids the executor from rereading source; a post-write epoch bump invalidates reuse so stale evidence cannot ride. Scope is `evidence:<runId>:<root>`, so evidence never leaks across workspaces.
- Adaptive admission: a deterministic route decision (LOCAL_DETERMINISTIC / PI_ONLY / PI_PLUS_ADVISOR / ADVISOR_RETRY) that runs BEFORE a browser session or a token is spent, with verifier-feedback re-scoring and de-escalation.
- Workspace-state owner and pre-write fence: a monotonic generation and a fail-closed last gate before source mutation, refusing writes to generated, out-of-scope or read-only targets.
- Execution coordinator: one handoff record that reuses the V16.8 Decision Barrier verdict and adds the write-side fence; a refused handoff downgrades to a local fallback (AUTO) or an explicit unavailable (FORCE).

### Changed

- `lib/lazy-runtime.mjs` resolves `WEB_REASONING_LANE` to the V16.9 lifecycle wrapper, which re-exports the V16.8 lane verbatim so every existing caller keeps the same result shape.
- `pi/extensions/ues.ts` now serves evidence requests through the evidence broker instead of an inline closure; the workspace-diff source is gathered lazily only when the advisor actually asks for it. Served evidence is carried into the follow-up turn as an `evidence-delta`, closing the request loop, and a completed write turn bumps the ledger epoch so later turns cannot reuse evidence invalidated by the mutation.

### Performance

- Adaptive admission pre-gate on a no-signal task: 203.2ms/op (V16.8) to 0.032ms/op (V16.9), ~100% of the pre-consult phase0/local-prep work skipped, 0 provider consultations in both. Measured by `npm run bench:v16.9`.
- Representative A-G task matrix (`npm run bench:v16.9:representative`): a repeated evidence request drops from 4002 to 134 characters (an `evidence_id` marker), a ~96% reduction on the repeated-evidence path. Wall-clock, char counts and call counts are MEASURED; provider tokens stay `NOT_MEASURED`.

### Notes

- Unmeasured token savings are reported as `NOT_MEASURED`; no optimization is wired without a measured benefit.
- The admission microbenchmark above is NOT extrapolated into a total task speedup. The representative A-G matrix measures whole-task wall-clock separately, and the two are reported side by side.

## [16.8.0] - 2026-10-06

### Added

- Async Web Advisor consultation overlapped with deterministic source-read-only local preparation.
- Decision Barrier with generation and workspace fingerprint fencing.
- Strict compact executor advisor capsule with feasibility validation.
- Deterministic circuit breaker, timeout/cancellation fencing, stale-result discard and measured overlap telemetry.

### Fixed

- Concurrent regression-test workspace probe isolation and Windows cancellation settle stability.

## [16.7.2] - 2026-10-06

### Fixed

Production correctness and runtime hardening follow-ups shipped in 16.7.2.

- **DeepSeek Web grounding starvation.** The primary `webLane.consult()` (and the
  patch-review consult) passed no local grounding, so `knownFiles` was empty, the
  decision packet carried `packetFiles: 0`, every provider claim was classified
  `unverified`, and the fail-closed binder rejected the advice (`advisorText: null`).
  The controller now builds a TRUTHFUL, bounded local grounding capsule from runtime
  state that already exists (plan task files, planning-recovery referenced files, and
  the run's changed files) and passes `knownFiles` + `relevantFiles`. `knownFiles`
  stays local-only; `relevantFiles` drives the outbound packet. No repo rescan and no
  fabricated paths.
- **The follow-up consult read `structuredPlan.files`, which never exists** (files live
  at `plan.tasks[].files`). It now uses the same grounding builder, so the resume
  capsule is genuinely populated.
- **Agent generation-loop guard.** A new self-contained watchdog
  (`lib/agent-progress-watchdog.mjs`) detects the repetitive-narration stall
  (`"Let me write. Go."` repeated with zero tool calls or file mutations) from the
  ABSENCE of action progress plus a repeated narration fingerprint — never vocabulary
  alone. It warns first, then performs at most a bounded context-edit recovery, then
  fails closed with `AGENT_LOOP_UNRECOVERED`. Detection is bounded (fixed rolling
  window, fixed counters), side-effect-free, and only active during a UES run.
- **Process/timeout hygiene.** The run-scoped web lane, managed browser lane, and the
  persistent browser worker + exclusive profile lease are now released in a `finally`
  block on every exit path, including a throw and a parent timeout/abort, so a
  timed-out controller leaves no zombie worker and no stale profile lock.
- **Workspace-root call sites read the resolver object as a string.**
  `resolveGitWorkspaceRoot(start)` returns `{ ok, requested, root, error }`, not a
  string. Three production call sites used the raw object: the two compaction hooks
  passed it to helpers that require a path string, so they threw
  `The "paths[0]" argument must be of type string` and every caller swallowed the
  throw — the durable compaction resume guard therefore never ran in production;
  and the `input` auto-admission test treated the always-truthy object as a Git
  workspace, defeating the V15.12 fail-closed admission check for non-Git
  directories. All three now read `.root`.

No safety, budget, quality, escalation or permission behavior is changed.

### Added

V16.7.1 release parts that close the remaining proof gaps on the DeepSeek Web lane.

- **Verified local grounding (Part 1).** `knownFiles`/`relevantFiles` now pass a real
  filesystem existence + repo-containment check (`resolveVerifiedRepoFile`): absolute paths,
  `..` escapes, and non-files are dropped, so a planner hallucination can never become local
  truth. `verifyLocalAdvice` is unchanged and is never weakened.
- **Streaming generation-loop guard (Part 2).** The parent watchdog observes the real Pi
  `message_update` / `assistantMessageEvent.text_delta` events, warns on a repeated trailing
  window, then aborts the CURRENT generation with `ctx.abort()` BEFORE `message_end` — bounded
  memory, deterministic, no false positive on a legitimate long stream or a stream with real
  tool progress. Detection is TWO bounded candidates: a word-token trailing repetition (period
  up to `maxStreamPeriod`) and a PHRASE trailing repetition (sentences/clauses, period up to
  `maxStreamPhrasePeriod`). The phrase candidate is required because the real defect streamed a
  CYCLE of five short phrases (`"Let me write. / Go. / OK. / Writing. / Let me output."`, nine
  normalized tokens) which a token-period bound alone can never see. Both candidates only
  qualify when the repeating block is a declared imminent action, so a repeated code fragment or
  ordinary prose repetition is never treated as a loop.
- **Watchdog scope (Part 3).** The loop guard now protects any engineering/tool-capable turn
  (`uesModeActive()` OR an admitted engineering turn OR a turn that already used a tool), not
  only an explicit UES run. Casual chat is never guarded.
- **Two-level cleanup (Part 4).** Level A is cooperative `try/finally`; Level B covers an
  uncooperative external process death with dead-owner lock reclaim. A live-owner lock is
  NEVER stolen, and TTL expiry alone never reclaims a live owner.
- **Real manual login (Part 5).** `ues deepseek login --profile <name>` opens a HEADED
  persistent browser and waits, bounded, for the human to sign in. It NEVER reads, fills or
  logs a password, cookie, token, OTP, CAPTCHA or storageState, and never switches the active
  profile. An incomplete login is `HUMAN_ACTION_REQUIRED` (exit 2), never a fake success.
- **Persisted, secret-free enablement (Parts 6-7, 18).** Only safe metadata
  (`enabled`/`mode`/`profile` NAME) is persisted to `<ues-config>/.ues/web-reasoning.json`.
  Precedence is env override > persisted config > default; the default posture is `AUTO`
  (`FORCE` is never a default). The browser is launched lazily, only when a consultation is
  actually about to be sent, and closed cleanly; the daily flow is just `cd <project>; pi`.
- **Bounded consultation policy and accounting (Parts 8-13).** Documented proactive triggers
  and a skip list; parallel read-only prep with no irreversible write on incomplete advice; a
  compact outbound packet that records `packetChars`/`packetFiles`/`packetEvidenceCount`; a
  compact advisor capsule (`hypotheses`/`approach`/`evidence`/`risks`/`alternatives`/
  `questions`/`confidence`, plus `advisorCapsuleChars`); one initial consult with at most one
  bounded, novelty-gated follow-up; and a consultation cache identity that includes the profile
  ID, task fingerprint, evidence digest, repo fingerprint and session identity, with a
  replay-vs-live `source` discriminator.
- **Closed, secret-free failure classification (Part 14).** `needs-auth`, `ui-changed`,
  `browser-unavailable`, `service-unavailable`, `rate-limited` and `profile-locked` are now
  distinct from the generic `provider-error`, classified from stable provider tokens only; the
  raw message is never returned or logged, and the adapter hooks (`authProbe`/`domInspect`/
  `transitionBegin`/`transitionMeasure`) are preserved.
- **Telemetry and measurement honesty (Parts 15-16).** Structured, secret-free journal fields
  for each consultation; the A/B benchmark reports `NOT_MEASURED` (null + reason) wherever a
  metric is unavailable instead of a fabricated number.

No safety, budget, quality, escalation or permission behavior is changed. `verifyLocalAdvice`
and every previously verified safety/budget/verifier invariant is preserved.

## [16.7.1] - 2026-10-05

### Fixed

DeepSeek Web consultations could never complete on the production path. The controller
passed the escalation router a `notes` payload as a JOINED STRING, while the router
assumed an ARRAY and called `.join()` on it. That threw
`TypeError: (intermediate value).join is not a function` for every non-empty string, the
async throw became a rejected promise, and the controller swallowed it with
`.catch(() => null)`, so the consultation result was always `null` and no reason was ever
recorded.

- The escalation router now normalizes `notes` at its single canonical boundary
  (`normalizeNotes`): an array is preserved, a non-empty string becomes a one-element array,
  and `null`/`undefined`/`""` become an empty array. No caller has to know the router's
  preferred shape and no layer re-normalizes.
- A thrown consultation is never swallowed to `null`. The controller journals a structured,
  secret-free reason (`web-reasoning.consultation-error`) using the closed vocabulary
  `consultation-error` | `escalation-error` | `provider-error` | `unavailable` | `timeout`,
  then honors the mode: AUTO falls back to local, FORCE keeps its fail-loudly contract with an
  explicit `WEB_REASONING_UNAVAILABLE` result. The raw error message is never logged.
- The `web-reasoning.consulted` journal event is now discriminated. It distinguishes a cache
  replay, a real provider consultation, a skip, an unavailable provider and a thrown error via
  a `source` field and always-defined `provider`/`outcome`. A live provider consultation
  reports `provider: deepseek-web`, `outcome: success`, and the old
  `provider: undefined, outcome: undefined` ambiguity is gone. A fake success is never emitted
  when `consultation === null`.
- The reassigned consult binding is `let`, not `const`. The stale/late-response isolation path
  reassigns `consultation = null`; with `const` this threw
  `TypeError: Assignment to constant variable` on a real response race.
- The lane now reports `consulted` and re-exposes the error classifier, so the controller never
  statically imports the lazy escalation module and never re-derives provider participation.

No safety, budget, quality, escalation or permission behavior is changed. Turn budgets,
FAST/EASY suppression, the default `UES_WEB_REASONING_MODE=auto`, and the default
`UES_WEB_REASONING_LIVE=false` are unchanged.

## [16.7.0] - 2026-10-05

### Added

DeepSeek account, profile and authentication lifecycle. Multiple independent DeepSeek
profiles (`personal`, `work`, `test`, or any valid custom name) with an explicit active
profile, a bounded manual login, and a mid-task expiry path that continues the task without
losing state. The full design and safety contract are in
`docs/V16.7-DEEPSEEK-ACCOUNT-PROFILE-AUTH.md`; the invariants are asserted by
`test/deepseek-profile-v16-7.test.mjs` (38 tests).

- **Profile registry** (`lib/deepseek-profile-registry.mjs`). Profiles live under
  `<ues-config>/browser-profiles/<name>`, OUTSIDE the repository. Writes are atomic; names
  are validated (no traversal, no reserved names); the resolved directory is contained to
  the profiles root; the active profile is EXPLICIT with no auto-fallback; a corrupt
  registry is reported, never silently repaired. The opaque profile id is a SHA-256 of the
  name and carries no path or credential.
- **Per-profile lock** (`lib/deepseek-profile-lock.mjs`). One writer per profile via an
  atomic exclusive create; stale locks (TTL passed, or owner pid provably dead on this host)
  are reclaimed and the reclaim is reported; release is token-safe.
- **Auth lifecycle** (`lib/deepseek-auth-lifecycle.mjs`). Fail-closed classification that
  wraps the V16.3 evidence contract; `ready` is the ONLY state that continues; a bounded
  manual-login wait (90 probes / 180 s) that treats a dead browser as terminal; a prior
  `ready` followed by a login wall becomes `expired` and yields a credential-free
  `expiryResumeRequest` for the existing bounded Resume Capsule. No account substitution.
- **Profile doctor** (`lib/deepseek-profile-doctor.mjs`). READ-ONLY diagnostics with
  `ok`/`info`/`warn`/`error` severities; `error` fails the command. It never launches a
  browser unless `--probe` was explicitly requested, never mutates a profile, never reads or
  prints a credential.
- **CLI** `ues deepseek status|profiles|doctor|login|use|switch|logout|remove-profile|help`.
  `status` and `profiles` are read-only and launch no browser.

### Changed

- **Consult cache isolation.** `consultCacheKey` now includes `profile:<opaque id>` (or
  `none`). A consultation answered for one DeepSeek account can never be replayed for
  another, even when the workspace, diff, packet and question are byte-identical. Applied at
  the runtime call site in `pi/extensions/ues.ts` via a metadata-only, credential-free
  profile-id resolver.
- **Lazy runtime.** The profile registry is registered as a lazy module so it is only read
  when a run actually consults.

### Security

- UES never reads a cookie, token, `storageState`, password or credential; never prints or
  stores one; never autofills credentials, solves a CAPTCHA or injects an OTP; never copies a
  cookie or session between profiles; never auto-falls-back to another account; never grants
  DeepSeek filesystem, Git or terminal rights. Login stays manual and human-driven.
- Asserted by test sections E–F and reported by `ues deepseek doctor`.

### Notes for upgrade

- No widening of any session/eval/token budget. No new persistent store beyond the profile
  registry metadata. No credential read path of any kind. `profileForMode` is unchanged: it
  still returns `null` unless a live run supplies a name.
- Existing single-profile users are unaffected: with no registry, `resolveActiveProfile`
  returns `no-active-profile` and the runtime behaves as before until a profile is chosen.

## [16.6.1] - 2026-10-05

### Fixed

DeepSeek runtime integrity. Every item below was a confirmed production-wiring defect on
16.6.0 HEAD and is reproduced by `test/v16-6-1-regressions.test.mjs` (47 tests, each of which
fails on 16.6.0). The full table with before/after detail is in
`docs/V16.6-UNIFIED-ADAPTIVE-ORCHESTRATION.md` section 1a.

- **Atomic budget escalation**: `refineOrchestrationBudget` recomputes the entire decision from
  the stored inputs. It previously changed only the profile, producing a real `DEEP` run
  advertised with `deepSeekMode: "off"` and a zero-turn advisor budget.
- **Context-pressure budget is applied**: the task policy now spends the budget's own
  (pressure-adjusted) value instead of the profile base. The telemetry figure and the actual
  spend agree.
- **Consult cache cannot replay stale advice**: the key binds the real diff, per-file content,
  the whole Decision Packet, the evidence fingerprint (including the verifier failure), and the
  workspace/provider/model/role/phase. `status + path` and packet prefixes are gone.
- **Real conversation rotation**: `rotateConversationSession` closes conversation A and opens a
  distinct conversation B carrying a bounded Resume Capsule. The browser profile, its cookies and
  its login are never touched, and a rotation never refills the run turn budget.
- **One evidence-request protocol**: canonical JSON `evidenceRequests` on the advisor reply. The
  legacy `EVIDENCE: <kind>` line form remains a compatibility parser over the same normalized
  shape; there is still only one authority path.
- **Cumulative evidence budget**: per-exchange (24,000 chars) and per-run (60,000 chars) limits in
  addition to the request counts. Exhaustion returns a bounded refusal and local reasoning
  continues; nothing is faked as delivered.
- **Relative evidence targets resolve against the workspace root**, never `process.cwd()`.
  Windows drive paths, POSIX, worktrees and child runtimes are all covered, and a sibling
  directory whose name merely shares a prefix is rejected.
- **Fail-closed provider states**: only an explicit recognized READY observation is READY.
  A missing, malformed or unrecognized state, and `logged-out` / `ui-changed` / `timeout` /
  `closed`, all stop instead of being reported as a live conversation.
- **Session reuse no longer resets the conversation**: reuse performs a read-only health probe.
  The previous code navigated to the entry URL on reuse, discarding the thread.
- **Resume capsule sanitization**: secrets are stripped before the capsule object exists, over
  every structured field, not only the rendered content. `maxChars` is exact including the
  truncation marker.
- **Parallel reasoning safety**: the DeepSeek writer occupies one of the budgeted lanes, so
  `maxParallel <= 1` means no overlap, and only explicitly allowlisted read-only operations may
  overlap. Unknown operations fall back to serial.
- **Session-pool writer accounting**: the lease is no longer counted twice, and the
  high-water mark only rises on a granted lease.
- **Decision Packet budget on the real payload**: the ceiling is judged on the rendered
  outbound text, essential constraints are compacted by dropping whole rows rather than
  clipping one mid-sentence, and an essential floor larger than the requested tier is reported
  as `essential-floor-exceeds-tier`.
- **Follow-up delta honesty**: `changedSections` is exactly what was sent;
  `omittedChangedSections` names what changed but was dropped, and a partial delta is flagged
  `misleading`.
- **Canonical follow-up bounds**: `WEB_REASONING_BOUNDS` is the single owner for consultations
  and follow-ups, and the second follow-up is gated by the module that has owned that rule since
  V16.4.
- **Advisor benefit learner**: samples stay pending until the run's local verifier resolves them.
  A task PASS alone is not benefit: acceptance plus a favorable verifier before/after delta is
  required, otherwise the sample is neutral.
- **Wider local grounding for advice**: architecture and root-cause recommendations no longer
  need to name an existing file, but they must be bound to local grounding (symbol, repository
  topology, runtime evidence, verifier evidence, constraint or dependency graph) before use.
- **Tool-output economy**: unique deprecation warnings are preserved verbatim instead of being
  merged, the `up to date` pattern typo is fixed, real progress-bar shapes are recognized, and
  the default mode is `auto` with an explicit refusal reason.
- **Telemetry provenance**: chars-to-token conversions are `ESTIMATED`, unavailable provider
  counters are `NOT_MEASURED`, and the two fabricated zeros are gone.
- **Progress observer**: a real post-render secret scan runs and is reported as `MEASURED`;
  chain-of-thought is reported as a policy invariant rather than an empirical zero.
- **Prefix drift baselines are workspace-scoped** using a hashed workspace identity.
- **Lazy-load graph**: `pi/extensions/ues.ts` no longer statically imports the V16.6 consult cache
  or the parallel-reasoning planner, so an easy task hydrates no DeepSeek session stack.
- **Evidence-first tool routing**: runtime and repository structure outrank task text, and
  `model` alone never means a database model.
- **Description learner scoping**: keyed by model family, risk, phase, tool-surface fingerprint
  and description schema version.

### Added

- `test/v16-6-1-regressions.test.mjs`: 47 production-wiring regressions.
- `test/release-coordinator-v16-6.test.mjs`: release-coordinator coverage through V16.6.

### Changed

- The release coordinator now coordinates `eval:v16.5` and `eval:v16.6` as well, and re-runs each
  eval's behaviour-specific companion scripts so no coverage is lost.
- `UES_TOOL_OUTPUT_ECONOMY` defaults to `auto`; `off` and `on` remain operator overrides.

## [16.6.0] - 2026-10-05

### Added

- **Unified orchestration budget** (`lib/orchestration-budget-v16-6.mjs`): ONE evidence-driven
  decision per run for execution profile, context, skill capsule, advertised tool surface, tool
  description profile, DeepSeek turns, delegation and verification shape. Evidence priority is
  runtime > repository structure > verifier > task text, and task text alone can never reach DEEP.
- **Canonical DeepSeek turn budget** (`lib/deepseek-turn-policy-v16-6.mjs`) replacing
  `maxConsultations = 1`: 0 / 2 / 4 / 6 by complexity, clamped by the existing lane safety bounds
  (consultations <= 3, follow-ups <= 2, effective max 5 turns).
- **`UES_REASONING_MODE`** = `economy` | `balanced` | `deepseek-first`. It controls the degree of
  DeepSeek participation only: it never enables the browser lane and never bypasses escalation.
  An invalid value falls back to `balanced` with `normalized: false`.
- **Session intelligence**: `lib/deepseek-session-budget.mjs`, `lib/deepseek-session-pool.mjs`,
  `lib/deepseek-consult-cache.mjs`, `lib/deepseek-resume-capsule.mjs` - one conversation session
  per run with rotation, a bounded in-memory consult cache, and a bounded, deterministic,
  secret-scanned resume capsule. No second persistent store was introduced.
- **Context-window awareness**: detected -> override -> conservative fallback, clamped and
  labeled `ESTIMATED`; `UES_DEEPSEEK_CONTEXT_TOKENS=auto` is the default and no 64K constant is
  hard-coded.
- **Bounded evidence-request loop** (`lib/deepseek-evidence-requests.mjs`): 8 allowlisted kinds,
  <= 4 per exchange, <= 8 per run, workspace-contained, with `.env` / key material / `.git/` /
  `node_modules/` / traversal denied and a redact -> bound -> re-scan pass before anything can
  leave the machine. DeepSeek still runs no tools.
- **Advisor roles V2** (`lib/deepseek-advisor-roles-v2.mjs`): the 5 V16.5 roles plus
  IMPLEMENTATION_PLAN, CODE_REVIEW, UI_UX_REVIEW and RESEARCH - 9 frozen, one primary thread and
  at most one secondary.
- **Tool description profiles** (`lib/tool-description-profiles-v16-6.mjs`): `full` / `compact` /
  `minimal`. A compression that would drop a protective, permission, containment, failure or
  re-read line is rejected and the original text is restored.
- **Stable-prefix drift guard** (`lib/prefix-drift-guard-v16-6.mjs`): report-only CACHE /
  BALANCED / TOKEN budgets; an env budget may only tighten.
- **Bounded tool-output economy** (`lib/tool-output-economy-v16-6.mjs`), off by default, with
  `assertNoLossyTransform()` as the executable proof that preserved evidence survives.
- **Parallel read-only reasoning overlap** (`lib/parallel-reasoning-v16-6.mjs`): fail-closed,
  exactly one DeepSeek writer, any write during overlap refuses the overlap.
- **Progress Observer V2** (`lib/progress-observer-v2.mjs`) with the header
  `UES 16.6 · DEEPSEEK-FIRST · BALANCED`, compact by default.
- **Measurement provenance** (`lib/measurement-provenance.mjs`): MEASURED / DERIVED / ESTIMATED /
  NOT_MEASURED, with an additive `v16_6` block in the task telemetry.
- `lib/v16-6-runtime.mjs`: the single production surface, hydrating the heavy session and economy
  modules only when a run actually consults DeepSeek or compacts output.
- `scripts/eval-v16-6.mjs`: a deterministic 20-scenario A/B against V16.5 behavior.

### Changed

- The task policy is now derived from the unified budget. Spending less is always allowed;
  spending more requires an evidence floor (high/critical risk, long horizon, hard evidence
  score), and an existing DEEP floor is always kept.
- The web lane receives budget-derived ceilings for consultations and follow-ups; the V16.5
  bounds (consultations <= 3, follow-ups <= 2) are unchanged.

### Unchanged (deliberately)

- Correctness gates, verifier strictness, permission lattice, workspace containment, Evidence
  Store integrity, process cleanup, browser safety, Windows support and LSP fail-closed behaviour.
- `lib/web-reasoning-escalation.mjs` remains the only component that may decide to ask DeepSeek.
- The V16.5 progress observer is kept intact next to Observer V2.

### Measured (deterministic corpus, no live model)

- skill capsule chars 40,000 -> 34,200; advertised tools 158 -> 166; context chars
  248,000 -> 276,000; DeepSeek turn budget 20 -> 37; advisor packet chars 12,476 -> 12,476.
- Provider tokens, wall-clock latency, cost and model quality stay `NOT_MEASURED`.

## [16.5.0] - 2026-10-04

### Added

- Skill Registry V2 with bounded machine-readable contracts for the complete skill catalog.
- Adaptive Skill Router V3 with evidence-driven minimal skill activation.
- Skill Capsules with bounded composition, provenance and preserved constraints.
- Tool Surface V3 with task-scoped tool advertisement and capability hydration.
- Subagent Fabric V2 with fresh-context specialist delegation, bounded depth and lifecycle guards.
- Verified Handoff Capsules backed by reversible Evidence Store references.
- Bounded parallel delegation with safe-wave execution and deterministic result ordering.
- DeepSeek specialist advisor roles for root cause, architecture, alternative fixes, adversarial review and verifier failures.
- Advisor Benefit Learner V2 with bounded provider/model-scoped AUTO-routing influence.
- Read-only reasoning diagnostics and agent progress observability.
- Professional README rewrite focused on current installation, architecture, safety and usage.
- Micro-skill registry, evidence-driven skill router, bounded skill capsules, phase-scoped tool surface.
- Subagent Fabric V2: delegate-vs-parent-direct decision, fresh-context child briefs, bounded session lifecycle.
- Verified Handoff Capsules: raw child output to the Evidence Store, bounded capsule to the parent.
- Five DeepSeek advisor question types with consultant-only authority.
- Advisor benefit learner (bounded AUTO consult weight only), reasoning doctor, progress observer.
- `lib/delegation-fleet.mjs` — bounded concurrent wave executor wired into the production
  controller's structured-plan wave loop (`executeStructuredPlan` in `pi/extensions/ues.ts`).
### Changed (V16.5)
- Independent children in a proven-safe wave now execute **concurrently** instead of serially.
  Wave order still comes from the task graph (`computeSafeWaves`); wave safety still comes from
  `lib/delegation-safety.mjs`; the child runtime is still the existing Pi child spawn plus
  `lib/process-supervisor.mjs`. The fleet spawns no process and is not a scheduler.
- Concurrency for a delegation wave is bounded to `UES_MAX_ACTIVE_CHILDREN` (default 2, hard
  max 3) instead of the raw `MAX_CONCURRENCY` request.
- Delegation telemetry (`safeWaveCount`, `parallelDelegations`, `serializedDelegations`,
  `maxObservedChildConcurrency`, `childQueueMs`, `childExecutionMs`, `parallelWallMs`,
  `sequentialEquivalentMs`, `overlapSavingsMs`) is reported on every scheduler return path.
### Safety invariants
- Parallelism is fail-closed. Overlapping writers, destructive shell, external side effects, and
  shared mutable services stay serial; writer conflicts are isolated through the existing
  per-task Git worktree.
- A child that throws, is aborted, is reaped by the watchdog, or returns a non-zero exit code is
  a failure. `runDelegationWave()` always returns `passed: false` and `canProduceVerdict: false`.
- One child failing never cancels an unrelated read-only sibling; the parent decides recovery.
- Results are emitted in deterministic task-id order regardless of completion order.
- Cancellation and the inactivity watchdog abort the child's own signal, so the real process
  tree is terminated and no orphan process survives.
### Measurement honesty
- `overlapSavingsMs` is a measured dispatch overlap of child execution windows inside this
  process. It is not called a speedup anywhere, and `speedupClaim` is always `null`.
- Provider tokens, real-model wall clock, and model quality remain `NOT_MEASURED`; they require
  a live `ues trial` run.

### Changed

- Specialist delegation defaults to 2 active children with a hard maximum of 3.
- Unsafe writer, destructive, mutable-service and external-side-effect work remains serialized.
- Parent context receives bounded handoff capsules instead of full child transcripts by default.
- Skill and tool exposure are reduced per task while runtime safety policy remains authoritative.
- V16.5 production controller now executes proven-safe specialist waves concurrently instead of degenerating to serial child dispatch.

### Measurement

- Skill routing evaluation: 20/20 cases.
- Average activated skills: approximately 2 from the 48-skill catalog.
- Advertised tools/task in the deterministic corpus: 8.0 → 5.8.
- Estimated model-facing tool-schema surface: 12,287 → 7,873 characters.
- Measured bounded delegation fixture:
  sequential-equivalent child execution: 1,526 ms
  overlapped dispatch wall time: 1,013 ms
  overlap savings: 514 ms.
- These are runtime/corpus measurements only.
- No real-model token, quality or end-to-end speedup claim is made without provider telemetry.

### Safety / quality invariants

- Local verifier remains final task authority.
- DeepSeek remains consultant-only and cannot produce PASS.
- Child agents cannot grant permissions or global verdicts.
- External side effects retain zero automatic replay.
- Evidence Store, static diagnostics, dirty-work protection, workspace containment, execution ownership and secret boundaries remain authoritative.
- No automatic push, publish or deploy capability was added.

## [16.4.0] - 2026-10-04

### Added

- Lazy Runtime Hydration for heavy browser, DeepSeek, code-intelligence and repo-intelligence paths.
- Evidence-first Structural Escalation V2 with Vietnamese fallback signals.
- Fresh-evidence DeepSeek follow-up protocol with fingerprint-bound deltas.
- Adaptive Decision Packet tiers with progressive disclosure.
- Verified Task Cost with explicit measurement provenance.
- Advisor Benefit Learner for bounded observational consultation telemetry.
- Parallel read-only consultation preparation.
- Release Test Coordinator with deduplicated test execution.
- Repo Map quality measurements and V16.4 real-task corpus support.

### Changed

- Default DeepSeek follow-up budget reduced to one; a second follow-up requires fresh verified evidence.
- CI coverage aligned across Node 22/24 and Windows Node 24.
- Heavy production boot graph reduced through lazy hydration.
- Release consistency now validates package, lockfile, README and latest CHANGELOG version.

### Performance / measurement

- Static production boot graph: 127 → 106 modules.
- Static eager runtime bytes: 1,576,012 → 1,005,013 bytes (~36% reduction).
- Heavy browser/web/code modules in eager boot set: 13 → 0.
- Release test file slots: 83 → 56 unique executions.
- No real-model token/speed/quality uplift claimed without live measured telemetry.

### Safety / quality invariants

- Local verifier remains final authority.
- DeepSeek remains consultant-only and cannot produce PASS.
- External side effects remain zero automatic retry.
- Safety, permission, ownership, dirty-work, workspace and verifier policy remain eager/fail-closed.

## [16.3.1] - 2026-10-04

### Fixed

- Preserve DeepSeek consult → follow-up session lifecycle across verifier retries.
- Bounded read-only follow-up dispatch confirmation before any follow-up submit.
- Async UI hydration race handling in follow-up dispatch.
- Follow-up dispatch regressions.
- Advisor/verifier accuracy validation (`validate:v16.3:accuracy`).

### Safety / quality invariants

- DeepSeek remains consultant-only; local verifier is the final authority.
- External submits keep zero automatic retry; every submit is bounded and accounted.

## [16.3.0] - 2026-10-03

### Added

- **Production DeepSeek Web reasoning bridge.** Managed browser worker drives a real third-party web consultation over a persistent authenticated profile: fill exactly once, unique Send resolution, submit at most once, scoped answer-region polling with streaming acquisition, structured response parsing, local advice verification, and bounded cleanup.
- **Separated integration vs advice acceptance in live smoke.** Bridge PASS means session started, prompt filled once, prompt submitted once, response extracted, structured parser succeeded, local verifier ran, and cleanup ran; `adviceAccepted` reports the verifier verdict separately. `advice-rejected` is an expected safe outcome, never a recommendation, and never enters executor context.
- **AUTO escalation / non-escalation routing.** Genuine ambiguity, architectural uncertainty, and repeated verifier failure escalate; well-grounded, trivial, or doc/version tasks stay local with an auditable reason.
- **Production-wired live A/B benchmark with consent.** Measured readiness, provider failures, browser retries, false-pass rate, consultation counts, submit attempts, and verified pass rate prove integration and routing. Verified live benchmark: readiness live-provider-measured, provider_failures 0, browser_retries 0, false_pass_rate 0, web_consultations 1, submit_attempts 1, verified_pass_rate 1; per-task AUTO routing consulted once (ambiguous MCP retry → advice-rejected) and stayed local for the three grounded tasks.

### Safety / quality invariants

- Local verifier is not weakened: rejected web advice remains untrusted (`trust=untrusted-external`, `instruction-authority=none`), authorizes only `reject-and-retry-locally`, and cannot change permissions, request secrets, authorize external side effects, or produce a task verdict.
- DeepSeek authority boundaries unchanged: consultant-only, advisory evidence only, every claim verified against the local repository before use.
- **Non-goal:** this release proves bridge integration and routing, not real Pi model improvement. No Pi model token savings measured, no equivalence to larger models claimed, no measured model quality improvement claimed.

## [16.0.0] - 2026-10-02

### Added

- **Static Completeness Gate V2.** Turbo FAST deterministic PASS now combines fresh behavioral receipts with complete, error-free static diagnostics for supported changed source files. Timeout, unavailable/incomplete diagnostics, multi-file static scope or diagnostics errors fall back to the independent verifier rather than being treated as clean.
- **Durable Evidence Pinning + Resume Integrity.** Evidence Store GC protects references reachable from active `.ues-work` state; checkpoints persist concrete evidence refs when present, and compaction resume reports `OK` / `DEGRADED` / `NOT_APPLICABLE` evidence integrity.
- **External Data Provenance Boundary.** External/MCP output is explicitly non-authoritative (`trustClass=external-data`, `instructionAuthority=none`). Prompt-injection-like output remains under the reversible output governor instead of bypassing compaction.
- **Capability-level exfiltration guard.** Shell and managed-service preflight block commands that combine an outbound transfer primitive, an explicit credential/secret source and an outbound payload operation; ordinary network reads are unaffected.
- **Windows-safe Cleanup Barrier.** Shared bounded cleanup retries transient `EBUSY`, `EPERM`, `ENOTEMPTY`, `EMFILE` and `ENFILE` failures for worktree/workspace cleanup.
- **Cost-aware empirical routing.** Model performance reranking now incorporates retry-amplified expected token work after the existing minimum evidence floor.
- Added `npm run eval:v16`, a V16 runtime wiring contract, and package/release closure checks for V16 hardening artifacts.

### Changed

- Package runtime advances to 16.0.0 and `/ues-status` schema advances to V7 with explicit V16 hardening markers.
- Deterministic FAST verification receipts record the static diagnostics file/source/fingerprint alongside behavioral evidence.
- `release:verify` now includes `eval:v16`; V16 documentation and critical runtime modules are protected by release/package closure checks.

### Safety / quality invariants

- V15.9 ACI/context/reversible-output architecture, LSP lifecycle, process-tree supervision, task leases, dirty-work/local-env guards and independent verifier/integration gates are retained.
- Incomplete static analysis cannot be converted into deterministic PASS.
- Missing durable evidence during compaction resume is surfaced as degraded state and must be reacquired instead of guessed.
- **Non-goal:** V16.0 does not claim full container isolation of the Pi/model session. Existing container isolation remains a deterministic verification boundary; broader host execution isolation remains a separate hardening track.

## [15.8.0] - 2026-10-01

### Added

- **Command Intelligence V4.** Unwraps PowerShell call-operator commands, `cmd /c`, PowerShell/pwsh `-Command`, and POSIX `sh/bash/zsh -c` launchers before verification/service classification. Hidden verification pipelines remain visible to policy after wrapper unwrapping.
- **Bun package-manager coverage.** `bun test`, filtered Bun tests, and Bun dev/start scripts share the verification/managed-service lanes and command-aware output reduction.
- **Real A/B Telemetry V2.** Pi eval captures first provider usage, so initial-input inflation is measured instead of silently unavailable.
- **Fail-closed real-model promotion.** `ues trial --require-promotion` / `npm run trial:gate` requires paired quality non-regression plus measured efficiency evidence.
- **Provider Cache Stability V2.** Learning is scoped by provider + model + accounting schema and uses bounded hysteresis to avoid oscillation on borderline samples.
- **Model Runtime Profile V2.** Runtime surfaces prefer measured performance, then configured capability evidence, then model-name heuristics.
- Added `npm run eval:v15.8` and V15.8 measured-hardening regression coverage.

### Changed

- Package/status contracts advance to 15.8.0 / status schema V6.
- `release:verify` now includes `eval:v15.8`.
- Cache policy cold-start evidence is more conservative while preserving V15.7 live-zone-only compaction and stable-prefix semantics.
- V15.8 telemetry hardening now isolates cache learning by accounting schema and routed model identity, shares one durable learning root across task sandboxes, preserves cross-stream event order, records true first-turn child usage, and aggregates all provider turns/recovery attempts for token/cache measurement.

### Safety / quality invariants

- Independent verifier, integration/visual gates, Evidence Store, dirty-work/local-env/destructive-command guards, execution ownership and selected thinking level are not weakened.
- Missing real-model token evidence blocks promotion when `--require-promotion` is requested; deterministic tests still never imply real-model performance.
- Runtime Waste Learner remains evidence-producing and does not self-modify correctness/security gates.

## [15.7.0] - 2026-10-01

### Added

- **Command Intelligence V3.** Child shell preflight now identifies verification commands, likely foreground services and output-hiding pipelines. Verification timeouts are policy-clamped even when a model supplied a larger value; a command such as `npm test | grep | tail` can no longer request a multi-hour timeout and bypass the bounded verifier policy.
  Classification is quote/escape-aware and recognizes workspace-filtered npm/pnpm/yarn verification families; the same family signal now reaches the command-aware reducer registry.
- **Provider Cache Stability V1.** Recent provider-reported cache usage selects a conservative `neutral/cache/balanced/token` presentation policy. Missing telemetry stays `NOT_MEASURED`. Cache policy participates in Runtime Epoch identity so warm workers do not cross an incompatible policy boundary.
- **Content Router V2.** New tool output is classified as diff/JSON/test/diagnostics/log/code/search/text and combined with execution phase before choosing the bounded live-zone visible budget.
- **Efficiency Ledger V2.** Bounded `.ues-learning/efficiency-ledger-v2.jsonl` observations separate directly measured, derived-from-measured and unavailable metrics. Task telemetry feeds provider/cache/tool/wall-time observations; reversible tool compaction records exact before/after character counts.
- **Pi-normalized cache accounting.** Cache-read share uses Pi's disjoint `input + cacheRead + cacheWrite` prompt-side counters; uncached input is Pi's `input` bucket rather than subtracting cache counters from it. Efficiency ledger writes are serialized across parent/child Pi processes with a bounded filesystem lock.
- **Runtime Waste Learner.** `ues optimize-report` summarizes measured repeated tool signatures, queue pressure, interrupted/dangling tools, compaction recall demand and provider recovery. Metrics that are not observable remain explicitly unavailable.
- **Trajectory Intelligence V2.** Run inspection separates repeated reads, searches and mutations, and counts blocked/interrupted/failed tool calls, queue delays and hidden-output verification pipelines. Stage telemetry summaries expose measured provider/model/tool/verification/LSP latency averages when available instead of reconstructing missing time.
- **Durable execution ownership.** CLI/RPC child execution is fenced by a Runtime-Epoch + run-ID lease with parent heartbeat. Stale/expired children are blocked before the next tool side effect, while expired/abandoned ownership can be taken over by a replacement parent without blindly replaying work. Stale/dead lease artifacts are garbage-collected with bounded scanning and surfaced by `/ues-clean`.
- **Solution Economy Gate.** Writer roles prefer existing repository patterns, standard library, native platform primitives and already-installed dependencies before adding the smallest complete new implementation. Correctness, security, validation, accessibility, explicit requirements and verification are never traded for fewer lines.
- **One-command real-model trial.** `ues trial` wraps the existing Pi baseline-vs-UES evaluator with live/both/3-trial/keep defaults.
- **Durable execution ownership fencing.** Parent CLI/RPC launches heartbeat a Runtime Epoch lease and child Pi checks the owner before every tool call. Expired/abandoned parent ownership can be taken over; stale owner tokens fail closed before another side effect. Explicit same-session provider recovery now preserves the prior effective Runtime Epoch so the RPC pool actually addresses the existing worker/session.
- Added `npm run eval:v15.7` and V15.7 documentation.

### Changed

- V15.6 recall-driven compaction now composes with content routing and cache-stability policy while exact raw Evidence Store payload remains authoritative.
- Verification/test commands with explicit overlong timeouts are clamped instead of only receiving a timeout when the field is absent.
- Runtime Epoch includes `cachePolicyHash`.
- RPC safe same-session provider recovery preserves the prior effective Runtime Epoch identity; ordinary new turns still compute a new epoch.
- `release:verify` now includes `eval:v15.7`.

### Hardened before release

- **Executable-head shell classification.** Command Intelligence now classifies each simple shell segment from its actual executable head instead of matching package-manager/test words anywhere in the command. This prevents false positives such as `echo npm test` and `npm exec echo test`, while preserving workspace/filter scripts and Windows executable paths.
- **Managed-service routing is enforced across call sites.** Monorepo forms such as `npm --filter ... start`, `pnpm --filter ... dev` and `yarn workspace ... serve` now share the same Command Intelligence detector in the service manager and child preflight, so they are blocked before foreground shell execution and redirected to `ues_service`.
- **Tool-kind-aware Content Router.** Search-tool identity (`grep`/`find`/`ls`) remains part of the routing hint even when the tool input is a pattern rather than a literal shell command, preventing search output from falling back to generic text reduction.

- **Telemetry provenance stays per-field.** Missing provider cache/input/output buckets remain `null` in Efficiency Ledger summaries instead of becoming false zeroes. Provider Cache Stability requires complete disjoint `input/cacheRead/cacheWrite` samples before changing cache mode; partial samples are observational only.
- **Cross-process task telemetry serialization.** Concurrent Pi processes now serialize task-telemetry append/compaction with a bounded filesystem lock so cache-learning evidence is not corrupted by multi-session writes.
- **Monorepo service routing.** Workspace/filter service commands such as `npm --filter ... run start`, `pnpm --filter ... dev` and `yarn workspace ... serve` are recognized as long-running services and stay on the managed-service lane.
- **Trial option fidelity.** `ues trial` preserves explicit `--mode=x`, `--suite=x` and `--trials=x` forms instead of appending competing defaults.
- **V15.7 regression import cleanup.** Removed a duplicate ownership import that could stop the V15.7 test file at parse time.

### Safety / quality invariants

- Selected thinking level is unchanged.
- Independent verifier, integration/visual gates, Evidence Store, dirty-work and local-env guards, workspace containment, hash-guarded checkpoints, fail-closed diagnostics, Repo Map V3, Semantic Index V3 and Holdout D are unchanged.
- Efficiency evidence never establishes correctness and deterministic tests are not promoted to real-model performance claims.

All notable changes to this project are documented here.

The project follows Semantic Versioning.

## [Unreleased]

### Added

- **V16.5 Agent Skill & Delegation Intelligence.** `lib/skill-registry.mjs` compiles a machine-readable contract (intents, task classes, required/optional capabilities and tools, forbidden actions, context class, side-effect class, output contract, verification requirements, derived composability, host support) for every one of the 48 shipped skills, bounded per contract and in aggregate, validated fail-closed, with registry-to-package drift detection.
- **Adaptive Skill Router V3** (`lib/skill-router.mjs`) ranks all 48 contracts from task intent, stack token, repository evidence, task class, required capability, risk domain, learned usefulness, context cost and negative guards, then activates a relative-cutoff minimal set (normally 1-3). Diacritic-insensitive English/Vietnamese/mixed language classification. Going past the default target is only possible through a recorded `expandedReason` (`above-default-cutoff` or `composition-with-independent-evidence`).
- **Skill Utility** telemetry with a minimum sample floor of 8, bounded hysteresis, and a bounded store. It can reorder candidates only: it cannot delete a skill and cannot change safety policy.
- **Skill Capsule** (`lib/skill-capsule.mjs`) composes several skills into one bounded block with deterministic ordering, per-section provenance, a cache fingerprint, guaranteed constraint preservation under a tight budget, and an explicit `expandSkillCapsule()` escape hatch.
- **Tool Surface V3** (`lib/tool-surface-v3.mjs`) predicts the capabilities a task phase needs and advertises only those. `SAFETY_CAPABILITIES` stay runtime-enforced regardless of what is advertised; hiding a tool never removes a permission. A deferred capability hydrates once on explicit evidence with a deterministic hash-bound receipt; denied capabilities stay denied with an explicit reason.
- **Subagent Fabric V2** (`lib/subagent-fabric.mjs`) reuses the existing 12-agent catalog for six delegation roles, with fresh child context, an explicit `notCopied` list, depth 1 default / hard max 2, a cycle guard, 2 concurrent children (hard max 3), bounded timeout and inactivity sweeps, cancellation that leaves no orphan, and completion receipts carrying `canProduceVerdict: false`.
- **Verified Handoff Capsules** (`lib/verified-handoff.mjs`) store raw child transcripts in the Evidence Store and return a bounded, secret-redacted, provenance-bound capsule to the parent (2k-6k chars, default 4k). A child can never grant a permission or mark a task verified.
- **Bounded parallel delegation** (`lib/delegation-safety.mjs`) classifies scopes and fails closed on writer overlap, overlapping files, destructive shell, external side effects, mutable services, and capacity.
- **DeepSeek specialist advisors** (`lib/deepseek-advisor-roles.mjs`): five bounded question types (`root-cause`, `architecture`, `alternative-fix`, `adversarial-review`, `verifier-failure`) with required inputs, explicit forbids, and consultant-only authority.
- **Advisor Benefit Learner V2** (`lib/advisor-benefit-learner-v2.mjs`): provider/model-scoped, bounded, GC'd, persisted. Its only allowed effect is the AUTO consultation weight.
- **Reasoning Doctor**: `ues doctor --reasoning` (and `--json`) reports web-reasoning readiness read-only, with no prompt submission, no state mutation, no credential/cookie output, and unavailable values reported as unavailable.
- **Agent Progress Observer** (`lib/agent-progress-observer.mjs`): an observer-only fleet view with bounded, redacted actions. No chain-of-thought, no runtime authority.
- `ues skills registry` and `ues skills route <task>` CLI commands.
- `evals/v16.5-routing-matrix.json`, `scripts/eval-skill-routing-v16-5.mjs`, `scripts/eval-v16-5.mjs`, and `npm run eval:v16.5`.
- `docs/V16.5-AGENT-SKILL-DELEGATION.md` and `docs/V16.5-RESEARCH-NOTES.md`.

### Changed

- Pi micro-skill context is now built through `lib/v16-5-runtime.mjs` (registry -> router -> capsule), with the legacy `lib/skill-compiler.mjs` path retained as an automatic fallback whenever the router activates nothing or the capsule fails.
- Both Pi child-spawn paths now receive a task-phase tool priority list. The V16.2 `compileToolSurface` remains the final advertised-surface authority and stable-prefix owner; V16.5 only ranks phase-relevant tools.
- The release-consistency checker now reads a machine-readable README version marker and a semantic section contract instead of matching historical prose, and additionally enforces an anti-bloat line limit, rejects per-version release dumps, rejects unmeasured speed claims, and validates relative README links.

### README

- Complete rewrite. The release-history wall, the 31-item Vietnamese table of contents, and the internal implementation chronology moved to `CHANGELOG.md` and `docs/`. The landing page is now a professional English README (318 lines) that answers what/why/install/start immediately, links to deep internals, and keeps measurement provenance explicit.
- Release-consistency tests and fixtures were updated to the new machine-readable version marker.

### Measured (deterministic 15-task corpus; not a real-model claim)

- Skills considered per task: 48. Skills activated per task: 1.8 average, 3 maximum.
- Advertised tools per task: 8.0 -> 5.8. Estimated tool schema chars per task: 12,287 -> 7,873 (-4,413, -35.9%). Provenance: `MEASURED` for counts, `ESTIMATED` for schema characters.
- Handoff raw -> capsule: 88,000 -> 423 chars (0.48%). Provenance: `MEASURED`.
- Skill context chars per task: 1,196 baseline vs 1,220 for V16.5. Provenance: `MEASURED`. V16.5 is NOT smaller here; its value is provenance, guaranteed constraint preservation, and bounded composition of four skills without concatenating four bodies.
- Provider tokens, wall-clock speed, and model quality: `NOT_MEASURED`. No claim is made.

### Unchanged

- Local final verifier, integration verifier, visual verifier, Evidence Store, static diagnostics completeness, dirty-work guard, `.env` protection, workspace containment, destructive-shell policy, execution ownership, process-tree cleanup, Windows cleanup barrier, browser action taxonomy, external-side-effect zero automatic replay, DeepSeek consultant-only (`canProducePass = false`), untrusted external content boundary, secret redaction, selected thinking level, and no automatic publish/push/deploy.
- Repo Map, Semantic Index, LSP architecture, browser taxonomy, process supervisor and verification architecture were not modified: no V16.5 benchmark proved a regression in them.


## [15.6.0] - 2026-10-01

### Added

- **Durable Run Journal V2.** Controller runs receive an idempotent admission record and ordered JSONL event stream under `.ues-work/journals/`. An idempotent controller resume automatically recovers the prior journal and marks tool calls left running across a process boundary as `tool.interrupted` with `replayed: false`; side effects are never blindly replayed.
- **Runtime Epoch V1.** Child identity now binds policy snapshot, workspace/context identity, tool/skill surfaces, model runtime profile, model and thinking level. Warm RPC worker keys include the epoch ID so reuse cannot cross an incompatible runtime surface.
- **Model Runtime Profiles.** Compact/balanced/expanded surfaces bound advertised tool choice and read parallelism while preserving the host-selected thinking level. The classification is an orchestration profile, not a model-quality ranking.
- **Tool Scheduler V1.** The V15.5 Tool Concurrency Contract is enforced in specialist child `tool_call` admission. Explicit bounded reads/searches may run concurrently; built-in writes/process tools use Pi-native sequential execution, while conflicting dynamic/unknown surfaces are deferred fail-closed instead of waiting inside preflight. Observable UES scheduler/admission delay is surfaced into run telemetry where available.
- **Adaptive Compaction V2 policy.** Existing command-aware reversible reducers keep raw Evidence Store data as source of truth, while the model-visible budget adjusts only after enough observed compaction-recall history exists.
- **Bounded Write Checkpoints.** Small file writes may capture exact pre-write bytes under `.ues-work/checkpoints/`; rollback is allowed only when every current file hash still matches the finalized post-write state.
- **Run Artifact Bundle + Inspector.** Controller runs emit bounded `.ues-work/runs/<runId>/` metadata/evidence artifacts and `npm run inspect:run -- last` can report event counts, scheduler delay, repeated tool signatures, dangling calls and comparisons.
- **Runtime Hook Bus V1.** Internal deterministic lifecycle hooks support observe/modify/deny semantics with critical hooks failing closed.
- **V15.6 regression suite.** Covers epoch fencing, model profiles, actual tool scheduling, journal idempotency/recovery, recall-driven compaction, hook decisions, rollback divergence protection and run inspection.

### Changed

- `/ues-status` schema advances to V4 and advertises the V15.6 durable/measured runtime contracts.
- `release:verify` includes `eval:v15.6`; `prepublishOnly` now runs the full release verification gate.
- Stable npm text in README is no longer hard-coded to an old version; the registry query is the source of truth.

### Hardened before release

- **Pi-native mixed-batch scheduling.** Built-in write/process tools use Pi's native sequential execution mode; preflight scheduler admission is non-blocking, preventing a sibling read/write batch from deadlocking before execution starts. Read/search/evidence recovery remains parallel-safe where explicitly classified.
- **Cross-process journal serialization.** Parent and child Pi processes share a bounded filesystem lock and re-read persisted sequence state while locked, preventing duplicate `eventSeq` values and duplicate run admission under concurrent writers.
- **Runtime Epoch skill binding.** The selected micro-skill names now participate in `skillSurfaceHash`, so warm reuse is fenced when the effective skill surface changes.
- **Checkpoint containment.** Checkpoint capture/finalization/rollback refuses symlink traversal and never follows an in-workspace link to an external target.
- **Security workflow.** CodeQL workflow actions are updated to major v4.

### Safety / quality invariants

- No verifier, integration/visual evidence requirement, Evidence Store semantics, dirty-work guard, local `.env` guard, destructive-command policy, Repo Map V3 ranking, Semantic Index V3, LSP Diagnostics V2, Holdout D or thinking policy is weakened.
- Checkpoints never overwrite a file whose post-write hash has diverged, and unsupported/large checkpoint targets are skipped rather than treated as safely reversible.
- Model Runtime Profiles reduce orchestration noise only; they do not lower the user's selected thinking level or claim to make a weak model intrinsically equivalent to a larger model.
- Real-model pass-rate, latency or token improvements remain **NOT MEASURED** until `eval:pi` is run on a real paired corpus. Deterministic tests validate contracts, not real-model quality.

## [15.5.0] - 2026-10-01

### Added

- **LSP Diagnostics V2.** Managed sessions retain server capabilities and dynamic diagnostic registrations, advertise LSP 3.17 diagnostic client capabilities, and use `textDocument/diagnostic` only when the server declares support. A full pull report is authoritative; failed/unsupported/unchanged-without-cache pull results are never treated as clean.
- **Pooled first-push recovery.** If a persistent document is unchanged but no current published diagnostics exist, UES sends a versioned full-content `didChange` to trigger fresh analysis instead of waiting on work the server was never asked to redo.
- **Large-file diagnostics policy.** Medium/large/XL TypeScript workloads launch deterministic compiler fallback earlier (1000/500/250 ms recommendation) while keeping primary LSP enabled.
- **Telemetry V2 compatibility.** Pi aliases `input`, `output`, `cacheRead`, and `cacheWrite` are normalized; optional provider/model/tool/LSP/verification stage timings remain nullable and never synthesize wall time.
- **Tool Concurrency Contract V1 + Policy Snapshot V2.** Bounded reads/searches are explicitly parallel-safe; writes/processes/unknown tools fail serial. Specialist children receive a deterministic policy snapshot ID, and RPC warm reuse is keyed by it.
- **V15.5 regression suite.** Covers lost first diagnostics push recovery, pull diagnostics, Pi token aliases, large-file policy, concurrency classification and child-policy loosening detection.

### Changed

- Managed LSP status exposes diagnostic capability/registration state and protocol-level received/matched/re-sync counters.
- `release:verify` includes `eval:v15.5`.

### Safety / quality invariants

- Independent verifier, integration/visual policy, Evidence Store, completion auditor, fail-closed incomplete diagnostics, dirty-work guard, local `.env` guard, workspace containment, destructive-command protection, Repo Map V3 ranking, Semantic Index V3, Holdout D and thinking policy are not weakened.
- Real-model A/B is not inferred from deterministic tests; release reporting must say `MEASURED` or `NOT MEASURED`.

## [15.4.1] - 2026-10-01

### Fixed

- **Cancellation unhandled rejection in async document ingestion.** When an already-aborted signal reached the shared-conversion waiter, that waiter left before attaching a rejection handler to the shared promise. Aborting the underlying controller then rejected a promise nobody was listening to, which Node escalates to a process-level `unhandledRejection` and can terminate the runtime during an ordinary cancellation. The shared promise now gets its rejection consumed before the underlying controller is aborted. The caller still receives its own `ABORT_ERR`; public API semantics are unchanged apart from removing the process-level crash.
- **Timing-sensitive V15.4 foundation test synchronization.** The coalescing test waited a fixed 5ms before asserting the converter had been invoked. Because `ingestDocument` still resolves the workspace, lstat/realpath and reads the file before reaching the converter, that budget was exceeded under the parallel load `release:verify` itself runs. The test now waits for the actual converter-invocation event, keeping a bounded guard so a non-invoked converter still fails instead of hanging, and keeping the assertion that the converter ran exactly once. The guard timer handle is cleared once the race settles so it no longer keeps the event loop alive.

### Notes

- Hotfix only. No architecture, ranking, Repo Map V3, holdout, verifier, safety-policy or public-schema changes. No performance claim is made for this release.

## [15.4.0] - 2026-10-01

### Added

- **Task-level operational telemetry** under ignored `.ues-learning/` state. Top-level controller runs record true end-to-end wall time separately from specialist runs; specialist rows retain bounded context/agent/hygiene timings, tool counts, provider recovery, cache hits and provider token usage when it actually exists. Unavailable provider/model/tool-only timing remains `null` instead of being inferred.
- **Compaction Recall Analytics** for reversible context and command-aware output, attributing later expand/search requests back to the original Evidence Store ref.
- **Conservative permission preflight** for specialist tool exposure. Only deterministic action-wide denies are hidden; path/command-dependent rules stay visible and runtime resource checks remain authoritative.
- **Mutation-shape detection** for custom/renamed write tools, including edit-permission classification and local-env/temp-path safety for concrete mutation-shaped calls.
- `npm run eval:v15.4` focused regression gate.

### Changed

- Multi-file post-write feedback now checks every discovered path instead of collapsing a multi-file mutation to the first file.
- Office/PDF ingestion is now **async and supervised** instead of `spawnSync`, with hard/idle timeout, bounded output, process-tree cleanup, content-addressed cache, same-content request coalescing and reference-counted abort propagation.
- `/ues-status` schema V3 exposes task telemetry and compaction recall summaries while preserving V15.3 counters.
- `release:verify` includes the V15.4 focused regression suite.

### Safety

- V15.4 does not change Repo Map V3 weights, semantic-index identity, historical holdouts, verifier requirements, thinking level, or destructive-command policy.
- Telemetry persists hashes/operational metrics rather than raw task prompt text; compaction analytics hashes command/source hints instead of persisting them verbatim. Explicit `null`/missing token data remains unavailable rather than being coerced to zero.
- MarkItDown remains optional and is never auto-installed.
- Real-model quality A/B remains explicitly unmeasured in repository CI when provider credentials are unavailable; deterministic gates are not presented as a substitute.
- Public reversible-context and document-ingestion response schema numbers remain compatible with V15.3; only internal cache/event schemas advance independently.

## [15.3.0] - 2026-09-30

### Added

- **Incremental Write Intelligence.** After a write tool edits a file, UES now reports diagnostics for that file without the caller asking. A result is only reported `complete: true` when a diagnostics source actually finished the requested scope; an unresolved module graph or ambient type set reports `complete: false` with the real diagnostics it did find rather than presenting the absence of errors as a clean file. The immediate answer is an honest `pending` state, not a guess.
- Post-write feedback **rejects stale results**: a result whose file fingerprint no longer matches the current file is discarded rather than reported against newer content, and **coalesces** bursts so a rapid sequence of writes settles into one check instead of one per keystroke-batch.
- Truncated diagnostics are preserved **reversibly** through the Evidence Store, so a bounded payload still carries the exact raw evidence needed to re-derive what was dropped.
- A **multi-file mutation coverage contract**: write tools that can touch several files at once report which of them the post-write pass actually observed, and `ues status` advertises the supported write surface (`apply_patch`, `edit`, `str_replace`, `str_replace_editor`, `ues_code_edit`, `write`, `write_file`) instead of leaving the model to guess.
- **Content-Addressed Semantic Index V3.** Symbol data is stored as a content-addressed artifact, so a second worktree of the same commit reuses the artifact instead of re-parsing, and a same-size/different-content edit is correctly treated as a miss.
- **Bounded global content-artifact GC** removes orphaned artifacts with a deterministic victim order and a proven per-run cost bound, verified at the exact boundary and under a volume stress harness.
- **Graph-Ranked Repo Map V3** (`lib/repo-map.mjs`): repo context is now selected by a graph-ranked structural pass rather than lexical overlap alone. It resolves modules, packages and paths structurally; separates **definitions from references**; disambiguates a query against the module that declares the symbol; and reports deterministic, explainable score contributions for every selected file.
- A **TypeScript syntax gate for the Pi extensions** (`scripts/check-extension-types.mjs`, wired into `npm run syntax`), so the two `.ts` extension sources are type/syntax checked instead of only being read as text.
- **`npm run accept:fresh-pi`**: an end-to-end acceptance gate that loads the extension into a *fresh* Pi child process and asserts the real post-write, repo-map, coalescing, cross-worktree-reuse and session-boundary behaviour. The child spawn sanitizes npm `allow-scripts` configuration at the spawn boundary so the host environment cannot suppress the install step.

### Changed

- `npm run ci` now includes `npm run accept:fresh-pi`.
- The bounded test runner declares a scoped 90s per-file allowance for `test/installer.test.mjs`. The global per-file bound stays at 45s for every other file. This is a runner allowance only: the installer test file, `scripts/install.mjs` and `scripts/uninstall.mjs` are unchanged in this release, and the file's entire import closure is byte-identical to 15.2.1. It simply straddles the 45s boundary under real suite load (measured 41.5s in a 127-file run), so the allowance prevents a load-dependent flake rather than masking a regression.
- The npm package no longer ships the retrieval holdout corpora. The shared retrieval scoring harness (`evals/retrieval/fixture.mjs`, `queries.json`, `score.mjs`) and the DEV tuning corpus still ship; `holdout-*` and the three holdout runners plus the holdout-dependent trace tool are excluded so an independent gate cannot be published with the package.

### Verification

Retrieval generalization was measured on a **final independent frozen holdout** created after freeze receipt V3b, hashed and locked before any scored ranking run, and executed **exactly once**: 205 queries, 5 families, all 10 classes, zero answer-path overlap with DEV / holdout A / holdout B.

| metric | value |
| --- | --- |
| recall@1 | 0.700407 |
| recall@3 | 0.916667 |
| recall@5 | 0.970325 |
| MRR | 0.897085 |
| hit@1 (primary) | 0.834146 |

Those figures were independently recomputed offline from the stored scored artifact without re-running any ranking, and the recomputation reproduces the published query count, class counts, MRR, hit@1, per-class MRR and every loss record exactly.

Evaluation history, stated precisely: **Holdout A** is a historical diagnostic. **Holdout B** was previously executed and scored once and failed (116 queries, verdict `15.3 BLOCKED`); it is contaminated and no longer valid as final release evidence, and it was **not rerun** during the final V3b validation cycle and was **not used** as release evidence. A draft **Holdout C** was contaminated during fixture construction, was never scored, and is never release evidence. **Holdout D** is the final independent holdout described above.

## [15.2.1] - 2026-09-30

### Fixed

- Tier-B diagnostics fallback could not win the race after a non-zero grace period. The race was constructed inside the retry loop while the fallback promise was still `null` (the grace timer had not fired yet), so tier B was raced against a never-settling promise; when the timer later assigned the real promise, the already-constructed race was not rebuilt, and the continuation branch then dropped it entirely. With the default grace a deterministic fallback that finished **complete** in ~800ms still could not win, so the call burned the whole initial plus continuation budget. Tier B now races one long-lived promise shared by every window, so a result becomes winnable as soon as it exists. Measured on `npm run bench:code`: `diagnosticsSmall` 7528ms -> 2179ms, `diagnosticsSmallRepeat` 10011ms -> 2469ms.
- A **complete** tier-B result may now return early without waiting for tier A to time out, while an **incomplete** tier-B result still never stands in for a clean file: its evidence is held, the language server keeps its full bounded window, and the result is reported honestly as `complete: false`. The healthy LSP fast path is unchanged — a publish before the grace still spawns no child process, an LSP answer still wins over a running fallback, and a discarded fallback is still aborted and reaped without restarting or evicting the session.
- Tier A's window is now an absolute deadline measured from the start of the request. Resuming tier A after an incomplete tier-B result previously re-armed a whole fresh initial window, so a large-file incomplete case could cost `grace + fallback + initial + continuation` instead of the intended bounded budget. `diagnosticsLarge` is back within its intended window while still reporting `complete: false` with the real diagnostics it found.
- Adaptive diagnostics history is keyed on a stable workload identity — workspace + provider + `configFingerprint` + relative file + cold/warm class — instead of the language-server `sessionId`, which is a fresh UUID on every start. Learning previously survived nothing: every idle-TTL eviction, bounded restart or config re-acquisition discarded it. The identity still separates distinct workspaces and cold from warm timings, and invalidates on a relevant configuration change.
- A single diagnostics request now contributes exactly one terminal history outcome. The tier A / tier B race has several legitimate exits and one request can pass through more than one, which previously recorded both a sample and a timeout and inflated the next request's budget twice. Only the actual observed duration is admitted as a timing sample; an intermediate incomplete tier-B settlement is no longer recorded as the request's outcome, and a configured budget is never recorded as if it were an observation.
- `diagnosticsFallbackGraceMs` now reports the **effective** grace taken from the operation result rather than the raw option. The runtime clamps the configured grace to half the resolved initial window, so telemetry previously described an intent the runtime never used, and the default path reported `null` while a real 1500ms grace was in force. Metrics and existing result fields are otherwise unchanged.

### Added

- Regression coverage for the diagnostics race under the **default** grace. Earlier race tests all passed `diagnosticsFallbackGraceMs: 0`, the one configuration in which the fallback participated, which is why the default-path defect was not caught.
- Bounded-memory coverage for the diagnostics request ledger that enforces exactly-once terminal accounting: it is a FIFO map capped at 256 entries with oldest-first eviction, verified deterministic at the exact boundary, still bounded after thousands of terminal requests, and verified to be insertion-bounded rather than time-based.

## [15.2.0] - 2026-09-30

### Added

- Adaptive diagnostics budget V2 for Parent Code Intelligence Lite: a deterministic, bounded budget derived from file size, line count, provider identity, pooled cold/warm state, measured server startup time and previously observed diagnostics durations. Model-visible telemetry exposes the chosen budget, its source, workload class, actual duration and whether it timed out.
- Tiered diagnostics for the TypeScript/JavaScript family: the pooled language server stays the fast path, and a deterministic `typescript` compiler fallback — resolved from the provider's own installation, so there is no new dependency and no version skew — is launched after a short grace period and *raced* against the remaining server budget instead of running after it. A tier A timeout therefore costs the budget only, never `budget + fallback`, and the healthy fast path spawns no child process at all.
- Honest diagnostics completeness: a result is only reported `complete: true` when a diagnostics source actually finished evaluating the requested scope. A workspace whose module graph or ambient type set does not resolve reports `complete: false` (`fallback-environment-incomplete`) together with the real diagnostics it did find, rather than presenting the absence of errors as a clean file.
- A missed `publishDiagnostics` is accounted as a request-level outcome, not a session failure: it increments dedicated diagnostics counters and never inflates `failedOperations`, restarts, or evicts a healthy persistent session. `ues_code status` exposes those counters separately from pool health.
- Model-facing payload reduction for `ues_code` (`symbols`, `search`, `diagnostics`, `definition`, `references`): positions are reported 1-based to match tool parameters, redundant pool/provider metadata is compacted, and the exact pre-reduction JSON is preserved in reversible context for verifiers.
- `scripts/benchmark-code-intelligence.mjs` (`npm run bench:code`) producing a before/after receipt for cold/warm symbols, search, small/large diagnostics, repeated warm operations, pool status and model-facing payload sizes.

### Changed

- `git diff` reducer rows now keep bounded added/removed lines instead of file/hunk headers only, and a compound command hint unions every matching reducer family instead of silently using only the first.

### Fixed

- Language servers that echo document URIs in an equivalent but different form (percent-encoded drive colon, different drive-letter case) no longer cause every pooled diagnostics request to burn its full timeout as `diagnostics-timeout`.
- AST/structural search capability detection now distinguishes "not installed" (`ast-provider-unavailable`) from "installed but unlaunchable" (`ast-provider-unresolvable`) and returns bounded, 1-based match evidence instead of verbose AST rows.

## [15.1.0] - 2026-09-28

### Added

- Command-Aware Compression V2 with reducer registry for noisy test, diff, search, tree, TypeScript, ESLint, Docker and Prisma output while preserving exact raw evidence.
- Durable Compaction Resume Guard that checkpoints before Pi compaction and rebuilds authoritative state from execution contracts, phase artifacts, task state and evidence receipts afterwards.
- Memory Retrieval V2 with evidence-only recall, repository dependency-graph affinity, scoped file/module retrieval, aging and reinforcement/use ranking signals.
- Code Intelligence V2 LSP operations for definitions, references, symbols, hover, rename preview and call hierarchy in addition to diagnostics.
- Durable subagent artifacts and handles under `.ues-work/.subagents`, including exact task/output evidence refs and `ues_dispatch action=status|list` inspection.
- Unicode Source Hygiene Guard for invisible/control characters and mixed-script lookalikes in changed source.
- Post-Run File Hygiene Guard that removes proven transient artifacts and rejects unexplained debug/scratch files.
- Pre-final Workspace Audit that rechecks the complete task delta before PASS and enforces declared write scope for structured execution.
- Unified Workspace Snapshot V2 so fingerprint, dirty-work guard and hygiene baseline can share one Git/filesystem capture instead of rescanning the same state.
- Git-index affected-test inventory with bounded content caching to avoid repeated recursive repository walks.
- Latency telemetry for workspace snapshot, context preparation, model execution and hygiene phases.

### Changed

- UES keeps the existing 12 specialist agents; the new subagent layer reduces resume/status cost instead of increasing agent count.
- Every Pi child specialist now gets a filesystem hygiene baseline; writer roles are audited after mutation and read-only roles may not leave source mutations behind.
- Adaptive context preparation now overlaps memory retrieval and capability-fabric lookup with manifest construction.
- Verification evidence stdout/stderr persistence and preview reads now run in parallel where independent.

### Fixed

- Preserve V14 reversible-compaction `strategy` values while exposing Command-Aware Compression V2 through `strategyV2` and `commandFamily`.
- Scope file/module memory identity by normalized file set so same-text memories from different files no longer collapse into one record.


## [15.0.0] - 2026-09-28

- Stable release of V15.19 Finalization Hardening after full release verification.


## [15.0.0-beta.23] - 2026-09-28

### Fixed
- Prevented a second normal engineering prompt from being silently consumed while a direct UES controller is already active.
- Added deterministic natural-continuation forwarding for explicit `tiếp tục` / `làm tiếp` / `continue` style follow-ups when one active child can be targeted safely.

### Changed
- Unrelated prompts during an active direct run stay on Pi's normal path instead of attempting a duplicate controller admission.
- `/ues-status` now advertises safe continuation together with the native/auto/high-risk router.
- Added `npm run release:verify` as the final one-command release-candidate gate (full CI/package smoke + focused V15 regressions).

### Validation
- Added V15.19 regression coverage for Vietnamese/English continuations, inactive-run rejection, unrelated-prompt rejection, slash-command bypass, and host wiring that refuses to swallow prompts.


## [15.0.0-beta.22] - 2026-09-28

### Added
- Added three-tier zero-friction routing for normal Pi input: `native`, automatic UES, and high-risk UES.
- Added conservative informational-query detection so explanation/comparison questions stay on Pi's native path instead of starting engineering orchestration.
- Added richer admission reasons/confidence and surfaced `native / auto / high-risk` through `/ues-status`.

### Changed
- Automatic UES runs now launch non-blockingly from the input hook, keeping stop/steer/follow-up interaction responsive while the supervised controller continues.
- Direct admission reuses the already-classified task policy inside `ues_execute`, avoiding duplicate classification and keeping the selected execution/risk profile stable.
- Expanded natural engineering verbs for project-health workflows such as inspect, scan, check, analyze, `xem`, and `phân tích`.

### Validation
- Added regression coverage for native informational chat, project-health auto routing, long structured prompts, high-risk database work, non-Git workspaces, and explicit slash-command bypass.


## [15.0.0-beta.21] - 2026-09-27

### Added
- Added deterministic zero-friction admission for normal interactive text engineering prompts inside Git worktrees. Users no longer need to type `/ues-run` for ordinary engineering tasks.
- Automatic admission routes through the same direct UES controller as `/ues-run`, preserving process supervision, timeout/abort recovery, phase gates, durable state, verification, and cleanup.
- Added conservative admission rules: greetings, casual discussion, slash commands, non-Git workspaces, and image-bearing prompts stay on the normal Pi path.
- Added `UES_AUTO_ADMIT=0` / `false` / `off` as an opt-out and surfaced admission state through `/ues-status`.

### Changed
- Parent UES tools remain hidden during ordinary chat; zero-friction admission invokes the controller directly instead of exposing orchestration tools to the parent model.
- `/ues-run` remains available as an explicit force-entry/compatibility command but is no longer required for normal text engineering work.

### Validation
- Added regression coverage for long structured prompts, action+target engineering prompts, read-only engineering prompts, greetings, non-Git workspaces, and explicit slash-command bypass.


## [15.0.0-beta.20] - 2026-09-27

### Fixed
- Added a Windows-specific portable temp-path guard for UES child file tools. POSIX paths such as `/tmp/foo` and `/var/tmp/foo` now fail closed instead of being passed between Pi file tools and bash/MSYS namespaces that may resolve them differently.
- Specialist prompts now direct transient transformations to stay inside one shell pipeline, or to use ignored repository-local scratch such as `.ues-cache/tmp` when cross-tool scratch is necessary.
- `/ues-status` now reports `Portable temp-path guard: on`.

### Validation
- Added regression coverage proving Windows rejects ambiguous POSIX temp paths while repository-local scratch and Linux POSIX temp paths remain allowed.


## [15.0.0-beta.19] - 2026-09-27

### Added
- Deterministic execution contracts for long-horizon UES runs, including source-facing inherited-dirty snapshots, local-env authorization, explicit phase manifests, database-cleanup safety gates, and independent final verdict dimensions.
- Explicit `PHASE N` sections now become machine-enforced previous-phase barriers. Constraint-only phases remain invariants rather than fake execution tasks.
- Durable work now persists `EXECUTION_CONTRACT.json`, `phases/MANIFEST.json`, one phase artifact per explicit phase, and `FINAL_VERDICTS.json` for resume without replaying the full original prompt.
- Final status separates `SOURCE_PASS`, `RUNTIME_PASS`, `DB_CLEAN_PASS`, and `DEVICE_PASS`; missing real-device evidence remains `DEVICE_NOT_VERIFIED` instead of becoming a false full PASS.

### Safety
- UES child safety now blocks `git restore`, `git checkout --`, and `git stash` so pre-existing user work cannot be silently discarded.
- Local `.env*` files are no-write by default across child edit/code-edit and common shell-write paths. Explicit user authorization is required; `.env.example` / `.env.sample` / `.env.template` remain writable.
- Fixture/database cleanup contracts require production refusal, dry-run candidate evidence, exact/pre-post counts, deterministic markers, canonical preservation, idempotent second-pass proof, and transaction/rollback protection when supported.

### Validation
- Added focused regression coverage for inherited dirty-state capture, local env protection, explicit phase barriers, cleanup/device verdict evidence, and Git discard-command blocking.
- Focused `eval:v15` now includes `test/execution-contract.test.mjs`.


## [15.0.0-beta.18] - 2026-09-27

### Fixed
- Added a deterministic fast path for command-only READ-ONLY Git inspections so weak verifier models cannot fail a valid run merely by omitting the report template or final verdict.
- Whitelisted commands are executed directly through the supervised process runner and are accepted only when every command exits 0 and the source-facing workspace fingerprint is unchanged.
- Unknown Git commands fail closed to the existing model-backed verifier path instead of being guessed or executed.
- Strengthened the model-backed read-only prompt with the exact required report sections and final UES verdict format.

### Validation
- Added regression coverage for the exact Vietnamese read-only request using git status, git branch --show-current, and git rev-parse HEAD, plus fail-closed coverage for an unrecognized git log command.

## [15.0.0-beta.16] - 2026-09-27

### Fixed
- Made the parent Pi integration command-only: ordinary prompts no longer receive UES shell/MCP interception unless an explicit `/ues-*` command activates UES.
- Parent `ues_*` tools are inactive and hidden from normal model turns by default; prompt-style `/ues-*` commands activate them only for that UES turn and restore the normal Pi tool set afterward.
- `/ues-run`, `ues_execute`, `ues_cli`, `ues_service`, specialist dispatch, and `/ues-clean` now require a real Git worktree and canonicalize runtime state to its top-level, preventing `.ues-cache` / `.ues-traces` spill into parent folders such as `E:\\dev`.
- Read-only inspections use a dedicated no-write lane, skip writer worktrees and behavioral-receipt gates, and fail if the source workspace fingerprint changes.
- Structured tasks with no declared write files no longer allocate duplicate Git worktrees.
- Active owned sandboxes are reclaimed during Pi session shutdown; normal completion/failure cleanup remains in place.
- `/ues-clean` now removes transient trace/service/dashboard state and rebuildable cache entries, quota-prunes evidence, and protects evidence referenced by live verified memory while preserving durable work, memory, learning and eval state.
- Trace storage now has bounded per-file, total-size, file-count and age retention.
- Evidence storage now has byte, entry-count and age quotas with automatic garbage collection.
- Durable runtime event journals compact before unbounded growth, and parallel writer concurrency is separately capped (default 2 on Windows) to reduce peak worktree/build disk pressure without reducing read-only parallelism.
- A semantic plan-gate `REVISE` now receives one bounded architect revision and one re-check before being surfaced to the user.

### Validation
- Added V15.12 regression coverage for Git-root refusal, read-only policy, command-only wiring, bounded trace retention and evidence byte quotas.


## [15.0.0-beta.15] - 2026-09-27

### UX
- Keep Pi session identity aligned with the active UES task instead of leaving the sidebar named after an earlier chat message such as `xin chào`.
- `/ues-run` now sets a deterministic, bounded session name from the engineering task without an extra model call.
- Prompt-style UES commands such as `/ues-resume`, `/ues-fix`, `/ues-review`, and related aliases synchronize the session name through Pi's input hook.
- UI title synchronization is best-effort and does not affect controller execution when unavailable.

### Validation
- Added V15.11 tests for deterministic bounded titles, Windows workspace paths, non-UES input isolation, and Pi extension wiring to `setSessionName`.


## [15.0.0-beta.14] - 2026-09-27

### Fixed
- Stopped sandbox diff/integration from running root-wide `git add -N -- .` when UES runtime directories such as `.ues-cache/` are ignored by the target repository.
- Intent-to-add now enumerates only non-ignored untracked source files with `git ls-files --others --exclude-standard -z`, filters UES runtime artifacts again, and batches explicit source paths for Windows-safe command sizing.
- Applied the same source-only intent behavior to both the Pi controller sandbox change detector and the worktree integration path.

### Validation
- Added a regression that creates an ignored `.ues-cache/fast-acceptance.test.mjs` beside a real new source file and proves sandbox integration keeps the source change while never staging or integrating the runtime cache artifact.


## [15.0.0-beta.13] - 2026-09-27

### Fixed
- Prevented a transient unhandled-rejection race when an active RPC specialist is externally aborted before execution reaches its internal settlement await.
- RPC abort semantics are unchanged: the active run still rejects with `UES RPC aborted`, and the caller still receives the runtime-phase abort error.

### Validation
- The existing regression `external RPC abort rejects the active run instead of settling normally` now exercises the fixed settlement path without `PromiseRejectionHandledWarning`.


## [15.0.0-beta.12] - 2026-09-27

### Fixed
- Corrected the shared runtime-artifact import in `lib/workspace-fingerprint.mjs` from the accidental `UES_UES_RUNTIME_DIRS` name to the exported `UES_RUNTIME_DIRS`.
- This hotfix restores CLI/module startup for the V15.10 Adaptive Stability Runtime without changing its planning, verification, or safety behavior.


## [15.0.0-beta.11] - 2026-09-27

### Reliability
- Added V15.10 Adaptive Stability Runtime. Planning workers now start with a short deadline that may extend only when recent activity proves forward progress, while an absolute cap still prevents indefinite runs.
- RPC timeout errors preserve partial assistant output and deadline diagnostics before transport teardown, allowing completed structured output to survive a late timeout.
- Architect planning can salvage only repository task graphs that still pass the existing deterministic plan validator; incomplete or invalid JSON remains fail-closed.
- Architect emits `UES_PLAN_JSON` before optional prose in structured planning mode so the machine-consumable graph is available as early as possible.
- CLI child fallback uses the same activity-aware deadline semantics as RPC to prevent runtime drift between child modes.

### Performance
- Read-only architect/plan-checker context is role-bounded even for high-risk DEEP work. Executor/verifier/integration roles continue to keep the full high-risk evidence budget.
- DEEP architect starts at 60s but may extend while active up to a bounded 150s ceiling; recovery is shorter. Plan-checker uses the same bounded-extension model.
- Workspace fingerprinting now shares the central UES runtime-artifact contract instead of maintaining a duplicate runtime-directory list.

### Safety
- Activity extension never bypasses the idle watchdog or the absolute deadline.
- A salvaged plan must pass `normalizePlanForValidation` + `validatePlan` and still pass the independent plan-checker before any structured write execution.
- High-risk execution evidence budgets were not reduced; only read-only planning context was bounded.


## [15.0.0-beta.10] - 2026-09-27

### Fixed
- UES runtime artifacts such as `.ues-traces/**`, `.ues-cache/**`, `.ues-services/**`, and `.ues-work/**` no longer count as task source mutations.
- Structured write-scope checks and same-wave conflict detection now operate on source-facing changes only, preventing trace files from causing false scope/conflict failures.
- Sandbox integration excludes UES runtime artifacts from generated patches, so controller telemetry/state never leaks back into the target repository through task integration.
- Dirty-root inheritance also skips UES runtime artifacts to avoid unnecessary worktree churn.

### Safety
- Real source/config changes are still enforced. For example, `apps/mobile/package.json` remains a real task mutation and still fails write-scope validation unless the task declares it.
- Runtime artifact filtering is centralized in one contract shared by scope checking and sandbox integration to reduce drift between code paths.


## [15.0.0-beta.9] - 2026-09-27

### Fixed
- Plan-checker no longer fails immediately on a bounded RPC hard/idle timeout. It is soft-steered before timeout and gets one shorter warm-context recovery pass on transport/runtime failure.
- Plan-checker first-pass budget is 75s hard / 30s idle with a 35s soft-steer; recovery is 40s hard / 15s idle with an 18s soft-steer.
- /ues-clean now scans repository-specific sandbox directories directly and removes stale detached physical worktrees even when Git has already forgotten their worktree registration.

### Safety
- A semantic REVISE verdict is never converted into PASS by timeout recovery.
- Detached cleanup only removes directories with valid UES metadata bound to the exact repository root and never removes protected active directories or live-owner sandboxes.


## [15.0.0-beta.8] - 2026-09-27

### Performance
- Added V15.7 Lightweight Sandbox Cleanup. Direct `/ues-run` executions track their own worktrees and reclaim any leftovers immediately on PASS, FAIL, Stop, or controller exception.
- Stale same-process sandboxes can be reclaimed without waiting for the Pi host process to exit, while active sandbox paths remain protected.
- Legacy UES sandboxes without owner leases now use a 30-minute cleanup grace instead of 6 hours.
- Orphan `.ues-meta.json` sidecars are removed automatically, and the sandbox base directory is deleted when empty.

### Developer Experience
- Added `/ues-clean` for safe on-demand cleanup of stale UES sandboxes and orphan metadata in the current repository.

### Safety
- Active worktrees are protected through the in-memory active sandbox registry.
- Live worktrees owned by another process are not removed.
- Cleanup still only targets UES branches/worktrees under the repository-specific UES sandbox base.


## [15.0.0-beta.7] - 2026-09-27

### Performance
- Added V15.6 Fast Planning: architect first-pass planning is bounded to a 60s hard timeout and 25s idle timeout, with a 30s soft-steer / 16-tool exploration cap that asks the worker to stop scanning and emit UES_PLAN_JSON immediately.
- Plan-checker is bounded independently (45s hard / 20s idle) without changing executor/verifier budgets.
- Invalid or timed-out architecture passes get one bounded recovery attempt using the same stable task/context cache namespace instead of restarting repository discovery.
- Architect cache keys use the base planning budget across recovery attempts so warm context survives escalation.

### Reliability
- New task sandboxes record an owner PID lease. Before a controller run, UES prunes sufficiently old UES worktrees whose recorded owner process is dead.
- Legacy sandboxes without an owner lease are conservatively retained for a longer grace period to avoid deleting another live session.
- A valid structured plan emitted before transport timeout is accepted into the independent plan-checker gate instead of being discarded solely because the child exited non-zero after emission.

### Safety
- Fast planning remains fail-closed: if the bounded recovery still cannot produce a valid deterministic graph, execution stops rather than fabricating a plan.
- Executor, verifier, integration verification, scope/conflict checks, and final completion gates retain their existing budgets and semantics.


## [15.0.0-beta.6] - 2026-09-27

### Performance
- Added V15.5 Per-Leaf Turbo: low-risk single-file leaf tasks inside a DEEP/high-risk root plan can execute with the FAST profile instead of inheriting project-wide orchestration cost.
- Added deterministic-first leaf verification. A FAST leaf may skip a verifier model turn only when fresh post-edit behavioral receipts satisfy the existing fail-closed FAST gate.
- Added task-local failure-delta retry so a failed leaf receives only its own high-signal verifier/runtime evidence instead of replaying the whole wave failure.
- Structured retry context keys now use the root repository namespace plus workspace fingerprint, so a fresh worktree sandbox can reuse context when its source snapshot is identical.
- Retry failure evidence is kept outside the stable leaf task text, allowing exact context-pack reuse across attempts.

### Safety
- High-risk/database/public-contract leaves remain DEEP when their own evidence/risk requires it.
- Final root integration verification and completion evidence remain mandatory for DEEP structured work.
- Cache reuse remains fingerprint-bound; changed source invalidates the reusable context instead of chasing a synthetic hit-rate target.


## [15.0.0-beta.5] - 2026-09-27

### Fixed
- Fixed Zed/ACP runs failing with `EADDRINUSE` when a UES specialist child accidentally reused the ACP host entrypoint and tried to bind the host ACP port again.
- Pi child invocation now reuses `process.argv[1]` only when it is a verified Pi CLI entrypoint.
- On Windows ACP hosts, UES resolves the installed Pi CLI from the managed `~/.pi/agent/install/releases` tree or PATH instead of re-spawning the ACP adapter.

### Safety
- Terminal Pi behavior remains unchanged: a genuine Pi CLI host still reuses its current CLI entrypoint.
- No verifier, integration, evidence, or fail-closed gates were removed.


## [15.0.0-beta.4] - 2026-09-27

### Performance
- Added V15.3 DEEP Speed: long-horizon planning no longer spawns a redundant first-pass debugger for generic `fix` wording when no concrete failure evidence exists.
- Added bounded exploration contracts for architect, plan-checker, executor, and debugger roles so they consume the UES context pack and declared scope before repository-wide discovery.
- Structured executors now explicitly stop discovery once the safe minimal edit is grounded and spend remaining effort on fresh verification.

### Safety
- Full DEEP/high context budgets, plan checks, task verification, integration verification, durable receipts, and fail-closed completion remain unchanged.
- Concrete failure evidence still enables first-pass diagnosis; retries still diagnose before patching when required.


## [15.0.0-beta.3] - 2026-09-27

### Fixed
- Fixed long-horizon architect plans being rejected when weak models used common aliases such as `acceptanceCriteria` or `verificationChecks`.
- Added conservative task-graph normalization: descriptive prose mistakenly placed in `risk` is preserved as `riskNotes` and mapped to a safe enum instead of silently weakening verification.
- Strengthened the architect contract with an explicit `UES_PLAN_JSON` schema and repair guidance.
- Normalization remains fail-closed: missing acceptance or verification evidence is never invented.


## [15.0.0-beta.2] - 2026-09-27

### Added
- Added a fail-closed Turbo Fast Path policy for first-attempt low-risk single-file executor/verifier work.
- Added bounded FAST latency budgets: 180s hard timeout, 60s idle timeout, 30s post-tool-error idle timeout and 90s verification command timeout by default.
- Added visible interactive controller progress notifications and benchmark progress telemetry.

### Fixed
- Removed the conflicting `pi/prompts/ues-run.md`; Pi now exposes exactly one `/ues-run`, owned by the deterministic extension command.
- Preserved the original user-task policy across controller-generated executor/verifier prompts so UES instructions cannot accidentally reclassify a FAST single-file task as STANDARD/DEEP.
- Pi live eval now reads direct-controller telemetry from both stdout and stderr; headless extension diagnostics emitted by Pi no longer cause false `uesControllerUsed=false`.
- Direct benchmark telemetry is written explicitly to stderr, matching Pi headless/JSON stream boundaries.

### Performance
- FAST attempt 1 remains one bounded model lane where possible, prioritizes fresh behavioral receipts, and skips a separate verifier model turn only when the deterministic gate proves the acceptance criteria.
- FAST timeouts fail closed into the existing recovery/escalation path rather than lowering completion requirements.


## [15.0.0-beta.1] - 2026-09-27

### Added
- Added deterministic `/ues-run` admission as a Pi extension command, so weak parent models no longer need to remember to call `ues_execute`.
- Added `ues_service` Managed Background Services to parent and specialist runtimes with start, wait-ready, status, logs, stop and restart actions.
- Added TCP/log readiness probes, bounded service logs, Evidence Store snapshots and cross-platform process-tree cleanup.
- Added focused V15 regression coverage for foreground-service classification, readiness, evidence capture, shutdown and deterministic benchmark admission.

### Changed
- Pi live UES benchmarks now enter through `/ues-run` instead of asking the model to voluntarily call `ues_execute`.
- RPC specialists now receive the same `ues_code` / `ues_code_edit` intelligence tools as CLI specialists, plus `ues_service`.
- Common foreground dev-server commands are blocked in bash/powershell and redirected to `ues_service`.
- `.ues-services/` runtime state is ignored by Git and excluded from fingerprints, semantic indexing, repo graphs and affected-test scans.

### Safety
- Managed services use shell-free executable + argument invocation and existing safe Windows shim resolution.
- Destructive service commands still pass through UES destructive-command policy.
- Session shutdown stops only processes owned by the current UES runtime; historical PID metadata is never blindly killed.


## [14.4.0] - 2026-09-26

### Added
- Added bounded code intelligence for weak models: semantic search, optional ast-grep structural search, hash-anchored source reads and optional LSP diagnostics.
- Added fail-closed hash-anchored editing through the Pi child runtime; stale anchors require a fresh read instead of fuzzy patch retry.
- Added a deterministic completion auditor that requires structured verifier evidence and fresh behavioral verification receipts before UES reports PASS.
- Added reversible T1/T2/T3 context blocks backed by the Evidence Store with bounded search and expansion.
- Added optional document ingestion: text formats are dependency-free and Office/PDF ingestion can use Microsoft MarkItDown only when installed.
- Added cache-stable verified-memory snapshots so retrieval/touch telemetry does not invalidate the stable prompt prefix.
- Added MCP annotation policy plus bounded MCP health tracking, transient-failure cooldown and conservative reconnect advice.

### Changed
- Pi child agents now receive a bounded `ues_code` intelligence tool; writer roles additionally receive `ues_code_edit`.
- Model-performance PASS accounting now happens only after all required verification, integration/visual gates and the deterministic completion audit pass.
- Browser/MCP routing prefers providers that are not currently in a health cooldown when healthy alternatives exist.
- Capability Fabric now exposes code editing, code structure, diagnostics, document ingestion and reversible-context capabilities.
- Stable npm installation is now the primary documented public installation path.

### Safety
- MCP annotations are treated only as hints that can tighten safety; they never bypass existing UES gates.
- Destructive MCP tools still require confirmation and are never auto-retried/reconnected.
- LSP, ast-grep and MarkItDown remain optional capabilities; their absence does not break unrelated UES execution.
- Code/document operations reject paths or symlinks that escape the workspace root.

### Validation
- Added V14.3/V14.4 regression coverage for stale-anchor rejection, workspace-contained editing, completion false-PASS prevention, reversible context, prompt-cache telemetry, stable memory generations, MCP annotations and MCP health/reconnect behavior.
- Windows validation confirmed source integrity, runtime exports, JavaScript syntax, the V14 evaluation suite and Pi package tests before stable release preparation.

## [14.2.0-beta.1] - 2026-09-25

### Added
- Added a persistent Pi RPC worker pool with fresh sessions between specialist runs, CLI fallback, bounded worker count, interactive steer forwarding and active-child abort support.
- Added a unified process-tree supervisor with hard/idle timeout, output caps, Windows/POSIX tree termination and bounded I/O drain.
- Added rolling streamed-output hang detection so split Jest open-handle warnings cannot evade the detector.
- Added role-aware adaptive context budgets, runtime context caching, workspace-fingerprint invalidation and cached dependency graphs.
- Added bounded micro-skill compilation so child agents receive selected domain/role rules without loading the full skill catalog.
- Added changed-file affected-test hints and fresh verification-receipt reuse at unchanged workspace fingerprints.
- Added a minimal child runtime extension for shell safety, verification-command timeout, tool-boundary receipts, full-output recovery and reversible compaction.
- Added selective JSON evidence retrieval with `#/json/pointer` and dotted selectors.
- Added personalized dependency-graph ranking to context selection.
- Added task-specific Playwright/Browser MCP subsets.
- Added confidence-bound empirical model routing and a larger default minimum sample threshold.
- Added automatic DEEP/long-horizon promotion to durable `.ues-work` state with plan, task and integration receipts.
- Added bounded operational trajectory events for controller/agent execution.
- Added shell segment analysis for compound destructive-command detection.
- Added baseline-contamination detection and a turbo benchmark promotion gate for quality non-regression plus efficiency improvement.

### Changed
- Test/lint/typecheck/build commands executed by child agents now receive policy-bounded default timeouts when no timeout was specified.
- Reusable child verification receipts now canonicalize safe simple shell commands into exact executable + argument keys, preventing unrelated checks from cross-reusing a PASS.
- POSIX process supervision now escalates against surviving descendants after the direct child exits, closing the inherited-pipe/open-handle gap that can otherwise keep test trees alive.
- Low/medium-risk verifiers can consume fresh executable-check receipts captured at the tool boundary; high-risk verification keeps independent fresh checking.
- Reusable executable-check receipts now require an unchanged verification state (`workspaceBefore === workspaceAfter === currentFingerprint`); checks that mutate repository state cannot seed a reusable PASS.
- Hot-path runtime caches now include regression/integrity guards for compiled micro-skills, affected-test caching and one-pass workspace snapshots.
- Runtime fingerprints now hash untracked file contents, avoid following untracked symlinks outside the repository, and fail closed when an untracked artifact is too large to fingerprint safely.
- Repository graph and affected-test scans now exclude all UES runtime/sandbox state while preserving legitimate source under `bin/`.
- CLI fallback children are tracked so interactive stop/cancel can terminate their process trees even when RPC steering is unavailable.
- Semantic snapshots are cached by trusted workspace fingerprint and shared across specialist context builds.
- Warm RPC workers are isolated by verification-timeout policy, and `auto` fallback is now startup-only: in-task RPC timeout/failure never triggers a blind second execution through CLI.
- Interactive stop/cancel now aborts the active RPC promise with exit-code-130 semantics; CLI fallback children remain tracked until termination is actually requested.
- Untracked workspace fingerprinting is bounded by both per-file and aggregate byte limits to avoid expensive cache-key scans on large local artifacts.
- Turbo benchmark promotion now requires explicit baseline-isolation evidence and explicit UES-controller telemetry for every paired UES arm.
- User stop/cancel is terminal across structured and ordinary retries: exit-code-130/aborted runs clean up state and are never promoted into another automatic attempt.
- User-aborted runs are excluded from model-performance learning so manual cancellation cannot poison future model routing.
- Semantic-index, dependency-graph and affected-test scanners coalesce concurrent identical builds, while the warm RPC worker map now uses true LRU refresh on reuse.
- Child output compaction runs before the result returns to the model and preserves recoverable Evidence Store references.
- Pi shell `fullOutputPath` is used when available so raw evidence is not limited to the already-truncated model-visible result.
- Browser MCP exposure is reduced from the discovered provider set to the subset relevant to the current browser/visual task.
- Model-performance reranking now uses a Wilson lower confidence bound instead of letting very small samples move weak-model selection.
- Verification-broker cache updates now use a cross-process lock so parallel child Pi workers cannot overwrite each other's reusable receipts; malformed/stale receipt metadata fails closed.
- RPC worker-cache eviction never terminates an active specialist just to satisfy the warm-worker limit; dead/idle workers are pruned safely and steer/abort control latency is bounded.
- The canonical local `npm run ci` release-consistency gate no longer depends on GitHub Actions workflow configuration.
- Source-integrity checks now protect the V14.2 regression suite and verification broker against accidental fragment/truncation overwrites.

### Safety
- Thinking level is not lowered by V14.2.
- Verifier, integration-verifier and visual-verifier gates remain in place.
- High-risk tasks disable child output compaction and receipt-reuse optimization by default.
- Child runtime independently blocks destructive shell commands even if the parent UES extension is not rediscovered inside the child.
- Non-Git runtime caches fail closed instead of reusing a root-only fingerprint.
- DEEP tasks refuse to report durable PASS when durable initialization or finalization cannot produce fresh receipts.

### Regression coverage
- Added V14.2 tests for adaptive context, micro-skills, affected tests, receipt freshness, process supervision, browser tool minimization, non-Git cache isolation, graph ranking, shell segment safety and selective evidence retrieval.
- Added benchmark tests for quality-parity efficiency promotion and controller false-PASS rejection.
- Extended Pi/package smoke contracts for the minimal child runtime, steering, process supervision, safety and full-output recovery.

## [14.1.0-beta.1] - 2026-09-24

### Added
- V14.1 introduces a quality-preserving performance fabric for model-visible UES output. Oversized deterministic CLI output is compacted into a bounded head/high-signal/tail preview while the byte-exact original is stored in Evidence Store behind a recovery reference.
- Capability Fabric now detects RTK, Caveman and Headroom CLIs as optional output-compaction providers. The built-in reversible UES compactor remains the default; external providers are never auto-installed or auto-enabled.
- Pi browser tools are now routed on demand: Playwright/Browser MCP tools are discovered from the host registry and exposed only to browser/visual child tasks; visual tasks gain a final read-only visual-verifier gate.

### Performance safety
- Child model thinking level is unchanged, independent verifier/integration-verifier gates are unchanged, and compaction fails open to raw output if Evidence Store is unavailable.
- The executor now follows a minimal-solution ladder without trading away validation, error handling, security, data integrity, accessibility, compatibility, tests, observability or explicit requirements.
- `ues hierarchy` is compact by default and exposes `--full` for complete file lists, reducing accidental context bloat while preserving an explicit lossless path.
- Dynamic Workflow now skips the executor only for deterministic tasks with an empty write scope; the read-only verifier still runs at the inherited thinking level and must PASS.
- External command capability probes are cached for 60 seconds so optional RTK/Caveman/Headroom discovery does not repeatedly spawn command lookup processes.

### Changed
- Durable `.ues-work` task contexts now recall the same evidence-verified V14 memory used by inline Pi execution and expose bounded selected/fallback provider hints from Capability Fabric.
- Finalized durable work now records a non-fatal evidence-backed episodic memory using the plan's declared file scope.
- Adaptive Pi context now exposes Capability Fabric provider selections so weaker models do not have to guess which healthy backend should satisfy a capability.

### Fixed
- Explicit file scope is authoritative when recording verified task memory, preventing unrelated pre-existing dirty files from contaminating future recall.
- Workspace fingerprints now ignore `.ues-memory/` state in both Git and non-Git workspaces, so memory writes cannot invalidate otherwise fresh verification evidence.

### Regression coverage
- Added durable-context parity coverage for verified memory, provider hints, finalization memory, explicit memory file scope, and non-Git memory fingerprint isolation.
- Added focused coverage proving backend tasks do not receive browser tools while E2E/visual tasks selectively receive detected Playwright MCP tools.

## [14.0.0-beta.1] - 2026-09-24

### Added
- Persisted capability success/failure/latency observations under ignored `.ues-learning/` state with bounded confidence before routing influence.
- Added task-class affinity, expiry filtering and usage accounting for verified persistent memory.
- Added hierarchy scope diversity so a single parent/child directory chain cannot consume the context scope budget.
- Exposed V14 capability-fabric health alongside memory status in Control Center.

### Changed
- Adaptive context now passes the current task class into memory retrieval and records actual recalled-memory usage.
- Capability routing can learn away from repeatedly failing providers without letting one transient failure poison selection.

### Regression coverage
- Added focused V14 tests for learned provider failover, hierarchy diversity, memory expiry/task-class/use tracking and Control Center telemetry.

## [14.0.0-beta.0] - 2026-09-24

### Added
- Added a deterministic capability fabric with provider health checks, primary/fallback selection, quality/cost/latency scoring, project overrides and `ues doctor` visibility.
- Added hierarchical repository context with bounded L0 routing abstracts, L1 subtree overviews and existing L2 source/test/instruction excerpts.
- Added verified persistent project memory under ignored `.ues-memory/` state with candidate/verified/superseded lifecycle, durable Evidence Store requirements, confidence and reinforcement metadata.
- Added hybrid memory retrieval combining BM25-style lexical relevance, deterministic hashed-vector similarity, file-path affinity, recency/confidence and reciprocal-rank fusion.
- Added `capability-fabric`, `hierarchy` and `memory` CLI surfaces plus V14 Control Center memory telemetry.
- Added V14 deterministic contract/eval fixtures for hierarchy routing, evidence-backed recall, supersession, provider failover and context contamination.

### Changed
- Adaptive task context now scope-boosts semantic references using the hierarchy and injects only bounded verified memories into child Pi context.
- Pi `ues_execute` records an episodic memory only after independent task/integration verification passes; memory failures remain non-fatal to an already verified engineering task.
- Semantic indexing excludes `.ues-memory/` runtime state.

### Safety
- Candidate or superseded memories are never retrieved.
- Memory verification fails closed without a named verifier, PASS verdict and at least one existing content-addressed evidence reference.
- Supersession requires the replacement memory to be verified first.
- Optional capability providers may be unavailable without pretending to be healthy or failing unrelated capabilities.

### Regression coverage
- Added focused V14 unit and CLI tests for capability fallback, L0/L1 hierarchy bounds, verified-memory retrieval, supersession, evidence fail-closed behavior and adaptive-context injection.


## [13.0.0-beta.3] - 2026-09-23

### Fixed