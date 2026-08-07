import type { DB } from "./db.js";
import { kvGet, kvSet } from "./db.js";

/**
 * USD per GBP, cached for a day. Derek rules in pounds; precision here does
 * not matter (the guide's words), so a daily ECB-derived rate is plenty.
 */
export async function getUsdPerGbp(db: DB, fallback: number): Promise<number> {
  const day = new Date().toISOString().slice(0, 10);
  const cached = kvGet(db, "fx_usd_per_gbp");
  if (cached) {
    const { d, rate } = JSON.parse(cached) as { d: string; rate: number };
    if (d === day && rate > 0) return rate;
  }

  try {
    const res = await fetch("https://api.frankfurter.dev/v1/latest?base=GBP&symbols=USD");
    if (!res.ok) throw new Error(`frankfurter HTTP ${res.status}`);
    const body = (await res.json()) as { rates?: { USD?: number } };
    const rate = Number(body.rates?.USD);
    if (rate > 0) {
      kvSet(db, "fx_usd_per_gbp", JSON.stringify({ d: day, rate }));
      return rate;
    }
    throw new Error("frankfurter: no USD rate in response");
  } catch {
    if (cached) {
      const { rate } = JSON.parse(cached) as { rate: number };
      if (rate > 0) return rate; // yesterday's rate beats a hardcoded one
    }
    return fallback;
  }
}
