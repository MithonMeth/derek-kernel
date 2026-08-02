import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { query } from "@/lib/db";
import { currentRound } from "@/lib/data";

// Very small in-memory sliding window. Resets on dyno restart, doesn't share
// state across dynos — an acceptable gap at this project's scale. The real
// one-vote-per-day guarantee is enforced atomically in SQL below, keyed on
// the voter_id cookie, not this.
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;
const hits = new Map<string, number[]>();

function isRateLimited(ip: string) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_LIMIT_MAX;
}

type VoteRow = { inserted: string; taco: string; no_taco: string };

export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (isRateLimited(ip)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const voterId = request.cookies.get("taco_voter_id")?.value;
  if (!voterId) {
    return NextResponse.json({ error: "missing_voter_id" }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  const choice = body?.choice;
  if (choice !== "taco" && choice !== "no_taco") {
    return NextResponse.json({ error: "invalid_choice" }, { status: 400 });
  }

  // Every part of a WITH query reads the same snapshot, so a plain scan of
  // public_votes in the outer SELECT won't see the row `ins` just inserted —
  // only referencing `ins` itself does. Add its count into whichever bucket
  // matches $3 to account for that.
  const result = await query<VoteRow>(
    `with ins as (
       insert into public_votes (round_number, voter_id, choice)
       select $1, $2, $3
       where not exists (
         select 1 from public_votes
         where round_number = $1 and voter_id = $2
           and created_at >= now() - interval '24 hours'
       )
       returning id
     )
     select
       (select count(*) from ins) as inserted,
       (select count(*) filter (where choice = 'taco') from public_votes where round_number = $1)
         + (select count(*) from ins where $3 = 'taco') as taco,
       (select count(*) filter (where choice = 'no_taco') from public_votes where round_number = $1)
         + (select count(*) from ins where $3 = 'no_taco') as no_taco`,
    [currentRound.number, voterId, choice],
  );

  const row = result.rows[0];
  const tally = { taco: Number(row.taco), noTaco: Number(row.no_taco) };
  const inserted = Number(row.inserted) > 0;

  if (!inserted) {
    return NextResponse.json({ error: "already_voted", tally }, { status: 409 });
  }

  return NextResponse.json({ tally });
}
