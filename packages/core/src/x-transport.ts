import { createHmac, randomBytes } from "node:crypto";
import type { PostTransport } from "./publisher.js";
import type { Logger } from "./logger.js";

/**
 * Posting to X. OAuth 1.0a rather than OAuth 2.0 user context: the account
 * posts as itself and never on behalf of a visitor, so fixed access tokens
 * avoid a refresh dance that would need somewhere to store rotating state.
 */

export interface XCredentials {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessSecret: string;
  /** Numeric account id, needed only to reconcile after a failed post. */
  userId?: string;
}

/** RFC 3986 — stricter than encodeURIComponent, which leaves !'()* alone. */
export function pctEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

/**
 * METHOD&url&params, with parameters sorted by encoded key then encoded
 * value. Only oauth_* and query parameters are signed: a JSON body is not
 * form-encoded, so its contents are outside the signature.
 */
export function signatureBaseString(
  method: string,
  url: string,
  params: Record<string, string>
): string {
  const encoded = Object.entries(params)
    .map(([k, v]) => [pctEncode(k), pctEncode(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return [method.toUpperCase(), pctEncode(url), pctEncode(encoded)].join("&");
}

export function oauth1Header(
  method: string,
  url: string,
  creds: XCredentials,
  queryParams: Record<string, string> = {},
  nonce: string = randomBytes(16).toString("hex"),
  timestamp: number = Math.floor(Date.now() / 1000)
): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(timestamp),
    oauth_token: creds.accessToken,
    oauth_version: "1.0"
  };

  const base = signatureBaseString(method, url, { ...oauth, ...queryParams });
  const key = `${pctEncode(creds.consumerSecret)}&${pctEncode(creds.accessSecret)}`;
  oauth.oauth_signature = createHmac("sha1", key).update(base).digest("base64");

  return (
    "OAuth " +
    Object.entries(oauth)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${pctEncode(k)}="${pctEncode(v)}"`)
      .join(", ")
  );
}

export class XApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const POST_URL = "https://api.x.com/2/tweets";
// Media still lives on the v1.1 host; there is no v2 upload endpoint.
const MEDIA_URL = "https://upload.twitter.com/1.1/media/upload.json";

export class XTransport implements PostTransport {
  constructor(
    private creds: XCredentials,
    private log?: Logger,
    private doFetch: FetchLike = fetch
  ) {}

  /**
   * Uploads a PNG and returns its media id.
   *
   * OAuth 1.0a only folds body parameters into the signature for
   * form-urlencoded bodies. This is multipart, so the base string covers
   * the oauth_* parameters alone — signing the image bytes would produce a
   * valid-looking header that X rejects.
   */
  async uploadMedia(png: Buffer): Promise<string> {
    const auth = oauth1Header("POST", MEDIA_URL, this.creds);
    const form = new FormData();
    form.append("media", new Blob([new Uint8Array(png)], { type: "image/png" }));
    const res = await this.doFetch(MEDIA_URL, {
      method: "POST",
      headers: { authorization: auth }, // content-type is set by FormData, with its boundary
      body: form as unknown as string // FetchLike takes the node fetch body union
    });
    const body = (await res.json().catch(() => ({}))) as {
      media_id_string?: string;
      errors?: Array<{ message?: string }>;
    };
    if (!res.ok || !body.media_id_string) {
      throw new XApiError(body.errors?.[0]?.message ?? `x media upload ${res.status}`, res.status);
    }
    return body.media_id_string;
  }

  async post(text: string, _key: string, mediaIds?: string[]): Promise<{ id: string }> {
    const auth = oauth1Header("POST", POST_URL, this.creds);
    const payload: Record<string, unknown> = { text };
    if (mediaIds?.length) payload.media = { media_ids: mediaIds };
    const res = await this.doFetch(POST_URL, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const body = (await res.json().catch(() => ({}))) as {
      data?: { id?: string };
      detail?: string;
      title?: string;
    };
    if (!res.ok || !body.data?.id) {
      throw new XApiError(body.detail ?? body.title ?? `x api ${res.status}`, res.status);
    }
    return { id: body.data.id };
  }

  /**
   * After a failed post, checks whether it actually landed. Every ruling
   * carries its docket id in the text, so the account's recent posts are
   * enough to tell — and a read costs less than posting the same ruling
   * twice would.
   */
  async find(key: string): Promise<{ id: string } | null> {
    if (!this.creds.userId) {
      this.log?.warn("no X_USER_ID configured; cannot reconcile a failed post");
      return null;
    }
    const url = `https://api.x.com/2/users/${this.creds.userId}/tweets`;
    const query = { max_results: "10" };
    const auth = oauth1Header("GET", url, this.creds, query);
    const res = await this.doFetch(`${url}?max_results=10`, {
      method: "GET",
      headers: { authorization: auth }
    });
    if (!res.ok) throw new XApiError(`x api ${res.status}`, res.status);
    const body = (await res.json()) as { data?: Array<{ id: string; text: string }> };
    const hit = (body.data ?? []).find((t) => t.text.includes(key));
    return hit ? { id: hit.id } : null;
  }
}
