import { historyRows } from "@/lib/data";

export function HistorySection() {
  return (
    <section id="history">
      <div className="eyebrow mono">
        <span>Form guide</span>
      </div>
      <h2 className="reveal">Previous tacos. The indicator has priors.</h2>
      <div className="hist">
        {historyRows.map((row) => (
          <div className="row reveal" key={row.title}>
            <span className="mono">{row.date}</span>
            <h3>{row.title}</h3>
            <p>{row.note}</p>
            <span className={`v ${row.outcome === "taco" ? "taco" : "no"}`}>
              {row.outcome === "taco" ? "TACO" : "NO TACO"}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
