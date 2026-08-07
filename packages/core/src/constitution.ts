import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { z } from "zod";

const LimitsSchema = z
  .object({
    version: z.number().int().positive(),
    max_award_gbp: z.number().positive(),
    min_award_gbp: z.number().positive(),
    treasury_fraction_cap: z.number().gt(0).lte(1),
    claim_expiry_days: z.number().int().positive(),
    fee_split: z.object({
      burn: z.number().min(0).max(1),
      treasury: z.number().min(0).max(1),
      ops: z.number().min(0).max(1)
    })
  })
  .refine((l) => l.min_award_gbp <= l.max_award_gbp, "min award exceeds max award")
  .refine(
    (l) => Math.abs(l.fee_split.burn + l.fee_split.treasury + l.fee_split.ops - 1) < 1e-9,
    "fee split must sum to 1"
  );

export type Limits = z.infer<typeof LimitsSchema>;

export interface Constitution {
  text: string;
  limits: Limits;
  sha256: string;
  commit: string | null;
}

export class ConstitutionError extends Error {}

/**
 * Loads and validates the constitution at boot. Any failure here must
 * prevent startup: Derek does not rule under a constitution he cannot read.
 */
export function loadConstitution(dir: string): Constitution {
  let text: string;
  let limitsRaw: string;
  try {
    text = readFileSync(join(dir, "CONSTITUTION.md"), "utf8");
    limitsRaw = readFileSync(join(dir, "LIMITS.json"), "utf8");
  } catch (e) {
    throw new ConstitutionError(`constitution unreadable: ${(e as Error).message}`);
  }

  let limits: Limits;
  try {
    limits = LimitsSchema.parse(JSON.parse(limitsRaw));
  } catch (e) {
    throw new ConstitutionError(`LIMITS.json invalid: ${(e as Error).message}`);
  }

  assertProseMatchesLimits(text, limits);

  const sha256 = createHash("sha256").update(text).update("\0").update(limitsRaw).digest("hex");

  let commit: string | null = null;
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  } catch {
    commit = null; // not a git checkout (e.g. Heroku slug) — hash still pins the content
  }

  return { text, limits, sha256, commit };
}

/**
 * The prose and LIMITS.json describe the same rules. If they drift apart,
 * one of them is lying, and Derek must not boot until a human decides which.
 */
export function assertProseMatchesLimits(text: string, limits: Limits): void {
  const expect: Array<[string, string]> = [
    [`£${limits.max_award_gbp}`, "max award"],
    [`£${limits.min_award_gbp}`, "min award"],
    [`${limits.treasury_fraction_cap * 100}%`, "treasury fraction cap"],
    [`${limits.claim_expiry_days} days`, "claim expiry"],
    [`${limits.fee_split.burn * 100}%`, "burn split"],
    [`${limits.fee_split.treasury * 100}%`, "treasury split"],
    [`${limits.fee_split.ops * 100}%`, "ops split"]
  ];
  for (const [needle, what] of expect) {
    if (!text.includes(needle)) {
      throw new ConstitutionError(
        `constitution prose does not state the ${what} (${needle}) from LIMITS.json`
      );
    }
  }
}
