/**
 * Minimal operator surface. Runs against the same database file as the
 * server, so on Heroku run it via `heroku run` only when the web process
 * embeds the worker is not in play — locally it is just `npm run admin`.
 *
 *   admin status                 counts, spend, stuck dockets
 *   admin rule <proposals.json>  push proposals through the pipeline, no payment
 *   admin sweep [--send]         show what a sweep would move; --send actually moves it
 *   admin pause | unpause        flip intake without a redeploy
 *   admin approve <docket> [--price=<usd>] [--send]
 *                                countersign a held approval and mint a claim
 *                                code; --price locks the amount by hand before
 *                                the token has a market
 *   admin bonded                 check whether the market can price things yet
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
  describePlan,
  loadConfig,
  markClaimPaid,
  todaySpendUsd
} from "@derek/core";

const log = createLogger("derek-admin");
const cfg = loadConfig();
const runtime = await Runtime.create(
  cfg,
  fileURLToPath(new URL("../../../constitution", import.meta.url)),
  log
);
const db = runtime.db;
const [, , command, arg1, arg2] = process.argv;
const args = process.argv.slice(2);

async function main(): Promise<void> {
  switch (command) {
    case "status": {
      const dockets = await db.rows<{ status: string; n: string }>(
        "SELECT status, COUNT(*) AS n FROM dockets GROUP BY status"
      );
      const stuck = await db.rows<{ id: string }>(
        "SELECT id FROM dockets WHERE status = 'paid' AND judge_attempts >= 3"
      );
      const pending = await db.rows<{ docket_id: string }>(
        "SELECT docket_id FROM rulings WHERE review_status = 'pending_review'"
      );
      console.log("cycle:", await currentCycle(db));
      console.log("paused:", await runtime.isPaused());
      console.log("dockets:", dockets.map((d) => `${d.status}=${d.n}`).join(" ") || "none");
      console.log("today's API spend: $" + (await todaySpendUsd(db)).toFixed(4));
      console.log("stuck (needs human):", stuck.map((s) => s.id).join(" ") || "none");
      console.log("pending approval:", pending.map((p) => p.docket_id).join(" ") || "none");
      break;
    }
    case "pause":
    case "unpause": {
      await runtime.setPaused(command === "pause");
      console.log("paused:", await runtime.isPaused());
      break;
    }
    case "approve": {
      if (!arg1) throw new Error("usage: admin approve <docketId>");
      const ruling = await db.row<{ award_usd: number; cycle: number | null }>(
        "SELECT award_usd, cycle FROM rulings WHERE docket_id = $1 AND verdict = 'approved' AND review_status = 'pending_review'",
        [arg1]
      );
      if (!ruling) throw new Error(`${arg1} has no approval pending review`);
      // The constitution's one-approval-per-cycle limit binds the operator
      // too, or countersigning two held rulings would quietly break it.
      const rulingCycle = ruling.cycle ?? (await currentCycle(db));
      if (!(await cycleSlotFree(db, rulingCycle, runtime.constitution.limits.approvals_per_cycle))) {
        throw new Error(
          `cycle ${rulingCycle} has already issued its approval; this one cannot be countersigned into it`
        );
      }
      // A claim locks a token amount, which normally comes from the live
      // price. Before a token has a market there is no price to lock
      // against, so --price supplies one by hand. It is the same override
      // in spirit as FAKE_TREASURY_USD and just as temporary.
      const priceFlag = args.find((a) => a.startsWith("--price="));
      const manualPrice = priceFlag ? Number(priceFlag.split("=")[1]) : null;
      if (manualPrice !== null && !(Number.isFinite(manualPrice) && manualPrice > 0)) {
        throw new Error(`--price must be a positive number, got ${priceFlag}`);
      }
      const priceUsd = manualPrice ?? runtime.oracle.current()?.priceUsd ?? null;
      if (priceUsd === null) {
        throw new Error(
          "no live price — pass --price=<usd> to lock the amount by hand, " +
            "e.g. admin approve " + arg1 + " --price=0.000002253 --send"
        );
      }

      const whole = Math.round(ruling.award_usd / priceUsd);
      console.log(`${arg1}  award $${ruling.award_usd}  at $${priceUsd}`);
      console.log(`  -> ${whole.toLocaleString("en-US")} $DEREK`);
      console.log(`  price source: ${manualPrice !== null ? "MANUAL (--price)" : "live oracle"}`);
      if (!args.includes("--send")) {
        // Same shape as sweep: money-moving commands do not fire on a typo.
        console.log("\nDry run. No claim issued. Re-run with --send to issue it.");
        break;
      }

      const claim = await createClaim(
        db,
        arg1,
        ruling.award_usd,
        priceUsd,
        cfg.TOKEN_DECIMALS,
        cfg.CLAIM_EXPIRY_DAYS
      );
      await db.run("UPDATE rulings SET review_status = 'confirmed' WHERE docket_id = $1", [arg1]);
      console.log(`\ncountersigned ${arg1}; claim code: ${claim.code}`);
      console.log("Give this code to the submitter. Anyone holding it can name the payout wallet.");
      break;
    }
    case "bonded": {
      // Everything priced by hand right now - the flat fee, the stated
      // treasury - exists because the token has no market. This reports
      // whether that is still true, and refuses to pretend otherwise.
      const price = runtime.oracle.current();
      const floor = cfg.MIN_LIQUIDITY_USD;
      console.log("fee mode:        " +
        (cfg.FEE_FIXED_TOKENS !== undefined
          ? `FLAT ${cfg.FEE_FIXED_TOKENS.toLocaleString("en-US")} $DEREK`
          : `$${cfg.FEE_TARGET_USD} tracked against the price`));
      console.log("treasury value:  " +
        (cfg.FAKE_TREASURY_USD !== undefined ? `MANUAL $${cfg.FAKE_TREASURY_USD}` : "read from chain"));
      console.log("live price:      " + (price ? `$${price.priceUsd}` : "none"));
      console.log("liquidity floor: $" + floor.toLocaleString("en-US"));

      if (!price) {
        console.log("\nNot bonded: no fresh price. Nothing to change yet.");
        break;
      }
      const tokens = await runtime.treasuryTokens();
      if (tokens !== null) {
        const usd = (Number(tokens) / 10 ** cfg.TOKEN_DECIMALS) * price.priceUsd;
        console.log(`\nTreasury would value at $${usd.toFixed(2)} ` +
          `(cap ${(runtime.constitution.limits.treasury_fraction_cap * 100).toFixed(0)}% = $${(usd * runtime.constitution.limits.treasury_fraction_cap).toFixed(2)})`);
      }
      if (cfg.FEE_TARGET_USD && price.priceUsd > 0) {
        console.log(`A $${cfg.FEE_TARGET_USD} fee would be ` +
          `${Math.round(cfg.FEE_TARGET_USD / price.priceUsd).toLocaleString("en-US")} $DEREK`);
      }
      console.log("\nIf that looks right, hand back to the market with:");
      console.log("  heroku config:unset FEE_FIXED_TOKENS FAKE_TREASURY_USD -a smokingandalf");
      break;
    }
    case "claim-paid": {
      if (!arg1 || !arg2) throw new Error("usage: admin claim-paid <code> <tx>");
      await markClaimPaid(db, arg1, arg2);
      console.log("recorded");
      break;
    }
    case "rule": {
      if (!arg1) throw new Error("usage: admin rule <proposals.json>");
      const raw = JSON.parse(readFileSync(arg1, "utf8")) as unknown;
      const list = (Array.isArray(raw) ? raw : [raw]) as Array<{
        title: string;
        amountUsd: number;
        body: string;
      }>;

      for (const p of list) {
        if (!p || typeof p.title !== "string" || typeof p.body !== "string") {
          throw new Error("each proposal needs title, amountUsd and body");
        }
        const r = await runtime.dryRun(p);
        const award =
          r.verdict === "approved" ? `$${r.awardUsd}` : r.awardUsd === null ? "$0" : String(r.awardUsd);

        console.log("\n" + "=".repeat(72));
        console.log(`${r.docketId}  ${r.verdict.toUpperCase()}  ${award}` +
          `   gates ${r.gatesPassed}/5   cycle ${r.cycle}` +
          (r.review === "pending_review" ? "   [held for countersign]" : ""));
        console.log(`${p.title}  ·  requested $${p.amountUsd}`);
        if (r.flags.length) console.log(`flags: ${r.flags.join(", ")}`);
        console.log("-".repeat(72));
        console.log(r.rulingText);
        console.log("-".repeat(72));
        console.log(`line: "${r.rulingLine}"`);
        console.log(`cost: $${r.costUsd.toFixed(4)}`);
      }
      console.log(
        `\n${list.length} ruling(s). Today's spend: $${(await todaySpendUsd(db)).toFixed(4)}`
      );
      break;
    }
    case "sweep": {
      const plans = await runtime.sweepPlans();
      const whole = (v: bigint): string =>
        (v / 10n ** BigInt(cfg.TOKEN_DECIMALS)).toLocaleString("en-GB");
      if (plans.length === 0) {
        console.log("nothing to sweep");
        break;
      }
      let burn = 0n, treas = 0n, air = 0n;
      for (const p of plans) {
        console.log(describePlan(p, cfg.TOKEN_DECIMALS));
        burn += p.burn; treas += p.treasury; air += p.airdrops;
      }
      console.log(`\n${plans.length} docket(s)`);
      console.log(`  burn     ${whole(burn)}`);
      console.log(`  treasury ${whole(treas)}`);
      console.log(`  airdrops ${whole(air)}`);

      if (arg1 !== "--send") {
        console.log("\nDry run. Nothing sent. Re-run with --send to move it.");
        break;
      }
      const executor = runtime.sweepExecutor();
      if (!executor) throw new Error("SWEEP_FEE_PAYER_SECRET is not set");
      const done = await runtime.sweepCycle();
      console.log(`\nswept ${done.length} of ${plans.length}`);
      for (const d of done) console.log(`  ${d.docketId}  ${d.signature}`);
      break;
    }
    case "queue": {
      const rows = (await db.rows(
        `SELECT r.docket_id, r.verdict, r.ruling_line, d.fee_tokens, p.amount_usd, r.award_usd
         FROM rulings r JOIN dockets d ON d.id = r.docket_id JOIN proposals p ON p.id = d.proposal_id
         WHERE r.post_status = 'queued_manual'`
      )) as never[];
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
      await db.run("UPDATE rulings SET post_status = 'posted', post_id = $1 WHERE docket_id = $2", [
        arg2,
        arg1
      ]);
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
