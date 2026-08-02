import { roadmapItems } from "@/lib/data";

const statusTag = {
  live: { label: "Live", className: "tag hot" },
  next: { label: "Next", className: "tag cool" },
  planned: { label: "Planned", className: "tag" },
} as const;

export function RoadmapSection() {
  return (
    <section id="roadmap">
      <div className="eyebrow mono">
        <span>Roadmap</span>
      </div>
      <h2 className="reveal">What&apos;s next, if any of it happens.</h2>
      <div className="roadmap-list">
        {roadmapItems.map((item) => {
          const tag = statusTag[item.status];
          return (
            <details className="rm-item reveal" data-status={item.status} key={item.title}>
              <summary className="rm-row">
                <span className="rm-node" aria-hidden="true" />
                <span className="rm-num mono">{item.number}</span>
                <span className="rm-title">{item.title}</span>
                <span className={tag.className}>{tag.label}</span>
                <span className="rm-toggle" aria-hidden="true" />
              </summary>
              <p className="rm-detail">{item.detail}</p>
            </details>
          );
        })}
      </div>
    </section>
  );
}
