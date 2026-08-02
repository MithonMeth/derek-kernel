import { GoalTrack } from "@/components/GoalTrack";
import { TipCopyButton } from "@/components/TipCopyButton";

export function GoalSection() {
  return (
    <section className="goal" id="goal">
      <div className="eyebrow mono">
        <span>Community goal</span>
      </div>
      <h2 className="reveal">Buy one month of the Truth API. For no reason at all.</h2>
      <GoalTrack />
      <div className="cols">
        <div className="reveal">
          <div className="rule" />
          <h3>What it costs</h3>
          <p>
            Trump Media charges up to $100,000 a month for real-time access to the platform&apos;s
            top accounts, or $60,000 a month if you sign for three years. We are not signing for
            three years.
          </p>
        </div>
        <div className="reveal">
          <div className="rule" />
          <h3>Do we need it</h3>
          <p>
            No. It sells a few milliseconds of head start to high-frequency trading desks. We
            publish a vote result every few days. A scraper costs fractions of a penny per call
            and is entirely sufficient.
          </p>
        </div>
        <div className="reveal">
          <div className="rule" />
          <h3>Then why</h3>
          <p>
            Because buying one month of the president&apos;s posting feed to power a chicken-out
            meter is the funniest possible use of it, and we will post the invoice.
          </p>
        </div>
      </div>

      <div className="tip reveal">
        <div>
          <h3>Buy the dev a coffee</h3>
          <p>
            The indicator, the site and the backend are one person&apos;s evenings. No treasury,
            no team allocation, no salary. If it made you laugh, caffeine is welcome.
          </p>
        </div>
        <div>
          <span className="mono tip-label">Dev wallet · SOL</span>
          <TipCopyButton />
          <p className="alt mono">Send it yourself from your wallet. This page will never open a transaction prompt.</p>
        </div>
      </div>
    </section>
  );
}
