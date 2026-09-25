# UES for Pi Agent

> Universal Engineering System (UES) là một engineering runtime dành cho **Pi Agent**, tập trung vào việc giúp model coding nhỏ/yếu làm việc có cấu trúc hơn trên repository thật: lấy đúng context, chia task, giữ trạng thái dài hạn, cô lập thay đổi, thu evidence và chỉ kết luận khi có verification.

**Package:** <code>opencode-agent-skill</code>  
**Host chính:** Pi Agent  
**Phiên bản package hiện tại:** <code>14.2.0-beta.1</code>  
**Nhánh phát triển hiện tại:** V14.2 Turbo Weak-Model Runtime  
**Runtime:** Node.js 22.19+  
**License:** MIT

> UES không biến một model nhỏ thành model lớn theo nghĩa năng lực nền tảng. UES cố gắng giảm phần suy luận hạ tầng mà model phải tự gánh bằng deterministic tooling, bounded context, specialist roles, durable state và evidence-gated verification.

---

## Mục lục

1. [UES giải quyết vấn đề gì?](#ues-giải-quyết-vấn-đề-gì)
2. [Kiến trúc tổng thể](#kiến-trúc-tổng-thể)
3. [Luồng /ues-run end-to-end](#luồng-ues-run-end-to-end)
4. [Task Policy: FAST / STANDARD / DEEP](#task-policy-fast--standard--deep)
5. [12 specialist agents](#12-specialist-agents)
6. [48 skills](#48-skills)
7. [11 slash prompts](#11-slash-prompts)
8. [Context Engine L0/L1/L2](#context-engine-l0l1l2)
9. [Semantic index, repo graph và ACI](#semantic-index-repo-graph-và-aci)
10. [Model routing và recovery](#model-routing-và-recovery)
11. [Task graph, Dynamic Workflow và parallel runtime](#task-graph-dynamic-workflow-và-parallel-runtime)
12. [Worktree sandbox](#worktree-sandbox)
13. [Evidence Store, receipts và verification gates](#evidence-store-receipts-và-verification-gates)
14. [V14.1 reversible output compaction](#v141-reversible-output-compaction)
15. [V14.2 Turbo Weak-Model Runtime](#v142-turbo-weak-model-runtime)
16. [Verified Persistent Memory](#verified-persistent-memory)
16. [Capability Fabric](#capability-fabric)
17. [Playwright / Browser MCP on-demand](#playwright--browser-mcp-on-demand)
18. [Trajectory và observability](#trajectory-và-observability)
19. [Learning engine và benchmark confidence](#learning-engine-và-benchmark-confidence)
20. [Durable long-horizon work](#durable-long-horizon-work)
21. [Control Center](#control-center)
22. [Safety model](#safety-model)
23. [Cài đặt](#cài-đặt)
24. [Cập nhật](#cập-nhật)
25. [Đóng gói npm](#đóng-gói-npm)
26. [Các CLI quan trọng](#các-cli-quan-trọng)
27. [Benchmark model yếu](#benchmark-model-yếu)
28. [Cấu trúc repository](#cấu-trúc-repository)
29. [Triết lý thiết kế](#triết-lý-thiết-kế)
30. [Giới hạn có chủ đích](#giới-hạn-có-chủ-đích)

---

# UES giải quyết vấn đề gì?

Một coding model yếu thường gặp các vấn đề sau khi làm việc trên repository thật:

| Vấn đề | Nếu để model tự xử lý | UES xử lý thế nào |
|---|---|---|
| Repository lớn | đọc quá nhiều file, mất context | semantic index + hierarchy L0/L1/L2 + bounded context |
| Task dài | quên mục tiêu, lặp lại việc | durable work state + PLAN/STATE/EVENTS |
| Nhiều thay đổi song song | đụng file, ghi đè nhau | task graph + safe waves + worktree sandbox |
| Không biết test gì | chạy full CI hoặc đoán | detect-tests + verification plan + declared verification commands |
| Model báo xong quá sớm | false PASS | verifier + integration-verifier + receipts |
| Retry mù | vá chồng vá | diagnosis-first recovery policy |
| Log quá lớn | token phình | reversible model-visible compaction |
| Tool quá nhiều | model chọn sai tool | role allowlist + capability-based routing |
| UI/browser | đoán thay vì quan sát | Playwright/Browser MCP lane + visual verifier |
| Kinh nghiệm cũ | nhớ sai hoặc nhiễm | verified persistent memory |
| Tối ưu không có bằng chứng | nhanh hơn nhưng yếu đi | baseline-vs-UES eval + promotion confidence |

---

# Kiến trúc tổng thể

~~~mermaid
flowchart TD
    U[User task] --> P[Pi Agent]
    P --> X[UES extension]

    X --> TP[Task Policy]
    TP --> C[Context Engine]
    TP --> M[Model Policy]
    TP --> W[Workflow Policy]

    C --> H[Hierarchy L0 L1 L2]
    C --> SI[Semantic Index]
    C --> MEM[Verified Memory]
    C --> CAP[Capability Fabric]
    C --> EV[Evidence Store]

    W --> A[Specialist Agents]
    W --> TG[Task Graph]
    W --> DW[Dynamic Workflow]
    W --> SB[Worktree Sandbox]

    A --> EX[Executor]
    A --> VE[Verifier]
    A --> IV[Integration Verifier]
    A --> VV[Visual Verifier]

    EX --> CHECK[Project-native checks]
    VE --> CHECK
    IV --> CHECK
    VV --> BROWSER[Playwright Browser evidence]

    CHECK --> R[Fresh Evidence]
    BROWSER --> R
    R --> G{Verification gates}
    G -->|PASS| DONE[Verified completion]
    G -->|FAIL| REC[Diagnosis and bounded retry]
    REC --> C
~~~

## Các lớp chính

### 1. Pi host layer

Pi chịu trách nhiệm session, model provider, thinking level, built-in tools và extension runtime.

### 2. UES Pi extension

File chính: <code>pi/extensions/ues.ts</code>.

Extension đăng ký ba tool orchestration:

| Tool | Vai trò |
|---|---|
| <code>ues_execute</code> | Chạy task engineering end-to-end |
| <code>ues_cli</code> | Gọi deterministic UES CLI không qua shell interpolation |
| <code>ues_dispatch</code> | Gọi specialist child agents theo single / chain / bounded parallel |

### 3. Deterministic engine

Thư mục <code>lib/</code> chứa các engine cho:

- task/risk classification;
- semantic index;
- repo graph;
- context manifest;
- evidence storage;
- receipts;
- work state;
- task graph;
- safe-wave scheduling;
- model routing;
- memory;
- capability selection;
- browser evidence;
- benchmark/learning;
- safety;
- Windows compatibility.

### 4. Specialist layer

UES không dùng một prompt khổng lồ cho mọi việc. Nó có 12 specialist roles với tool boundary khác nhau.

### 5. Verification layer

Hoàn thành không đồng nghĩa model nói “done”. UES cố gắng ràng buộc completion với fresh evidence, receipt và verifier độc lập.

---

# Luồng /ues-run end-to-end

<code>/ues-run</code> là entry point khuyến nghị cho engineering task.

~~~mermaid
sequenceDiagram
    participant U as User
    participant P as Pi
    participant UES as UES Controller
    participant CTX as Context Engine
    participant EX as Executor
    participant V as Verifier
    participant IV as Integration Verifier
    participant VV as Visual Verifier

    U->>P: /ues-run task
    P->>UES: ues_execute(task)
    UES->>UES: classify task/risk/profile
    UES->>CTX: build bounded context
    CTX-->>UES: hierarchy + evidence + memory + capability hints

    alt long/high risk
        UES->>UES: architect + structured plan
        UES->>UES: plan-checker gate
    end

    UES->>EX: fresh specialist execution
    EX-->>UES: implementation handoff

    UES->>V: independent verification
    V-->>UES: PASS / FAIL / PARTIAL

    alt integration required
        UES->>IV: cross-task/final repository verification
        IV-->>UES: PASS / FAIL / PARTIAL
    end

    alt visual/browser evidence required
        UES->>VV: rendered-state verification
        VV-->>UES: PASS / FAIL / PARTIAL
    end

    alt all required gates PASS
        UES-->>P: verified completion
        P-->>U: final result
    else failure
        UES->>UES: diagnosis / recovery / bounded retry
    end
~~~

## UES không làm gì ở luồng này?

- không tự push;
- không tự publish npm;
- không tự deploy production;
- không coi executor report là bằng chứng hoàn thành;
- không bỏ verifier chỉ vì compile pass;
- không lưu hidden chain-of-thought.

---

# Task Policy: FAST / STANDARD / DEEP

Task Policy nằm trong <code>lib/task-policy.mjs</code> và phân loại task theo tín hiệu có thể quan sát.

~~~mermaid
flowchart LR
    T[Task text + repo facts] --> S[Risk and complexity signals]

    S --> F{Classification}
    F -->|low + bounded| FAST[FAST]
    F -->|medium| STD[STANDARD]
    F -->|long horizon or high risk| DEEP[DEEP]

    FAST --> F1[8k context budget]
    FAST --> F2[max 2 skills]
    FAST --> F3[targeted verification]

    STD --> S1[20k context budget]
    STD --> S2[max 4 skills]
    STD --> S3[targeted + affected verification]

    DEEP --> D1[48k context budget]
    DEEP --> D2[max 5 skills]
    DEEP --> D3[plan + integration + durable state]
~~~

## FAST

Dành cho task nhỏ, low-risk, bounded.

Đặc điểm:

- context budget mặc định khoảng 8k;
- tối đa 2 skills;
- direct skill loading;
- không bắt durable work;
- verification targeted;
- không bật full CI mặc định.

## STANDARD

Dành cho task vừa, có debugging/change scope đáng kể.

Đặc điểm:

- context budget khoảng 20k;
- tối đa 4 skills;
- selective skill loading;
- affected verification;
- worktree khi có conflict.

## DEEP

Dành cho long-horizon/high-risk.

Đặc điểm:

- context budget đến khoảng 48k;
- tối đa 5 skills;
- structured plan;
- durable state;
- plan checker;
- worktree cho writers;
- integration verification;
- full CI policy;
- critic ở high-risk/final paths.

## High-risk signals

UES phân biệt “chỉ nhắc tới database/security” với “thực sự thay đổi database/security”.

Những thay đổi như sau có thể nâng risk:

- auth/permission/security mutation;
- payment flow;
- database/schema migration;
- production deploy;
- secret/credential rotation;
- breaking public API;
- destructive Git/database action.

---

# 12 specialist agents

Thư mục: <code>global-config/agents/</code>.

| Agent | Nhiệm vụ | Có ghi file? | Khi dùng |
|---|---|---:|---|
| architect | thiết kế plan/contract/dependency | không | task phức tạp, long-horizon |
| codebase-mapper | đọc repo và map scope | không | repo lớn/không rõ vị trí |
| critic | phản biện plan/solution | không | high-risk hoặc recovery sâu |
| debugger | tìm nguyên nhân gốc từ evidence | không | bug/failure/retry |
| executor | thực thi thay đổi nhỏ nhất hợp lý | có | implementation |
| integration-verifier | kiểm tra final cross-task state | không | standard/deep/high-risk |
| merge-arbiter | xử lý integration/merge boundary | có | conflict/merge workflow |
| plan-checker | kiểm tra plan có grounded không | không | trước long/high-risk execution |
| researcher | nghiên cứu bằng chứng | không | uncertainty/external facts |
| reviewer | review thay đổi | không | code review/audit |
| verifier | fresh independent verification | không | completion gate |
| visual-verifier | verify rendered UI/browser state | không | visual/browser task |

## Quan hệ giữa các agent

~~~mermaid
flowchart TD
    MAP[codebase-mapper] --> ARCH[architect]
    ARCH --> PC[plan-checker]
    PC --> EX[executor]

    EX --> V[verifier]
    V -->|PASS| IV[integration-verifier]
    V -->|FAIL| D[debugger]

    D --> EX
    D --> C[critic]
    C --> ARCH

    IV -->|visual task| VV[visual-verifier]
    IV -->|non visual| DONE[complete]
    VV --> DONE

    R[researcher] -. evidence .-> ARCH
    R -. evidence .-> D
    REV[reviewer] -. review .-> V
~~~

---

# 48 skills

UES hiện có 48 skill directories trong <code>global-config/skills/</code>. Skills không phải 48 agent độc lập; chúng là bounded domain instructions để UES chỉ nạp đúng chuyên môn cần thiết.

## Nhóm orchestration và reasoning

- engineering-orchestrator
- dynamic-workflow
- task-planner
- software-architect
- context-engineering
- change-impact-analysis
- repo-explorer
- research-verification
- long-task-state
- implementation-engineer
- bug-diagnosis
- code-review
- skill-authoring
- skill-evaluation

## Nhóm verification và testing

- test-driven-development
- test-verification
- accessibility
- responsive-verification
- component-visual-testing
- visual-fidelity
- browser-qa
- browser-security
- web-security-review
- performance-engineering

## Nhóm backend / API / data

- api-contract
- rest-api-design
- auth-security
- database-engineering
- payment-engineering
- ecommerce-engineering
- file-upload-engineering
- dependency-management
- devops-engineering
- documentation-engineering
- git-safety

## Nhóm framework / language

- nodejs-engineering
- nextjs-engineering
- react-engineering
- react-native-engineering
- nestjs-engineering
- fastapi-engineering
- django-engineering
- python-engineering
- java-spring-engineering
- dotnet-engineering
- flutter-engineering

## Nhóm UI/design

- ui-ux-engineering
- design-source

> Mục tiêu của skill routing là progressive disclosure: model không phải đọc tất cả 48 skills cho một task.

---

# 11 slash prompts

Pi package cung cấp 11 slash prompts:

| Command | Ý nghĩa |
|---|---|
| <code>/ues-run</code> | controller end-to-end |
| <code>/ues-plan</code> | lập kế hoạch |
| <code>/ues-feature</code> | triển khai feature |
| <code>/ues-fix</code> | sửa bug |
| <code>/ues-debug</code> | điều tra failure |
| <code>/ues-review</code> | review code/scope |
| <code>/ues-verify</code> | xác minh claim |
| <code>/ues-audit</code> | audit scope |
| <code>/ues-research</code> | research |
| <code>/ues-critique</code> | phản biện proposal |
| <code>/ues-resume</code> | tiếp tục durable work |

~~~mermaid
flowchart LR
    CMD[Slash command] --> ROUTE[UES router/controller]
    ROUTE --> POLICY[Task policy]
    POLICY --> AGENT[Relevant specialist path]
    AGENT --> EVIDENCE[Fresh evidence]
    EVIDENCE --> RESULT[Result]
~~~

---

# Context Engine L0/L1/L2

Một trong các mục tiêu lớn của UES là **nạp ít context hơn nhưng đúng hơn**.

~~~mermaid
flowchart TD
    Q[Task query] --> TERM[Extract bounded terms]
    TERM --> IDX[Semantic index]
    IDX --> H0[L0 routing abstract]
    H0 --> H1[L1 subtree overview]
    H1 --> H2[L2 exact excerpts on demand]

    GIT[Git changed files] --> RANK[Ranking]
    DECL[Declared files] --> RANK
    TEST[Likely tests] --> RANK
    SYM[Symbol hits] --> RANK
    MEM[Verified memory] --> RANK

    H2 --> RANK
    RANK --> PACK[Bounded context pack]
    PACK --> CHILD[Fresh child agent]
~~~

## L0

Routing abstract rất ngắn:

- khu vực nào có vẻ liên quan;
- key symbols;
- child areas.

## L1

Scope overview:

- file count;
- extension mix;
- symbols;
- bounded file names;
- subtree relation.

## L2

Exact excerpts chỉ load khi cần.

## Context pack có thể bao gồm

- declared files;
- import neighbors;
- likely tests;
- nearby instructions;
- Git-changed files;
- semantic references;
- symbol hits;
- evidence refs;
- verified memories;
- provider hints;
- recent failure.

---

# Semantic index, repo graph và ACI

UES có ba lớp khác nhau; chúng không phải một thứ.

## Semantic Index

<code>lib/semantic-index.mjs</code>

Dùng để tạo persistent incremental index phục vụ retrieval.

~~~mermaid
flowchart LR
    SRC[Source files] --> PARSE[Bounded parse]
    PARSE --> SYMBOLS[Symbols]
    PARSE --> TERMS[Terms]
    SYMBOLS --> INDEX[Persistent semantic index]
    TERMS --> INDEX
    INDEX --> QUERY[Task query]
    QUERY --> RANK[Ranked references]
~~~

CLI:

~~~text
ues index status .
ues index build .
ues index rebuild .
~~~

## Repo Graph

<code>lib/repo-graph.mjs</code>

Tạo bounded import/dependency graph:

- local edges;
- external imports;
- coupling hotspots.

Nó **không tự nhận là full language-server call graph**.

~~~mermaid
flowchart LR
    FILES[Source files] --> IMPORTS[Import extraction]
    IMPORTS --> LOCAL[Local dependency edges]
    IMPORTS --> EXT[External import frequency]
    LOCAL --> HOT[Coupling hotspots]
    EXT --> HOT
~~~

CLI:

~~~text
ues repo-graph .
ues repo-graph . --compact
~~~

## ACI

<code>lib/aci.mjs</code>

Evidence-first code interface cho:

- search;
- references;
- view;
- bounded text search.

CLI:

~~~text
ues aci search ...
ues aci refs ...
ues aci view ...
ues aci text ...
~~~

---

# Model routing và recovery

UES không hard-code tên model “mạnh nhất”. Model IDs do người dùng cấu hình.

## Tier

- light
- standard
- heavy

Role có default tier, và attempt có thể escalate trong giới hạn cấu hình.

~~~mermaid
flowchart TD
    TASK[Task] --> CLASS[Task class + risk]
    CLASS --> BASE[Base tier]
    BASE --> CAPS[Required capabilities]
    CAPS --> PERF[Historical model performance]
    PERF --> SELECT[Select configured model]

    SELECT --> RUN[Attempt]
    RUN -->|PASS| DONE[Done]
    RUN -->|FAIL attempt 1| DIAG[Diagnosis]
    DIAG --> RETRY[Attempt 2]
    RETRY -->|FAIL| DEEP[Deep recovery + critic]
    DEEP --> STRONGER[Eligible stronger tier]
~~~

## Recovery policy

### Attempt 1

- normal bounded context;
- smallest coherent implementation.

### Attempt 2

- dedicated diagnosis;
- mở rộng context vừa phải;
- caller/test/failure-adjacent evidence;
- không vá speculative chồng lên patch cũ.

### Attempt 3

- deep recovery;
- semantic + graph + Git context;
- critic;
- re-investigate failed hypothesis;
- architecture/coupling review khi cần.

---

# Task graph, Dynamic Workflow và parallel runtime

Structured plan dùng JSON schema version 1.

Mỗi task có thể khai báo:

- id;
- title;
- summary;
- dependsOn;
- files create/modify/test/delete/read;
- acceptance;
- verification;
- optional verificationCommands;
- risk.

## Dependency validation

UES kiểm tra:

- duplicate IDs;
- missing dependency;
- self dependency;
- cycles;
- path escape;
- acceptance/verification thiếu;
- invalid risk.

## Safe waves

~~~mermaid
flowchart TD
    PLAN[PLAN tasks] --> DAG[Dependency DAG]
    DAG --> READY[Ready tasks]
    READY --> FILES[Read/write file scope]
    FILES --> CONFLICT{Conflict?}

    CONFLICT -->|No| SAME[Same safe wave]
    CONFLICT -->|Yes| SERIAL[Serialize]

    SAME --> PAR[Bounded parallel execution]
    SERIAL --> NEXT[Later wave]
~~~

Read/read overlap có thể chạy cùng wave. Writer xung đột với reader/writer sẽ bị serialize nếu scope overlap hoặc không đủ rõ.

## Dynamic Workflow

<code>lib/dynamic-workflow.mjs</code> phân task thành:

- deterministic;
- inline;
- agent;
- vision-related work.

~~~mermaid
flowchart LR
    T[Task] --> K{Kind}
    K -->|test lint typecheck compile| DET[Deterministic]
    K -->|small bounded reasoning| INLINE[Inline]
    K -->|independent substantial work| AG[Agent]
    K -->|visual judgment| VISION[Vision agent]

    DET --> SAVE[No unnecessary executor slot]
    INLINE --> SAVE
    AG --> SLOT[LLM slot]
    VISION --> VSLOT[Vision slot]
~~~

V14.1 có fast path: deterministic read-only task có thể bỏ executor nhưng **verifier vẫn phải PASS**.

---

# Worktree sandbox

Parallel writers không được cùng sửa một checkout.

~~~mermaid
sequenceDiagram
    participant R as Root repo
    participant U as UES Scheduler
    participant W1 as Worktree T1
    participant W2 as Worktree T2

    U->>R: inspect dirty state
    U->>W1: create isolated worktree
    U->>W2: create isolated worktree

    W1->>W1: execute + verify T1
    W2->>W2: execute + verify T2

    U->>W1: inspect changed files
    U->>W2: inspect changed files
    U->>R: conflict check

    alt safe integration
        U->>R: apply T1 patch
        U->>R: apply T2 patch
    else conflict/failure
        U->>R: refuse or rollback integrated wave
    end
~~~

## Safety của worktree

- root dirty mặc định bị chặn nếu không dùng explicit inheritance;
- dirty root có thể được snapshot vào sandbox theo policy;
- integration kiểm tra overlap với thay đổi root;
- branch cleanup chỉ xóa branch namespace UES;
- rollback dùng reverse patch;
- không force-push.

---

# Evidence Store, receipts và verification gates

## Evidence Store

UES có content-addressed Evidence Store.

~~~mermaid
flowchart LR
    RAW[Raw output / artifact] --> HASH[SHA-256]
    HASH --> STORE[Evidence Store]
    STORE --> REF[evidence:sha256:...]
    REF --> RECEIPT[Verification / memory / gate receipt]
    REF --> GET[Bounded retrieval]
~~~

CLI:

~~~text
ues store status .
ues store put ...
ues store get evidence:sha256:<hash>
ues store gc .
~~~

## Verification receipts

Receipt có thể bind:

- command result;
- output digest;
- before/after workspace fingerprint;
- verifier;
- verdict;
- active run/task.

Mục tiêu là tránh tình trạng:

~~~text
test từng PASS ở trạng thái A
→ code thay đổi sang trạng thái B
→ model vẫn dùng PASS cũ để tuyên bố hoàn thành
~~~

## Gate model

~~~mermaid
flowchart TD
    PLAN[Plan] --> PG[Plan checker]
    PG --> PR[Plan receipt]
    PR --> EXEC[Execution]

    EXEC --> TV[Task verifier]
    TV --> TR[Task verification receipt]

    TR --> INT[Integration verifier]
    INT --> IR[Integration receipt]

    IR --> FP{Workspace fingerprint unchanged?}
    FP -->|Yes| FINAL[Finalize]
    FP -->|No| INVALID[Receipt stale - reverify]
~~~

---

# V14.1 reversible output compaction

Mục tiêu của V14.1 là giảm model-visible noise mà **không bỏ raw evidence**.

~~~mermaid
flowchart TD
    OUT[Large CLI/tool output] --> SIZE{Over limit?}
    SIZE -->|No| RAW[Return unchanged]
    SIZE -->|Yes| SAVE[Store exact raw bytes in Evidence Store]
    SAVE --> PREVIEW[Build head + high-signal + tail preview]
    PREVIEW --> MODEL[Send bounded preview to model]
    MODEL --> NEED{Need more?}
    NEED -->|Yes| REF[Retrieve exact slices by evidence ref]
    NEED -->|No| CONT[Continue]
~~~

Default model-visible limit hiện khoảng 64 KiB.

High-signal lines ưu tiên các pattern như:

- error;
- failed;
- exception;
- warning;
- timeout;
- traceback;
- mismatch;
- conflict;
- passed;
- tests;
- exit code;
- changed.

## Quan trọng

- thinking level không bị hạ bởi compaction;
- raw output được lưu trước khi compact;
- small output giữ nguyên;
- failure của compaction fail-open về raw output.

---

# V14.2 Turbo Weak-Model Runtime

V14.2 tối ưu hot path cho model yếu/siêu yếu mà không hạ thinking hoặc bỏ verification gate.

~~~mermaid
flowchart TD
    T[Task] --> P[Task Policy]
    P --> C[Adaptive context]
    C --> G[Semantic + dependency graph rank]
    G --> S[Bounded micro-skills]
    S --> W[Warm Pi RPC worker]

    W --> E[Executor]
    E --> R[Tool-boundary verification receipts]
    R --> V[Verifier]

    V -->|fresh receipt fully covers check| REUSE[Reuse exact PASS receipt]
    V -->|missing/stale/high-risk| RUN[Run fresh check]

    REUSE --> IV[Integration verification when required]
    RUN --> IV

    E --> O[Large tool output]
    O --> COMP[Command-aware compaction]
    COMP --> RAW[Raw bytes in Evidence Store]
    RAW --> REC[Selective recovery on demand]
~~~

Các thay đổi chính:

- warm Pi RPC worker pool với fresh session giữa specialist runs;
- interactive steering/abort khi một child đang active;
- unified process-tree supervisor + bounded I/O drain;
- rolling Jest/open-handle detection;
- adaptive role-aware context budgets;
- runtime context + dependency-graph cache theo workspace fingerprint;
- bounded micro-skill compiler thay vì load toàn bộ skill catalog;
- affected-test hints;
- verification receipt reuse chỉ khi fingerprint còn nguyên;
- high-risk verifier không dùng receipt reuse optimization;
- child test/lint/typecheck/build có timeout theo profile;
- full shell output được recover từ Pi `fullOutputPath` khi có;
- command-aware reversible compaction ngay ở child tool-result boundary;
- JSON evidence selector để lấy đúng subtree;
- personalized dependency graph ranking;
- task-specific Browser MCP subset;
- confidence-bound weak-model routing;
- DEEP task auto-promote sang `.ues-work` durable workflow;
- paired benchmark có turbo promotion gate: **quality non-regression + efficiency gain + zero controller false-PASS**.

Các optimization quan trọng có thể rollback riêng:

~~~text
UES_CHILD_RUNTIME=cli
UES_ADAPTIVE_CONTEXT=0
UES_MICRO_SKILLS=0
UES_AFFECTED_TEST_HINTS=0
UES_CHILD_TOOL_COMPACTION=0
~~~

Chi tiết: `docs/V14.2-TURBO-WEAK-MODEL-RUNTIME.md`.

---

# Verified Persistent Memory

Memory của UES không phải “chat memory tự do”. Retrieval chỉ dùng memory đủ điều kiện.

~~~mermaid
flowchart TD
    EXPERIENCE[Task outcome] --> CAND[Memory candidate]
    CAND --> EVID{Has durable evidence?}
    EVID -->|No| DROP[Not retrievable]
    EVID -->|Yes| VER{Verifier PASS?}
    VER -->|No| DROP
    VER -->|Yes| VM[Verified memory]

    VM --> RANK[Hybrid retrieval]
    RANK --> LEX[Lexical relevance]
    RANK --> VEC[Deterministic vector similarity]
    RANK --> FILE[File affinity]
    RANK --> REC[Recency/confidence]
    RANK --> TASK[Task-class affinity]

    LEX --> TOP[Bounded top memories]
    VEC --> TOP
    FILE --> TOP
    REC --> TOP
    TASK --> TOP
~~~

Memory hỗ trợ:

- candidate / verified / superseded lifecycle;
- confidence;
- expiry;
- task-class affinity;
- usage accounting;
- evidence references;
- supersession.

CLI:

~~~text
ues memory status .
ues memory retrieve ...
ues memory propose ...
ues memory verify ...
ues memory supersede ...
~~~

---

# Capability Fabric

Capability Fabric giúp model không phải tự đoán backend/tool nào đang khỏe.

## Built-in capability groups

Source hiện có các nhóm như:

- code.search;
- memory;
- evidence;
- output.compaction;
- filesystem;
- git;
- agent.host;
- github;
- browser.

~~~mermaid
flowchart TD
    NEED[Required capability] --> REG[Provider registry]
    REG --> PROBE[Health probe]
    PROBE --> SCORE[Score]

    OBS[Persisted success/failure/latency] --> SCORE
    QUALITY[Quality] --> SCORE
    COST[Cost class] --> SCORE
    LAT[Latency class] --> SCORE

    SCORE --> PRIMARY[Selected provider]
    SCORE --> FALLBACK[Fallback providers]
~~~

Provider score xét:

- configured priority;
- quality;
- current health;
- historical success/failure;
- cost class;
- latency class.

## Output compaction providers

V14.1 có registry cho:

- built-in <code>ues-reversible-compactor</code> — mặc định;
- RTK CLI — optional;
- Caveman CLI — optional experimental;
- Headroom CLI — optional experimental.

Detection **không có nghĩa auto-enable** external provider.

---

# Playwright / Browser MCP on-demand

UES có browser adapter/runtime riêng và thêm routing cho Playwright/Browser MCP đang có trong Pi host.

Mục tiêu: browser tools chỉ xuất hiện khi task thực sự cần browser/visual evidence.

~~~mermaid
flowchart TD
    TASK[Task] --> NEED{Needs browser or visual evidence?}

    NEED -->|No| NORMAL[Normal agent tool allowlist]
    NEED -->|Yes| DISCOVER[Inspect host Pi tool registry]

    DISCOVER --> SELECT[Select Playwright/browser tools]
    SELECT --> CHILD[Add selected names to child --tools]

    CHILD --> SNAP[Semantic/accessibility snapshot]
    CHILD --> INT[Targeted interaction]
    CHILD --> LOG[Console/network evidence]
    CHILD --> SHOT[Screenshot when visual proof needed]

    SNAP --> VV[Visual verifier]
    INT --> VV
    LOG --> VV
    SHOT --> VV

    VV -->|PASS| DONE[Visual claim verified]
    VV -->|FAIL / no evidence| STOP[No browser-visible PASS claim]
~~~

## Routing behavior

### Backend task

Ví dụ:

~~~text
/ues-run sửa transaction inventory backend và chạy test
~~~

Playwright không cần được thêm vào child agent.

### Browser E2E task

Ví dụ:

~~~text
/ues-run kiểm tra checkout form bằng browser, click flow và console error
~~~

Browser MCP lane được yêu cầu.

### Visual task

Ví dụ:

~~~text
/ues-run sửa giao diện theo ảnh mẫu và kiểm tra responsive
~~~

Sau code verifier/integration verifier, UES có thể chạy thêm <code>ues-visual-verifier</code>.

## Evidence order

UES ưu tiên:

1. semantic/accessibility snapshot;
2. DOM/target state;
3. targeted interaction;
4. console/network evidence;
5. viewport checks;
6. screenshot khi cần visual proof.

## Browser security

Webpage text, accessibility content, console output và network payload được coi là **untrusted external evidence**.

Page content không được:

- thay đổi permissions;
- yêu cầu secret;
- override system/task instructions;
- tự cấp quyền external/destructive side effect.

## Optional overrides

Nếu Browser MCP dùng tên tool lạ:

~~~cmd
set UES_BROWSER_MCP_TOOL_NAMES=browser_navigate,browser_snapshot,browser_screenshot,browser_click
set UES_BROWSER_MCP_TOOL_LIMIT=14
~~~

---

# Trajectory và observability

<code>lib/trajectory.mjs</code> lưu **operational events**, không lưu hidden chain-of-thought.

~~~mermaid
flowchart LR
    RUN[Agent run] --> EVT[Observable event]
    EVT --> SCRUB[Secret redaction]
    SCRUB --> LIMIT[Bound event size]
    LIMIT --> JSONL[.ues-traces trace.jsonl]

    JSONL --> SHOW[trace show]
    JSONL --> DEBUG[Debug/replay analysis]
~~~

Trajectory scrub các dạng dữ liệu như:

- Authorization Bearer;
- OpenAI-style API keys;
- GitHub tokens;
- npm tokens;
- generic api_key/token/secret/password/credential fields.

Large event payload được bounded và có SHA-256 digest.

CLI:

~~~text
ues trace append ...
ues trace show ...
~~~

---

# Learning engine và benchmark confidence

Learning của UES được thiết kế theo hướng **proposal → shadow evidence → promotion**, không phải “agent fail một lần rồi tự sửa rule vĩnh viễn”.

~~~mermaid
flowchart TD
    EVAL[Eval artifacts] --> ANALYZE[Analyze recurring failures]
    ANALYZE --> PROP[Learning proposal]
    PROP --> ACCEPT[Manual acceptance]
    ACCEPT --> SHADOW[Shadow benchmark required]

    SHADOW --> PAIR[Paired baseline vs UES]
    PAIR --> CONF[Statistical confidence checks]

    CONF -->|Eligible| PROMOTE[Promote learning]
    CONF -->|Not eligible| HOLD[Keep unpromoted]
~~~

## Failure patterns được phân tích

Ví dụ:

- hard-timeout;
- idle-timeout;
- agent-exit;
- grader-failure;
- orchestration-failure;
- telemetry parse errors.

## Promotion confidence

<code>lib/benchmark-confidence.mjs</code> so sánh paired baseline/UES:

- total paired samples;
- both pass;
- both fail;
- baseline-only win;
- UES-only win;
- pass-rate delta;
- exact sign-test p-value;
- per-suite regression;
- duration ratio;
- initial input ratio;
- token ratio;
- cost summary.

Promotion yêu cầu nhiều điều kiện cùng đạt, không chỉ “UES thắng một vài task”.

---

# Durable long-horizon work

Task dài có thể dùng <code>.ues-work/&lt;slug&gt;/</code> làm source of truth.

~~~text
.ues-work/<slug>/
  SPEC.md
  PLAN.json
  STATE.json
  EVIDENCE.json
  EVENTS.jsonl
  ACTIVE_PLAN.json
  tasks/
  reports/
  plans/
~~~

## State machine khái quát

~~~mermaid
stateDiagram-v2
    [*] --> Initialized
    Initialized --> Planned
    Planned --> PlanApproved
    PlanApproved --> Running
    Running --> Running: next task
    Running --> Blocked
    Blocked --> Running
    Running --> IntegrationVerification
    IntegrationVerification --> Finalized: PASS + fresh fingerprint
    IntegrationVerification --> Running: FAIL / rework
    Running --> Recovering: stale lease / interruption
    Recovering --> Running
~~~

## Locking

State/evidence mutation dùng:

- per-work lock;
- heartbeat;
- stale lock recovery;
- atomic file replacement.

## Runtime events

<code>EVENTS.jsonl</code> append-only cho operational observability.

---

# Control Center

UES có local Control Center qua:

~~~text
ues dashboard .
ues dashboard . --serve
~~~

Control Center tổng hợp các loại dữ liệu như:

- durable work;
- task state;
- blockers;
- receipts;
- recent events;
- eval summaries;
- learning state;
- evidence store;
- verified memory;
- capability fabric health.

~~~mermaid
flowchart LR
    WORK[.ues-work] --> CC[Control Center]
    EVENTS[EVENTS.jsonl] --> CC
    EV[Evidence Store] --> CC
    MEM[Memory] --> CC
    CAP[Capability Fabric] --> CC
    LEARN[Learning] --> CC
    EVAL[Eval artifacts] --> CC
~~~

Control Center là observer/controller cục bộ; nó không bypass verification/safety gates.

---

# Safety model

UES cố gắng đưa safety vào code thay vì chỉ nhắc model.

## Shell safety

Có detection/gate cho các thao tác rủi ro như:

- force push;
- history rewrite;
- reset hard;
- recursive destructive deletion;
- destructive database commands;
- deploy/apply;
- publish.

## Scope safety

Structured task phải khai báo file scope. Scheduler kiểm tra actual changed files so với declared write scope.

## Parallel safety

Writer agents chạy parallel phải ở distinct worktree/cwd.

## Evidence safety

Old PASS không tự được coi là hợp lệ nếu workspace đã thay đổi.

## Browser safety

External page content là untrusted.

## Memory safety

Candidate hoặc superseded memory không được retrieval như verified memory.

## Learning safety

Proposal không tự promote nếu chưa có benchmark evidence phù hợp.

---

# Cài đặt

## Yêu cầu

- Node.js 22.19+
- Git
- Pi Agent

Cài Pi:

~~~cmd
npm install -g @earendil-works/pi-coding-agent
pi --version
~~~

Cài UES trực tiếp từ GitHub:

~~~cmd
pi install git:github.com/laivannha0202/opencode-agent-skill-
pi list
pi
~~~

Nếu đã clone repo local:

~~~cmd
cd /d E:\Code\opencode-agent-skill-
npm install
pi install .
~~~

---

# Cập nhật

Nếu cài từ clone local:

~~~cmd
cd /d E:\Code\opencode-agent-skill-
git status
git pull --ff-only origin main
pi install .
~~~

Nếu local có thay đổi chưa commit, hãy backup/stash hoặc xử lý diff trước khi pull. Không nên reset/clean mù quáng.

---

# Đóng gói npm

Kiểm tra đầy đủ trước khi pack:

~~~cmd
npm install
npm run ci
npm pack --dry-run
npm pack
~~~

Package version hiện tại trong <code>package.json</code> là:

~~~text
14.2.0-beta.1
~~~

V14.1 hiện là incremental work trên package version đó.

Test file packed với Pi:

~~~cmd
pi install .\opencode-agent-skill-14.2.0-beta.1.tgz
pi list
~~~

Publish thật chỉ nên thực hiện sau khi CI và package smoke tests PASS.

---

# Các CLI quan trọng

CLI ưu tiên là <code>ues</code>; <code>ocskill</code> vẫn là compatibility alias.

## Repository intelligence

~~~text
ues inspect .
ues impact <query> .
ues evidence .
ues working-tree .
ues repo-graph .
ues index status .
ues index build .
ues aci search ...
~~~

## Task và verification

~~~text
ues task-policy "<task>"
ues verification-plan .
ues task-graph PLAN.json
ues workflow-plan PLAN.json
ues review-scope main .
~~~

## Durable work

~~~text
ues work init <slug> . --goal "..."
ues work plan <slug> PLAN.json .
ues work approve-plan <slug> . --evidence "..."
ues work start <slug> <task-id> .
ues work verify-command <slug> <task-id> . --run-id <id> -- npm test
ues work complete <slug> <task-id> . --run-id <id> --evidence "..."
ues work verify-integration <slug> . --verdict PASS --evidence "..."
ues work finalize <slug> . --evidence "..."
ues work events <slug> .
ues work resume <slug> .
~~~

## Sandbox

~~~text
ues sandbox list .
ues sandbox create ...
ues sandbox integrate ...
ues sandbox rollback ...
ues sandbox remove ...
~~~

## Context / memory / capability

~~~text
ues hierarchy "<query>" .
ues hierarchy "<query>" . --full
ues memory status .
ues capability-fabric status .
ues capabilities "<task>"
~~~

## Evidence / trace

~~~text
ues store status .
ues store get evidence:sha256:<hash>
ues trace show ...
~~~

## Browser / visual

~~~text
ues browser capability .
ues browser plan ...
ues browser inspect ...
ues visual ...
ues ui tokens ...
ues ui layout ...
~~~

## Models

~~~text
ues models status
ues models on
ues models set light <provider/model>
ues models set standard <provider/model>
ues models set heavy <provider/model>
ues models role verifier standard
~~~

## Learning / eval

~~~text
ues eval-pi --model provider/model --thinking low --suite live --trials 3 --mode both
ues learn analyze . --eval-dir .ues-evals
~~~

---

# Benchmark model yếu

UES có Pi-native baseline-vs-UES benchmark.

~~~mermaid
flowchart LR
    TASKS[Same benchmark tasks] --> B[Baseline Pi]
    TASKS --> U[Pi + UES]

    B --> BG[External grader]
    U --> UG[External grader]

    B --> BT[Tokens/cost/tool telemetry]
    U --> UT[Tokens/cost/tool telemetry]

    BG --> PAIR[Paired comparison]
    UG --> PAIR
    BT --> PAIR
    UT --> PAIR

    PAIR --> CONF[Confidence / regression checks]
~~~

Ví dụ:

~~~cmd
ues eval-pi --model provider/model --thinking low --suite live --trials 3 --mode both
~~~

Eval script thu thập:

- pass/fail;
- duration;
- parent tool calls;
- child tool calls;
- input/output/cache token telemetry;
- reported cost;
- controller usage;
- workspace changes;
- external grader result.

## Eval suites trong repo

Hiện có các nhóm như:

- live;
- long;
- polyglot;
- repo-scale;
- v11;
- v14;
- routing/router trigger suites.

---

# Cấu trúc repository

~~~text
opencode-agent-skill-/
├─ bin/
│  └─ ocskill.mjs
│
├─ lib/
│  ├─ task-policy.mjs
│  ├─ task-engine.mjs
│  ├─ task-graph.mjs
│  ├─ dynamic-workflow.mjs
│  ├─ context-engine-v11.mjs
│  ├─ hierarchical-context.mjs
│  ├─ semantic-index.mjs
│  ├─ repo-graph.mjs
│  ├─ aci.mjs
│  ├─ evidence-store.mjs
│  ├─ evidence-receipt.mjs
│  ├─ gate-receipt.mjs
│  ├─ memory-engine.mjs
│  ├─ capability-fabric.mjs
│  ├─ model-policy.mjs
│  ├─ model-performance.mjs
│  ├─ worktree-sandbox.mjs
│  ├─ container-sandbox.mjs
│  ├─ performance-fabric.mjs
│  ├─ trajectory.mjs
│  ├─ learning-engine.mjs
│  ├─ benchmark-confidence.mjs
│  ├─ browser-adapter.mjs
│  ├─ browser-runtime.mjs
│  ├─ browser-mcp-routing.mjs
│  └─ ...
│
├─ pi/
│  ├─ extensions/
│  │  └─ ues.ts
│  └─ prompts/
│     └─ 11 UES slash prompts
│
├─ global-config/
│  ├─ agents/
│  │  └─ 12 specialist agents
│  └─ skills/
│     └─ 48 domain/workflow skills
│
├─ evals/
│  ├─ live/
│  ├─ long/
│  ├─ polyglot/
│  ├─ repo-scale/
│  ├─ v11/
│  └─ v14/
│
├─ scripts/
│  └─ eval, validation, smoke, install helpers
│
├─ test/
│  └─ deterministic/runtime/regression tests
│
└─ docs/
   ├─ ENGINEERING-DESIGN.md
   ├─ DETERMINISTIC-TOOLS.md
   ├─ V11-PERCEPTION-ADAPTIVE-EXECUTION.md
   ├─ V12-WEAK-MODEL-INTELLIGENCE.md
   ├─ V13-PARALLEL-WEAK-MODEL-RUNTIME.md
   ├─ V14-CONTEXT-MEMORY-FABRIC.md
   └─ V14.1-QUALITY-PERFORMANCE-FABRIC.md
~~~

---

# Một ví dụ đầy đủ

Task:

~~~text
/ues-run sửa checkout inventory reservation, chạy test liên quan và xác minh UI checkout
~~~

Luồng có thể diễn ra:

~~~mermaid
flowchart TD
    T[User task] --> P[Task Policy STANDARD/DEEP]
    P --> C[Context selection]
    C --> R[Repo graph + semantic refs + likely tests]
    R --> E[Executor]
    E --> TEST[Targeted backend tests]
    TEST --> V[Verifier]

    V -->|PASS| I[Integration verifier]
    V -->|FAIL| D[Debugger]
    D --> E

    I --> B{Visual/browser required?}
    B -->|No| DONE[Verified completion]
    B -->|Yes| MCP[Playwright MCP lane]
    MCP --> VV[Visual verifier]
    VV -->|PASS| DONE
    VV -->|FAIL| D
~~~

Điểm khác với “một model tự làm tất cả” là:

1. context được bounded;
2. implementation và verification tách vai;
3. browser evidence chỉ nạp khi cần;
4. retry có diagnosis;
5. long task có state;
6. parallel writers có isolation;
7. completion bị ràng buộc bởi evidence.

---

# Triết lý thiết kế

## Deterministic facts trước probabilistic reasoning

Những việc có thể tính bằng code thì ưu tiên tính bằng code:

- Git state;
- dependency graph;
- changed files;
- plan cycle;
- file overlap;
- command exit status;
- workspace fingerprint;
- provider health;
- token/cost telemetry.

Model tập trung vào phần cần semantic judgment.

## Progressive disclosure

Không nạp:

- toàn repo;
- toàn bộ 48 skills;
- mọi MCP tool;
- mọi memory;
- mọi log.

Chỉ nạp bounded evidence phù hợp.

## Fresh specialists

Child specialist được tạo với prompt/tool boundary hẹp hơn để giảm contamination từ conversation dài.

## Evidence-first completion

“Agent nói đã xong” không phải completion gate.

## Reversible optimization

Tối ưu output/context phải giữ đường lấy raw evidence trở lại.

## Benchmark-gated learning

Không promote rule/tool/provider chỉ vì cảm giác “có vẻ nhanh”.

---

# Giới hạn có chủ đích

UES cố ý **không**:

- tạo hàng trăm agents;
- load mọi skill cho mọi task;
- auto push;
- auto publish;
- auto deploy;
- ghi hidden chain-of-thought;
- coi keyword routing là semantic truth tuyệt đối;
- coi import scan là full compiler/LSP semantic graph;
- coi một benchmark là bằng chứng model-equivalence;
- bỏ verifier chỉ để tăng tốc;
- dùng browser tool cho backend task không cần browser.

---

# Quick start

~~~cmd
npm install -g @earendil-works/pi-coding-agent
pi install git:github.com/laivannha0202/opencode-agent-skill-
pi
~~~

Trong Pi:

~~~text
/ues-run kiểm tra project, tìm lỗi, sửa lỗi cần thiết và chạy test xác minh
~~~

Kiểm tra deterministic runtime:

~~~cmd
ues task-policy "fix checkout bug" --json
ues capability-fabric status .
ues hierarchy "checkout inventory" .
ues memory status .
~~~

---

# Tài liệu sâu hơn

- <code>docs/ENGINEERING-DESIGN.md</code> — engineering architecture.
- <code>docs/DETERMINISTIC-TOOLS.md</code> — deterministic CLI/evidence tools.
- <code>docs/V11-PERCEPTION-ADAPTIVE-EXECUTION.md</code> — perception/adaptive execution.
- <code>docs/V12-WEAK-MODEL-INTELLIGENCE.md</code> — weak-model intelligence.
- <code>docs/V13-PARALLEL-WEAK-MODEL-RUNTIME.md</code> — parallel runtime.
- <code>docs/V14-CONTEXT-MEMORY-FABRIC.md</code> — context, memory, capability fabric.
- <code>docs/V14.1-QUALITY-PERFORMANCE-FABRIC.md</code> — quality-preserving performance.
- <code>docs/EVALS.md</code> — evaluation.
- <code>docs/PI-COMPAT.md</code> — Pi compatibility.
- <code>docs/NPM-PUBLISH.md</code> — npm publishing.

---

# License

MIT