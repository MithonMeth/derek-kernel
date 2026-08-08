import { createHmac } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  XApiError,
  XTransport,
  oauth1Header,
  pctEncode,
  signatureBaseString,
  type XCredentials
} from "../src/x-transport.js";
import {
  recordSpend, recordXPost, todaySpendUsd, todayXSpendUsd, underXDailyCap
} from "../src/spend.js";
import { closeTestDbs, testDb } from "./helpers.js";

afterAll(closeTestDbs);

const CREDS: XCredentials = {
  consumerKey: "ckey",
  consumerSecret: "csecret",
  accessToken: "atoken",
  accessSecret: "asecret",
  userId: "12345"
};

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("oauth 1.0a signing", () => {
  it("percent-encodes to RFC 3986, not encodeURIComponent", () => {
    // These five are the ones encodeURIComponent leaves alone and OAuth
    // requires escaped; getting it wrong produces signatures that verify
    // locally and are rejected by the server.
    expect(pctEncode("!'()*")).toBe("%21%27%28%29%2A");
    expect(pctEncode("a b")).toBe("a%20b");
    expect(pctEncode("~-._")).toBe("~-._"); // unreserved, must not change
    expect(pctEncode("£")).toBe("%C2%A3");
  });

  it("builds the base string with parameters sorted by encoded key", () => {
    const base = signatureBaseString("post", "https://api.x.com/2/tweets", {
      oauth_nonce: "n",
      oauth_consumer_key: "ckey",
      b: "2",
      a: "1"
    });
    expect(base).toBe(
      "POST&https%3A%2F%2Fapi.x.com%2F2%2Ftweets&" +
        "a%3D1%26b%3D2%26oauth_consumer_key%3Dckey%26oauth_nonce%3Dn"
    );
  });

  it("signs with consumerSecret&tokenSecret using HMAC-SHA1", () => {
    const header = oauth1Header(
      "POST",
      "https://api.x.com/2/tweets",
      CREDS,
      {},
      "fixednonce",
      1700000000
    );
    // Recompute independently from the documented algorithm.
    const base = signatureBaseString("POST", "https://api.x.com/2/tweets", {
      oauth_consumer_key: "ckey",
      oauth_nonce: "fixednonce",
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: "1700000000",
      oauth_token: "atoken",
      oauth_version: "1.0"
    });
    const expected = createHmac("sha1", "csecret&asecret").update(base).digest("base64");
    expect(header).toContain(`oauth_signature="${pctEncode(expected)}"`);
    expect(header).toContain('oauth_signature_method="HMAC-SHA1"');
    expect(header).toMatch(/^OAuth /);
  });

  it("matches the RFC 2202 HMAC-SHA1 vector, so the primitive is right", () => {
    const key = Buffer.alloc(20, 0x0b);
    expect(createHmac("sha1", key).update("Hi There").digest("hex")).toBe(
      "b617318655057264e28bc0b6fb378c8ef146be00"
    );
  });

  it("produces a different signature for a different body-less request", () => {
    const a = oauth1Header("POST", "https://api.x.com/2/tweets", CREDS, {}, "n1", 1);
    const b = oauth1Header("GET", "https://api.x.com/2/tweets", CREDS, {}, "n1", 1);
    expect(a).not.toBe(b);
  });
});

describe("x transport", () => {
  it("posts and returns the id", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const t = new XTransport(CREDS, undefined, async (url, init) => {
      seen = { url, init };
      return response(201, { data: { id: "1900000000" } });
    });

    const out = await t.post("Docket D-1 — REJECTED", "D-1");
    expect(out).toEqual({ id: "1900000000" });
    expect(seen!.url).toBe("https://api.x.com/2/tweets");
    expect(String(seen!.init.headers && (seen!.init.headers as Record<string, string>).authorization))
      .toMatch(/^OAuth oauth_consumer_key="ckey"/);
    expect(JSON.parse(String(seen!.init.body))).toEqual({ text: "Docket D-1 — REJECTED" });
  });

  it("throws with the API's own message on rejection", async () => {
    const t = new XTransport(CREDS, undefined, async () =>
      response(403, { detail: "duplicate content" })
    );
    await expect(t.post("x", "D-1")).rejects.toThrow(/duplicate content/);
    await expect(t.post("x", "D-1")).rejects.toBeInstanceOf(XApiError);
  });

  it("treats a 200 with no id as a failure rather than a success", async () => {
    const t = new XTransport(CREDS, undefined, async () => response(200, { data: {} }));
    await expect(t.post("x", "D-1")).rejects.toThrow();
  });

  it("finds a post that landed, by the docket id in its text", async () => {
    const t = new XTransport(CREDS, undefined, async () =>
      response(200, {
        data: [
          { id: "111", text: "Docket D-9 — REJECTED" },
          { id: "222", text: "Docket D-1 — REJECTED" }
        ]
      })
    );
    expect(await t.find("D-1")).toEqual({ id: "222" });
    expect(await t.find("D-404")).toBeNull();
  });

  it("cannot reconcile without a user id, and says so rather than guessing", async () => {
    const t = new XTransport({ ...CREDS, userId: undefined }, undefined, async () => {
      throw new Error("should not be called");
    });
    expect(await t.find("D-1")).toBeNull();
  });
});

describe("x spend cap", () => {
  it("counts posts and stops publishing once the daily cap is reached", async () => {
    const db = await testDb();
    // $0.015 a post against a $0.03 cap: two posts fit, the third does not.
    expect(await underXDailyCap(db, 0.03)).toBe(true);
    await recordXPost(db);
    expect(await underXDailyCap(db, 0.03)).toBe(true);
    await recordXPost(db);
    expect(await underXDailyCap(db, 0.03)).toBe(false);
    expect(await todayXSpendUsd(db)).toBeCloseTo(0.03, 6);
  });

  it("keeps X spend separate from model spend", async () => {
    const db = await testDb();
    await recordSpend(db, 4);
    await recordXPost(db);
    expect(await todaySpendUsd(db)).toBe(4);
    expect(await todayXSpendUsd(db)).toBeCloseTo(0.015, 6);
    // A big model bill must not silently consume the posting budget.
    expect(await underXDailyCap(db, 1)).toBe(true);
  });
});
