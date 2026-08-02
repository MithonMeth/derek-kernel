"use client";

import { useEffect, useRef } from "react";
import { currentRound, tally } from "@/lib/data";

const score = Math.round((tally.taco / (tally.taco + tally.noTaco)) * 100);
const needleDeg = (score / 100) * 180 - 90;
const voteCount = tally.taco + tally.noTaco;

export function Hero() {
  const needleRef = useRef<SVGGElement>(null);

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      if (needleRef.current) needleRef.current.style.transform = `rotate(${needleDeg}deg)`;
    });
    return () => cancelAnimationFrame(id);
  }, []);

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
          <g id="needle" ref={needleRef}>
            <polygon points="250,220 243,214 250,58 257,214" fill="#141210" />
            <circle cx="250" cy="220" r="13" fill="#141210" />
            <circle cx="250" cy="220" r="5" fill="#EFE9DD" />
          </g>
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
        {voteCount.toLocaleString()} holder votes
      </p>
      <a href="#vote" className="scroller mono">
        ↓ Cast yours
      </a>
    </header>
  );
}
