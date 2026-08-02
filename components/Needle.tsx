"use client";

import { useEffect, useRef } from "react";

export function Needle({ deg }: { deg: number }) {
  const ref = useRef<SVGGElement>(null);

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      if (ref.current) ref.current.style.transform = `rotate(${deg}deg)`;
    });
    return () => cancelAnimationFrame(id);
  }, [deg]);

  return (
    <g id="needle" ref={ref}>
      <polygon points="250,220 243,214 250,58 257,214" fill="#141210" />
      <circle cx="250" cy="220" r="13" fill="#141210" />
      <circle cx="250" cy="220" r="5" fill="#EFE9DD" />
    </g>
  );
}
