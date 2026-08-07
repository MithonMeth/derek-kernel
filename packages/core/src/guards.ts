import { z } from "zod";
import type { Limits } from "./constitution.js";

export class GuardError extends Error {}

export type Verdict = "approved" | "rejected" | "void";

export interface FinalRuling {
  verdict: Verdict;
  awardGbp: number | null;
  gatesPassed: number;
  rulingLine: string;
  rulingText: string;
  flags: string[];
}

const RawRulingSchema = z.object({
  verdict: z.enum(["approved", "rejected", "void"]),
  award_gbp: z.number().finite(),
  gates_passed: z.number(),
  ruling_line: z.string().min(1),
  ruling_text: z.string().min(1)
});

/**
 * Strips anything that could turn a published ruling into a payload: URLs,
 * @mentions, and base58 runs long enough to be a wallet address. The
 * publisher strips again before posting — defence in depth, not redundancy.
 */
export function sanitizePublishedText(s: string, maxLen: number): string {
  return s
    .replace(/https?:\/\/\S+/gi, "[link removed]")
    .replace(/\bwww\.\S+/gi, "[link removed]")
    .replace(/@[A-Za-z0-9_]{2,}/g, "[mention removed]")
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g, "[address removed]")
    .slice(0, maxLen)
    .trim();
}

/**
 * The model proposes; this function disposes. Every number that leaves here
 * is bounded by the constitution and the treasury, no matter what the model
 * said. A fully compromised model response must not be able to move more
 * money than the rules allow — that is the invariant the tests pin.
 */
export function clampRuling(
  raw: unknown,
  ctx: {
    limits: Limits;
    capGbp: number;
    amountRequestedGbp: number;
    screeningFlags: string[];
  }
): FinalRuling {
  const parsed = RawRulingSchema.safeParse(raw);
  if (!parsed.success) {
    throw new GuardError(`model output failed schema: ${parsed.error.message}`);
  }
  const r = parsed.data;

  const rulingLine = sanitizePublishedText(r.ruling_line, 200);
  const rulingText = sanitizePublishedText(r.ruling_text, 4000);
  if (!rulingLine || !rulingText) {
    throw new GuardError("ruling text empty after sanitization");
  }

  const gatesPassed = Math.min(5, Math.max(0, Math.round(r.gates_passed) || 0));

  // A flagged submission is void regardless of what the ruling model said.
  // The screening result is the cheaper, harder-to-poison signal, and a
  // poisoned ruling model must not be able to override it.
  if (ctx.screeningFlags.length > 0) {
    return {
      verdict: "void",
      awardGbp: null,
      gatesPassed: 0,
      rulingLine,
      rulingText,
      flags: ctx.screeningFlags
    };
  }

  if (r.verdict !== "approved") {
    return {
      verdict: r.verdict,
      awardGbp: null,
      gatesPassed,
      rulingLine,
      rulingText,
      flags: []
    };
  }

  // Approved: the award is bounded by what was asked, the constitutional
  // cap, and the treasury fraction cap — whichever is smallest.
  const ceiling = Math.min(ctx.amountRequestedGbp, ctx.limits.max_award_gbp, ctx.capGbp);
  const award = Math.round(Math.min(r.award_gbp, ceiling) * 100) / 100;

  if (!Number.isFinite(award) || award < ctx.limits.min_award_gbp) {
    // No defensible award exists (tiny treasury, absurd model number).
    // Approving £0 or a negative number is worse than rejecting.
    return {
      verdict: "rejected",
      awardGbp: null,
      gatesPassed,
      rulingLine,
      rulingText,
      flags: []
    };
  }

  return {
    verdict: "approved",
    awardGbp: award,
    gatesPassed: 5,
    rulingLine,
    rulingText,
    flags: []
  };
}
