# Node.js workflow

Establish runtime constraints from package.json engines, lockfile, tsconfig/module settings and deployment files.

For services, trace request/job -> validation -> business logic -> I/O -> response/ack. Check rejected promises, missing awaits, double responses, timers/listeners, pool/socket/file cleanup, backpressure for streams, and graceful shutdown for owned resources.

For subprocess/filesystem code, avoid shell interpolation when argument arrays work; validate paths and ownership; distinguish ENOENT/permission/data errors rather than broad catch-and-ignore.

For ESM/CJS issues, inspect package type, file extensions, tsconfig output and dependency export maps before changing imports broadly.

Verification should reproduce the original runtime path, then run focused tests plus repository-native typecheck/lint/build. For lifecycle/concurrency changes, test failure and shutdown/cleanup paths rather than only the happy path.
