# React workflow

Trace data ownership before editing: source -> transformation -> component props/state -> event -> mutation/refetch.

Check:
- whether state can be derived during render instead of synchronized by effect
- effect dependencies, cleanup, stale closures, request races and unmounted updates
- list keys based on stable identity rather than index when ordering can change
- controlled form values, validation timing, submit/error/loading states
- context/store selectors that cause broad rerenders
- server/cache state kept in the repository's existing data library instead of duplicated locally
- Suspense/error-boundary/framework behavior only when already supported by the stack

For regressions, find the nearest working component with the same pattern and compare ownership/lifecycle differences.

Verification should exercise user-visible behavior with the repository's component/integration tests where available, then typecheck/lint/build according to blast radius. Do not treat a successful render or TypeScript compile as proof that interaction/state timing is correct.
