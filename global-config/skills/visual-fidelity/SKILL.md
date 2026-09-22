---
name: visual-fidelity
description: Reproduce or verify a UI against screenshots, image references or visual requirements using structured geometry, deterministic pixel diff, focused crops and evidence-backed repair instead of subjective looks-close judgment.
---

# Visual Fidelity

Use semantic structure, element geometry and pixels together. Convert the reference into a compact visual spec, implement the smallest owning component/style change, render a representative viewport, then verify with geometry and screenshot diff.

Prefer deterministic ocskill visual checks before asking a vision model to inspect an entire page. When a diff is localized, inspect only the failing crop. Never declare visual success from code inspection alone.

Read [workflow.md](references/workflow.md) for the full reference → spec → render → diff → repair loop.
