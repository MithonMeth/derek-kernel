import { baseToUsd } from "./amounts.js";

export interface TreasuryValuation {
  treasuryUsd: number;
  capGbp: number;
}

/**
 * capGbp = treasuryUsd × fraction ÷ (USD per GBP). The per-ruling award
 * clamp uses this so no single approval can move more than the constitution's
 * fraction of the pot.
 */
export function valueTreasury(
  treasuryBase: bigint,
  decimals: number,
  priceUsd: number,
  usdPerGbp: number,
  fraction: number
): TreasuryValuation {
  const treasuryUsd = baseToUsd(treasuryBase, decimals, priceUsd);
  return { treasuryUsd, capGbp: (treasuryUsd * fraction) / usdPerGbp };
}
