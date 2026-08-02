import { currentRound } from "@/lib/data";
import type { Tally } from "@/lib/votes";
import { Needle } from "@/components/Needle";

export function Hero({ tally }: { tally: Tally }) {
  const total = tally.taco + tally.noTaco;
  const score = total ? Math.round((tally.taco / total) * 100) : 50;
  const needleDeg = (score / 100) * 180 - 90;

  return (
    <header className="hero" id="top">
      <div className="gauge">
        <svg viewBox="0 0 500 250" aria-label="TACO indicator gauge">
          <path
            d="M40 220 A210 210 0 0 1 141 40"
            fill="none"
            stroke="#241F1A"
            strokeWidth="26"
          />
          <path
            d="M141 40 A210 210 0 0 1 359 40"
            fill="none"
            stroke="#E0A72E"
            strokeWidth="26"
          />
          <path
            d="M359 40 A210 210 0 0 1 460 220"
            fill="none"
            stroke="#C8321E"
            strokeWidth="26"
          />
          <Needle deg={needleDeg} />
          <text
            x="34"
            y="246"
            fontFamily="JetBrains Mono, monospace"
            fontSize="13"
            fill="#241F1A"
            letterSpacing="1.5"
          >
            OH SH!T
          </text>
          <text
            x="466"
            y="246"
            textAnchor="end"
            fontFamily="JetBrains Mono, monospace"
            fontSize="13"
            fill="#C8321E"
            letterSpacing="1.5"
          >
            MAJOR TACO
          </text>
        </svg>
      </div>
      <div className="reading">
        <span className="num">{score}</span>% Taco
      </div>
      <p className="q">{currentRound.question}</p>
      <p className="sub mono">
        Round {String(currentRound.number).padStart(2, "0")} · Closes in {currentRound.closesIn} ·{" "}
        {total.toLocaleString()} votes
      </p>
      <a href="#vote" className="scroller mono">
        ↓ Cast yours
      </a>
    </header>
  );
}
