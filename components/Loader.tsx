"use client";

import { useEffect, useRef, useState } from "react";

const LETTERS = ["T", "A", "C", "O"];

export function Loader() {
  const [litCount, setLitCount] = useState(0);
  const [pct, setPct] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const [removed, setRemoved] = useState(false);
  const lockedScrollY = useRef(0);

  useEffect(() => {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

    // overflow:hidden alone doesn't stop touch-swipe scrolling on mobile
    // Safari/Chrome, so pin the body in place instead.
    lockedScrollY.current = window.scrollY;
    document.body.style.position = "fixed";
    document.body.style.top = `-${lockedScrollY.current}px`;
    document.body.style.left = "0";
    document.body.style.right = "0";

    const letterTimers = LETTERS.map((_, i) =>
      setTimeout(() => setLitCount((n) => Math.max(n, i + 1)), reduced ? 0 : i * 110),
    );

    let p = 0;
    const tick = setInterval(
      () => {
        p += Math.random() * 12;
        if (p >= 100) {
          p = 100;
          clearInterval(tick);
          setTimeout(() => setLeaving(true), 300);
        }
        setPct(Math.floor(p));
      },
      reduced ? 10 : 70,
    );

    return () => {
      letterTimers.forEach(clearTimeout);
      clearInterval(tick);
    };
  }, []);

  useEffect(() => {
    if (!leaving) return;
    document.body.style.position = "";
    document.body.style.top = "";
    document.body.style.left = "";
    document.body.style.right = "";
    window.scrollTo(0, lockedScrollY.current);
    const t = setTimeout(() => setRemoved(true), 1100);
    return () => clearTimeout(t);
  }, [leaving]);

  if (removed) return null;

  return (
    <div id="loader" className={leaving ? "out" : undefined}>
      <div className="letters" id="lts">
        {LETTERS.map((letter, i) => (
          <span key={letter} className={i < litCount ? "in" : undefined}>
            {letter}
          </span>
        ))}
      </div>
      <p className="tagline mono">Trump Always Chickens Out</p>
      <div className="pct mono" id="pct">
        {String(pct).padStart(3, "0")}
      </div>
      <div className="note mono">Calibrating chicken sensor</div>
    </div>
  );
}
