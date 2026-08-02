import { query } from "@/lib/db";
import { currentRound } from "@/lib/data";

export type Tally = { taco: number; noTaco: number };
export type Choice = "taco" | "no_taco";

export async function getTally(): Promise<Tally> {
  const result = await query<{ taco: string; no_taco: string }>(
    `select
       count(*) filter (where choice = 'taco') as taco,
       count(*) filter (where choice = 'no_taco') as no_taco
     from public_votes where round_number = $1`,
    [currentRound.number],
  );
  return {
    taco: Number(result.rows[0]?.taco ?? 0),
    noTaco: Number(result.rows[0]?.no_taco ?? 0),
  };
}

export async function getVotedChoice(voterId: string | undefined): Promise<Choice | null> {
  if (!voterId) return null;
  const result = await query<{ choice: Choice }>(
    `select choice from public_votes
     where round_number = $1 and voter_id = $2
       and created_at >= now() - interval '24 hours'
     order by created_at desc limit 1`,
    [currentRound.number, voterId],
  );
  return result.rows[0]?.choice ?? null;
}
