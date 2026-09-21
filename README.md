# OpenCode Universal Engineering System (UES)

> **Bản hiện tại: 9.0.0**
> UES là bộ công cụ hỗ trợ OpenCode xử lý dự án lớn, tác vụ dài và quy trình kỹ thuật cần kiểm chứng bằng bằng chứng thực tế.

[![npm version](https://img.shields.io/npm/v/opencode-agent-skill.svg)](https://www.npmjs.com/package/opencode-agent-skill)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Giới thiệu

**OpenCode Universal Engineering System (UES)** là một engineering harness dành cho OpenCode. UES không thay đổi năng lực nền tảng của model, mà tổ chức cách model làm việc để:

- giảm lượng thông tin phải giữ trong một context dài;
- chia tác vụ lớn thành các bước rõ ràng;
- lưu trạng thái ra filesystem để có thể tiếp tục sau khi session bị ngắt;
- chạy executor bằng context mới cho từng tác vụ;
- yêu cầu bằng chứng kiểm thử trước khi đánh dấu hoàn tất;
- kiểm tra thay đổi ở mức task và mức tích hợp toàn hệ thống;
- hỗ trợ routing skill, model tier, task policy và recovery theo trạng thái thực tế của repository.

Mục tiêu của UES là giúp quá trình làm việc với coding agent **ổn định hơn, có thể kiểm chứng hơn và phù hợp hơn với repository lớn**.

---

## Cài đặt

Yêu cầu:

- Node.js 20 trở lên;
- npm;
- OpenCode.

Cài đặt toàn cục từ npm:

```cmd
npm install -g opencode-agent-skill
```

Kiểm tra:

```cmd
ocskill version
ocskill status
ocskill doctor
```

Nếu npm không chạy lifecycle script trong lúc cài đặt, chạy thêm:

```cmd
ocskill install
```

Sau khi cài hoặc cập nhật UES, nên mở một OpenCode session mới để các skill, command, subagent và plugin được nạp lại đầy đủ.

---

## Bắt đầu nhanh

Với tác vụ lớn, dùng:

```text
/ues-run <yêu cầu>
```

Nếu session bị ngắt hoặc context bị compact:

```text
/ues-resume <slug>
```

Một số lệnh hữu ích:

```cmd
ocskill inspect .
ocskill repo-graph .
ocskill verification-plan .
ocskill task-policy "refactor auth across the whole repository"
ocskill dashboard . --serve
```

---

## UES 9.0.0 có gì?

UES 9.0.0 cung cấp các khả năng sau (kế thừa từ 8.0.0):

- **39 engineering skills**;
- **11 slash commands**;
- **10 subagents**;
- long-task engine bền vững dưới `.ues-work/<slug>/`;
- `PLAN.json`, `STATE.json`, `EVIDENCE.json` và append-only `EVENTS.jsonl`;
- structured plan/integration receipts gắn với plan hash hoặc workspace fingerprint;
- task lease với `runId`, heartbeat, session owner, lease expiry và task-scoped stale recovery;
- strict verification cho long/high-risk task: receipt phải PASS đúng active run và đúng workspace hiện tại;
- context manifest v3 với Git-change awareness, symbol hits, TF-IDF-style relevance, tests/instructions và centered excerpts;
- task policy `inline / standard / long-horizon` cùng model tier `light / standard / heavy`;
- bounded fresh executor với hard timeout, interrupt/cancel và recovery;
- safe-wave scheduling cùng Git worktree isolation/integration có conflict detection;
- learning v2: failure clustering, explicit acceptance và shadow-benchmark promotion;
- benchmark matrix standard + long-horizon + polyglot;
- optional Hermes adapter;
- UES Control Center hiển thị runtime events, receipts và stale recovery;
- OpenCode V2 router plugin với multilingual routing, safety gate, cancel/recover tools và fresh-session dispatch.

V9 bổ sung:

- persistent incremental source index dưới `.ues-cache/semantic-index-v1.json` cùng ACI search/refs/view/text;
- FAST / STANDARD / DEEP execution profiles với bounded context budget, skill cap và verification depth;
- context manifest v4 tiêu thụ incremental evidence index trước khi mở rộng graph;
- redacted operational trajectory dưới `.ues-traces/*.jsonl` để replay/debug mà không lưu hidden chain-of-thought;
- optional container verification sandbox (Docker/Podman) với network-off, dropped capabilities và resource bounds;
- paired baseline-vs-UES confidence gate qua `npm run evals:matrix:gate`.

---

## Kiến trúc tác vụ dài

Luồng long-horizon chính:

```text
Yêu cầu
  ↓
Khảo sát repository / bằng chứng
  ↓
SPEC.md
  ↓
PLAN.json
  ↓
ues-plan-checker
  ↓
Phê duyệt kế hoạch
  ↓
Các task theo dependency graph
  ↓
Fresh ues-executor session cho từng task
  ↓
Task evidence + durable state
  ↓
ues-integration-verifier
  ↓
Integration PASS
  ↓
Kiểm tra workspace không thay đổi
  ↓
Finalize
```

Mỗi work item dùng cấu trúc:

```text
.ues-work/<slug>/
├── SPEC.md
├── PLAN.json
├── STATE.json
├── EVIDENCE.json
├── EVENTS.jsonl
├── tasks/
└── reports/
```

`.ues-work/` là trạng thái thực thi của workflow, không phải hidden chain-of-thought.

### Gate 1 — Phê duyệt kế hoạch

Sau khi tạo plan, task chưa được chạy ngay. Trạng thái sẽ ở:

```text
awaiting-plan-approval
```

Sau khi `ues-plan-checker` trả PASS, với long/high-risk work hãy tạo receipt gắn với đúng plan hiện tại rồi mới approve:

```cmd
ocskill work gate-receipt <slug> plan . --verifier ues-plan-checker --evidence "plan checker PASS" --out .ues-work/<slug>/reports/plan-receipt.json
ocskill work approve-plan <slug> . --evidence "plan checker PASS" --receipt-file .ues-work/<slug>/reports/plan-receipt.json
```

Nếu thiếu structured receipt ở workflow strict, `ocskill work start` sẽ không được mở gate.

### Gate 2 — Bằng chứng cho từng task

Có thể ghi verification receipt trực tiếp từ command:

```cmd
ocskill work verify-command <slug> <task-id> . --run-id <run-id> -- npm test
```

Receipt gắn kết kết quả command với đúng task run. Với long/high-risk work, receipt PASS còn phải khớp workspace fingerprint hiện tại; nếu code thay đổi sau khi test thì phải verify lại.

### Gate 3 — Kiểm tra tích hợp

Sau khi toàn bộ task hoàn tất, tạo integration receipt gắn với workspace hiện tại rồi ghi PASS:

```cmd
ocskill work gate-receipt <slug> integration . --verifier ues-integration-verifier --verdict PASS --evidence "integration PASS" --out .ues-work/<slug>/reports/integration-receipt.json
ocskill work verify-integration <slug> . --verdict PASS --evidence "integration PASS" --receipt-file .ues-work/<slug>/reports/integration-receipt.json
```

Sau đó:

```cmd
ocskill work finalize <slug> . --evidence "final acceptance verified"
```

`finalize` sẽ bị từ chối nếu còn task chưa hoàn tất, còn blocker, chưa có integration PASS hoặc workspace đã thay đổi sau lần kiểm tra tích hợp.

---

## Fresh-context executor trên OpenCode V2

OpenCode V2 plugin cung cấp tool:

```text
ues.dispatch_task
```

Luồng thực thi:

```text
work start
  ↓
đọc bounded context pack
  ↓
chọn model tier theo task + attempt
  ↓
tạo OpenCode session mới
  ↓
switchAgent(ues-executor)
  ↓
switchModel(...) nếu đã cấu hình
  ↓
gửi đúng một task
  ↓
heartbeat + bounded wait
  ↓
interrupt nếu timeout/cancel
  ↓
isolate writer khi cần
  ↓
trả child-session report
```

Parent session vẫn chịu trách nhiệm kiểm tra diff, evidence và quyết định gọi `work complete` hoặc `work fail`.

Child session không được tự động merge, push, publish hoặc deploy.

---

## Subagents

| Subagent | Vai trò |
|---|---|
| `ues-codebase-mapper` | Lập bản đồ repository, entry point, boundary, hotspot, contract và test surface |
| `ues-architect` | Phân tích kiến trúc và phạm vi ảnh hưởng |
| `ues-plan-checker` | Kiểm tra SPEC/PLAN trước khi cho phép thực thi |
| `ues-executor` | Thực hiện một task đã được phê duyệt trong context mới |
| `ues-debugger` | Điều tra nguyên nhân gốc của lỗi |
| `ues-researcher` | Kiểm tra tài liệu, API và phiên bản hiện hành |
| `ues-reviewer` | Review correctness, regression, security và compatibility |
| `ues-critic` | Tìm giả định sai, counterexample và điểm yếu trong phương án |
| `ues-verifier` | Xác minh độc lập theo acceptance criteria |
| `ues-integration-verifier` | Kiểm tra tích hợp giữa nhiều task và luồng end-to-end |

`ues-executor` là subagent chính có quyền sửa code theo scope được giao. Các agent còn lại chủ yếu phục vụ phân tích, review và xác minh.

---

## Slash commands

| Lệnh | Công dụng |
|---|---|
| `/ues-feature` | Triển khai feature theo workflow UES |
| `/ues-fix` | Điều tra nguyên nhân rồi sửa bug |
| `/ues-plan` | Lập kế hoạch triển khai có thể thực thi |
| `/ues-debug` | Điều tra lỗi build, runtime hoặc test |
| `/ues-research` | Kiểm tra docs, API, package hoặc version |
| `/ues-review` | Review code hoặc diff |
| `/ues-verify` | Xác minh bằng evidence mới |
| `/ues-critique` | Tìm assumption sai và counterexample |
| `/ues-audit` | Audit repository hoặc một khu vực |
| `/ues-run` | Chạy workflow long-horizon với durable state |
| `/ues-resume` | Tiếp tục work item từ `.ues-work` |

---

## Task policy và model policy

Phân loại yêu cầu kỹ thuật:

```cmd
ocskill task-policy "your engineering request"
```

Kiểm tra model policy:

```cmd
ocskill model-policy executor --attempt 1 --text "your engineering request"
```

UES dùng ba model tier:

```text
light
standard
heavy
```

Xem cấu hình:

```cmd
ocskill models status
```

Bật model policy:

```cmd
ocskill models on
```

Gán model cho từng tier:

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

Model ID do người dùng cấu hình vẫn là nguồn quyết định cuối cùng; UES không tự đoán provider/model ID.

---

## Công cụ CLI

| Lệnh | Công dụng |
|---|---|
| `ocskill inspect [dir]` | Phát hiện stack, package manager, root và test command |
| `ocskill repo-graph [dir]` | Lập import graph có giới hạn và tìm hotspot |
| `ocskill impact <query> [dir]` | Tìm phạm vi ảnh hưởng theo symbol hoặc từ khóa |
| `ocskill evidence [dir]` | Thu thập snapshot về repository, verification và Git |
| `ocskill working-tree [dir]` | Kiểm tra branch, HEAD và working tree |
| `ocskill review-scope [base] [dir]` | Phân tích changed-file coverage và risk hint |
| `ocskill verification-plan [dir]` | Đề xuất verification phù hợp với project |
| `ocskill task-graph <PLAN.json>` | Kiểm tra DAG và tính safe waves |
| `ocskill context-pack <slug> <task> [dir]` | Tạo bounded handoff cho executor |
| `ocskill work ...` | Điều khiển durable long-task state machine |

Ví dụ:

```cmd
ocskill repo-graph .
ocskill review-scope main .
ocskill verification-plan .
ocskill task-graph .ues-work/checkout/PLAN.json
ocskill work status checkout .
```

---

## Skills

UES hiện có **39 skills**. Router chỉ chọn các skill phù hợp thay vì nạp toàn bộ catalog vào mỗi task.

Một số process skill quan trọng:

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

Nhóm domain/framework hiện bao gồm React, Next.js, React Native, Node.js, NestJS, Python, Django, FastAPI, .NET, Java/Spring, Flutter, database, REST/API contract, authentication/security, payment, ecommerce, file upload, DevOps, UI/UX, accessibility và performance.

---

## Tương thích OpenCode

### OpenCode 1.x

- cài skill, command và subagent;
- dùng frontmatter tương thích V1;
- không cài V2 runtime plugin;
- durable long-task CLI vẫn dùng được;
- không có V2 `ues.dispatch_task`.

### OpenCode 2.x

Ngoài resource file, UES cài managed plugin tại:

```text
~/.config/opencode/plugins/ues-router/
```

Plugin cung cấp:

- automatic skill routing;
- context guardrail;
- permission safety gate;
- read-only long-task helpers;
- fresh-session executor runtime qua `ues.dispatch_task`.

Điều khiển router:

```cmd
ocskill router status
ocskill router on --max 4
ocskill router off
```

---

## Safety

OpenCode V2 permission gate yêu cầu xác nhận rõ ràng trước các thao tác có tác động lớn, ví dụ:

- `git push --force` hoặc `git push -f`;
- `git reset --hard`;
- destructive `git clean`;
- `npm publish`;
- recursive forced deletion;
- `DROP` hoặc `TRUNCATE`;
- Terraform, Kubernetes hoặc Helm action có tác động lớn.

Safety hook là lớp bảo vệ deterministic bổ sung, không thay thế review của người dùng.

---

## Learning loop

Phân tích eval trace:

```cmd
ocskill learn analyze . --eval-dir .ues-evals
```

Xem trạng thái:

```cmd
ocskill learn status .
```

Chấp nhận một proposal trước khi thử nghiệm:

```cmd
ocskill learn accept <proposal-id> .
```

Sau khi shadow benchmark chứng minh candidate tốt hơn baseline:

```cmd
ocskill learn promote <proposal-id> . --baseline 0.50 --candidate 0.75 --samples 4
```

Proposal có `shadowRequired` chỉ được đưa trở lại context sau khi vừa được chấp nhận rõ ràng vừa có benchmark improvement đo được.

---

## Hermes adapter

UES hỗ trợ Hermes theo dạng adapter tùy chọn, không nhúng Hermes runtime vào core:

```cmd
ocskill hermes status
ocskill hermes prompt <slug> <task> .
ocskill hermes exec <slug> <task> .
```

Nếu máy không có Hermes CLI, các tính năng Hermes chỉ báo unavailable và không ảnh hưởng đến core UES.

---

## UES Control Center

Tạo dashboard tĩnh:

```cmd
ocskill dashboard .
```

Chạy dashboard có tự refresh:

```cmd
ocskill dashboard . --serve --port 4177
```

Control Center hiển thị work state, verification receipts, runtime events, learning proposals và eval summary; server mode có safe stale-recovery action.

---

## Sandbox cho tác vụ ghi song song

Tạo isolated Git worktree:

```cmd
ocskill sandbox create <slug> <task-id> .
```

Tích hợp sandbox sau khi đã inspect/verify:

```cmd
ocskill sandbox integrate <worktree-path> .
```

Liệt kê sandbox:

```cmd
ocskill sandbox list .
```

Integration sẽ từ chối ghi đè lên file đang dirty ở root. Safe-wave scheduling chỉ bảo vệ declared file scope. Generated file, lockfile hoặc shared write surface ngầm định vẫn nên được serialize khi cần.

---

## Evaluation

UES 9.0.0 hiện có:

- **34 static skill-routing scenarios** phủ 39 skills;
- **120 V2 router cases** với required routes và negative guards;
- **20 standard live tasks**;
- **5 long-horizon tasks**;
- **8 polyglot tasks** cho Python, Java, .NET, Next.js, React Native, SQL migration, monorepo và generated contract;
- benchmark matrix baseline-vs-UES nhiều trial;
- một long task tích hợp tới **15 source modules**.

Kiểm tra static routing:

```cmd
npm run evals
```

Kiểm tra V2 router:

```cmd
npm run evals:router
```

Kiểm tra standard hidden graders:

```cmd
npm run evals:live:validate
```

Kiểm tra long-horizon và polyglot suite:

```cmd
npm run evals:long:validate
npm run evals:polyglot:validate
```

Chạy benchmark với model thật:

```cmd
ocskill eval-live --model provider/model --trials 3
ocskill eval-live --suite long --model provider/model --trials 3
npm run evals:matrix -- --model provider/model --trials 3
```

Live eval hỗ trợ heartbeat, hard timeout, idle timeout và Ctrl+C process-tree cancellation.

Với long suite, một run UES chỉ được tính PASS khi hidden grader PASS, durable work state tồn tại, plan approval hợp lệ, toàn bộ task hoàn tất, integration verification PASS và finalization hoàn tất.

---

## Phát triển và CI

Yêu cầu:

- Node.js 20+;
- npm;
- Git.

Cài dependency mà không chạy lifecycle script:

```cmd
npm ci --ignore-scripts
```

Chạy toàn bộ CI:

```cmd
npm run ci
```

Pipeline hiện kiểm tra:

```text
syntax
→ resource validation
→ static skill routing
→ V2 router matrix
→ standard hidden-grader integrity
→ long hidden-grader integrity
→ polyglot hidden-grader integrity
→ Node tests
→ npm pack --dry-run
→ packed global-install smoke
→ plain one-command install compatibility smoke
```

Packed smoke xác minh package cài được từ tarball và kiểm tra OpenCode V2 path, skills, commands, subagents, router plugin, task graph, durable state và model config.

---

## Cập nhật và gỡ cài đặt

Cập nhật lên bản npm mới nhất:

```cmd
ocskill update
```

Gỡ UES:

```cmd
ocskill remove
```

UES chỉ quản lý resource có namespace/marker của chính nó và cố gắng giữ nguyên resource không thuộc quyền quản lý của UES.

---

## Tài liệu

- [Thiết kế hệ thống](docs/ENGINEERING-DESIGN.md)
- [Tương thích OpenCode](docs/OPENCODE-COMPAT.md)
- [Công cụ deterministic](docs/DETERMINISTIC-TOOLS.md)
- [Evaluation](docs/EVALS.md)
- [Trace schema](docs/TRACE-SCHEMA.md)
- [Hướng dẫn publish npm](docs/NPM-PUBLISH.md)
- [Nguồn nghiên cứu](docs/RESEARCH-SOURCES.md)
- [V7 Intelligence Runtime](docs/V7-INTELLIGENCE-RUNTIME.md)
- [V8 Intelligence & Reliability](docs/V8-INTELLIGENCE-RELIABILITY.md)
- [V9 Speed & Intelligence](docs/V9-SPEED-INTELLIGENCE.md)

---

## npm

Package:

```text
opencode-agent-skill
```

Cài đặt:

```cmd
npm install -g opencode-agent-skill
```

Phiên bản hiện tại:

```text
9.0.0
```

---

## License

MIT
