import { z } from "zod";
import type { Limits } from "./constitution.js";

export class GuardError extends Error {}

export type Verdict = "approved" | "rejected" | "void";

export interface FinalRuling {
  verdict: Verdict;
  awardUsd: number | null;
  gatesPassed: number;
  rulingLine: string;
  rulingText: string;
  flags: string[];
  /**
   * Set when the clamp overrode the model's verdict. The prose still argues
   * the model's case, so a clamped ruling contradicts itself and must never
   * be published without a human reading it first.
   */
  clamped?: string;
}

const RawRulingSchema = z.object({
  verdict: z.enum(["approved", "rejected", "void"]),
  award_usd: z.number().finite(),
  gates_passed: z.number(),
  ruling_line: z.string().min(1),
  ruling_text: z.string().min(1)
});

/**
 * Strips anything that could turn a published ruling into a payload: URLs,
 * @mentions, and base58 runs long enough to be a wallet address. The
 * publisher strips again before posting — defence in depth, not redundancy.
 *
 * Also strips XML-ish tags. Submissions are wrapped in tags to mark them as
 * untrusted, and the ruling model has been observed mirroring that back —
 * closing a `</ruling_text>` it never opened. Scaffolding must not reach the
 * page or the timeline.
 */
export function sanitizePublishedText(s: string, maxLen: number): string {
  return s
    // Attributes included: a real ruling leaked `<parameter name="ruling_text">`,
    // which a tag pattern without attribute support walks straight past.
    .replace(/<\/?[A-Za-z_][\w:.-]*(\s+[^<>]*?)?\/?>/g, "")
    .replace(/https?:\/\/\S+/gi, "[link removed]")
    .replace(/\bwww\.\S+/gi, "[link removed]")
    .replace(/@[A-Za-z0-9_]{2,}/g, "[mention removed]")
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g, "[address removed]")
    .replace(/[ \t]+\n/g, "\n")
    .slice(0, maxLen)
    .trim();
}

/**
 * The quotable line goes on the share card and the X post, so it has to be
 * one line. A real ruling returned the closing line followed by a whole
 * second ruling; take the first line and leave the rest behind.
 */
export function sanitizeLine(s: string, maxLen: number): string {
  const cleaned = sanitizePublishedText(s, maxLen * 6);
  const first = cleaned.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  return first.slice(0, maxLen).trim();
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
    capUsd: number;
    amountRequestedUsd: number;
    screeningFlags: string[];
  }
): FinalRuling {
  const parsed = RawRulingSchema.safeParse(raw);
  if (!parsed.success) {
    throw new GuardError(`model output failed schema: ${parsed.error.message}`);
  }
  const r = parsed.data;

  const rulingLine = sanitizeLine(r.ruling_line, 200);
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
      awardUsd: null,
      gatesPassed: 0,
      rulingLine,
      rulingText,
      flags: ctx.screeningFlags
    };
  }

  if (r.verdict !== "approved") {
    return {
      verdict: r.verdict,
      awardUsd: null,
      gatesPassed,
      rulingLine,
      rulingText,
      flags: []
    };
  }

  // Approved: the award is bounded by what was asked, the constitutional
  // cap, and the treasury fraction cap — whichever is smallest.
  const ceiling = Math.min(ctx.amountRequestedUsd, ctx.limits.max_award_usd, ctx.capUsd);
  const award = Math.round(Math.min(r.award_usd, ceiling) * 100) / 100;

  if (!Number.isFinite(award) || award < ctx.limits.min_award_usd) {
    // No defensible award exists: below the constitutional floor, or the
    // treasury cannot cover it. The verdict has to change, but the prose
    // still argues for approval — so mark it clamped and let a human read
    // the contradiction rather than publishing it.
    return {
      verdict: "rejected",
      awardUsd: null,
      gatesPassed,
      rulingLine,
      rulingText,
      flags: [],
      clamped: `award of ${award} is below the minimum of ${ctx.limits.min_award_usd}`
    };
  }

  return {
    verdict: "approved",
    awardUsd: award,
    gatesPassed: 5,
    rulingLine,
    rulingText,
    flags: []
  };
}
