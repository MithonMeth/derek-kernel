import { memeWall } from "@/lib/data";
import { siteConfig } from "@/lib/site-config";

export function CommunitySection() {
  return (
    <section className="comm" id="community">
      <div className="eyebrow mono">
        <span>Community</span>
      </div>
      <h2 className="reveal">Come and post something stupid.</h2>
      <p className="lede reveal">
        The indicator is the serious bit, and it isn&apos;t very serious. Everything else happens
        in the Telegram: memes, arguing about the next question, calling the tacos before they
        land.
      </p>

      <div className="cta">
        <a className="btn big" href={siteConfig.telegramUrl}>
          Join the Telegram →
        </a>
        <a className="btn line" href={siteConfig.xUrl}>
          X / Twitter
        </a>
      </div>

      <div className="wall">
        {memeWall.map((meme, i) => (
          <div className="mm reveal" key={meme.caption}>
            <span className="mono">{String(i + 1).padStart(2, "0")}</span>
            <div>
              <p className="cap">{meme.caption}</p>
              <p className="by mono">{meme.by}</p>
            </div>
          </div>
        ))}
        <p className="note mono">
          Wall is curated from the Telegram each week. Post there, not here — we don&apos;t take
          uploads on this site, on purpose.
        </p>
      </div>

      <div className="rules">
        <div className="reveal">
          <div className="rule" />
          <h4>One group, everyone welcome</h4>
          <p>
            You don&apos;t need to hold anything to hang around and take the piss. Holding only
            matters when a round opens and you want to vote.
          </p>
        </div>
        <div className="reveal">
          <div className="rule" />
          <h4>Voting stays on the site</h4>
          <p>
            The gate lives here, not in the chat. Nobody in the group will ever ask you to connect
            a wallet to a bot or a link they sent you.
          </p>
        </div>
        <div className="reveal">
          <div className="rule" />
          <h4>What gets you removed</h4>
          <p>Shilling other tokens, posting contract addresses, DMing members unprompted, and being boring about it.</p>
        </div>
        <div className="reveal">
          <div className="rule" />
          <h4>Question submissions</h4>
          <p>Anyone can propose the next round&apos;s question. Holders vote on which one runs.</p>
        </div>
      </div>

      <div className="dm reveal">
        <h3>Nobody here will ever DM you first</h3>
        <p>
          Not the dev, not an admin, not &quot;support&quot;. Every drained wallet in this corner
          of the internet starts with a friendly unsolicited message. If someone with our name
          messages you offering help, an airdrop, a whitelist or a fix, it is a scam without
          exception — screenshot it, post it in the group, and block them. Admins are only ever
          admins inside the group.
        </p>
      </div>
    </section>
  );
}
