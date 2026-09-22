---
name: skill-evaluation
description: Evaluate UES skill quality with positive/negative routing cases, behavioral fixtures, token/time measurements and baseline-vs-candidate comparison before promoting broad instruction changes.
---

# Skill Evaluation

Test both triggering and behavior. A skill that always loads is not good even if its happy-path output improves.

Measure:
- routing recall on intended prompts;
- negative-guard specificity;
- task success with and without the candidate;
- input/total tokens and duration when telemetry exists;
- variance/flakiness across repeated live trials for risky changes.

Prefer forward tests on realistic fixtures. Promote only when correctness is preserved and the claimed efficiency/quality improvement is actually measured.
