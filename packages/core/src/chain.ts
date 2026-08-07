/**
 * The one seam between Derek and the chain. Everything above this interface
 * is testable without an RPC; the Solana implementation below is the only
 * code that talks to the network.
 */
export interface ChainClient {
  /** Total balance of `mint` held by `owner`, in base units. */
  getTokenBalanceBase(owner: string, mint: string): Promise<bigint>;
  /** Most recent transaction signature touching `owner`, if any. */
  getLatestSignature(owner: string): Promise<string | null>;
}

export class SolanaRpcClient implements ChainClient {
  constructor(private rpcUrl: string) {}

  private async rpc(method: string, params: unknown[]): Promise<unknown> {
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
    if (!res.ok) throw new Error(`rpc ${method} -> HTTP ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (body.error) throw new Error(`rpc ${method}: ${body.error.message}`);
    return body.result;
  }

  async getTokenBalanceBase(owner: string, mint: string): Promise<bigint> {
    const result = (await this.rpc("getTokenAccountsByOwner", [
      owner,
      { mint },
      { encoding: "jsonParsed" }
    ])) as {
      value?: Array<{
        account?: {
          data?: { parsed?: { info?: { tokenAmount?: { amount?: string } } } };
        };
      }>;
    };
    let total = 0n;
    for (const entry of result.value ?? []) {
      const amount = entry.account?.data?.parsed?.info?.tokenAmount?.amount;
      if (amount && /^\d+$/.test(amount)) total += BigInt(amount);
    }
    return total;
  }

  async getLatestSignature(owner: string): Promise<string | null> {
    const result = (await this.rpc("getSignaturesForAddress", [owner, { limit: 1 }])) as Array<{
      signature?: string;
    }>;
    return result?.[0]?.signature ?? null;
  }
}

/** Test double: balances are set directly, signatures are canned. */
export class FakeChainClient implements ChainClient {
  private balances = new Map<string, bigint>();

  setBalance(owner: string, base: bigint): void {
    this.balances.set(owner, base);
  }

  async getTokenBalanceBase(owner: string): Promise<bigint> {
    return this.balances.get(owner) ?? 0n;
  }

  async getLatestSignature(owner: string): Promise<string | null> {
    return this.balances.has(owner) ? `fake-tx-${owner.slice(0, 8)}` : null;
  }
}
