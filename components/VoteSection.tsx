"use client";

import { useEffect, useRef, useState } from "react";
import { currentRound } from "@/lib/data";

const options = [currentRound.optionA, currentRound.optionB];

export function VoteSection() {
  const [counts, setCounts] = useState(options.map((o) => o.votes));
  const [unlocked, setUnlocked] = useState(false);
  const [voted, setVoted] = useState(false);
  const fillRefs = useRef<(HTMLDivElement | null)[]>([]);

  const total = counts[0] + counts[1];
  const percents = counts.map((c) => Math.round((c / total) * 100));

  useEffect(() => {
    fillRefs.current.forEach((el, i) => {
      if (el) el.style.width = unlocked ? `${percents[i]}%` : "0%";
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlocked, counts]);

  function vote(i: number) {
    if (!unlocked || voted) return;
    setVoted(true);
    setCounts((c) => c.map((v, idx) => (idx === i ? v + 1 : v)));
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
  }

  return (
    <section className="vote" id="vote">
      <div className="eyebrow mono">
        <span>
          Round {String(currentRound.number).padStart(2, "0")} · {currentRound.status}
        </span>
      </div>
      <h2 className="reveal">{currentRound.headline}</h2>

      <div className="gate">
        {unlocked ? (
          <p className="mono">Wallet verified · Balance above threshold · Round 07 unlocked</p>
        ) : (
          <>
            <p>
              Voting is open to $TACO holders. Connect a wallet holding at least the minimum
              balance to unlock this round. Nothing is staked and nothing is paid out — this is a
              sentiment reading, not a bet.
            </p>
            <button className="btn" onClick={() => setUnlocked(true)}>
              Connect wallet
            </button>
          </>
        )}
      </div>

      <div className="opts">
        {options.map((opt, i) => (
          <button
            key={opt.name}
            className={`opt${unlocked ? "" : " locked"}`}
            disabled={!unlocked || voted}
            onClick={() => vote(i)}
          >
            <div className="fill" ref={(el) => { fillRefs.current[i] = el; }} />
            <div className="in">
              <span className="mono">{opt.label}</span>
              <h3>{opt.name}</h3>
              <span className="pc">{unlocked ? `${percents[i]}%` : "—"}</span>
            </div>
          </button>
        ))}
      </div>
      <div className="meta mono">
        <span>Snapshot taken at round open</span>
        <span>One wallet, one vote</span>
        <span>Balance does not weight the vote</span>
      </div>
    </section>
  );
}
