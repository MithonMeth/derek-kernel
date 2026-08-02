import { Fragment } from "react";
import { marqueeItems } from "@/lib/data";

function MarqueeCopy() {
  return (
    <span>
      {marqueeItems.map((item) => (
        <Fragment key={item.label}>
          {item.label} <b>{item.value}</b> —{" "}
        </Fragment>
      ))}
      Nothing staked, nothing paid out —{" "}
    </span>
  );
}

export function Marquee() {
  return (
    <div className="marquee mono">
      <div>
        <MarqueeCopy />
        <MarqueeCopy />
      </div>
    </div>
  );
}
