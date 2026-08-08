import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  decodeCloseAccountInstruction
} from "@solana/spl-token";
import { SolanaSweepExecutor } from "../src/solana-sweep.js";

const MINT = "So11111111111111111111111111111111111111112";
const TREASURY = Keypair.generate().publicKey.toBase58();
const AIRDROPS = Keypair.generate().publicKey.toBase58();
const FEE_PAYER = Keypair.generate();

function executor(): SolanaSweepExecutor {
  return new SolanaSweepExecutor({
    rpcUrl: "https://rpc.invalid", // never dialled: buildTransaction is offline
    mint: MINT,
    decimals: 9,
    treasuryAddress: TREASURY,
    airdropAddress: AIRDROPS,
    feePayerSecret: FEE_PAYER.secretKey
  });
}

const owner = Keypair.fromSeed(new Uint8Array(32).fill(9));
const plan = {
  docketId: "D-1",
  address: owner.publicKey.toBase58(),
  total: 1000n,
  burn: 500n,
  treasury: 350n,
  airdrops: 150n
};

describe("sweep transaction", () => {
  it("returns the closed account's rent to the fee payer, not to airdrops", () => {
    // ~0.002 SOL is locked as rent when a deposit token account is created.
    // Sending it back to the fee payer is what stops that wallet draining:
    // a sweep costs ~0.00001 in signatures and returns ~0.002.
    const tx = executor().buildTransaction(plan, owner);
    const close = tx.instructions.find(
      (i) => i.programId.equals(TOKEN_PROGRAM_ID) && i.data[0] === 9 // CloseAccount
    );
    expect(close).toBeTruthy();
    const decoded = decodeCloseAccountInstruction(close!);
    expect(decoded.keys.destination.pubkey.toBase58()).toBe(FEE_PAYER.publicKey.toBase58());
    expect(decoded.keys.destination.pubkey.toBase58()).not.toBe(AIRDROPS);
  });

  it("closes the account last, after the tokens have left it", () => {
    // Closing a non-empty token account fails, taking the whole sweep with
    // it. Ordering is load-bearing, not stylistic.
    const tx = executor().buildTransaction(plan, owner);
    const closeIdx = tx.instructions.findIndex(
      (i) => i.programId.equals(TOKEN_PROGRAM_ID) && i.data[0] === 9
    );
    expect(closeIdx).toBe(tx.instructions.length - 1);
  });

  it("pays network fees from the fee payer, never from the deposit", () => {
    const tx = executor().buildTransaction(plan, owner);
    expect(tx.feePayer?.toBase58()).toBe(FEE_PAYER.publicKey.toBase58());
  });

  it("sends the treasury and airdrop shares to their own token accounts", () => {
    const tx = executor().buildTransaction(plan, owner);
    const dests = tx.instructions.flatMap((i) => i.keys.map((k) => k.pubkey.toBase58()));
    expect(dests).toContain(
      getAssociatedTokenAddressSync(new PublicKey(MINT), new PublicKey(TREASURY), true).toBase58()
    );
    expect(dests).toContain(
      getAssociatedTokenAddressSync(new PublicKey(MINT), new PublicKey(AIRDROPS), true).toBase58()
    );
  });

  it("refuses to sign when the derived signer is not the planned address", () => {
    // A mismatch means the seed and the advertised deposit address have
    // diverged, and signing anyway would send into the void.
    expect(() =>
      executor().buildTransaction({ ...plan, address: Keypair.generate().publicKey.toBase58() }, owner)
    ).toThrow();
  });
});
