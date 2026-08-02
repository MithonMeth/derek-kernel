@AGENTS.md

# $TACO — project instructions

A community sentiment indicator for a Solana memecoin. Token holders vote on whether
Trump will back down ("taco") on a given live situation. A gauge shows the aggregate
reading. Nothing is staked, no outcome is wagered on, no payout depends on any
real-world event.

Full build spec: @SPEC.md
Design reference: `design/taco.html` — a complete static mockup. Match its visual
language exactly. It is the source of truth for layout, palette, type and motion.

## Non-negotiables

These are promises made in writing on the site's security section. Breaking one makes
the site a liar, which for this project is worse than a bug.

1. **Never request `signTransaction`.** Not anywhere, not for any feature. The app only
   ever calls `signIn` (SIWS) or `signMessage`. If a feature seems to need a
   transaction, stop and ask before building it.
2. **Never request token approval or delegate authority.**
3. **Auth is SIWS via `@solana/wallet-adapter`.** Do not hand-roll a signMessage auth
   flow. Domain binding and the nonce come from the SIWS input, and the server must
   verify the returned message against the input it issued — not just the signature.
4. **Votes are counted against a balance snapshot taken when the round opened**, never
   against live balance. The site states this explicitly. Live-balance checks let
   people borrow tokens to vote.
5. **One wallet, one vote. Balance does not weight the vote.** A holder with 50m tokens
   and a holder at the minimum threshold count the same.
6. **The tip jar is display-only.** Render the address, offer copy-to-clipboard. Never
   construct or send a transfer.
7. **No user uploads.** No image posting, no comment fields, no free-text submissions
   rendered to other users. This is deliberate — it keeps the site outside UK Online
   Safety Act user-to-user duties. The meme wall is curated content committed to the
   repo. If a task seems to need uploads, stop and ask.

## Stack

- Next.js (App Router), TypeScript, deployed on Vercel from GitHub
- Postgres (Neon or Supabase), accessed through a thin query layer — no heavy ORM
- `@solana/wallet-adapter` + `@solana/web3.js`
- No CSS framework. Plain CSS with custom properties, mirroring `design/taco.html`

## Conventions

- Keep the dependency tree small and justify every addition in the PR description.
  Minimal deps is a stated security property, not a preference.
- Commit the lockfile. Never use `--force` or `--legacy-peer-deps` to resolve a conflict.
- Any externally loaded script needs a Subresource Integrity hash.
- Server-side env vars only for RPC keys and DB credentials. Never expose an RPC key
  with write or archival privileges to the client.
- Wallet addresses are the only user data stored. No emails, no IPs beyond transient
  rate-limit keys, no analytics that fingerprint users.
- Reduced motion must be respected on every animation added.

## Commands

```
npm run dev        # local dev
npm run build      # production build, must pass before any PR
npm run lint
npm run test
npm run snapshot   # manually trigger a holder snapshot (see SPEC.md)
```

## Where to be careful

- **Holder snapshots need an RPC that permits `getProgramAccounts`.** Public
  mainnet-beta will rate-limit or refuse it. Assume Helius/QuickNode/Triton. If a
  snapshot fails, the round must not open — never silently fall back to live balance.
- **Round state transitions** (open → closed → archived) are the thing most likely to
  produce a wrong public number. Write tests for these before adding features.
- **Nonces are single-use and expire.** Reused nonces are a replay vector.
- Copy on the site is written in a specific voice: blunt, dry, no marketing language,
  no exclamation marks, no emoji. If you add UI text, match it. When in doubt, write
  less.

## Ask before doing

- Adding any dependency that touches wallets, signing, or crypto
- Anything that would make the site accept user-generated content
- Changing the wording of the security section or the risk warning
- Anything involving real money movement
