import { describe, expect, it } from "vitest";
import { renderRulingCard, type CardRuling } from "../src/cards.js";

const BASE: CardRuling = {
  docketId: "D-14",
  verdict: "rejected",
  rulingLine: "There is no object in this proposal. There are nine adjectives.",
  amountUsd: 340,
  awardUsd: null,
  burnedTokens: "25,000",
  siteHost: "derek-kernel.xyz"
};

function png(over: Partial<CardRuling> = {}): Buffer {
  return renderRulingCard({ ...BASE, ...over });
}

describe("ruling cards", () => {
  it("renders a real PNG at X's card size", () => {
    const b = png();
    expect(b.subarray(1, 4).toString()).toBe("PNG");
    // IHDR width/height are big-endian uint32 at offsets 16 and 20.
    expect(b.readUInt32BE(16)).toBe(2400); // 1200 at 2x
    expect(b.readUInt32BE(20)).toBe(1256); // 628 at 2x
  });

  it("renders approved and rejected differently", () => {
    expect(png({ verdict: "approved", awardUsd: 340 }).equals(png())).toBe(false);
  });

  it("survives a ruling line far longer than the card", () => {
    const b = png({ rulingLine: "adjective ".repeat(200) });
    expect(b.subarray(1, 4).toString()).toBe("PNG");
    expect(b.length).toBeGreaterThan(1000);
  });

  it("survives an empty line, one word, and unicode", () => {
    for (const rulingLine of ["", "No.", "Rejeté — naïve ✋ £€"]) {
      expect(png({ rulingLine }).subarray(1, 4).toString()).toBe("PNG");
    }
  });

  it("is deterministic, so the cached endpoint cannot serve two versions", () => {
    expect(png().equals(png())).toBe(true);
  });

  it("does not render a URL, mention, or address smuggled into the ruling line", () => {
    // The renderer sanitises the same way the post text does: a URL or a
    // mention is replaced by a marker, not silently dropped. A card is the
    // most shareable surface here, so a smuggled link would travel furthest.
    const dirty = png({ rulingLine: "Rejected. See https://evil.example and @scammer." });
    const marked = png({ rulingLine: "Rejected. See [link removed] and [mention removed]." });
    expect(dirty.equals(marked)).toBe(true);
    // ...and definitely not the same as leaving the link in.
    expect(dirty.equals(png({ rulingLine: "Rejected. See https://evil.example and @scammer" }))).toBe(false);
  });
});

describe("submitter handle", () => {
  it("accepts a plain handle, with or without the @", async () => {
    const { normaliseHandle } = await import("../src/cards.js");
    expect(normaliseHandle("@dave")).toBe("dave");
    expect(normaliseHandle("  dave_99 ")).toBe("dave_99");
    expect(normaliseHandle("@@dave")).toBe("dave");
  });

  it("drops anything that is not a real handle", async () => {
    const { normaliseHandle } = await import("../src/cards.js");
    for (const bad of [
      "",
      null,
      undefined,
      "a".repeat(16),            // handles cap at 15
      "has space",
      "semi;colon",
      "emoji😀",
      "<script>alert(1)</script>",
      "elon musk (real)"
    ]) {
      expect(normaliseHandle(bad as string)).toBeNull();
    }
  });

  it("puts a valid handle on the card and a rejected one nowhere", () => {
    const withHandle = png({ xHandle: "dave" });
    const without = png({ xHandle: null });
    expect(withHandle.equals(without)).toBe(false);
    // Junk is dropped, so the card is byte-identical to having none at all.
    expect(png({ xHandle: "not a handle!" }).equals(without)).toBe(true);
  });
});
