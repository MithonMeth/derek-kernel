/**
 * Token amounts live as base-unit strings in the database and BigInt in
 * memory. They must never pass through a JS number: 9-decimal tokens
 * overflow double precision silently.
 */

export function wholeTokensToBase(whole: bigint, decimals: number): bigint {
  return whole * 10n ** BigInt(decimals);
}

export function baseToWholeTokens(base: bigint, decimals: number): bigint {
  return base / 10n ** BigInt(decimals);
}

/** "12345678" -> "12,345,678" for display, whole tokens only. */
export function formatWholeTokens(base: bigint, decimals: number): string {
  const whole = baseToWholeTokens(base < 0n ? -base : base, decimals).toString();
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return base < 0n ? `-${grouped}` : grouped;
}

/** Base units valued in USD. Only for display/valuation — never fed back into amounts. */
export function baseToUsd(base: bigint, decimals: number, priceUsd: number): number {
  // Split into whole tokens + fractional part so the bigint→number cast
  // stays within safe integer range for any sane supply.
  const div = 10n ** BigInt(decimals);
  const whole = Number(base / div);
  const frac = Number(base % div) / Number(div);
  return (whole + frac) * priceUsd;
}

export function parseBase(s: string): bigint {
  if (!/^-?\d+$/.test(s)) throw new Error(`not a base-unit amount: ${JSON.stringify(s)}`);
  return BigInt(s);
}
