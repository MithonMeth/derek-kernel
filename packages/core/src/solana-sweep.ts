import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnCheckedInstruction,
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync
} from "@solana/spl-token";
import type { SweepExecutor, SweepPlan } from "./sweeper.js";
import { SweepConfigError } from "./sweeper.js";

export interface SolanaSweeperOptions {
  rpcUrl: string;
  mint: string;
  decimals: number;
  treasuryAddress: string;
  airdropAddress: string;
  /**
   * Pays network fees and any rent for destination accounts. A deposit
   * address holds only tokens and no SOL, so it cannot pay for its own
   * transaction — Solana lets a different account be the fee payer, which
   * avoids having to pre-fund thousands of throwaway addresses.
   */
  feePayerSecret: Uint8Array;
}

/**
 * Burns the burn share outright rather than sending it to an incinerator
 * address: the SPL burn instruction reduces total supply on chain, which is
 * what "burned" ought to mean and is independently verifiable. It also needs
 * no destination account and no rent.
 */
export class SolanaSweepExecutor implements SweepExecutor {
  private connection: Connection;
  private mint: PublicKey;
  private treasury: PublicKey;
  private airdrops: PublicKey;
  private feePayer: Keypair;
  private decimals: number;

  constructor(opts: SolanaSweeperOptions) {
    this.connection = new Connection(opts.rpcUrl, "confirmed");
    this.mint = new PublicKey(opts.mint);
    this.treasury = new PublicKey(opts.treasuryAddress);
    this.airdrops = new PublicKey(opts.airdropAddress);
    this.decimals = opts.decimals;
    this.feePayer = Keypair.fromSecretKey(opts.feePayerSecret);
  }

  async execute(plan: SweepPlan, signingSeed: Buffer): Promise<string> {
    const owner = Keypair.fromSeed(signingSeed);
    const tx = this.buildTransaction(plan, owner);
    return sendAndConfirmTransaction(this.connection, tx, [this.feePayer, owner], {
      commitment: "confirmed",
      maxRetries: 3
    });
  }

  /**
   * Split out from execute() so the instruction list - which is the part
   * that decides where money goes - can be asserted without a chain.
   */
  buildTransaction(plan: SweepPlan, owner: Keypair): Transaction {
    if (owner.publicKey.toBase58() !== plan.address) {
      // The advertised address and the signing key must be the same account.
      // If they ever diverge, stop rather than send into the void.
      throw new SweepConfigError(
        `derivation mismatch for ${plan.docketId}: signer is ${owner.publicKey.toBase58()}`
      );
    }

    const source = getAssociatedTokenAddressSync(this.mint, owner.publicKey, true);
    const treasuryAta = getAssociatedTokenAddressSync(this.mint, this.treasury, true);
    const airdropAta = getAssociatedTokenAddressSync(this.mint, this.airdrops, true);

    const tx = new Transaction();

    // Idempotent: creating an account that already exists is a no-op rather
    // than a failed transaction, so this is safe to include on every sweep.
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        this.feePayer.publicKey, treasuryAta, this.treasury, this.mint
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        this.feePayer.publicKey, airdropAta, this.airdrops, this.mint
      )
    );

    if (plan.burn > 0n) {
      tx.add(
        createBurnCheckedInstruction(source, this.mint, owner.publicKey, plan.burn, this.decimals)
      );
    }
    if (plan.treasury > 0n) {
      tx.add(
        createTransferCheckedInstruction(
          source, this.mint, treasuryAta, owner.publicKey, plan.treasury, this.decimals
        )
      );
    }
    if (plan.airdrops > 0n) {
      tx.add(
        createTransferCheckedInstruction(
          source, this.mint, airdropAta, owner.publicKey, plan.airdrops, this.decimals
        )
      );
    }

    // The deposit account is finished with. Closing it releases the ~0.002
    // SOL of rent that was locked when the account was created, and that
    // goes back to the fee payer rather than to airdrops.
    //
    // This is what makes sweeping self-funding. A sweep costs two
    // signatures - on the order of 0.00001 SOL - and returns around 0.002,
    // so the fee payer gains roughly 0.002 SOL per swept docket instead of
    // draining and needing to be topped up by hand. The two destination
    // token accounts are created once, out of the same wallet, and are
    // no-ops on every sweep after the first.
    tx.add(createCloseAccountInstruction(source, this.feePayer.publicKey, owner.publicKey));

    tx.feePayer = this.feePayer.publicKey;
    return tx;
  }
}
