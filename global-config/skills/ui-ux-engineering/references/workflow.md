# UI/UX engineering workflow

Start from the existing design system, component primitives and real user flow.

Check the complete state model:
- default, hover/focus/pressed/disabled
- loading, empty, validation error, server error and success
- long text, missing images/data and slow network
- narrow/mobile, large viewport and zoom/text scaling

Preserve visual hierarchy through spacing, typography and grouping before adding decoration. Reuse components/tokens instead of creating near-duplicates.

Forms need clear labels, inline actionable errors, submission state and prevention of accidental duplicate actions. Navigation and dialogs should preserve focus and back/escape expectations.

For data-heavy UI, design pagination/filter/sort and stale/loading transitions deliberately.

Verification should exercise the actual interaction at representative breakpoints, keyboard/focus behavior, overflow/long-content cases and accessibility checks where relevant—not only compare a static screenshot.
