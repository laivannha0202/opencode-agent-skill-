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

Extension đăng ký hai tool chính:

- `ues_cli`: chạy deterministic UES operations như task policy, repo inspection, durable work state, evidence và verification receipts;
- `ues_dispatch`: chạy specialist Pi child agents theo single, chain hoặc bounded parallel mode.

Writer chạy song song phải dùng working directory/worktree riêng. Nếu không có isolation, runtime fail closed thay vì cho hai writer sửa cùng một checkout.

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
