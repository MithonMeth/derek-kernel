"use client";

import { useRef, useState } from "react";
import { siteConfig } from "@/lib/site-config";

export function TipCopyButton() {
  const [copied, setCopied] = useState(false);
  const codeRef = useRef<HTMLElement>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(siteConfig.devTipAddress);
    } catch {
      const el = codeRef.current;
      if (el) {
        const range = document.createRange();
        range.selectNode(el);
        const selection = getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="addr">
      <code id="devaddr" ref={codeRef}>
        {siteConfig.devTipAddress}
      </code>
      <button className="btn ghost" id="copyaddr" onClick={copy}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
