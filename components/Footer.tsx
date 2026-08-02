import { siteConfig } from "@/lib/site-config";

export function Footer() {
  return (
    <footer>
      <div className="big">Taco</div>
      <div className="fr mono">
        <span>Solana · SPL</span>
        <a href="#">Contract</a>
        <a href={siteConfig.telegramUrl}>Telegram</a>
        <span>© 2026</span>
      </div>
      <p className="warn">
        Not affiliated with, endorsed by, or connected to Donald J. Trump, Trump Media &amp;
        Technology Group, Truth Social, or any government body. Political commentary and satire.
        — Votes are opinion polls of token holders. Nothing is staked, no outcome is wagered on,
        and no payout depends on any real-world event. — Risk warning: don&apos;t invest unless
        you&apos;re prepared to lose all the money you invest. This is a high-risk investment and
        you&apos;re unlikely to be protected if something goes wrong. [Placeholder: use the
        FCA&apos;s exact prescribed wording, and get approval from an authorised person before
        promoting to UK consumers.]
      </p>
    </footer>
  );
}
