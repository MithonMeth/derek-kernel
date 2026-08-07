# DEREK

Departmental Expenditure Review & Evaluation Kernel. A single-page site where
anyone can submit a spending proposal, pay a fee in $DEREK, and receive a
ruling written by an AI civil servant with a constitution, a £980 cap, and no
appeals process. Half of every fee is burned whether he approves you or not.

Built from `derek-build-guide.md`. `constitution/CONSTITUTION.md` is the real
variant C. Two companion documents named by the guide have still not arrived:
`ai-treasury-spec.md` (Parts 1–4 were built from the guide's own descriptions)
and `test-proposals.json` (the hostile-case fixtures in `packages/core/test`
are original).

## Two things in the constitution that need a human decision

**The minimum award rejects the kettle.** Section 7 sets `Minimum award: 50`,
and the code enforces it. But section 6's own register approves a £34 kettle,
and so does the decision-log mockup. As written, that ruling is impossible —
an approval below 50 is converted to a rejection. Either the floor should drop
(to ~25, keeping the kettle) or the examples should move above it. Right now
section 7 wins, because it is the section that says it is enforced in code.

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
produce. Rulings persist, so they also populate `/log.html` — point `DATA_DIR`
at a scratch directory unless you want to keep them.

```
ANTHROPIC_API_KEY=... FAKE_TREASURY_USD=20000 PAUSED=false \
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

## Deploy (Heroku)

`git push heroku main`. One web dyno runs API + worker together
(`EMBED_WORKER` defaults to true) because dynos do not share a filesystem.

**Known limitation, deliberate for the paused pre-launch phase:** the SQLite
file lives on the dyno's ephemeral disk, so a restart wipes state. Before
unpausing with real money in play, move persistence off-dyno (the app already
has a Heroku Postgres addon to port to) or move hosts. Do not launch on
ephemeral storage.

## Launch order (from the build guide)

1. Deploy with `PAUSED=true` and `FAKE_TREASURY_USD` set — this is the current state
2. Run ~50 real submissions through yourself; read every ruling
3. Publish the constitution repo and swap in CONSTITUTION-rude.md
4. Mint, seed liquidity, transfer to the treasury address; set the token env vars
5. Verify the oracle price and that the fee lands near `FEE_TARGET_USD`
6. Solve persistence (above), then unpause with `MAX_DAILY_API_USD` low
