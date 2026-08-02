"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { currentRound } from "@/lib/data";
import type { Choice, Tally } from "@/lib/votes";

const options: { key: Choice; label: string; name: string }[] = [
  { key: "taco", label: currentRound.optionA.label, name: currentRound.optionA.name },
  { key: "no_taco", label: currentRound.optionB.label, name: currentRound.optionB.name },
];

export function VoteButtons({
  tally,
  votedChoice,
}: {
  tally: Tally;
  votedChoice: Choice | null;
}) {
  const [counts, setCounts] = useState(tally);
  const [voted, setVoted] = useState(votedChoice);
  const [error, setError] = useState<string | null>(null);
  const fillRefs = useRef<Partial<Record<Choice, HTMLDivElement | null>>>({});
  const router = useRouter();

  const total = counts.taco + counts.noTaco;
  const percents: Record<Choice, number> = {
    taco: total ? Math.round((counts.taco / total) * 100) : 0,
    no_taco: total ? Math.round((counts.noTaco / total) * 100) : 0,
  };

  useEffect(() => {
    for (const key of ["taco", "no_taco"] as const) {
      const el = fillRefs.current[key];
      if (el) el.style.width = `${percents[key]}%`;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [counts]);

  async function vote(choice: Choice) {
    if (voted) return;
    setError(null);
    setVoted(choice);
    try {
      const res = await fetch("/api/vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choice }),
      });
      const data = await res.json();
      if (res.ok) {
        setCounts(data.tally);
      } else if (res.status === 409) {
        setCounts(data.tally);
        setError("Already voted today.");
      } else {
        setVoted(null);
        setError("Vote didn't go through — try again.");
      }
    } catch {
      setVoted(null);
      setError("Vote didn't go through — try again.");
    }
    router.refresh();
  }

  return (
    <>
      <div className="opts" id="opts">
        {options.map((opt) => (
          <button key={opt.key} className="opt" disabled={!!voted} onClick={() => vote(opt.key)}>
            <div
              className="fill"
              ref={(el) => {
                fillRefs.current[opt.key] = el;
              }}
            />
            <div className="in">
              <span className="mono">{opt.label}</span>
              <h3>{opt.name}</h3>
              <span className="pc">{percents[opt.key]}%</span>
            </div>
          </button>
        ))}
      </div>
      {voted && (
        <p className="mono vote-status">
          {error ?? "Vote recorded"} · {total.toLocaleString()} votes today
        </p>
      )}
    </>
  );
}
