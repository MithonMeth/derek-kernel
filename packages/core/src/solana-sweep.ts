import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
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
  private programId?: PublicKey;
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

  /**
   * Which token program owns the mint, read from the mint account itself
   * and cached. Detected rather than configured: pump.fun mints are
   * Token-2022, older ones are the classic program, and the difference is
   * invisible in the address. Every instruction below, and the associated
   * token address itself, is derived from this - point it at the wrong
   * program and the sweep targets an account that does not exist.
   */
  private async tokenProgram(): Promise<PublicKey> {
    if (this.programId) return this.programId;
    const info = await this.connection.getAccountInfo(this.mint, "confirmed");
    if (!info) throw new SweepConfigError(`mint ${this.mint.toBase58()} not found on chain`);
    if (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      throw new SweepConfigError(`mint is owned by an unknown token program: ${info.owner.toBase58()}`);
    }
    this.programId = info.owner;
    return this.programId;
  }

  async execute(plan: SweepPlan, signingSeed: Buffer): Promise<string> {
    const owner = Keypair.fromSeed(signingSeed);
    const tx = this.buildTransaction(plan, owner, await this.tokenProgram());
    return sendAndConfirmTransaction(this.connection, tx, [this.feePayer, owner], {
      commitment: "confirmed",
      maxRetries: 3
    });
  }

  /**
   * Split out from execute() so the instruction list - which is the part
   * that decides where money goes - can be asserted without a chain.
   */
  buildTransaction(plan: SweepPlan, owner: Keypair, programId: PublicKey): Transaction {
    if (owner.publicKey.toBase58() !== plan.address) {
      // The advertised address and the signing key must be the same account.
      // If they ever diverge, stop rather than send into the void.
      throw new SweepConfigError(
        `derivation mismatch for ${plan.docketId}: signer is ${owner.publicKey.toBase58()}`
      );
    }

    const source = getAssociatedTokenAddressSync(this.mint, owner.publicKey, true, programId);
    const treasuryAta = getAssociatedTokenAddressSync(this.mint, this.treasury, true, programId);
    const airdropAta = getAssociatedTokenAddressSync(this.mint, this.airdrops, true, programId);

    const tx = new Transaction();

    // Idempotent: creating an account that already exists is a no-op rather
    // than a failed transaction, so this is safe to include on every sweep.
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        this.feePayer.publicKey, treasuryAta, this.treasury, this.mint, programId
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        this.feePayer.publicKey, airdropAta, this.airdrops, this.mint, programId
      )
    );

    if (plan.burn > 0n) {
      tx.add(
        createBurnCheckedInstruction(source, this.mint, owner.publicKey, plan.burn, this.decimals, [], programId)
      );
    }
    if (plan.treasury > 0n) {
      tx.add(
        createTransferCheckedInstruction(
          source, this.mint, treasuryAta, owner.publicKey, plan.treasury, this.decimals, [], programId
        )
      );
    }
    if (plan.airdrops > 0n) {
      tx.add(
        createTransferCheckedInstruction(
          source, this.mint, airdropAta, owner.publicKey, plan.airdrops, this.decimals, [], programId
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
    tx.add(createCloseAccountInstruction(source, this.feePayer.publicKey, owner.publicKey, [], programId));

    tx.feePayer = this.feePayer.publicKey;
    return tx;
  }
}
