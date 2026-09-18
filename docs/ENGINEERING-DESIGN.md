# UES engineering design

Version 2.1 strengthens the system as an engineering harness rather than trying to imitate a particular model.

## Research inputs

The design was informed by public engineering patterns from:

- Alibaba OpenCodeReview — deterministic guardrails around file/rule selection combined with an agent for dynamic reasoning and context retrieval; high-signal review over noisy finding volume.
- Open GSD Core — explicit planning artifacts, resumable state, verification records, checkpoints, and using fresh/isolated context selectively for larger work.
- Superpowers — root-cause-first debugging, fresh verification before completion claims, pragmatic red-green-refactor discipline, and testing the behavioral effect of skills.
- Agent Skills open specification and Anthropic guidance — progressive disclosure: keep discovery metadata small, put the operational core in SKILL.md, and move deeper material into references/templates/scripts loaded only when needed.
- OpenAI Agents SDK repository guidance — route behavior-impacting work through mandatory, focused skills and load only the supporting references needed for the selected route.
- NVIDIA public skills — coordinator skills that link to phase/reference files and use explicit gates instead of placing every detail in one large prompt.
- Ruflo/Claude Flow — useful patterns for orchestration and independent agents, while also motivating restraint: multi-agent fan-out is not automatically better and can duplicate work or correlate failures.

Sources are listed in [RESEARCH-SOURCES.md](RESEARCH-SOURCES.md).

## What UES adopts

### Deterministic lifecycle

npm owns package installation and versioning; the installer owns a namespaced set of OpenCode resources and records exactly what it manages. Existing unrelated user resources are preserved.

### Progressive-disclosure skills

The top-level workflow routes to a small number of skills. Skills such as `engineering-orchestrator`, `context-engineering`, `research-verification`, and `test-driven-development` keep deeper material under `references/` or `templates/`. The installer copies complete skill directories so these files remain available when OpenCode loads a skill.

### Risk-aware routing

Work is classified by risk and blast radius rather than forcing the same ceremony on every task. Small work stays inline. Standard work gets a short file-aware plan and verification. Complex work adds impact analysis, research/architecture, compatibility/rollback thinking, or persistent state only when useful.

### Evidence gates

Completion claims must be backed by fresh evidence matched to the claim. A successful compile does not prove a runtime bug is fixed; a unit test does not prove a migration is safe; an agent report is not independent verification.

### Bounded retry

Failures feed a diagnosis loop. UES discourages piling patches onto an unproven hypothesis. Repeated failed fixes trigger a fresh investigation and, after widening failures, an architecture check.

### Selective subagents

Five read-only/analysis-oriented subagents provide independent context for architecture, debugging, research, review, and verification. They are optional. The parent Build agent remains responsible for integration and final claims.

### Resumable long work

Long tasks can use a compact project state template when persistence is genuinely useful. It records decisions, completed work, verification evidence, blockers, and one resumable next action without copying the whole conversation into the repository.

### Skill maintenance evals

The repository includes a routing-eval contract with representative prompts and expected focused skill sets. This prevents renamed/deleted skills and uncontrolled routing growth from silently breaking the pack.

The current eval is static validation, not a claim about model accuracy. A live model benchmark should score actual task outcomes separately.

## What UES deliberately avoids

- loading all skills for every request
- default multi-agent swarms for simple work
- trusting subagent success reports without verification
- long system prompts that duplicate detailed skill content
- generic "clear cache/delete lockfile/upgrade everything" debugging
- invented current package versions or external API behavior
- claiming the skill pack changes one model into another

The goal is to raise reliability, context quality, and engineering discipline for whichever model OpenCode is using.
