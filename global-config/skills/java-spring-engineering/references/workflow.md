# Java / Spring workflow

Establish Java version, Spring Boot version, Maven/Gradle setup, active profiles and persistence/security conventions.

Trace controller -> validation -> service/domain -> transaction -> repository/external I/O -> response. Keep controllers thin and transaction boundaries aligned with invariants rather than convenience.

For JPA, inspect fetch type, cascades, ownership, orphan behavior, query count, locking/concurrency and entity/DTO boundaries. Avoid exposing mutable persistence entities as public contracts when the project uses DTOs.

For Spring Security, verify authentication plus role/tenant/resource authorization and method/filter ordering. Include negative cases.

For migrations, inspect Flyway/Liquibase ordering and mixed-version compatibility.

Verification should include focused tests, Maven/Gradle build, relevant integration/security cases, generated SQL/query behavior where needed and startup/profile configuration when wiring changed.
