# Retry policy

Failed verification is new evidence, not permission to guess faster.

1. Capture the exact failed check and its output.
2. Decide whether the failure is caused by the change, pre-existing, environmental, or unknown.
3. For caused/unknown failures, form one explicit hypothesis and test the smallest causal change.
4. Re-run the exact failing check before broader verification.
5. After two failed fixes, stop stacking patches. Re-read the error, recent diff, nearest working analogue, and relevant contract from scratch.
6. After three distinct failed hypotheses or widening symptoms, surface the possibility of an architectural assumption being wrong before another broad edit.

Do not use package upgrades, cache deletion, lockfile deletion, disabled checks, broad rewrites, or retries-without-changes as generic repair strategies.
