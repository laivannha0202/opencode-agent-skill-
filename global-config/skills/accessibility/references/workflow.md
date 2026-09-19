# Accessibility workflow

Start from the actual interaction and semantic tree, not visual appearance alone.

Check:
- native element/control semantics before adding ARIA
- accessible name, description, state and error association
- keyboard reachability, order, visible focus and escape from traps
- pointer/touch target size and equivalent keyboard behavior
- headings/landmarks and meaningful image alternatives
- live/dynamic updates that need status or alert semantics
- color contrast, zoom/reflow, reduced motion and text scaling
- modal focus entry/return and background inertness

For forms, connect labels, instructions, errors and invalid state to the exact field. Do not use placeholder text as the only label.

Verification should include keyboard-only flow and, when available, automated accessibility checks plus at least one screen-reader or accessibility-tree inspection for the changed path. Treat automated tools as partial evidence, not proof.
