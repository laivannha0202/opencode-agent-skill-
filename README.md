# OpenCode Universal Engineering System (UES)

**UES 7.7.0** là engineering harness cho OpenCode, tập trung vào việc giúp model hiện có xử lý repository lớn và task dài theo quy trình có trạng thái bền vững, fresh-context execution, deterministic evidence và verification gate.

UES không tuyên bố biến một model yếu thành model mạnh hơn về bản chất. Mục tiêu là giảm lượng reasoning mà model phải tự giữ trong một context: chia task rõ, lưu state ra filesystem, dùng code cho các việc có thể xác định được, chạy subagent với context mới, và chỉ cho phép hoàn tất khi có evidence.

## UES 7.7.0 có gì?

Ngoài nền V6 (durable PLAN/STATE/EVIDENCE, fresh executors, plan/integration gates), V7.7 thêm:

- crash-safe task lease với `runId`, heartbeat, stale-task recovery
- live benchmark heartbeat + hard/idle timeout + Ctrl+C process-tree cancellation
- structured verification receipts gắn command/exit code/output hash/workspace fingerprint vào task run
- context manifest tự chọn declared files, import neighbors, likely tests, manifests và accepted lessons
- adaptive task policy: inline/standard/long-horizon + risk/model/context/retry guidance
- read/write-aware safe waves và isolated Git worktree sandbox primitives cho parallel writers
- evidence-gated learning loop từ `.ues-evals` → proposal → explicit accept → future context retrieval
- optional Hermes bridge theo kiểu adapter, không nhúng Hermes runtime vào core
- zero-dependency local **UES Control Center** cho work state, evidence, learning và eval summaries

Xem chi tiết: [V7 Intelligence Runtime](docs/V7-INTELLIGENCE-RUNTIME.md)

### Lệnh V7 nhanh

```cmd
ocskill task-policy "refactor auth across the whole repository"
ocskill work recover <slug> .
ocskill work verify-command <slug> <task> . -- npm test
ocskill sandbox create <slug> <task> .
ocskill learn analyze . --eval-dir .ues-evals
ocskill hermes status
ocskill dashboard . --serve
```



- **39 engineering skills**
- **11 slash commands**
- **10 subagents**
- durable long-task engine dưới `.ues-work/<slug>/`
- machine-checkable `PLAN.json` + dependency DAG + safe execution waves
- hard plan approval gate và integration verification gate
- atomic/locked `STATE.json` + `EVIDENCE.json` để tránh mất state khi task độc lập hoàn tất đồng thời
- OpenCode V2 runtime plugin với automatic skill routing, safety permission gate và fresh-session task dispatch
- configurable `light / standard / heavy` model tiers với attempt-based escalation
- deterministic repository tools: repo graph, impact, review scope, verification plan, task graph, context pack
- **34 static skill-routing scenarios** phủ đủ 39 skill
- **120 V2 router trigger cases** có positive/negative guards
- **20 standard live hidden-graded tasks**
- **5 long-horizon tasks**, gồm một bài tích hợp **15 source files**
- hỗ trợ **OpenCode 1.x và 2.x**

Luồng long-horizon chính:

```text
request
  ↓
repo evidence / codebase map
  ↓
SPEC.md
  ↓
PLAN.json
  ↓
ues-plan-checker
  ↓
machine approval gate
  ↓
dependency-safe tasks
  ↓
fresh ues-executor session / task
  ↓
task evidence + durable state
  ↓
ues-integration-verifier
  ↓
machine integration PASS gate
  ↓
workspace fingerprint unchanged
  ↓
finalize
```

---

## Cài đặt

```cmd
npm install -g @laivannha0202/opencode-agent-skill --allow-scripts=@laivannha0202/opencode-agent-skill
```

Kiểm tra:

```cmd
ocskill status
ocskill doctor
```

Nếu npm không chạy lifecycle script:

```cmd
ocskill install
```

Khi đồng bộ V6 đầy đủ, status sẽ phản ánh khoảng:

```text
Package version: 7.7.0
Resource version: 7.7.0
Skills: 39/39
Commands: 11/11
Subagents: 10/10
Workflow: OK
```

Sau khi cài/cập nhật, nên mở OpenCode session mới để resource mới được nạp.

---

# 1. Subagents

| Subagent | Vai trò |
|---|---|
| `ues-codebase-mapper` | Map repository, entry point, boundary, hotspot, contract và test surface |
| `ues-architect` | Architecture/change-impact analysis |
| `ues-plan-checker` | Fresh-context gate kiểm tra SPEC/PLAN trước khi code |
| `ues-executor` | Fresh-context implementation cho đúng một approved task |
| `ues-debugger` | Root-cause debugging |
| `ues-researcher` | Kiểm tra docs/API/version hiện hành |
| `ues-reviewer` | Review correctness/regression/security/compatibility |
| `ues-critic` | Adversarial falsification/counterexample |
| `ues-verifier` | Verification độc lập theo acceptance criteria |
| `ues-integration-verifier` | Cross-task/end-to-end integration verification |

`ues-executor` là subagent có quyền sửa code theo scope được giao. Các agent còn lại chủ yếu phục vụ phân tích/kiểm chứng và không được dùng để âm thầm mở rộng implementation.

---

# 2. Slash commands

| Lệnh | Công dụng |
|---|---|
| `/ues-feature` | Làm feature theo workflow UES |
| `/ues-fix` | Điều tra root cause rồi sửa bug |
| `/ues-plan` | Lập implementation-ready plan |
| `/ues-debug` | Điều tra bug/build/test failure |
| `/ues-research` | Kiểm tra docs/API/package/version |
| `/ues-review` | Review diff/code |
| `/ues-verify` | Verification bằng evidence mới |
| `/ues-critique` | Tìm assumption sai/counterexample |
| `/ues-audit` | Audit repository/khu vực |
| `/ues-run` | Chạy long-horizon workflow với durable state + fresh executors |
| `/ues-resume` | Resume work item từ `.ues-work` thay vì dựa vào chat history |

Với task lớn, ưu tiên:

```text
/ues-run <yêu cầu>
```

Nếu session bị ngắt/compact:

```text
/ues-resume <slug>
```

---

# 3. Long-horizon engine

V7 task records additionally track `runId`, executor owner, heartbeat, lease expiry and evidence strength. `ocskill work resume` can recover stale running tasks, while the V2 dispatcher refreshes leases during fresh-session execution.

Structured verification can be recorded with:

```cmd
ocskill work verify-command <slug> <task> . --run-id <run-id> -- npm test
```



Mỗi work item dùng:

```text
.ues-work/<slug>/
├── SPEC.md
├── PLAN.json
├── STATE.json
├── EVIDENCE.json
├── tasks/
└── reports/
```

`.ues-work/` được git-ignore. Đây là execution state, không phải hidden chain-of-thought.

## Hard gate 1 — Plan approval

`ocskill work plan` không đưa task thẳng sang executable state. Nó để state ở:

```text
awaiting-plan-approval
```

Sau khi `ues-plan-checker` trả PASS:

```cmd
ocskill work approve-plan <slug> . --evidence "plan checker PASS: ..."
```

Nếu chưa có approval hợp lệ, `ocskill work start` sẽ từ chối.

## Hard gate 2 — Concurrent durable state

Mọi mutation của `STATE.json` và `EVIDENCE.json` dùng per-work-item lock + atomic replacement. Hai task độc lập có thể hoàn tất gần nhau mà không được phép ghi đè state/evidence của nhau.

Safe-wave chỉ bảo vệ declared file overlap. Nếu task có implicit shared write surface như generated files/lockfiles, hãy serialize.

## Hard gate 3 — Integration completion

Sau khi mọi task hoàn tất:

```cmd
ocskill work verify-integration <slug> . --verdict PASS --evidence "..."
```

PASS lưu workspace fingerprint. `finalize` sẽ bị từ chối nếu:

- còn task incomplete
- còn blocker
- chưa có integration PASS
- workspace đã thay đổi sau PASS

Sau đó:

```cmd
ocskill work finalize <slug> . --evidence "final acceptance verified"
```

---

# 4. Fresh-context executor trên OpenCode V2

V2 plugin expose tool:

```text
ues.dispatch_task
```

Nó thực hiện:

```text
work start
  ↓
read bounded context pack
  ↓
resolve model tier theo attempt
  ↓
create fresh OpenCode session
  ↓
switchAgent(ues-executor)
  ↓
switchModel(...) nếu được cấu hình
  ↓
prompt đúng 1 task
  ↓
wait
  ↓
return child-session report
```

Parent vẫn phải inspect diff/evidence và gọi `work complete` hoặc `work fail`. Child session không được tự merge/push/publish/deploy.

---

# 5. Adaptive task + model policy

V7 adds deterministic task classification:

```cmd
ocskill task-policy "your engineering request"
ocskill model-policy executor --attempt 1 --text "your engineering request"
```

Task risk/complexity can raise the base model tier before attempt-based escalation. User-configured provider/model IDs remain authoritative.

## Model tiers

Xem cấu hình:

```cmd
ocskill models status
```

Bật:

```cmd
ocskill models on
```

Gán model:

```cmd
ocskill models set light provider/cheap
ocskill models set standard provider/mid
ocskill models set heavy provider/strong
```

Gán tier theo role:

```cmd
ocskill models role executor standard
ocskill models role plan-checker heavy
```

Kiểm tra attempt:

```cmd
ocskill model-policy executor --attempt 1
ocskill model-policy executor --attempt 2
```

Mặc định role quan trọng như architect, plan-checker, critic và integration-verifier ưu tiên `heavy`; executor/debugger/reviewer thường bắt đầu ở `standard`. Retry có thể escalate lên tier cao hơn nếu đã cấu hình.

---

# 6. Deterministic CLI tools

| Lệnh | Công dụng |
|---|---|
| `ocskill inspect [dir]` | Stack/package manager/root map/test commands |
| `ocskill repo-graph [dir]` | Bounded import graph + coupling hotspots |
| `ocskill impact <query> [dir]` | Bounded symbol/term impact search |
| `ocskill evidence [dir]` | Repository + verification + Git evidence snapshot |
| `ocskill working-tree [dir]` | Branch/HEAD/dirty state |
| `ocskill review-scope [base] [dir]` | Changed-file coverage + deterministic risk hints |
| `ocskill verification-plan [dir]` | Project-native verification recommendations |
| `ocskill task-graph <PLAN.json>` | Validate DAG + compute safe waves |
| `ocskill context-pack <slug> <task> [dir]` | Bounded handoff cho fresh executor |
| `ocskill work ...` | Durable long-task state machine |

Ví dụ:

```cmd
ocskill repo-graph .
ocskill review-scope main .
ocskill verification-plan .
ocskill task-graph .ues-work/checkout/PLAN.json
ocskill work status checkout .
```

---

# 7. Skills

UES giữ **39 skills**, không tăng catalog chỉ để tăng số lượng. Thông thường router chỉ cần 2–4 skill phù hợp.

Các process skill quan trọng:

- `ues-engineering-orchestrator`
- `ues-repo-explorer`
- `ues-context-engineering`
- `ues-task-planner`
- `ues-change-impact-analysis`
- `ues-bug-diagnosis`
- `ues-test-driven-development`
- `ues-test-verification`
- `ues-code-review`
- `ues-research-verification`
- `ues-long-task-state`
- `ues-git-safety`

Domain/framework skills bao gồm React, Next.js, React Native, Node.js, NestJS, Python, Django, FastAPI, .NET, Java/Spring, Flutter, database, REST/API contract, auth/security, payment, ecommerce, file upload, DevOps, UI/UX, accessibility và performance.

---

# 8. OpenCode 1.x và 2.x

## OpenCode 1.x

- skill/command/subagent file vẫn được cài
- dùng permission frontmatter tương thích V1
- không cài V2 runtime plugin
- long-task CLI/durable state vẫn dùng được
- fresh child-session dispatch phụ thuộc khả năng subagent của runtime V1; không có V2 `ues.dispatch_task`

## OpenCode 2.x

Ngoài resource file, UES cài managed plugin:

```text
~/.config/opencode/plugins/ues-router/
```

Plugin cung cấp:

- prompt-time skill routing
- context guardrail
- permission safety gate cho destructive/high-impact shell action
- read-only long-task helpers
- `ues.dispatch_task` fresh-session executor runtime

Router:

```cmd
ocskill router status
ocskill router on --max 4
ocskill router off
```

---

# 9. Safety

V2 permission gate nâng các thao tác nguy hiểm lên explicit confirmation, gồm nhóm như:

- `git push --force` / `git push -f`
- `git reset --hard`
- destructive `git clean`
- `npm publish`
- recursive forced deletion
- `DROP/TRUNCATE`
- Terraform/Kubernetes/Helm high-impact deployment actions

Instruction vẫn yêu cầu confirmation cho destructive/external side effects. Hook là lớp deterministic bổ sung, không thay thế review của người dùng.

---

# 10. Evaluation

Live evals now print heartbeats and support `--heartbeat-ms`, `--idle-timeout-ms`, and `--timeout-ms`. Ctrl+C asks the harness to terminate the active OpenCode process tree cleanly.



## Static skill contract

```cmd
npm run evals
```

Giữ **34 scenarios** để kiểm catalog và phủ đủ 39 skill.

## V2 router precision matrix

```cmd
npm run evals:router
```

V6 có **120 cases** với required routes và negative guards.

## Standard hidden graders

```cmd
npm run evals:live:validate
```

Có **20 standard live tasks**.

## Long-horizon integrity

```cmd
npm run evals:long:validate
```

Có **5 long tasks**, trong đó một task yêu cầu phối hợp **15 source modules**.

## Baseline vs UES model thật

```cmd
ocskill eval-live --model provider/model --trials 3
ocskill eval-live --suite long --model provider/model --trials 3
```

Với suite `long`, UES mode chỉ được tính PASS khi:

- hidden grader PASS
- có durable `.ues-work`
- plan approval PASS
- plan có ít nhất 2 task
- mọi task đã được attempt + completed
- integration verification PASS
- integration evidence tồn tại
- finalization evidence tồn tại
- state cuối là `completed`

Vì vậy model giải code trực tiếp trong một context nhưng bỏ qua long-horizon engine sẽ không được tính là UES long PASS.

---

# 11. CI / package release

Yêu cầu phát triển:

- Node.js 20+
- npm
- Git

```cmd
npm ci --ignore-scripts
npm run ci
```

Pipeline gồm:

```text
syntax
→ resource validation
→ static skill routing
→ 120-case router eval
→ standard hidden-grader integrity
→ long hidden-grader integrity
→ Node tests
→ npm pack --dry-run
→ packed global-install smoke
```

Packed smoke kiểm tra OpenCode V2 path, 39 skills, 11 commands, 10 subagents, router plugin, task graph, durable work state và model config.

---

# 12. Update / remove

Update:

```cmd
ocskill update
```

Remove:

```cmd
ocskill remove
```

UES chỉ quản lý resource có namespace/marker của chính nó, giữ unmanaged collisions và chống accidental downgrade.

---

# Tài liệu

- [Engineering design](docs/ENGINEERING-DESIGN.md)
- [OpenCode compatibility](docs/OPENCODE-COMPAT.md)
- [Deterministic tools](docs/DETERMINISTIC-TOOLS.md)
- [Evaluation](docs/EVALS.md)
- [Trace schema](docs/TRACE-SCHEMA.md)
- [npm publish](docs/NPM-PUBLISH.md)
- [Research sources](docs/RESEARCH-SOURCES.md)

# License

MIT


# 13. Learning, Hermes và Control Center

Evidence-gated learning:

```cmd
ocskill learn analyze . --eval-dir .ues-evals
ocskill learn status .
ocskill learn accept <proposal-id> .
```

Optional Hermes adapter:

```cmd
ocskill hermes status
ocskill hermes prompt <slug> <task> .
```

Local Control Center:

```cmd
ocskill dashboard .
ocskill dashboard . --serve --port 4177
```

Parallel write isolation primitives:

```cmd
ocskill sandbox create <slug> <task> .
ocskill sandbox list .
```
