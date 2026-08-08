import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  HdAddressDeriver,
  Runtime,
  createLogger,
  loadConfig,
  openDb,
  type DB,
  type RulingModel,
  type RulingOutcome,
  type ScreeningOutcome
} from "@derek/core";
import { buildApp } from "../src/app.js";

const CONSTITUTION_DIR = fileURLToPath(new URL("../../../constitution", import.meta.url));
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://derek:derek@localhost:55432/derek";
const USAGE = { inputTokens: 2500, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 };

const opened: DB[] = [];
afterAll(async () => {
  await Promise.all(opened.splice(0).map((d) => d.close().catch(() => undefined)));
});

function stubModel(raw: unknown): RulingModel {
  return {
    async screen(): Promise<ScreeningOutcome> {
      return { flags: [], reason: "clean", usage: USAGE };
    },
    async rule(): Promise<RulingOutcome> {
      return { raw, usage: USAGE };
    }
  };
}

async function makeApp(env: Record<string, string> = {}) {
  const db = await openDb(TEST_DATABASE_URL, { schema: "a_" + randomBytes(8).toString("hex") });
  opened.push(db);
  const cfg = loadConfig({
    PAUSED: "false",
    FAKE_TREASURY_USD: "20000",
    AUTO_APPROVE_UNFLAGGED: "true",
    ...env
  } as NodeJS.ProcessEnv);
  const runtime = await Runtime.create(cfg, CONSTITUTION_DIR, createLogger("apitest"), {
    db,
    chain: null,
    deriver: new HdAddressDeriver("ab".repeat(32)),
    model: stubModel({
      verdict: "approved",
      award_usd: 180,
      gates_passed: 5,
      ruling_line: "Fine.",
      ruling_text: "Approved. 180."
    }),
    transport: null
  });
  const app = await buildApp(runtime, cfg);
  return { app, runtime, db };
}

describe("claim code exposure", () => {
  /**
   * Docket ids are sequential (D-1, D-2, ...), so anything the docket
   * endpoint returns unauthenticated is effectively published. The claim
   * code is a bearer token for the award: whoever submits it first names
   * the payout wallet. These tests exist because that was once public.
   */
  async function approvedDocket() {
    const { app, runtime, db } = await makeApp();
    await runtime.oracle.accept({
      priceUsd: 0.00004,
      liquidityUsd: 50_000,
      source: "test",
      observedAt: Date.now()
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/proposals",
      payload: { title: "Replacement kettle", amountUsd: 34, body: "It boils water. Argos." }
    });
    const { docketId, viewToken } = res.json();
    await db.run("UPDATE dockets SET status = 'paid' WHERE id = $1", [docketId]);
    await runtime.rulingCycle();
    return { app, docketId, viewToken, db };
  }

  it("does not hand the claim code to an unauthenticated reader", async () => {
    const { app, docketId } = await approvedDocket();
    const body = (await app.inject({ method: "GET", url: `/api/dockets/${docketId}` })).json();
    // The claim must still be visible - the ledger is the point - but the
    // code is the part that moves money.
    expect(body.claim).toBeTruthy();
    expect(body.claim.status).toBe("open");
    expect(body.claim.code).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/[0-9a-f]{32}/);
  });

  it("releases the code to the holder of the docket's token", async () => {
    const { app, docketId, viewToken } = await approvedDocket();
    expect(viewToken).toMatch(/^[0-9a-f]{32}$/);
    const body = (
      await app.inject({ method: "GET", url: `/api/dockets/${docketId}?t=${viewToken}` })
    ).json();
    expect(body.claim.code).toMatch(/^[0-9a-f]{32}$/);
  });

  it("refuses a wrong or empty token", async () => {
    const { app, docketId, viewToken } = await approvedDocket();
    for (const t of ["", "0".repeat(32), viewToken.slice(0, -1), viewToken + "a"]) {
      const body = (
        await app.inject({ method: "GET", url: `/api/dockets/${docketId}?t=${t}` })
      ).json();
      expect(body.claim.code).toBeUndefined();
    }
  });

  it("one docket's token does not open another's code", async () => {
    const a = await approvedDocket();
    const b = await approvedDocket();
    const body = (
      await b.app.inject({ method: "GET", url: `/api/dockets/${b.docketId}?t=${a.viewToken}` })
    ).json();
    expect(body.claim.code).toBeUndefined();
  });
});

describe("api", () => {
  it("serves stats as real values, not pending promises", async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/stats" });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Every one of these was, at some point, an unawaited promise that
    // serialised as {}. Assert the primitive type, not just presence.
    expect(typeof body.paused).toBe("boolean");
    expect(typeof body.cycle).toBe("number");
    expect(typeof body.rulings).toBe("number");
    expect(body.daysSinceApproval === null || typeof body.daysSinceApproval === "number").toBe(true);
    expect(body.minAward).toBe(1);
    expect(body.maxAward).toBe(5000);
  });

  it("reports pause state as a boolean on healthz", async () => {
    const { app } = await makeApp({ PAUSED: "true" });
    const body = (await app.inject({ method: "GET", url: "/healthz" })).json();
    expect(body.paused).toBe(true);
  });

  it("refuses submissions while paused", async () => {
    const { app } = await makeApp({ PAUSED: "true" });
    const res = await app.inject({
      method: "POST",
      url: "/api/proposals",
      payload: { title: "Kettle", amountUsd: 34, body: "It boils water." }
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("paused");
  });

  it("validates the proposal body before anything is written", async () => {
    const { app, db } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/proposals",
      payload: { title: "", amountUsd: -5, body: "" }
    });
    expect(res.statusCode).toBe(400);
    const n = await db.row<{ n: string }>("SELECT COUNT(*) AS n FROM proposals");
    expect(Number(n!.n)).toBe(0);
  });

  it("rejects an unknown claim code with 404 rather than reporting success", async () => {
    // This endpoint once answered "Recorded" for every request because the
    // claim call was never awaited.
    const { app } = await makeApp();
    const addr = new HdAddressDeriver("ab".repeat(32)).deriveAddress(7);
    const res = await app.inject({
      method: "POST",
      url: "/api/claim",
      payload: { code: "0".repeat(32), address: addr, addressConfirm: addr }
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("unknown_code");
  });

  it("rejects a mismatched confirmation address", async () => {
    const { app } = await makeApp();
    const deriver = new HdAddressDeriver("ab".repeat(32));
    const res = await app.inject({
      method: "POST",
      url: "/api/claim",
      payload: {
        code: "0".repeat(32),
        address: deriver.deriveAddress(1),
        addressConfirm: deriver.deriveAddress(2)
      }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("address_mismatch");
  });

  it("pages the ledger and only includes detail when asked", async () => {
    const { app, runtime } = await makeApp();
    await runtime.oracle.accept({
      priceUsd: 0.00004,
      liquidityUsd: 50_000,
      source: "test",
      observedAt: Date.now()
    });
    await runtime.dryRun({ title: "500 vinyl stickers", amountUsd: 180, body: "A real quote." });

    const plain = (await app.inject({ method: "GET", url: "/api/rulings" })).json();
    expect(plain.total).toBe(1);
    expect(plain.items[0].proposal).toBeUndefined();

    const detailed = (await app.inject({ method: "GET", url: "/api/rulings?detail=1" })).json();
    expect(detailed.items[0].proposal).toBe("A real quote.");
    expect(detailed.items[0].rulingText).toContain("Approved");
  });

  it("returns 404 for a docket that does not exist", async () => {
    const { app } = await makeApp();
    expect((await app.inject({ method: "GET", url: "/api/dockets/D-999" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/r/D-999" })).statusCode).toBe(404);
  });
});
