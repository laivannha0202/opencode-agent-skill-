# .NET / ASP.NET Core workflow

Establish target framework, nullable mode, SDK pinning, project references and test layout first.

Trace endpoint -> model binding/validation -> service -> persistence/external I/O -> response. Respect DI lifetimes; do not inject scoped services into singletons. Carry CancellationToken through meaningful async I/O and avoid sync-over-async.

For EF Core, inspect tracking needs, query projection, Include usage, transaction boundaries, concurrency tokens, migration output and database-provider differences. Avoid loading whole aggregates when a projection is enough.

For auth, verify policy/claim/resource authorization at the server boundary and include negative cases.

Verification should use dotnet restore/build/test as appropriate, targeted endpoint/integration tests, migration/script inspection for schema changes, and analyzer/nullability output rather than suppressing warnings.
