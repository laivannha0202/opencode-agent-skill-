# Python engineering workflow

Establish Python version, environment/package manager, project layout, typing mode, formatter/linter and test runner.

Respect import/package boundaries and avoid changing environment tooling incidentally. Keep public types and validation explicit where the codebase uses them.

For async code, do not call blocking I/O in the event loop; manage task cancellation and resource cleanup. For sync code, use context managers for files/connections and avoid broad exception swallowing.

Watch mutable defaults, timezone-naive datetimes, implicit text/bytes conversions, iterator exhaustion and shared global state. Prefer standard-library solutions when a dependency adds little value.

Verification should use the project interpreter/environment, focused tests, type checking/linting when configured, and the actual runtime path for packaging/CLI/import changes.
