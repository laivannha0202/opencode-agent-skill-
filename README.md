# OpenCode Universal Engineering System (UES)

**UES 4.0.0** là bộ workflow kỹ thuật, skill, subagent và công cụ kiểm chứng dành cho OpenCode.

Mục tiêu của UES không phải biến một model thành model khác. UES giúp model đang dùng làm việc theo quy trình kỹ thuật chặt chẽ hơn: hiểu repository trước khi sửa, chọn đúng skill, lập kế hoạch khi cần, tìm nguyên nhân gốc, kiểm tra phạm vi ảnh hưởng, xác minh bằng bằng chứng mới, review độc lập và chỉ kết luận khi có đủ evidence.

## UES 4.0.0 có gì?

- **39 engineering skills**
- **9 slash commands**
- **6 subagents** chuyên phân tích/kiểm chứng
- workflow chung được đồng bộ vào OpenCode qua `AGENTS.md`
- bộ công cụ CLI `ocskill` để kiểm tra repository, impact, Git state và benchmark
- **34 routing scenarios** bao phủ đủ 39 skill
- **20 live hidden-graded benchmark tasks**
- hỗ trợ **OpenCode 1.x và 2.x**
- OpenCode 2.x có thêm **UES Router plugin** để tự chọn một nhóm skill phù hợp

Luồng làm việc chính:

```text
hiểu yêu cầu
  -> thu thập bằng chứng
  -> chọn skill phù hợp
  -> lập kế hoạch nếu cần
  -> triển khai
  -> kiểm chứng
  -> review / critic khi cần
  -> sửa có giới hạn
  -> hoàn tất
```

---

## Cài đặt

Với npm hiện đại có cơ chế cho phép lifecycle script theo package:

```cmd
npm install -g @laivannha0202/opencode-agent-skill --allow-scripts=@laivannha0202/opencode-agent-skill
```

Sau đó kiểm tra:

```cmd
ocskill status
ocskill doctor
```

Nếu npm không chạy `postinstall`, đồng bộ thủ công:

```cmd
ocskill install
```

Kết quả đồng bộ đúng sẽ có dạng:

```text
Package version: 4.0.0
Resource version: 4.0.0
Sync: OK
Skills: 39/39
Commands: 9/9
Subagents: 6/6
Workflow: OK
```

> Sau khi cài hoặc cập nhật UES, nên mở **OpenCode session mới** để workflow mới được nạp đầy đủ.

---

# Bảng công cụ UES

## 1. Subagent — dùng để làm gì?

Các subagent này chủ yếu là **read-only / analysis-oriented**. Chúng không tự ý sửa code. Agent chính vẫn chịu trách nhiệm triển khai và kết luận cuối cùng.

| Subagent | Công dụng | Nên dùng khi nào | Slash command liên quan |
|---|---|---|---|
| `ues-architect` | Phân tích kiến trúc, boundary, data flow, interface, blast radius, migration và trade-off | Trước thay đổi lớn, nhiều module, schema/API/auth hoặc khi chưa rõ nên thiết kế theo hướng nào | `/ues-plan` |
| `ues-debugger` | Điều tra nguyên nhân gốc của bug, test fail, build fail, crash hoặc regression | Khi có lỗi và muốn tìm **root cause** trước khi sửa | `/ues-debug` |
| `ues-researcher` | Kiểm tra package/API/version/docs hiện tại bằng nguồn phù hợp với version repository | Khi không chắc API mới, package version, breaking change, framework behavior | `/ues-research` |
| `ues-reviewer` | Review diff để tìm lỗi thực tế về correctness, security, compatibility, race, regression và thiếu verification | Sau khi code đã sửa xong, trước khi kết luận hoàn tất | `/ues-review` |
| `ues-critic` | Cố tình “bẻ” giải pháp bằng counterexample, challenge assumption và tìm edge case có thể phá implementation | Với thay đổi quan trọng/rủi ro cao trước khi chốt | `/ues-critique` |
| `ues-verifier` | Chạy/đánh giá verification độc lập theo acceptance criteria, test, build, status và diff | Khi cần chứng minh công việc thật sự đúng, không chỉ “có vẻ đúng” | `/ues-verify` |

### Ví dụ nhanh với subagent

Nếu bạn muốn thiết kế một feature lớn trước khi code:

```text
/ues-plan Thiết kế chức năng thanh toán nhiều nhà bán hàng, chỉ lập kế hoạch và chỉ ra các file cần sửa.
```

Nếu gặp bug khó:

```text
/ues-debug Điều tra vì sao đơn hàng bị trừ tồn kho hai lần khi webhook payment retry.
```

Nếu vừa sửa xong và muốn kiểm tra độc lập:

```text
/ues-review Kiểm tra toàn bộ thay đổi hiện tại, ưu tiên lỗi logic và regression.
/ues-verify Xác minh các acceptance criteria và chạy các test phù hợp.
/ues-critique Tìm counterexample có thể làm giải pháp hiện tại sai.
```

---

## 2. Slash commands

Khi được cài vào OpenCode, command nguồn sẽ mang prefix `ues-`.

| Lệnh | Agent sử dụng | Công dụng |
|---|---|---|
| `/ues-feature` | `build` | Triển khai feature theo repository, chọn skill cần thiết, kiểm chứng và review |
| `/ues-fix` | `build` | Tìm root cause rồi sửa bug bằng thay đổi nhỏ nhất có thể |
| `/ues-plan` | `ues-architect` | Lập kế hoạch implementation-ready mà không sửa code |
| `/ues-debug` | `ues-debugger` | Điều tra lỗi, build fail, test fail, crash, regression |
| `/ues-research` | `ues-researcher` | Kiểm tra API/package/version/docs hiện hành |
| `/ues-review` | `ues-reviewer` | Review code/diff độc lập |
| `/ues-verify` | `ues-verifier` | Chứng minh acceptance criteria bằng evidence mới |
| `/ues-critique` | `ues-critic` | Tìm assumption sai, edge case và counterexample |
| `/ues-audit` | `build` | Audit một repository/khu vực về architecture, correctness, security, performance và verification |

### Chọn command theo tình huống

| Bạn muốn làm gì? | Dùng |
|---|---|
| Làm feature mới | `/ues-feature ...` |
| Sửa bug | `/ues-fix ...` |
| Chỉ muốn lập kế hoạch, chưa sửa code | `/ues-plan ...` |
| Chưa biết nguyên nhân lỗi | `/ues-debug ...` |
| Không chắc docs/API/package hiện tại | `/ues-research ...` |
| Muốn review thay đổi vừa làm | `/ues-review ...` |
| Muốn kiểm chứng bằng test/build/evidence | `/ues-verify ...` |
| Muốn tìm edge case khó trước khi chốt | `/ues-critique ...` |
| Muốn audit toàn repository | `/ues-audit ...` |

---

## 3. Các skill quy trình và kiểm chứng

UES không nạp toàn bộ 39 skill cùng lúc. Thông thường chỉ cần khoảng **2–4 skill phù hợp nhất**.

| Skill | Công dụng |
|---|---|
| `ues-engineering-orchestrator` | Điều phối task không đơn giản: scope, routing skill, plan, delegation, verification, critic và repair loop |
| `ues-repo-explorer` | Khám phá repository lạ: stack, entry point, dependency, analogue, test và convention |
| `ues-context-engineering` | Giữ context gọn trong repository lớn; tránh đọc file lan man/lặp lại |
| `ues-task-planner` | Tạo kế hoạch file-aware cho task nhiều file, migration hoặc thay đổi rủi ro |
| `ues-change-impact-analysis` | Xác định blast radius, producer/consumer và phạm vi ảnh hưởng trước khi sửa |
| `ues-bug-diagnosis` | Tái hiện lỗi, tìm root cause và loại bỏ giả thuyết sai trước khi patch |
| `ues-test-driven-development` | Red → Green → Refactor khi repository có test harness phù hợp |
| `ues-test-verification` | Chứng minh kết quả bằng test, typecheck, lint, build, reproduction và diff |
| `ues-code-review` | Review lỗi thực tế thay vì style noise |
| `ues-research-verification` | Xác minh API/package/version/framework hiện tại bằng nguồn phù hợp |
| `ues-long-task-state` | Lưu facts, assumptions, rejected hypotheses, decisions, progress và next action cho task dài |
| `ues-git-safety` | Bảo vệ working tree, diff, staging, commit và tránh thao tác Git phá dữ liệu |
| `ues-implementation-engineer` | Triển khai feature/refactor theo architecture, compatibility, types và test |
| `ues-software-architect` | Phân tích boundary, module, interface, migration và trade-off kiến trúc |
| `ues-documentation-engineering` | Viết docs khớp với code, command, config và API thật |
| `ues-dependency-management` | Nâng/thay dependency an toàn, kiểm tra compatibility, peer/runtime và lockfile |
| `ues-performance-engineering` | Điều tra performance dựa trên measurement: DB, render, network, memory, cache, bundle |

---

## 4. Skill framework/domain

| Skill | Dùng cho |
|---|---|
| `ues-react-engineering` | React, hooks, component, state, form, rendering, test |
| `ues-nextjs-engineering` | Next.js App/Pages Router, server/client component, route/action, cache, metadata |
| `ues-react-native-engineering` | React Native/Expo, Android/iOS, navigation, native module, build/platform issue |
| `ues-nodejs-engineering` | Node.js service/tooling, async, module, process lifecycle, API |
| `ues-nestjs-engineering` | NestJS module, controller, provider, DTO, guard, interceptor |
| `ues-python-engineering` | Python project, packaging, typing, async, tests và environment |
| `ues-django-engineering` | Django/DRF, ORM, model, migration, permission, view, form |
| `ues-fastapi-engineering` | FastAPI, Pydantic, dependency, async endpoint, OpenAPI |
| `ues-dotnet-engineering` | .NET/ASP.NET Core, EF Core, DI, API, auth, async |
| `ues-java-spring-engineering` | Java/Spring Boot, controller, service, JPA, transaction, security |
| `ues-flutter-engineering` | Flutter/Dart, widget, state, navigation, async và platform behavior |
| `ues-database-engineering` | Schema, migration, index, query, ORM, transaction và data integrity |
| `ues-rest-api-design` | REST resource, method, status, pagination, error, versioning, idempotency |
| `ues-api-contract` | Đồng bộ frontend/backend/DTO/schema/client/validation/error contract |
| `ues-auth-security` | Authentication, authorization, role, permission, token, session, secret |
| `ues-web-security-review` | XSS, injection, access control, CSRF, SSRF, traversal, upload, secret |
| `ues-payment-engineering` | Payment state machine, webhook, idempotency, retry, reconciliation |
| `ues-ecommerce-engineering` | Marketplace, catalog, seller, inventory, cart, checkout, order, pricing |
| `ues-file-upload-engineering` | Upload file/image, validation, path, storage, cleanup, permission |
| `ues-devops-engineering` | Docker, CI/CD, deployment, health check, config, logging |
| `ues-ui-ux-engineering` | UI production, form, responsive, loading/empty/error state, consistency |
| `ues-accessibility` | Keyboard, focus, semantic, label, screen reader, touch target |

---

# Công cụ CLI `ocskill`

Các lệnh dưới đây chạy bên ngoài OpenCode và hữu ích để kiểm tra package hoặc repository.

| Lệnh | Công dụng | Ví dụ |
|---|---|---|
| `ocskill install` | Cài/re-sync resource UES vào OpenCode | `ocskill install` |
| `ocskill status` | Kiểm tra package và resource có đồng bộ không | `ocskill status` |
| `ocskill doctor` | Kiểm tra Node, npm, OpenCode và resource UES | `ocskill doctor` |
| `ocskill update` | Kiểm tra npm `latest`, chống downgrade và re-sync | `ocskill update` |
| `ocskill remove` | Gỡ resource UES và package theo workflow an toàn | `ocskill remove` |
| `ocskill version` | In version UES | `ocskill version` |
| `ocskill inspect [dir]` | Map repository, stack, package manager và test command | `ocskill inspect .` |
| `ocskill detect-stack [dir]` | Chỉ nhận diện stack/package manager | `ocskill detect-stack .` |
| `ocskill detect-tests [dir]` | Tìm test/lint/build command từ project | `ocskill detect-tests .` |
| `ocskill impact <query> [dir]` | Tìm file/line có khả năng bị ảnh hưởng bởi symbol hoặc keyword | `ocskill impact routeSkills .` |
| `ocskill evidence [dir]` | Thu thập stack + verification + Git evidence trong một JSON | `ocskill evidence .` |
| `ocskill working-tree [dir]` | Xem branch, HEAD, clean/dirty và thay đổi Git | `ocskill working-tree .` |
| `ocskill eval` | Kiểm tra static routing contract | `ocskill eval` |
| `ocskill eval-live ...` | Chạy benchmark model thật: baseline vs UES | `ocskill eval-live --model provider/model --trials 3` |
| `ocskill eval-report [paths]` | Tổng hợp pass-rate, tool, token, cost từ live eval | `ocskill eval-report .ues-evals` |
| `ocskill router status` | Xem trạng thái UES Router trên OpenCode 2.x | `ocskill router status` |
| `ocskill router on/off` | Bật/tắt auto routing trên OpenCode 2.x | `ocskill router off` |
| `ocskill router on --max N` | Giới hạn số skill được router tự chọn, từ 1 đến 6 | `ocskill router on --max 3` |

## Ví dụ dùng các CLI tool mới

Xem UES hiểu repository hiện tại như thế nào:

```cmd
ocskill inspect .
```

Tìm các vị trí liên quan tới một function/symbol:

```cmd
ocskill impact calculateOrderTotal .
```

Lấy nhanh stack, test command và Git state:

```cmd
ocskill evidence .
```

Kiểm tra working tree trước khi agent sửa code:

```cmd
ocskill working-tree .
```

---

# OpenCode 1.x và 2.x

UES tự phát hiện major version của OpenCode khi đồng bộ resource.

### OpenCode 1.x

- dùng agent permission format tương thích V1
- không cài V2 runtime router
- 39 skill, 9 command, 6 subagent vẫn hoạt động

### OpenCode 2.x

- dùng native ordered `permissions`
- cài managed plugin:
  `~/.config/opencode/plugins/ues-router/`
- lưu config router trong:
  `.ues/router.json`
- router tự chọn một nhóm skill phù hợp trước khi model bắt đầu xử lý

Sau khi nâng OpenCode từ V1 lên V2:

```cmd
ocskill install
ocskill router status
```

Router mặc định chọn tối đa **4 skill**. Có thể thay đổi:

```cmd
ocskill router on --max 3
```

Xem chi tiết: [OpenCode compatibility](docs/OPENCODE-COMPAT.md).

---

# Cách UES chọn skill

UES cố tình **không nạp toàn bộ 39 skill**.

Ví dụ:

```text
repository lạ
  -> ues-repo-explorer
  -> ues-context-engineering nếu cần
  -> domain skill phù hợp

bug / regression
  -> ues-bug-diagnosis
  -> domain skill
  -> ues-test-driven-development nếu phù hợp
  -> ues-test-verification

API / schema / auth / payment thay đổi
  -> ues-engineering-orchestrator
  -> ues-change-impact-analysis
  -> domain skill
  -> ues-test-verification
  -> ues-reviewer / ues-critic nếu rủi ro cao

không chắc API/package/version hiện tại
  -> ues-research-verification
  -> framework/dependency skill liên quan
```

---

# Benchmark và kiểm chứng

## Static routing

```cmd
npm run evals
```

Hiện V4 có:

```text
34 routing scenarios
39/39 skills được bao phủ
```

## Kiểm tra hidden grader

```cmd
npm run evals:live:validate
```

Hiện có **20 executable tasks** và mỗi broken fixture bắt buộc phải bị hidden grader phát hiện.

## Benchmark model thật

```cmd
ocskill eval-live --model provider/model --trials 3
```

Nếu OpenCode đã đăng nhập provider bằng `/connect`:

```cmd
ocskill eval-live --model provider/model --auth current --trials 3
```

So sánh:

```text
cùng model + cùng task

baseline
vs
UES
```

Tổng hợp kết quả:

```cmd
ocskill eval-report .ues-evals
```

Trace có thể ghi nhận pass/fail, thời gian, file thay đổi và best-effort telemetry về tool, skill, subagent, token và cost. UES không thu thập hidden chain-of-thought.

Xem thêm: [Evaluation](docs/EVALS.md) và [Trace schema](docs/TRACE-SCHEMA.md).

---

# Cập nhật

```cmd
ocskill update
```

UES 4 đọc explicit npm `latest` dist-tag và có fallback sang `npm dist-tag ls`. Nếu registry trả version cũ hơn version đang cài, updater sẽ từ chối downgrade.

---

# Gỡ cài đặt

```cmd
ocskill remove
```

Nên dùng `ocskill remove` thay vì chỉ `npm uninstall -g` nếu muốn dọn luôn resource UES trong OpenCode.

---

# Phát triển và test package

Yêu cầu:

- Node.js 20+
- npm
- Git

```cmd
git clone https://github.com/laivannha0202/opencode-agent-skill-.git
cd opencode-agent-skill-
npm install
npm run ci
```

Pipeline `npm run ci` của V4 gồm:

```text
JavaScript syntax check
-> validate skill / command / subagent
-> 34-scenario routing validation
-> 20-task hidden-grader validation
-> Node unit/integration tests
-> npm pack --dry-run
-> packed install smoke test
```

### Không dùng `npm install -g .` để mô phỏng release

Cài global trực tiếp từ folder có thể tạo symlink/junction về source checkout. Nếu source nằm trên RAM Disk hoặc folder tạm, package global có thể hỏng khi folder biến mất.

Test release giống npm thật bằng:

```cmd
npm pack
npm install -g .\laivannha0202-opencode-agent-skill-4.0.0.tgz --allow-scripts=@laivannha0202/opencode-agent-skill
```

---

# Nguyên tắc an toàn

- Resource UES dùng namespace `ues-`.
- Không tự ý ghi đè resource unmanaged trùng tên.
- Chỉ xóa stale resource được UES quản lý.
- Giữ nguyên thay đổi không liên quan của người dùng.
- Không force push/reset/clean hoặc thao tác phá dữ liệu nếu chưa có yêu cầu rõ ràng.
- Không bịa file, function, API, package version hoặc kết quả test.
- Không tuyên bố test/build/release thành công nếu chưa có evidence thực tế.
- Với auth, payment, migration, schema, public API và deployment, phải kiểm tra impact và compatibility kỹ hơn.

---

# Tài liệu chi tiết

- [Thiết kế kỹ thuật](docs/ENGINEERING-DESIGN.md)
- [Tương thích OpenCode](docs/OPENCODE-COMPAT.md)
- [Deterministic evidence tools](docs/DETERMINISTIC-TOOLS.md)
- [Evaluation](docs/EVALS.md)
- [Trace schema](docs/TRACE-SCHEMA.md)
- [Publish npm](docs/NPM-PUBLISH.md)
- [Nguồn nghiên cứu](docs/RESEARCH-SOURCES.md)

---

# License

MIT
