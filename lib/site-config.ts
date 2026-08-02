// Placeholders that need a human before launch — see SPEC.md section 9.
// Grep this file for "TODO" before promoting any deploy to production.

export const siteConfig = {
  // The apex forwards here at the DNS/registrar level (GoDaddy doesn't
  // support ALIAS/ANAME records for root domains), so www is where the
  // app is actually served from and holds the real cert.
  canonicalDomain: process.env.NEXT_PUBLIC_CANONICAL_DOMAIN ?? "www.tacotrades.fun",

  // TODO: GitHub repo the site deploys from, e.g. "your-org/taco".
  githubRepo: process.env.NEXT_PUBLIC_GITHUB_REPO ?? "your-org/taco",

  // TODO: the $TACO SPL mint address.
  tokenMint: process.env.NEXT_PUBLIC_TOKEN_MINT ?? "TOKEN_MINT_ADDRESS_TODO",

  // TODO: minimum $TACO balance (at snapshot) required to vote.
  minHolding: process.env.NEXT_PUBLIC_MIN_HOLDING ?? "MIN_HOLDING_TODO",

  devTipAddress:
    process.env.NEXT_PUBLIC_DEV_TIP_ADDRESS ??
    "Ez9sasVzu4rUfAAGM135jeRiQpSWv4189soxgtqCdZ4g",

  telegramUrl:
    process.env.NEXT_PUBLIC_TELEGRAM_URL ?? "https://t.me/+z7jeL-5hLMY5OWI0",

  // TODO: confirm this mailbox is real and monitored — see public/.well-known/security.txt.
  securityContact:
    process.env.NEXT_PUBLIC_SECURITY_CONTACT ?? "mailto:security@tacotrades.fun",
} as const;

/**
 * Deployed commit. Checks Vercel's system env var first (per SPEC.md), falling
 * back to Heroku's (requires `heroku labs:enable runtime-dyno-metadata`).
 * Null if neither is set, e.g. local dev.
 */
export function getDeployedCommit() {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.HEROKU_SLUG_COMMIT;
  return {
    full: sha ?? null,
    short: sha ? sha.slice(0, 7) : "0000000",
    treeUrl: sha
      ? `https://github.com/${siteConfig.githubRepo}/tree/${sha}`
      : `https://github.com/${siteConfig.githubRepo}`,
  };
}
