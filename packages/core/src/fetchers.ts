import type { PriceFetcher, PriceObservation } from "./oracle.js";

/**
 * Route shapes verified against docs.dexscreener.com and docs.dexpaprika.com
 * on 2026-08-07. DexScreener: 60 req/min, no key; back off exponentially on
 * 429 per their guidance.
 */

async function getJson(url: string, retries = 3): Promise<unknown> {
  let delay = 2000;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (res.status === 429 && attempt < retries) {
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2; // 2s, 4s, 8s
      continue;
    }
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return res.json();
  }
}

/** GET /tokens/v1/{chainId}/{tokenAddresses} — returns an array of pairs. */
export function dexScreenerFetcher(chainId: string, mint: string): PriceFetcher {
  return async (): Promise<PriceObservation> => {
    const body = (await getJson(
      `https://api.dexscreener.com/tokens/v1/${chainId}/${mint}`
    )) as Array<{
      priceUsd?: string | null;
      liquidity?: { usd?: number | null } | null;
    }>;
    if (!Array.isArray(body) || body.length === 0) throw new Error("dexscreener: no pairs");

    // Highest-liquidity pair wins. New tokens accumulate junk pairs and the
    // first element is not a meaningful ordering.
    let best: { price: number; liq: number } | null = null;
    for (const pair of body) {
      const price = Number(pair.priceUsd);
      const liq = Number(pair.liquidity?.usd ?? 0);
      if (!(price > 0)) continue;
      if (!best || liq > best.liq) best = { price, liq };
    }
    if (!best) throw new Error("dexscreener: no pair with a usable priceUsd");
    return {
      priceUsd: best.price,
      liquidityUsd: best.liq,
      source: "dexscreener",
      observedAt: Date.now()
    };
  };
}

/** GET /networks/{network}/tokens/{address} — summary.price_usd / summary.liquidity_usd. */
export function dexPaprikaFetcher(network: string, mint: string): PriceFetcher {
  return async (): Promise<PriceObservation> => {
    const body = (await getJson(
      `https://api.dexpaprika.com/networks/${network}/tokens/${mint}`
    )) as { summary?: { price_usd?: number; liquidity_usd?: number } };
    const price = Number(body.summary?.price_usd);
    const liq = Number(body.summary?.liquidity_usd ?? 0);
    if (!(price > 0)) throw new Error("dexpaprika: no usable price_usd");
    return { priceUsd: price, liquidityUsd: liq, source: "dexpaprika", observedAt: Date.now() };
  };
}
