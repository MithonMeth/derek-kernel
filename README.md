# DEREK

Departmental Expenditure Review & Evaluation Kernel. A single-page site where
anyone can submit a spending proposal, pay a fee in $DEREK, and receive a
ruling written by an AI civil servant with a constitution, a £980 cap, and no
appeals process. Half of every fee is burned whether he approves you or not.

Built from `derek-build-guide.md`. The companion documents it references
(`ai-treasury-spec.md`, `CONSTITUTION-rude.md` variant C, `test-proposals.json`)
were not available at build time — the constitution in `constitution/` is a
marked placeholder, and the hostile-case test fixtures are original. Swap both
when the real documents land.

## Layout

```
constitution/        CONSTITUTION.md + LIMITS.json — validated at boot; boot refuses on drift
packages/core        pipeline, guards, db, oracle, deposits, claims, publisher — no HTTP server
packages/worker      worker entrypoint + admin CLI
packages/api         fastify: /api/*, /r/:docket permalinks, serves the static site
packages/web         the site (no build step)
```

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
npm run admin -- …   status | pause | unpause | approve <docket> | claim-paid <code> <tx> | queue
```

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
