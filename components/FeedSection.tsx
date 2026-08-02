import { feedItems } from "@/lib/data";

const tagLabel = { bearish: "Bearish taco", mixed: "Mixed", bullish: "Bullish taco" } as const;
const tagClass = { bearish: "tag hot", mixed: "tag", bullish: "tag cool" } as const;

export function FeedSection() {
  return (
    <section id="feed">
      <div className="eyebrow mono">
        <span>Evidence</span>
      </div>
      <h2 className="reveal">What the indicator is reading right now.</h2>
      <div className="feed">
        {feedItems.map((item) => (
          <div className="item reveal" key={item.headline}>
            <span className="src mono">
              {item.source} · {item.date}
            </span>
            <h4>{item.headline}</h4>
            <span className={tagClass[item.tag]}>{tagLabel[item.tag]}</span>
          </div>
        ))}
      </div>
      <p className="mono feed-note">Static demo. Live feed needs a backend — see notes.</p>
    </section>
  );
}
