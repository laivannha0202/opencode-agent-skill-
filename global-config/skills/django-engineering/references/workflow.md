# Django engineering workflow

Trace request/command -> URL/view/serializer/form -> service/domain logic -> ORM -> response/template.

For ORM work, inspect generated query shape, select_related/prefetch_related opportunities, transaction boundaries, uniqueness constraints and migration compatibility. Avoid fixing N+1 problems with indiscriminate prefetching.

For DRF, keep request/response serializers explicit, enforce object-level permissions in the server path that retrieves or mutates the object, preserve status/error conventions and check pagination/filter behavior.

For migrations, inspect existing rows before NOT NULL/unique constraints, prefer additive compatible steps for live systems, and avoid editing already-applied migrations casually.

Verification should include focused tests, permission negative cases, migration checks and query-count/SQL inspection when performance or data access changed.
