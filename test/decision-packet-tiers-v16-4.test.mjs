import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PACKET_EMERGENCY_CEILING_CHARS,
  PACKET_TIER,
  PACKET_TIER_BUDGET,
  expandPacketSections,
  selectPacketTier,
} from "../lib/decision-packet-tiers.mjs";
import { DECISION_PACKET_SECTION } from "../lib/decision-packet.mjs";

describe("adaptive decision packet (V16.4 slice E)", () => {
  it("selects small for grounded single-file work", () => {
    assert.equal(selectPacketTier({ affectedSubsystems: 1, evidenceCount: 1 }), PACKET_TIER.SMALL);
    assert.ok(PACKET_TIER_BUDGET.small.maxPacketChars <= 10_000);
  });

  it("selects medium for ambiguous multi-file work", () => {
    assert.equal(selectPacketTier({ affectedSubsystems: 2, ambiguous: true }), PACKET_TIER.MEDIUM);
    assert.ok(PACKET_TIER_BUDGET.medium.maxPacketChars <= 20_000);
  });

  it("selects large for architectural / verifier-history work", () => {
    assert.equal(selectPacketTier({ architecturalWork: true }), PACKET_TIER.LARGE);
    assert.equal(selectPacketTier({ verifierRetries: 2 }), PACKET_TIER.LARGE);
    assert.equal(selectPacketTier({ affectedSubsystems: 3 }), PACKET_TIER.LARGE);
    assert.ok(PACKET_TIER_BUDGET.large.maxPacketChars <= 36_000);
  });

  it("emergency ceiling stays 48k", () => {
    assert.equal(PACKET_EMERGENCY_CEILING_CHARS, 48_000);
  });

  it("first send covers essentials; expansion sends only missing sections", () => {
    const essential = [
      DECISION_PACKET_SECTION.ORIGINAL_TASK,
      DECISION_PACKET_SECTION.REQUIREMENT_SUMMARY,
      DECISION_PACKET_SECTION.CONSTRAINTS,
      DECISION_PACKET_SECTION.VERIFICATION,
    ];
    const first = expandPacketSections({ essential, firstSend: true });
    assert.deepEqual(first, essential);
    const expansion = expandPacketSections({
      sectionsSent: [...essential, DECISION_PACKET_SECTION.CURRENT_DIFF],
      delta: { changed: true, changedSections: ["currentDiff", "exactRelevantSnippets"] },
    });
    assert.deepEqual(expansion, ["exactRelevantSnippets"]);
    assert.deepEqual(expandPacketSections({ sectionsSent: essential, delta: { changed: false } }), []);
  });
});
