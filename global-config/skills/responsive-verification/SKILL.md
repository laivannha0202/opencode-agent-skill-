---
name: responsive-verification
description: Verify responsive web/mobile layout across representative viewport matrices, checking overflow, overlap, offscreen controls, text scaling, image aspect ratio, sticky/fixed behavior and breakpoint-specific interaction.
---

# Responsive Verification

Use the project's breakpoints when available; otherwise use a small representative matrix rather than dozens of arbitrary sizes. Verify geometry and interaction, not screenshots alone.

Check overflow/overlap, hidden-but-required controls, long text, zoom/text scaling, safe areas where relevant, images and sticky/fixed positioning. Report failures by viewport and owning component.
