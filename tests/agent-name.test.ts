import { describe, expect, it } from "vitest";
import { agentName } from "../src/slack-daemon.js";

describe("agentName", () => {
  it("keeps a name herdr accepts", () => {
    expect(agentName("york-can-you-pls-check")).toBe("york-can-you-pls-check");
  });
  it("cuts a long question down to 32 characters, with no trailing dash", () => {
    const name = agentName("york-clarification-regarding-mirna-and");
    expect(name).toBe("york-clarification-regarding-mir");
    expect(name.length).toBeLessThanOrEqual(32);
  });
  it("starts with a lowercase letter and drops anything else", () => {
    expect(agentName("2026 Review! (draft)")).toBe("review-draft");
    expect(agentName("...", "york")).toBe("york");
  });
});
