import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { z } from "zod";

const LimitsSchema = z
  .object({
    version: z.number().int().positive(),
    // Section 7 of the constitution. These four are restated in the prose and
    // checked against it at boot.
    max_award_usd: z.number().positive(),
    min_award_usd: z.number().positive(),
    treasury_fraction_cap: z.number().gt(0).lte(1),
    approvals_per_cycle: z.number().int().positive(),
    // Operational parameters from the build guide, not the constitution, so
    // they are not prose-checked.
    claim_expiry_days: z.number().int().positive(),
    fee_split: z.object({
      burn: z.number().min(0).max(1),
      treasury: z.number().min(0).max(1),
      airdrops: z.number().min(0).max(1)
    })
  })
  .refine((l) => l.min_award_usd <= l.max_award_usd, "min award exceeds max award")
  .refine(
    (l) => Math.abs(l.fee_split.burn + l.fee_split.treasury + l.fee_split.airdrops - 1) < 1e-9,
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

const group = (n: number): string => n.toLocaleString("en-GB");
/** 0.05 -> "5", without the floating-point tail 0.05 * 100 produces. */
const percent = (f: number): string => String(Number((f * 100).toFixed(6)));

/**
 * Section 7 restates the enforced limits in prose, and says outright that if
 * the two disagree the code is right and the repository is broken. Rather
 * than trust that, refuse to boot: pin each limit to the exact line that
 * states it, so a number can never be changed in one place only.
 */
export function assertProseMatchesLimits(text: string, limits: Limits): void {
  const expect: Array<[string, string]> = [
    [`Maximum per proposal: **${group(limits.max_award_usd)}**`, "maximum per proposal"],
    [
      `Maximum share of Treasury: **${percent(limits.treasury_fraction_cap)}%**`,
      "maximum share of Treasury"
    ],
    [`Minimum award: **${group(limits.min_award_usd)}**`, "minimum award"],
    [`Approvals per cycle: **${limits.approvals_per_cycle}**`, "approvals per cycle"]
  ];
  for (const [needle, what] of expect) {
    if (!text.includes(needle)) {
      throw new ConstitutionError(
        `constitution prose does not state the ${what} from LIMITS.json — expected the line "${needle}"`
      );
    }
  }
}
