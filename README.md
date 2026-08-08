# DEREK

Departmental Expenditure Review & Evaluation Kernel. A single-page site where
anyone can submit a spending proposal, pay a fee in $DEREK, and receive a
ruling written by an AI civil servant with a constitution, a $980 cap, and no
appeals process. Half of every fee is burned whether he approves you or not.

Built from `derek-build-guide.md`. `constitution/CONSTITUTION.md` is the real
variant C. Two companion documents named by the guide have still not arrived:
`ai-treasury-spec.md` (Parts 1–4 were built from the guide's own descriptions)
and `test-proposals.json` (the hostile-case fixtures in `packages/core/test`
are original).

## Two things in the constitution that need a human decision

**Settled: the minimum award is 1.** Section 7 originally said 50, which made
the $34 kettle in section 6's own register — and in the decision-log mockup —
impossible to approve. The floor is now 1, changed in both `LIMITS.json` and
section 7 together, because the boot check refuses to start if the prose and
the enforced number disagree.

**Persona.** The constitution says "I am the Manager"; the site, token and
domain say DEREK. The build is consistent with reading DEREK as the system
(Departmental Expenditure Review & Evaluation Kernel) and the Manager as the
civil servant operating it — which is how the decision log's colophon reads —
so the constitution ships verbatim and the site keeps its own name. If they are
meant to be one name, the site copy is what changes.

**No submitter identity exists.** The constitution keeps a per-submitter tally
("If yours is in double figures I will mention it") and the log mockup shows a
handle. Submissions are anonymous — payment arrives at a per-docket address
with no account — so the log renders "submitted anonymously" and no tally. The
paying wallet could supply a stable pseudonym, but that means parsing the
funding transaction and was not built.

## Layout

```
constitution/        CONSTITUTION.md + LIMITS.json — validated at boot; boot refuses on drift
packages/core        pipeline, guards, db, oracle, deposits, claims, publisher — no HTTP server
packages/worker      worker entrypoint + admin CLI
packages/api         fastify: /api/*, /r/:docket permalinks, serves the static site
packages/web         the site (no build step) — `/` and `/log.html`
```

## Posting to X

OAuth 1.0a, four config values (`X_CONSUMER_KEY`, `X_CONSUMER_SECRET`,
`X_ACCESS_TOKEN`, `X_ACCESS_SECRET`). Missing any of them, rulings queue for
manual posting instead of failing — `npm run admin -- queue` prints them.
`X_USER_ID` is optional and used only to reconcile after a failed post.

**The post deliberately contains no link.** X moved to pay-per-use in February
2026 and closed the free and fixed tiers to new signups. It charges **$0.015
per post, and $0.20 if the text contains a URL**. Against the $2 fee, the
airdrop share is $0.30:

| | post | + model | vs airdrop share | result |
|---|---|---|---|---|
| with a link | $0.200 | $0.207 | $0.300 | margin $0.093 |
| without | $0.015 | $0.022 | $0.300 | margin $0.278 |

**This changed when the fee went from $0.40 to $2.** At the old fee a link lost
$0.147 per ruling and omitting it was forced arithmetic. It no longer is: a
link is affordable now. It still costs $0.185 — 62% of what a ruling
contributes to airdrops — to save a reader one tap, so the post stays linkless
by judgement rather than by necessity, and the permalink belongs on the share
card image where it costs nothing. There is a test asserting no URL appears in
the post text, so reversing this is a deliberate act rather than a slip.

> **Two things still missing.** The share card images are designed but not
> generated, so posts currently carry no image and therefore no visible
> permalink at all — card rendering is the piece that makes the linkless post
> work. And the transport has never run against the live API: the signing is
> unit-tested and the HMAC is checked against the RFC 2202 vector, but a real
> credential smoke test is required before trusting it.

## Sweeping

Fees land in one throwaway deposit address per docket. Sweeping empties them
into the three destinations the site promises — burned, Treasury, ops — at the
`fee_split` in `LIMITS.json`.

```
npm run admin -- sweep           # dry run: prints exactly what would move
npm run admin -- sweep --send    # actually moves it
```

The rules it works to, all of them tested:

- **Moves the live balance, not the quoted fee.** An underpayment inside
  tolerance or an overpayment both sweep for what is really there.
- **The split is exact.** Integer maths, and the Treasury absorbs the
  remainder, so burn + treasury + ops is always precisely the balance — never
  a token created or lost.
- **Re-sweeping is harmless.** The amount always comes from the live balance,
  so a crash between sending and recording cannot double-spend: the next pass
  reads zero and marks it done.
- **A failure leaves the docket unswept** to be retried, rather than marked.
- **Dust is written off** rather than paying a network fee to move less than
  it costs.
- **Half-configured is refused.** A fee payer without destination addresses
  throws instead of sending somewhere unintended.

The burn is a real SPL burn instruction, not a transfer to an incinerator
address: it reduces total supply on chain, needs no destination account, and
is independently verifiable. `BURN_ADDRESS` is consequently unused.

`SWEEP_FEE_PAYER_SECRET` is a base58 secret key holding a little SOL. A deposit
address holds only tokens, so it cannot pay for its own transaction; Solana
lets a separate account pay the fee, which avoids pre-funding thousands of
throwaway addresses. The deposit account still signs as the token owner.

One transaction per docket rather than batched, which contradicts the build
guide. On Solana a signature costs a fraction of a cent, so isolating a failure
to a single docket is worth more than the saving — the guide's batching advice
is really an EVM concern.

> **Not yet exercised against a live chain.** The logic, the split and the
> failure paths are tested against a fake, and the HD derivation is verified to
> produce keypairs that actually control the advertised addresses. Sending has
> never run against a validator. Do a devnet mint and a full sweep there before
> pointing this at mainnet.

## Cycles

A cycle is a day, anchored to a `cycle_epoch` fixed on first boot, and it is
what the constitution's `Approvals per cycle: 1` is counted against. A second
approvable proposal in the same cycle is **held**, not rewritten into a
rejection: the ruling stands and is published as an approval, but no claim code
issues until an operator countersigns it (`npm run admin -- approve <docket>`),
and the countersign path enforces the same limit. Only approvals that actually
issued consume the cycle's slot, so one held ruling does not block the next.

## The hero model

`packages/web/public/models/typewriter.glb` is an IBM Selectric II (glTF 2.0,
627KB, 5.4k triangles, no compression extensions). `public/js/hero3d.js` loads
it after first paint and replaces the line-art placeholder; the placeholder
stays if WebGL is missing or the model fails, so nothing on the page depends
on the 3D working. Idle turntable, drag or arrow keys to turn, and it stops
rendering entirely when off-screen or backgrounded. `prefers-reduced-motion`
gets a still frame.

three.js is self-hosted rather than loaded from a CDN — no third-party runtime
dependency and nothing to SRI-hash. `npm run vendor -w @derek/web` re-copies it
from node_modules after a version bump; the import map in `index.html` points
the bare `three` specifier at the vendored build.

## Commands

```
npm test             vitest, all packages — the done-when conditions from the build guide
npm run build        tsc, all packages
npm start            API server; embeds the worker loops unless EMBED_WORKER=false
npm run start:worker standalone worker (only when web and worker share a filesystem)
npm run admin -- …   status | rule <file> | pause | unpause | approve <docket> |
                     claim-paid <code> <tx> | queue | mark-posted <docket> <id>
```

## The read-through (launch order step 2)

`admin rule <proposals.json>` pushes proposals through the real pipeline with
no payment, no token and no chain, and prints each ruling. It runs the same
`judgeDocket` the worker does, so what you read is what production will
produce. Rulings persist, so they also populate `/log.html` — point
`DATABASE_URL` at a scratch database unless you want to keep them.

```
ANTHROPIC_API_KEY=... FAKE_TREASURY_USD=20000 PAUSED=false \
  DATABASE_URL=postgres://derek:derek@localhost:55432/derek \
  npm run admin -- rule proposals/starter.json
```

`proposals/starter.json` is eight proposals standing in for the
`test-proposals.json` that never arrived — padding, a clean object, an
injection attempt with an embedded payout address, a hardship case, and an
automation request that should hit the constitution's declared weakness.
Measured cost is about **$0.007 per ruling**.

## Environment

See `.env.example`. Nothing chain- or model-side is required to boot: with no
`ANTHROPIC_API_KEY` the ruling cycle idles, with no `RPC_URL` payment watching
idles, with no `DEPOSIT_MASTER_SEED` submissions are refused. `PAUSED=true`
(the deploy default) halts intake regardless; `npm run admin -- unpause` flips
it at runtime without a redeploy.

Price oracle: DexScreener `GET /tokens/v1/{chain}/{mint}` (free, no key,
60 req/min), fallback DexPaprika `GET /networks/{net}/tokens/{mint}` (free).
FX: frankfurter.dev (free, ECB). Model calls: Haiku 4.5 screening + Sonnet 5
ruling, ≈$0.01 per submission, capped by `MAX_DAILY_API_USD`.

## Persistence

Postgres, via `DATABASE_URL` (Heroku sets it from the addon). There is no
local-file fallback on purpose: a dyno's disk does not survive a restart, and
silently writing a ledger somewhere ephemeral is how a ruling goes missing.
Boot fails loudly if `DATABASE_URL` is unset.

Tests run against a real Postgres rather than an in-memory stand-in, each
suite in its own schema:

```
docker run -d --name derek-pg -e POSTGRES_PASSWORD=derek -e POSTGRES_USER=derek \
  -e POSTGRES_DB=derek -p 55432:5432 postgres:16-alpine
npm test          # override with TEST_DATABASE_URL if needed
```

Millisecond timestamps are `bigint`, parsed back to JS numbers (pg returns
int8 as a string by default, which would silently break every comparison
against `Date.now()`). Token amounts stay `text` and are only ever handled as
`BigInt` — they are the values that genuinely need arbitrary precision.

## Deploy (Heroku)

`git push heroku main`. One web dyno runs API + worker together
(`EMBED_WORKER` defaults to true), so there is a single writer.

## Launch order (from the build guide)

1. Deploy with `PAUSED=true` and `FAKE_TREASURY_USD` set — this is the current state
2. Run ~50 real submissions through yourself; read every ruling
3. Publish the constitution repo and swap in CONSTITUTION-rude.md
4. Mint, seed liquidity, transfer to the treasury address; set the token env vars
5. Verify the oracle price and that the fee lands near `FEE_TARGET_USD`
6. Solve persistence (above), then unpause with `MAX_DAILY_API_USD` low
