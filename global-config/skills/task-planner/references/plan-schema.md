# UES PLAN.json schema

A long-horizon plan is machine-checkable JSON:

```json
{
  "schemaVersion": 1,
  "goal": "Observable engineering outcome",
  "tasks": [
    {
      "id": "T1",
      "title": "Short task title",
      "summary": "What changes and why",
      "files": {
        "create": [],
        "modify": ["src/example.ts"],
        "test": ["test/example.test.ts"]
      },
      "dependsOn": [],
      "acceptance": [
        "Specific externally observable behavior"
      ],
      "verification": [
        "npm test -- example"
      ],
      "risk": "medium"
    }
  ]
}
```

Valid risk values are `low`, `medium`, `high`, and `critical`.

## Task boundaries

Each task should:
- produce an independently reviewable behavior or contract;
- name files/interfaces precisely enough for a fresh executor;
- carry its own verification;
- depend only on tasks whose outputs it consumes.

Avoid plans where every task touches the same central file; those cannot safely execute in parallel.

## Acceptance quality

Acceptance criteria describe behavior, not implementation steps. Prefer:
- "Duplicate webhook delivery cannot create a second charge"

over:
- "Add an idempotency check".

## Verification quality

Verification must be concrete enough for another agent to run. High-risk tasks need negative cases and compatibility evidence where applicable.

Before execution run `ocskill task-graph PLAN.json` and an independent `ues-plan-checker`.
