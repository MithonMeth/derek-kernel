/**
 * Minimal operator surface. Runs against the same database file as the
 * server, so on Heroku run it via `heroku run` only when the web process
 * embeds the worker is not in play — locally it is just `npm run admin`.
 *
 *   admin status                 counts, spend, stuck dockets
 *   admin rule <proposals.json>  push proposals through the pipeline, no payment
 *   admin pause | unpause        flip intake without a redeploy
 *   admin approve <docket>       countersign a pending approval, mint claim code
 *   admin claim-paid <code> <tx> record the multisig payout
 *   admin queue                  print manual-queue posts ready for X
 *   admin mark-posted <docket> <postId>
 */
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import {
  Runtime,
  buildPostText,
  createClaim,
  createLogger,
  currentCycle,
  cycleSlotFree,
  getUsdPerGbp,
  loadConfig,
  markClaimPaid,
  todaySpendUsd
} from "@derek/core";

const log = createLogger("derek-admin");
const cfg = loadConfig();
const runtime = new Runtime(
  cfg,
  fileURLToPath(new URL("../../../constitution", import.meta.url)),
  log
);
const db = runtime.db;
const [, , command, arg1, arg2] = process.argv;

async function main(): Promise<void> {
  switch (command) {
    case "status": {
      const dockets = db
        .prepare("SELECT status, COUNT(*) n FROM dockets GROUP BY status")
        .all() as Array<{ status: string; n: number }>;
      const stuck = db
        .prepare("SELECT id FROM dockets WHERE status = 'paid' AND judge_attempts >= 3")
        .all() as Array<{ id: string }>;
      const pending = db
        .prepare("SELECT docket_id FROM rulings WHERE review_status = 'pending_review'")
        .all() as Array<{ docket_id: string }>;
      console.log("paused:", runtime.isPaused());
      console.log("dockets:", dockets.map((d) => `${d.status}=${d.n}`).join(" ") || "none");
      console.log("today's API spend: $" + todaySpendUsd(db).toFixed(4));
      console.log("stuck (needs human):", stuck.map((s) => s.id).join(" ") || "none");
      console.log("pending approval:", pending.map((p) => p.docket_id).join(" ") || "none");
      break;
    }
    case "pause":
    case "unpause": {
      runtime.setPaused(command === "pause");
      console.log("paused:", runtime.isPaused());
      break;
    }
    case "approve": {
      if (!arg1) throw new Error("usage: admin approve <docketId>");
      const ruling = db
        .prepare(
          "SELECT award_gbp, cycle FROM rulings WHERE docket_id = ? AND verdict = 'approved' AND review_status = 'pending_review'"
        )
        .get(arg1) as { award_gbp: number; cycle: number | null } | undefined;
      if (!ruling) throw new Error(`${arg1} has no approval pending review`);
      // The constitution's one-approval-per-cycle limit binds the operator
      // too, or countersigning two held rulings would quietly break it.
      const rulingCycle = ruling.cycle ?? currentCycle(db);
      if (!cycleSlotFree(db, rulingCycle, runtime.constitution.limits.approvals_per_cycle)) {
        throw new Error(
          `cycle ${rulingCycle} has already issued its approval; this one cannot be countersigned into it`
        );
      }
      const price = runtime.oracle.current();
      if (!price) throw new Error("no live price — cannot lock the token amount; try again when the oracle has a tick");
      const usdPerGbp = await getUsdPerGbp(db, cfg.FX_FALLBACK_GBP_USD);
      const claim = createClaim(
        db,
        arg1,
        ruling.award_gbp,
        price.priceUsd,
        usdPerGbp,
        cfg.TOKEN_DECIMALS,
        cfg.CLAIM_EXPIRY_DAYS
      );
      db.prepare("UPDATE rulings SET review_status = 'confirmed' WHERE docket_id = ?").run(arg1);
      console.log(`countersigned ${arg1}; claim code: ${claim.code}`);
      break;
    }
    case "claim-paid": {
      if (!arg1 || !arg2) throw new Error("usage: admin claim-paid <code> <tx>");
      markClaimPaid(db, arg1, arg2);
      console.log("recorded");
      break;
    }
    case "rule": {
      if (!arg1) throw new Error("usage: admin rule <proposals.json>");
      const raw = JSON.parse(readFileSync(arg1, "utf8")) as unknown;
      const list = (Array.isArray(raw) ? raw : [raw]) as Array<{
        title: string;
        amountGbp: number;
        body: string;
      }>;

      for (const p of list) {
        if (!p || typeof p.title !== "string" || typeof p.body !== "string") {
          throw new Error("each proposal needs title, amountGbp and body");
        }
        const r = await runtime.dryRun(p);
        const award =
          r.verdict === "approved" ? `£${r.awardGbp}` : r.awardGbp === null ? "£0" : String(r.awardGbp);

        console.log("\n" + "=".repeat(72));
        console.log(`${r.docketId}  ${r.verdict.toUpperCase()}  ${award}` +
          `   gates ${r.gatesPassed}/5   cycle ${r.cycle}` +
          (r.review === "pending_review" ? "   [held for countersign]" : ""));
        console.log(`${p.title}  ·  requested £${p.amountGbp}`);
        if (r.flags.length) console.log(`flags: ${r.flags.join(", ")}`);
        console.log("-".repeat(72));
        console.log(r.rulingText);
        console.log("-".repeat(72));
        console.log(`line: "${r.rulingLine}"`);
        console.log(`cost: $${r.costUsd.toFixed(4)}`);
      }
      console.log(`\n${list.length} ruling(s). Today's spend: $${todaySpendUsd(db).toFixed(4)}`);
      break;
    }
    case "queue": {
      const rows = db
        .prepare(
          `SELECT r.docket_id, r.verdict, r.ruling_line, d.fee_tokens, p.amount_gbp, r.award_gbp
           FROM rulings r JOIN dockets d ON d.id = r.docket_id JOIN proposals p ON p.id = d.proposal_id
           WHERE r.post_status = 'queued_manual'`
        )
        .all() as never[];
      if (rows.length === 0) console.log("queue empty");
      for (const row of rows) {
        console.log("----");
        console.log(
          buildPostText(row, {
            siteUrl: cfg.SITE_URL,
            tokenDecimals: cfg.TOKEN_DECIMALS,
            burnFraction: runtime.constitution.limits.fee_split.burn
          })
        );
      }
      break;
    }
    case "mark-posted": {
      if (!arg1 || !arg2) throw new Error("usage: admin mark-posted <docketId> <postId>");
      db.prepare("UPDATE rulings SET post_status = 'posted', post_id = ? WHERE docket_id = ?").run(arg2, arg1);
      console.log("recorded");
      break;
    }
    default:
      console.log("commands: status | pause | unpause | approve <docket> | claim-paid <code> <tx> | queue | mark-posted <docket> <postId>");
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
