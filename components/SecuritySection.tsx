import { getDeployedCommit, siteConfig } from "@/lib/site-config";

export function SecuritySection() {
  const commit = getDeployedCommit();

  return (
    <section className="sec" id="security">
      <div className="eyebrow mono">
        <span>Connecting a wallet</span>
      </div>
      <h2 className="reveal">You should be suspicious. Here&apos;s exactly what happens.</h2>
      <p className="lede reveal">
        Connecting to a site you don&apos;t know is how people lose everything. So this page
        tells you what we ask for, what we can&apos;t do, and how to check we&apos;re telling the
        truth.
      </p>

      <div className="flow">
        <div className="fstep reveal">
          <span className="mono n">01</span>
          <h3>You pick your wallet</h3>
          <p>
            We use the Solana Wallet Adapter, the standard library maintained for the ecosystem.
            We haven&apos;t written our own wallet code and you shouldn&apos;t trust anyone who
            has.
          </p>
        </div>
        <div className="fstep reveal">
          <span className="mono n">02</span>
          <h3>We read your balance</h3>
          <p>
            A public read of how much $TACO the address holds, taken from a public RPC node. This
            is information anyone can look up on Solscan without your permission. It doesn&apos;t
            require anything from you.
          </p>
        </div>
        <div className="fstep reveal">
          <span className="mono n">03</span>
          <h3>You sign one message</h3>
          <p>
            Sign In With Solana — a standard your wallet builds and displays, not us. It contains
            our domain, a one-time nonce and a timestamp. Your wallet will warn you if the domain
            doesn&apos;t match the site you&apos;re on. Read it before you sign.
          </p>
        </div>
        <div className="fstep reveal">
          <span className="mono n">04</span>
          <h3>We check the signature and record one vote</h3>
          <p>
            The signature proves the address is yours. Your vote is stored against a snapshot
            taken when the round opened, so nobody can borrow tokens to vote. Then we&apos;re done
            until the next round.
          </p>
        </div>
      </div>

      <div className="never reveal">
        <h3>What we will never ask for</h3>
        <ul>
          <li>A transaction to sign. Voting costs nothing and moves nothing.</li>
          <li>Token approval or delegate authority over your wallet.</li>
          <li>A seed phrase or private key. Nobody legitimate ever asks. Ever.</li>
          <li>Any payment, deposit, gas fee or &quot;verification&quot; transfer to vote. Voting is free, always.</li>
        </ul>
        <p className="tail">
          A signed message cannot move funds. That&apos;s the whole security model — we only ever
          ask for the one thing that can&apos;t hurt you. The tip jar further down is the one
          place money is mentioned, and even that never triggers a prompt: you copy an address and
          send it yourself, or you don&apos;t. If this site ever asks you to approve a
          transaction, it isn&apos;t this site. Check the domain in your address bar against the
          one published on our socials.
        </p>
      </div>

      <div className="proof">
        <div className="reveal">
          <div className="rule" />
          <h4>The code is public</h4>
          <p>Whole repo, MIT licensed, no minified-only builds. Read it, fork it, tell us what&apos;s wrong with it.</p>
        </div>
        <div className="reveal">
          <div className="rule" />
          <h4>The build is traceable</h4>
          <p>
            The site deploys from GitHub through CI. The commit hash it was built from is printed
            below — diff it against the repo yourself. Open source means nothing if you can&apos;t
            check the deployed version matches.
          </p>
        </div>
        <div className="reveal">
          <div className="rule" />
          <h4>Dependencies are minimal</h4>
          <p>
            Lockfile committed, Dependabot on, integrity hashes on anything loaded externally.
            Most front-end wallet hacks arrive through a compromised package, not through the
            app&apos;s own code.
          </p>
        </div>
        <div className="reveal">
          <div className="rule" />
          <h4>Found something?</h4>
          <p>Disclosure contact is in our security.txt. Report it before you post it and we&apos;ll credit you.</p>
        </div>
      </div>

      <div className="repo">
        <span className="mono">
          Deployed from{" "}
          <code id="commit">
            <a href={commit.treeUrl}>{commit.short}</a>
          </code>{" "}
          · <a href={`https://github.com/${siteConfig.githubRepo}`}>github.com/{siteConfig.githubRepo}</a>
        </span>
        <span className="mono">
          Canonical domain — <code>{siteConfig.canonicalDomain}</code> — anything else is a clone
        </span>
      </div>
    </section>
  );
}
