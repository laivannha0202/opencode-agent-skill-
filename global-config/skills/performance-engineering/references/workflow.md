# Performance engineering workflow

Define the user-visible or system metric first: latency percentile, throughput, CPU, memory, query count, bundle size, startup time or render frequency.

Measure a representative baseline before changing code when practical. Find the dominant cost rather than optimizing a convenient line.

Investigate by layer:
- repeated network/database calls and N+1 patterns
- blocking I/O or serialized independent work
- excessive allocations, retained listeners/resources and unbounded caches
- unnecessary rerenders/recomputation
- oversized payloads/assets/bundles
- missing indexes or cache keys derived from actual access patterns

Preserve correctness under concurrency and failure; faster incorrect behavior is not an improvement.

Verification should compare before/after under comparable inputs, repeat noisy measurements, include correctness regression checks and disclose when only static evidence—not runtime measurement—supports the expected improvement.
