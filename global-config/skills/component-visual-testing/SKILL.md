---
name: component-visual-testing
description: Add or use component-level visual/interaction regression tests with Storybook or project-native component harnesses so changed UI states can be rendered, exercised and screenshot-compared independently of the whole application.
---

# Component Visual Testing

Detect an existing Storybook/component-test setup first. Reuse existing stories/fixtures and cover only meaningful variants: default plus states directly affected by the change.

Prefer component-level visual tests for local styling regressions, interaction tests for behavior, and accessibility checks for semantics. Do not replace end-to-end verification when routing/data/integration behavior is part of the acceptance criteria.
