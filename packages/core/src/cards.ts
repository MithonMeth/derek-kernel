import { createCanvas, GlobalFonts, type SKRSContext2D } from "@napi-rs/canvas";
import { fileURLToPath } from "node:url";
import { sanitizePublishedText } from "./guards.js";

/**
 * Renders a ruling as a PNG for X and for link previews.
 *
 * The post itself carries no URL — X charges $0.20 for a post containing
 * one against $0.015 without — so this image is the only route back to the
 * site. The permalink is therefore printed on the card, where it costs
 * nothing, and it is the one element that must never be dropped.
 *
 * Everything drawn here comes from structured verdict fields, never raw
 * model prose, and goes through the same sanitiser the post text does. A
 * ruling line is attacker-influenced text: it reaches this renderer from a
 * proposal a stranger wrote.
 */

// 1200x628 is X's summary_large_image size. Rendering at 2x and letting the
// upload downscale keeps the small type legible in-timeline.
const W = 1200;
const H = 628;
const SCALE = 2;

const PAPER = "#d7dcc8";
const BUFF = "#c9cdb6";
const RULE = "#9aa387";
const INK = "#1b2220";
const INK_SOFT = "#4a544e";
const OXBLOOD = "#8a2b22";
const STAMPBLUE = "#2b4763";

let fontsReady = false;

/** Idempotent: registering the same family twice is wasted work, not an error. */
export function registerCardFonts(dir?: string): void {
  if (fontsReady) return;
  const base = dir ?? fileURLToPath(new URL("../../web/assets/fonts", import.meta.url));
  GlobalFonts.registerFromPath(`${base}/IBMPlexMono-Regular.ttf`, "PlexMono");
  GlobalFonts.registerFromPath(`${base}/IBMPlexMono-SemiBold.ttf`, "PlexMonoBold");
  fontsReady = true;
}

export interface CardRuling {
  docketId: string;
  verdict: string;
  rulingLine: string;
  amountUsd: number;
  awardUsd: number | null;
  burnedTokens: string;
  siteHost: string;
}

/** Greedy wrap on measured width — monospace still needs measuring at 2x. */
function wrap(ctx: SKRSContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width <= maxWidth || !line) {
      line = next;
    } else {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines && words.length) {
    // Ellipsise rather than silently truncating mid-word.
    let last = lines[maxLines - 1];
    while (last && ctx.measureText(`${last}…`).width > maxWidth) {
      last = last.slice(0, -1);
    }
    const joined = lines.join(" ");
    if (joined.length < text.length) lines[maxLines - 1] = `${last}…`;
  }
  return lines;
}

/** A slightly rotated rubber stamp, the way the site's ruling output draws one. */
function stamp(ctx: SKRSContext2D, text: string, colour: string, x: number, y: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((-3 * Math.PI) / 180);
  ctx.font = "44px PlexMonoBold";
  const w = ctx.measureText(text).width;
  const padX = 22;
  const padY = 14;
  const boxW = w + padX * 2;
  const boxH = 44 + padY * 2;

  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = colour;
  ctx.lineWidth = 4;
  ctx.strokeRect(-boxW / 2, -boxH / 2, boxW, boxH);
  ctx.fillStyle = colour;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 0, 2);
  ctx.restore();
}

export function renderRulingCard(r: CardRuling): Buffer {
  registerCardFonts();
  const canvas = createCanvas(W * SCALE, H * SCALE);
  const ctx = canvas.getContext("2d");
  ctx.scale(SCALE, SCALE);
  ctx.textBaseline = "alphabetic";

  // Paper
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, H);

  // Punch-card edge down the left, so the card reads as a document even as
  // a thumbnail where no text is legible.
  ctx.fillStyle = BUFF;
  ctx.fillRect(0, 0, 54, H);
  ctx.fillStyle = RULE;
  for (let y = 40; y < H - 20; y += 46) {
    ctx.fillRect(20, y, 14, 22);
  }

  const L = 100;
  const R = W - 70;
  const colW = R - L;

  // Masthead
  ctx.fillStyle = INK;
  ctx.font = "27px PlexMonoBold";
  ctx.fillText("DEREK", L, 74);
  ctx.fillStyle = INK_SOFT;
  ctx.font = "15px PlexMono";
  ctx.fillText("DEPARTMENTAL EXPENDITURE REVIEW & EVALUATION KERNEL", L + 104, 74);

  ctx.strokeStyle = RULE;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(L, 96);
  ctx.lineTo(R, 96);
  ctx.stroke();

  // Docket line
  ctx.fillStyle = INK_SOFT;
  ctx.font = "19px PlexMono";
  ctx.fillText(`DOCKET ${r.docketId.toUpperCase()}`, L, 136);

  // The ruling line, which is the whole point of the card.
  const line = sanitizePublishedText(r.rulingLine, 180);
  ctx.fillStyle = INK;
  ctx.font = "38px PlexMono";
  const lines = wrap(ctx, `“${line}”`, colW - 250, 4);
  // Centred between the header and footer rules rather than hung from the
  // top: a one-line ruling and a four-line one then sit in the same optical
  // place, and short rulings stop leaving a third of the card empty. It
  // also drops the first line clear of the stamp.
  const LEADING = 52;
  let y = 340 - ((lines.length - 1) * LEADING) / 2;
  for (const l of lines) {
    ctx.fillText(l, L, y);
    y += LEADING;
  }

  // Verdict stamp, clear of the text column.
  const approved = r.verdict === "approved";
  stamp(
    ctx,
    approved ? "APPROVED" : r.verdict.toUpperCase(),
    approved ? STAMPBLUE : OXBLOOD,
    R - 150,
    186
  );

  // Footer rule and the numbers
  ctx.strokeStyle = RULE;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(L, H - 118);
  ctx.lineTo(R, H - 118);
  ctx.stroke();

  ctx.fillStyle = INK_SOFT;
  ctx.font = "20px PlexMono";
  const money = (n: number): string => `$${n.toLocaleString("en-US")}`;
  const facts = approved
    ? `Requested ${money(r.amountUsd)} · awarded ${money(r.awardUsd ?? 0)}`
    : `Requested ${money(r.amountUsd)}`;
  ctx.fillText(facts, L, H - 80);
  ctx.fillText(`${r.burnedTokens} $DEREK burned either way`, L, H - 48);

  // The permalink. The post has no link in it, so this is the only way back.
  ctx.fillStyle = OXBLOOD;
  ctx.font = "22px PlexMonoBold";
  const permalink = `${r.siteHost}/r/${r.docketId}`;
  ctx.textAlign = "right";
  ctx.fillText(permalink, R, H - 48);
  ctx.textAlign = "left";

  return canvas.toBuffer("image/png");
}
