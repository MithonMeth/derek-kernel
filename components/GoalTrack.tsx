"use client";

import { useEffect, useRef } from "react";
import { goalProgress } from "@/lib/data";

export function GoalTrack() {
  const trackRef = useRef<HTMLDivElement>(null);
  const progRef = useRef<HTMLDivElement>(null);
  const lblRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          if (progRef.current) progRef.current.style.width = `${goalProgress.percent}%`;
          if (lblRef.current) lblRef.current.textContent = goalProgress.label;
          io.unobserve(entry.target);
        }
      },
      { threshold: 0.25 },
    );
    io.observe(track);
    return () => io.disconnect();
  }, []);

  return (
    <div className="track" id="track" ref={trackRef}>
      <div className="prog" id="prog" ref={progRef} />
      <span className="lbl mono" id="prlbl" ref={lblRef}>
        0%
      </span>
    </div>
  );
}
