// Placeholders that need a human before launch — see SPEC.md section 9.
// Grep this file for "TODO" before promoting any deploy to production.

export const siteConfig = {
  // TODO: replace with the real production domain. Anything else is a clone.
  canonicalDomain: process.env.NEXT_PUBLIC_CANONICAL_DOMAIN ?? "taco.example",

  // TODO: GitHub repo the site deploys from, e.g. "your-org/taco".
  githubRepo: process.env.NEXT_PUBLIC_GITHUB_REPO ?? "your-org/taco",

  // TODO: the $TACO SPL mint address.
  tokenMint: process.env.NEXT_PUBLIC_TOKEN_MINT ?? "TOKEN_MINT_ADDRESS_TODO",

  // TODO: minimum $TACO balance (at snapshot) required to vote.
  minHolding: process.env.NEXT_PUBLIC_MIN_HOLDING ?? "MIN_HOLDING_TODO",

  // TODO: dedicated tip wallet — must not be a personal wallet.
  devTipAddress:
    process.env.NEXT_PUBLIC_DEV_TIP_ADDRESS ??
    "SoLDevWa11etAddre55GoesHere000000000000000",

  // TODO: cross-published so members can verify they're the real ones.
  telegramUrl: process.env.NEXT_PUBLIC_TELEGRAM_URL ?? "#",
  xUrl: process.env.NEXT_PUBLIC_X_URL ?? "#",

  // TODO: disclosure contact for security.txt (RFC 9116).
  securityContact:
    process.env.NEXT_PUBLIC_SECURITY_CONTACT ?? "mailto:security@taco.example",
} as const;

/** Deployed commit, wired from Vercel's system env var. Unset outside a Vercel build. */
export function getDeployedCommit() {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  return {
    full: sha ?? null,
    short: sha ? sha.slice(0, 7) : "0000000",
    treeUrl: sha
      ? `https://github.com/${siteConfig.githubRepo}/tree/${sha}`
      : `https://github.com/${siteConfig.githubRepo}`,
  };
}
