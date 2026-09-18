---
name: nextjs-engineering
description: Work on Next.js apps with version-aware App/Pages Router boundaries, server/client components, routes/actions, caching, data fetching, metadata, images, and deployment behavior.
---

# Next.js Engineering

Detect Next.js version, App vs Pages Router, runtime target, package manager, deployment adapter, and existing data/cache conventions before changing code.

Preserve server/client boundaries. Do not spread `use client` to bypass architecture problems. Treat caching/revalidation, route handlers/server actions, environment exposure, cookies/headers, metadata, static generation, image behavior, and edge/node runtime differences as explicit contracts.

Read [workflow.md](references/workflow.md) for version-sensitive routing/data rules, cache diagnosis, security boundaries, and verification.
