# NestJS workflow

Map module ownership before adding providers. Trace controller -> DTO/pipe -> guard/policy -> service/domain -> repository/external I/O -> response/interceptor.

Keep providers in the narrowest module that owns them and export only intentional public dependencies. Avoid circular-module workarounds until the ownership problem is understood.

Use DTO validation/transformation consistently and distinguish transport validation from business invariants. Enforce resource authorization in guards/policies or service logic that every entry point reaches.

For async providers, close connections/listeners on shutdown and handle rejected promises explicitly. Preserve exception filters, response envelopes and OpenAPI decorators where they define a contract.

Verification should include unit/integration tests around the changed provider path, validation and unauthorized cases, module compilation/bootstrap and contract/OpenAPI checks when endpoints change.
