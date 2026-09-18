# Skill routing evals

UES ships `evals/routing.json` as a maintenance contract for representative engineering requests.

Run:

```bash
npm run evals
```

or, after global installation:

```bash
ocskill eval
```

The validator checks that:

- scenarios are uniquely named
- each scenario has a real request and at least one expected skill
- expected skill IDs exist
- routing stays focused instead of selecting an excessive number of skills
- core process skills such as orchestration, debugging, research verification, and verification are exercised

## What this eval does not prove

This is a static routing contract. It does not call a language model and does not measure whether Big Pickle, GPT, Claude, Gemini, or another model actually selected the expected skill or solved a coding task correctly.

A future live benchmark should score:
- skill-trigger precision/recall
- task completion correctness
- regression rate
- verification quality
- token/tool-call cost
- recovery from injected failures

Static contract checks stay useful even after live evaluation is added because they catch packaging and catalog drift deterministically.
