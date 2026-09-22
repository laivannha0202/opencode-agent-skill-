---
name: responsive-verification
description: Verify responsive UI across project-relevant viewports, detecting overflow, overlap, offscreen controls, broken wrapping, incorrect sticky/fixed behavior, image distortion, and text-scaling failures.
---

# Responsive Verification

Use project breakpoints when available; otherwise choose a minimal representative matrix rather than many arbitrary widths. Verify the changed user flow at each relevant viewport.

Prefer deterministic geometry/overflow checks first, then use screenshots only for visual hierarchy issues. Report viewport, element/region, observed dimensions/state, and evidence. Do not accept desktop-only success for a responsive requirement.
