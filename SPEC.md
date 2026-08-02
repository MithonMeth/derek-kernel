# $TACO — build spec

## What this is

A single-page site with a live sentiment gauge. Token holders vote on a recurring
question about whether Trump will back down on a current situation. The gauge shows
the vote split. Past rounds are archived as a form guide. A news feed provides context.

The static mockup in `design/taco.html` is visually complete. This spec is about making
it real.

---

## 1. Phases

Build in this order. Each phase should deploy and work on its own.

**Phase 1 — Static deploy**
Port `design/taco.html` to Next.js components. All data hardcoded. Deploy to Vercel
from GitHub. Wire `VERCEL_GIT_COMMIT_SHA` into the security section's commit display.
Add `security.txt`, CSP headers, canonical domain.

**Phase 2 — Rounds and voting**
Database, SIWS auth, vote recording, live gauge. Snapshot job. This is the core.

**Phase 3 — Feed ingestion**
Scheduled job pulling news and Truth Social posts, stored and tagged.

**Phase 4 — Admin**
A minimal authenticated surface for opening/closing rounds, curating the feed and the
meme wall. Can be a protected route or just direct DB access early on.

---

## 2. Data model

```sql
create table rounds (
  id            serial primary key,
  question      text not null,
  context       text,                    -- one-line framing shown under the question
  opens_at      timestamptz not null,
  closes_at     timestamptz not null,
  snapshot_slot bigint,                  -- solana slot the snapshot was taken at
  snapshot_done boolean not null default false,
  status        text not null default 'draft',  -- draft|open|closed|archived
  outcome       text,                    -- 'taco' | 'no_taco' | null until resolved
  outcome_note  text,
  resolved_at   timestamptz
);

create table snapshot_balances (
  round_id  int not null references rounds(id),
  wallet    text not null,
  balance   numeric not null,
  primary key (round_id, wallet)
);

create table votes (
  round_id   int not null references rounds(id),
  wallet     text not null,
  choice     text not null,              -- 'taco' | 'no_taco'
  created_at timestamptz not null default now(),
  primary key (round_id, wallet)         -- enforces one wallet one vote
);

create table auth_nonces (
  nonce      text primary key,
  issued_at  timestamptz not null default now(),
  used_at    timestamptz
);

create table feed_items (
  id           serial primary key,
  source       text not null,            -- 'CNN', 'Truth Social', etc
  headline     text not null,
  url          text not null,
  published_at timestamptz not null,
  tag          text,                     -- 'bullish_taco' | 'bearish_taco' | 'mixed'
  visible      boolean not null default false
);
```

`votes` has no signature column on purpose. The signature proves the request; storing
it is a liability with no upside.

---

## 3. Auth flow (SIWS)

Use `@solana/wallet-adapter`. Detect the `signIn` feature; fall back to
`connect` + `signMessage` only for wallets that lack it.

```
POST /api/auth/nonce
  → { nonce, domain, statement, issuedAt }
  Server stores nonce, unused, 5 minute TTL.

Client builds SolanaSignInInput from that response, calls wallet.signIn(input).

POST /api/auth/verify
  body: { input, output }   -- output contains account, signedMessage, signature
  Server:
    1. Look up nonce. Reject if missing, used, or expired.
    2. Verify the returned message parses to the input the server issued.
       Check domain matches, nonce matches, issuedAt within window.
    3. Verify the ed25519 signature over signedMessage for output.account.publicKey.
    4. Mark nonce used.
    5. Issue a short-lived httpOnly session cookie (JWT or signed session id),
       scoped to the wallet address.
```

Step 2 is the one people skip. Verifying only the signature without checking the
message matches what you issued is the vulnerability described in the SIWS docs.

Rate limit `/api/auth/nonce` per IP. Wallet creation is free, so this is the only
meaningful bot control at this layer.

---

## 4. Snapshots

The site promises votes are counted against a snapshot taken at round open.

**Job: `npm run snapshot -- --round <id>`**

1. Get current slot.
2. Fetch all token accounts for the mint. `getProgramAccounts` on the SPL Token
   program, filtered by `dataSize: 165` and a `memcmp` on the mint at offset 0.
   Requires an RPC provider that permits this — public mainnet-beta does not, reliably.
3. Sum balances per owner (a wallet can hold multiple token accounts for one mint).
4. Insert rows into `snapshot_balances` for every owner at or above
   `MIN_HOLDING` (env var).
5. Set `snapshot_slot` and `snapshot_done = true`. Only then may status become `open`.

If the snapshot fails, the round stays in `draft`. Never open a round without one, and
never fall back to a live balance check — that would make the site's own copy false.

Consider storing only wallets above the threshold to keep the table small, but log the
total holder count for the record.

---

## 5. Voting

```
POST /api/vote
  body: { choice }
  auth: session cookie
  Server:
    1. Resolve wallet from session.
    2. Load current round. Reject unless status = 'open' and now < closes_at.
    3. Look up (round_id, wallet) in snapshot_balances. Reject if absent —
       message: "This wallet was below the threshold when the round opened."
    4. Insert into votes. Primary key collision → 409, already voted.
    5. Return updated tally.
```

```
GET /api/rounds/current
  → { id, question, context, closesAt, tally: { taco, noTaco }, total, eligible }
```

`eligible` reflects the requesting session, if any. Public callers get the tally and
question but percentages stay hidden in the UI until the wallet is verified — that's a
front-end presentation choice, not a security boundary, so don't over-engineer it.

Cache the tally for 5–10 seconds. The gauge does not need to be real-time.

---

## 6. Gauge

Score = `taco / (taco + noTaco) * 100`, rounded.
Needle rotation = `(score / 100) * 180 - 90` degrees.
Animate the transition; respect `prefers-reduced-motion`.

Show the vote count alongside. A 100% reading from 4 votes should not look like a
100% reading from 4,000, so display the denominator prominently.

---

## 7. Feed ingestion

Scheduled job (Vercel Cron, every 15 minutes):

1. Pull recent articles matching configured keywords from a news API.
2. Pull recent posts from the tracked Truth Social account via a third-party scraper
   API. Do not build a scraper — use a provider.
3. Deduplicate on URL. Insert with `visible = false`.
4. Items become visible only after a human sets a tag. The tags are editorial
   judgement about which way something cuts, and an automated guess will eventually be
   embarrassing.

Store the provider name and cost per call in the repo README so the running cost is
visible to anyone reading the code.

**Do not integrate the official Truth API.** It is $100k/month, aimed at HFT desks, and
the site's own copy jokes about this. If the community goal ever funds it, that's a
separate decision.

---

## 8. Security requirements

- CSP with no `unsafe-inline`. Move the mockup's inline script and styles into files.
- SRI hashes on any CDN-loaded resource. Prefer self-hosting the fonts.
- `security.txt` at `/.well-known/security.txt` with a disclosure contact.
- Rate limits on `/api/auth/nonce` and `/api/vote`.
- No wallet address appears in any log line, error report or analytics payload.
- Dependabot enabled. Any advisory on a wallet-adjacent package is treated as urgent.
- The deployed commit hash renders in the security section, linked to the GitHub tree
  at that commit.

---

## 9. Content that needs a human

These are placeholders in the mockup and must be filled before launch:

- Token mint address and `MIN_HOLDING` threshold
- Dev tip wallet address — use a dedicated wallet, not a personal one
- Telegram invite link, cross-published so it can be verified. No X/Twitter presence —
  deliberate, not a placeholder gap.
- Canonical domain, replacing `taco.example`
- The FCA risk warning. The mockup's text is a marked placeholder and is **not** the
  prescribed wording. Get the exact text from FCA guidance, and get approval from an
  authorised person before promoting to UK consumers.
- Meme wall images, committed to the repo

---

## 10. Out of scope

Explicitly not building:

- Staking, rewards, or any payout tied to vote outcomes. This is what keeps the project
  out of gambling and prediction-market regulation.
- User uploads or user-to-user messaging on the site.
- Any on-chain program. There is no contract to write; the token is a standard
  pump.fun SPL mint and voting is entirely off-chain.
- Balance-weighted voting.
