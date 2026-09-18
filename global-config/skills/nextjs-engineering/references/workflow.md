# Next.js workflow

Start from the route/layout/page or handler involved and identify:
- router type and exact Next.js version
- server vs client component ownership
- data source and cache/revalidation semantics
- runtime: node, edge, static/prerendered
- auth/session/cookie boundary
- deployment-specific constraints

For App Router changes, keep secrets and privileged data on the server, serialize only client-safe props, and avoid importing server-only modules into client graphs. For route handlers/actions, verify validation, authorization, error/status behavior and cache invalidation after mutations.

For stale-data bugs, inspect fetch/cache options, tags/paths, dynamic APIs, mutation invalidation and hosting behavior before adding forced-dynamic/no-store globally.

Verification should include the affected route behavior plus Next build/type checks. For cache/auth changes, test both fresh and repeated requests and unauthorized/expired cases where applicable.
