# UES for Pi Agent

UES là engineering runtime dành cho **Pi Agent**. Runtime này giúp model làm việc ổn định hơn trên repository lớn bằng cách dùng skill routing, fresh specialist contexts, durable state, evidence receipts, worktree isolation và verification gates.

> Host được hỗ trợ trong package hiện tại: **Pi Agent**.

## Yêu cầu

- Node.js 22.19 trở lên
- Git
- Pi Agent: `@earendil-works/pi-coding-agent`

## Cài đặt

```cmd
npm install -g @earendil-works/pi-coding-agent
pi --version
pi install git:github.com/laivannha0202/opencode-agent-skill-
pi list
pi
```

Nếu đang clone repo local:

```cmd
pi install .
```

## Lệnh chính trong Pi

```text
/ues-run <task>
/ues-plan <task>
/ues-feature <task>
/ues-fix <bug>
/ues-debug <failure>
/ues-review <scope>
/ues-verify <claim>
/ues-audit <scope>
/ues-research <question>
/ues-critique <proposal>
/ues-resume <slug>
```

## Pi runtime

Pi nạp trực tiếp:

- `pi/extensions/ues.ts`: extension runtime;
- `pi/prompts/*.md`: slash prompts;
- `global-config/skills/`: Agent Skills;
- `global-config/agents/`: specialist prompts mà `ues_dispatch` dùng trong child Pi processes;
- `bin/ocskill.mjs` + `lib/`: deterministic UES engine.

Extension đăng ký ba tool chính:

- `ues_execute`: controller end-to-end ưu tiên cho task coding; tự áp task policy, adaptive context, model routing, plan gate, retry, verifier, integration verifier và safe-wave/worktree scheduling cho plan nhiều task;
- `ues_cli`: chạy deterministic UES operations như task policy, repo inspection, durable work state, evidence và verification receipts;
- `ues_dispatch`: chạy specialist Pi child agents theo single, chain hoặc bounded parallel mode khi cần điều phối thủ công.

Child specialist được cô lập khỏi resource discovery ngẫu nhiên và nhận bounded context pack từ UES trước khi chạy.

Với structured long-horizon plan, controller tự tính safe waves, tạo Git worktree riêng, kiểm tra declared write scope, verify từng task, tích hợp tuần tự và rollback phần đã tích hợp nếu bước integration của wave thất bại. Manual `ues_dispatch` vẫn fail closed nếu người gọi cố chạy nhiều writer chung một checkout.

## Benchmark model yếu

So sánh cùng một model ở chế độ Pi thuần và Pi + UES:

```cmd
ues eval-pi --model provider/model --thinking low --suite live --trials 3 --mode both
```

Benchmark dùng Pi JSON event stream, grader bên ngoài workspace, và cộng cả usage/tool telemetry của child specialist để tránh làm đẹp số liệu bằng cách bỏ sót chi phí delegation.

## Safety

UES chặn hoặc yêu cầu xác nhận với các shell action có rủi ro cao như force-push, history rewrite, recursive destructive deletion, destructive database commands và deployment/apply commands.

## Test nhanh

Trong repository cần test:

```text
/ues-run Chỉ trả lời đúng một từ: OK
```

Sau đó thử task thực tế:

```text
/ues-run kiểm tra project, tìm lỗi, sửa lỗi cần thiết và chạy test xác minh
```

Xem thêm: `docs/PI-COMPAT.md`.

## License

MIT
