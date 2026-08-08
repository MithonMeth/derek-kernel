import { describe, expect, it, vi } from "vitest";
import { checkSweepFeePayer } from "../src/runtime.js";
import { base58Encode } from "../src/base58.js";
import { ed25519 } from "@noble/curves/ed25519";

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
}

/** A well-formed Solana secret key: 32-byte seed followed by its public key. */
function validKey(seedByte: number): { secret: string; pub: string } {
  const seed = new Uint8Array(32).fill(seedByte);
  const pub = ed25519.getPublicKey(seed);
  const full = new Uint8Array(64);
  full.set(seed, 0);
  full.set(pub, 32);
  return { secret: base58Encode(full), pub: base58Encode(pub) };
}

describe("sweep fee payer validation", () => {
  it("accepts a well-formed key and reports the public key it resolves to", () => {
    const { secret, pub } = validKey(7);
    const log = logger();
    // The operator needs the public key to check against the wallet they
    // funded; without it a wrong-but-valid key is invisible until a sweep.
    expect(checkSweepFeePayer(secret, log)).toBe(pub);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("is quiet and disables sweeping when no key is configured", () => {
    const log = logger();
    expect(checkSweepFeePayer(undefined, log)).toBeNull();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("rejects a key that is not base58 without throwing", () => {
    const log = logger();
    expect(checkSweepFeePayer("not-base58-0OIl!", log)).toBeNull();
    expect(log.error).toHaveBeenCalled();
  });

  it("rejects a key of the wrong length", () => {
    const log = logger();
    // 32 bytes: a seed pasted where the full keypair was wanted. This is the
    // realistic typo, and it decodes cleanly, so length is the only signal.
    expect(checkSweepFeePayer(base58Encode(new Uint8Array(32).fill(3)), log)).toBeNull();
    expect(log.error).toHaveBeenCalled();
  });

  it("rejects a key whose stored public half does not match its seed", () => {
    // Correct length, valid base58, but the seed and the stored public key
    // come from different keypairs. Every signature it produced would be
    // rejected on-chain, and length checks alone would wave it through.
    const seed = new Uint8Array(32).fill(1);
    const wrongPub = ed25519.getPublicKey(new Uint8Array(32).fill(2));
    const spliced = new Uint8Array(64);
    spliced.set(seed, 0);
    spliced.set(wrongPub, 32);

    const log = logger();
    expect(checkSweepFeePayer(base58Encode(spliced), log)).toBeNull();
    expect(log.error).toHaveBeenCalled();
  });
});

describe("automatic sweeping is opt-in", () => {
  it("defaults off, so a mint address alone never starts moving money", async () => {
    const { loadConfig } = await import("../src/config.js");
    expect(loadConfig({} as NodeJS.ProcessEnv).SWEEP_AUTO).toBe(false);
    expect(loadConfig({ TOKEN_MINT_ADDRESS: "mint" } as NodeJS.ProcessEnv).SWEEP_AUTO).toBe(false);
    expect(loadConfig({ SWEEP_AUTO: "true" } as NodeJS.ProcessEnv).SWEEP_AUTO).toBe(true);
  });
});
