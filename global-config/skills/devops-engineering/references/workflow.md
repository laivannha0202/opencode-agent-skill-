# DevOps engineering workflow

Map source -> build artifact -> deploy unit -> runtime dependencies -> health signal -> rollback path.

For containers, inspect build context, multi-stage boundaries, pinned base/runtime versions, non-root execution when practical, signal handling, health checks, secret injection and cache-invalidating COPY order.

For CI, compare local and runner OS/runtime/tool versions, environment variables, working directories, permissions, caches, artifacts and service dependencies. Diagnose the first failing step rather than rewriting the pipeline broadly.

For deployments, separate build-time from runtime configuration, sequence schema migrations safely, define readiness before traffic, preserve old/new compatibility during rolling changes, and keep rollback independent of destructive data changes.

Verification should validate configuration syntax, run the closest representative build/job locally when possible, inspect produced artifacts, and exercise health/readiness/failure behavior. Never print or commit secrets.
