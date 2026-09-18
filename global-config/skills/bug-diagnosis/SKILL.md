---
name: bug-diagnosis
description: Diagnose runtime errors, build failures, regressions, failing tests, integration issues, crashes, and incorrect behavior through reproducible evidence and root-cause hypotheses before fixing.
---

# Bug Diagnosis

Do not patch the first visible symptom.

## 1. Establish the failure

Capture the exact error, failing command, reproduction steps, environment/version clues, and recent relevant diff. If the issue is intermittent, gather enough evidence to identify the changing condition.

## 2. Trace cause

Find where the bad value/state first becomes wrong. In multi-component flows, inspect boundaries one at a time: input, output, configuration, ownership, and assumptions. Find a nearby working analogue and compare meaningful differences.

## 3. Test one hypothesis

State one causal hypothesis and why the evidence supports it. Make the smallest diagnostic or code change that can confirm/refute it. Do not bundle multiple speculative fixes.

## 4. Fix and prove

When practical, add a focused failing regression test or reproduction. Fix the earliest supported cause, rerun the exact failure, then run adjacent checks.

If two fixes fail, stop stacking changes and restart the investigation from fresh evidence. If three distinct hypotheses fail or the fixes expose widening coupling, surface the architectural assumption before another broad edit.

Never use cache clearing, lockfile deletion, disabled checks, or dependency upgrades as generic debugging rituals without evidence.
