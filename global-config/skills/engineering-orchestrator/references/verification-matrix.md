# Verification matrix

Use repository-native commands where available. This matrix identifies the kind of evidence to seek, not literal commands.

| Change | Minimum useful evidence | Add when risk is high |
|---|---|---|
| Local pure logic | focused unit/regression test | affected suite + typecheck |
| UI behavior | component/interaction check + build/typecheck | accessibility + browser/device path |
| Public API | provider test + consumer/contract check | backward-compatibility and error-shape checks |
| Database/schema | migration/schema validation + affected data tests | dry-run/rollback/backup strategy |
| Auth/permissions | positive and negative authorization cases | threat review + session/token edge cases |
| Payment/idempotency | success/failure/retry/idempotency tests | reconciliation/duplicate-event checks |
| Dependency change | clean install/lockfile + affected build/test | release notes, peer/runtime compatibility |
| CI/deploy config | syntax/config validation + representative job | rollback/deployment smoke |
| Performance change | correctness first + representative measurement | repeated benchmark under comparable conditions |
| Bug fix | original reproduction fails before fix and passes after | adjacent regression suite |

A passing unrelated check does not prove the changed behavior. Match evidence to the claim.
