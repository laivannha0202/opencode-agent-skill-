---
name: skill-authoring
description: Create or revise UES agent skills with concise discriminating descriptions, progressive disclosure, deterministic scripts/references when useful, clear boundaries and routing behavior that does not steal unrelated prompts.
---

# Skill Authoring

Assume the model already knows generic engineering. Put only decision-changing guidance in the skill.

Keep metadata concise and discriminating. Keep the entrypoint small; move mode-specific detail into references and repeated deterministic logic into scripts/runtime helpers. Define what should and should not trigger the skill when neighboring skills overlap.

Run ocskill skills lint and routing tests after adding or substantially changing a skill.
