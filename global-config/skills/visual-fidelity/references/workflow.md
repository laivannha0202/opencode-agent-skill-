# Visual fidelity workflow

1. Establish the reference viewport and states.
2. Create a VISUAL_SPEC.json with stable element IDs and expected x/y/width/height ranges for important anchors.
3. Render the implementation at the same viewport.
4. Collect DOM/accessibility identity and bounding boxes.
5. Run geometry verification.
6. Compare expected/actual PNGs with a deterministic threshold.
7. If the pixel diff is localized, crop the failing region and inspect only that region with vision when available.
8. Map the failure to the owning component or shared design token; avoid unrelated page-wide edits.
9. Re-render and produce fresh geometry/pixel evidence.
10. Verify responsive states separately; one desktop screenshot is not proof of responsive correctness.

Tolerance must come from the task/reference, not from loosening the checker until it passes.
