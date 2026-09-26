# V15 Managed Runtime

V15 starts by fixing two weak-model/runtime failures observed after the 14.4.0 stable release:

1. a weak parent model can ignore a prompt telling it to call `ues_execute`;
2. a foreground development server can keep a shell tool open indefinitely and stall the workflow.

## Deterministic /ues-run admission

`/ues-run` is now registered as a Pi extension command. Pi resolves extension commands before prompt templates, so engineering work enters the UES controller directly instead of depending on the parent model to remember a tool call.

The existing `ues_execute` tool remains available for programmatic/tool-driven use.

The Pi benchmark harness also invokes the UES arm through `/ues-run`, so controller effectiveness is measured rather than parent-tool-admission compliance.

## Managed background services

Both the parent extension and specialist child runtime expose `ues_service` with these actions:

- `start`
- `wait-ready`
- `status`
- `logs`
- `stop`
- `restart`

Service execution is shell-free. Commands are launched as executable + argument arrays, with Windows shim resolution through the existing safe resolver.

Readiness may be proven by:

- TCP port;
- literal log marker;
- or process survival when no explicit readiness criterion is supplied.

Logs are bounded and may be stored as Evidence Store snapshots.

Lifecycle is bounded as well:

- default maximum service lifetime: 30 minutes;
- configurable `lifetimeMs`: 10 seconds to 2 hours;
- optional `idleTimeoutMs`: stop a service after 5 seconds to 1 hour without stdout/stderr activity;
- session shutdown stops every service owned by that Pi runtime.

## Foreground-service guard

Common long-running foreground commands are blocked in ordinary bash/powershell execution and redirected to `ues_service`. Examples include:

- `npm run dev`
- `pnpm start:dev`
- `node apps/api/dist/main.js`
- `nest start`
- `next dev`
- `vite`
- `uvicorn`
- `dotnet run`
- `docker compose up` without `-d`

Normal test/build commands are not classified as services.

## Lifecycle and cleanup

Managed services are owned by the current Pi runtime. Session shutdown stops owned process trees. The runtime intentionally refuses to kill historical/unowned PID metadata, avoiding unsafe PID-reuse termination.

Runtime state lives under `.ues-services/`. It is ignored by Git and excluded from workspace fingerprints, semantic indexing, repository graphs and affected-test scans.

## Validation

Focused validation:

```cmd
npm run eval:v15
```

Full release gate:

```cmd
npm run ci
```

Live weak-model comparison:

```cmd
npm run eval:pi -- --model kilo/stepfun/step-3.7-flash:free --thinking low --suite live --task multi-file-contract-compatibility --trials 3 --mode both --min-pairs 3
```

For the UES arm, `controllerUsed` must now be true because admission is deterministic.


## V15.2 Turbo Fast Path

V15.2 addresses latency observed in weak-model live evaluation without weakening completion gates.

For a first-attempt task to enter Turbo Fast Path it must be:

- FAST profile;
- low risk;
- single-file bounded;
- executor/verifier role;
- no required integration verification;
- no browser/visual evidence requirement.

The original user-task policy is propagated into controller-generated specialist prompts. UES therefore does not reclassify its own orchestration text as if it were new user scope.

Default first-attempt budgets:

- hard child timeout: 180 seconds;
- child idle timeout: 60 seconds;
- post-tool-error idle timeout: 30 seconds;
- behavioral verification command timeout: 90 seconds.

A timeout is not a PASS. The attempt fails closed and the existing recovery policy can widen context, diagnose, and escalate the model on a later attempt.

Fresh behavioral verification receipts remain the preferred FAST completion proof. A separate verifier model turn is skipped only when the deterministic FAST gate proves the required acceptance criteria at the current workspace fingerprint.

### Pi benchmark telemetry

Pi headless/JSON mode keeps protocol stdout clean and extension/application diagnostics may appear on stderr. V15.2 therefore writes direct-controller eval telemetry to stderr and the eval harness parses both stdout and stderr.

This prevents a successful UES implementation from being mislabeled as `controllerUsed=false` merely because telemetry was read from the wrong stream.
