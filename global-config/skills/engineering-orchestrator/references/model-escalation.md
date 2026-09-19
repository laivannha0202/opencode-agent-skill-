# Model-tier escalation

UES can map agent roles to three user-configured model tiers:

```text
light -> cheap/mechanical work
standard -> normal implementation/debugging/review
heavy -> architecture, plan checking, critic and difficult integration
```

Configure explicit provider/model IDs with `ocskill models`. UES never invents model IDs.

Default role tiers favor:
- heavy: architect, plan-checker, critic, integration-verifier
- standard: executor, debugger, researcher, reviewer, verifier, codebase-mapper

A failed task attempt may escalate one tier through `ocskill model-policy <role> --attempt N`. Tier escalation is advice unless the runtime can launch the requested agent with that configured model.

Do not use model escalation as a substitute for better evidence. First failure -> diagnose. Repeated failure -> fresh context and stronger tier. Three failed causal approaches -> reconsider the plan/architecture.
