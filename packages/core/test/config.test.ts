import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";

const GOOD = "ab".repeat(32); // 64 hex chars

describe("config loading", () => {
  it("accepts a well-formed seed", () => {
    expect(loadConfig({ DEPOSIT_MASTER_SEED: GOOD } as NodeJS.ProcessEnv).DEPOSIT_MASTER_SEED)
      .toBe(GOOD);
  });

  it("trims whitespace, because a pasted value arrives with a newline", () => {
    const cfg = loadConfig({ DEPOSIT_MASTER_SEED: `  ${GOOD}\n` } as NodeJS.ProcessEnv);
    expect(cfg.DEPOSIT_MASTER_SEED).toBe(GOOD);
  });

  it("disables deposits rather than crashing when the seed is malformed", () => {
    // This exact input - two 64-char seeds joined by a newline - took the
    // live site down: config threw before the HTTP server existed, so the
    // ledger and every ruling went with it over one optional secret.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const bad of [`${GOOD}\n${GOOD}`, "nothex".repeat(11), "abc", "z".repeat(64)]) {
      const cfg = loadConfig({ DEPOSIT_MASTER_SEED: bad } as NodeJS.ProcessEnv);
      expect(cfg.DEPOSIT_MASTER_SEED).toBeUndefined();
    }
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("a malformed seed leaves every other setting working", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const cfg = loadConfig({
      DEPOSIT_MASTER_SEED: `${GOOD}\n${GOOD}`,
      FEE_TARGET_USD: "2",
      TREASURY_ADDRESS: "treasury"
    } as NodeJS.ProcessEnv);
    expect(cfg.FEE_TARGET_USD).toBe(2);
    expect(cfg.TREASURY_ADDRESS).toBe("treasury");
    err.mockRestore();
  });

  it("still rejects genuinely invalid settings that are not optional secrets", () => {
    // The tolerance is deliberately narrow: a bad number is still fatal.
    expect(() => loadConfig({ FEE_TARGET_USD: "-5" } as NodeJS.ProcessEnv)).toThrow();
  });
});
