import { currentRound } from "@/lib/data";
import type { Choice, Tally } from "@/lib/votes";
import { VoteButtons } from "@/components/VoteButtons";

export function VoteSection({
  tally,
  votedChoice,
}: {
  tally: Tally;
  votedChoice: Choice | null;
}) {
  return (
    <section className="vote" id="vote">
      <div className="eyebrow mono">
        <span>
          Round {String(currentRound.number).padStart(2, "0")} · {currentRound.status}
        </span>
      </div>
      <h2 className="reveal">{currentRound.headline}</h2>

      <div className="gate">
        <p>
          Voting is open to anyone right now — one vote per browser, per day. Nothing is staked
          and nothing is paid out — this is a sentiment reading, not a bet. Once $TACO bonds, this
          moves to wallet-gated holder voting — see the roadmap.
        </p>
      </div>

      <VoteButtons tally={tally} votedChoice={votedChoice} />

      <div className="meta mono">
        <span>One vote per browser, per day</span>
        <span>No wallet needed yet</span>
        <span>Nothing staked, nothing paid out</span>
      </div>
    </section>
  );
}
