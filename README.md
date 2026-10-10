# Footsy100

A footballer stock exchange played with fake money. Everyone starts the season with £100, buys shares in Premier League players, and prices move after each match based on how the player performed.

- **Hosting:** one Cloudflare Worker that serves the static front end from `public/` and the API under `/api`, with a D1 database.
- **Data:** the free (unofficial) Fantasy Premier League API, pulled by a cron trigger every 15 minutes. `src/fpl.ts` sits behind a `DataProvider` interface, so a paid source such as API-Football can replace it later.

## Game rules
- New accounts get £100 per season. Fractional shares are allowed and the minimum trade is 10p.
- Starting prices come from FPL prices: a £5.5m FPL player lists at £5.50.
- Trading on a player locks **2 hours before his team kicks off** and reopens once we settle prices: when FPL marks the match finished, or 2.5 hours after kick-off if FPL has the match at full time (bonus points are in by then, but FPL's final "finished" flag can take until the end of the day).
- Settlement moves each player's price by the weights in `src/pricing.ts` (goals, assists, clean sheets, cards, saves, bonus, defensive contributions, minutes). A player who doesn't feature drifts down 1%. Net buying or selling since his last match adds a small nudge, capped at ±3%. A single match move is capped at −25% / +40%.
- Selling costs a 2% fee.
- Leaderboards rank by total value (cash plus holdings at current prices). When a new season appears in the FPL data, final values are frozen into an all-time table, prices reset to FPL prices, and everyone restarts at £100.
- Private leagues use a 6-character invite code.
- Sign-in is by emailed magic link (sent with [Resend](https://resend.com), free up to 3,000 emails a month).

## Local development
```sh
npm install
npm run db:migrate:local
echo 'DEV_MODE="true"' > .dev.vars   # sign-in links are shown on screen instead of emailed
npm run dev                          # http://localhost:8787
npm test
```
To pull FPL data locally, add `ADMIN_TOKEN="something"` to `.dev.vars` and run
`curl -X POST localhost:8787/api/admin/sync -H "Authorization: Bearer something"`.

## Deploying
In Cloudflare's Git build settings, set the deploy command to `npm run deploy`. That deploys the Worker, which creates the `footsy100` D1 database on the first run, and then applies any new migrations.

Then set two secrets in the dashboard (Worker > Settings > Variables and Secrets) or with `npx wrangler secret put`:
- `RESEND_API_KEY`: from resend.com. It must come from the same Resend account that verified your sending domain.
- `ADMIN_TOKEN`: any long random string.

And one plain variable (type Text) on the same page:
- `EMAIL_FROM`: the sender, such as `Footsy100 <footsy100@yourdomain.com>`. The domain must be verified in Resend, and any domain you already verified there works, even one used by another project. Without it, mail goes from Resend's test sender, which only delivers to your own Resend account email. `keep_vars` in `wrangler.jsonc` stops deploys from wiping it.

Finally, trigger the first data sync so players load straight away:
`curl -X POST https://footsy100.<you>.workers.dev/api/admin/sync -H "Authorization: Bearer <ADMIN_TOKEN>"`

## Limits to know about
- The FPL API is unofficial and undocumented. It can change without notice, and its terms don't cover commercial use. That's fine for a free hobby game, and the provider interface keeps a swap cheap.
- The FPL API doesn't expose passes or offsides, so those aren't in the formula yet.
- The Workers free plan allows 10ms of CPU per run, and parsing FPL's ~2MB player file alone takes longer. So the sync hands FPL's JSON text to D1 (`json_each`) to parse, settles at most 2 matches per run, and records each step at `/api/status` so a stalled run is visible.
