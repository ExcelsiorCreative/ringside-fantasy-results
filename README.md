# Ringside Results DB

A self-updating wrestling results database for WWE, AEW, TNA and NXT. It runs on free plans only:

- **Cloudflare Worker + D1** stores the data and serves a read-only API to the fantasy app.
- **GitHub Actions** runs every 6 hours. It reads Wikipedia, works out the results and writes changes to D1.

Nobody has to enter data. A match the system can read cleanly is published. A match it can't read cleanly is **held** instead of guessed, retried on every run for 14 days, and listed on the status page.

## What it covers today

| Source | Status | What you get |
|---|---|---|
| Cagematch | **On** (written permission from Philip, Oct 2, 2026: non-commercial use) | All show results: weekly TV (Raw, SmackDown, NXT, Dynamite, Collision, Impact) and premium live events |
| Wikipedia (MediaWiki API) | **On, champions only** | Current champions from each title's article. It stops adding events while Cagematch is on, so no show is counted twice |
| Official promotion sites | Off | Only after their terms are checked |

**Cagematch rules this project keeps** (from Philip's permission and our request):
- Non-commercial use only. If the app ever makes money, ask Cagematch again first.
- One request at a time, at least 6 seconds apart, and a daily budget of 40 requests (`cagematch.daily_budget`). A normal run uses about 3–8: the results list plus each new or recent event.
- A descriptive User-Agent with your contact email.
- Cagematch sits behind a Sucuri firewall. At the first 403/429/503 or firewall page, the runner pauses Cagematch for 24 hours, makes no more requests, and the run shows as failed so GitHub emails you. **Don't lower the gap or raise the budget**; that is what gets a bot blocked.
- Events are re-read for 2 days after they air (`cagematch.recheck_days`), because volunteers correct results.

**Champions:** anyone in a current reign is a champion, including each member of a tag team or trios title team. So every holder is eligible for the fantasy Champion slot, and the CSV export marks them `is_champion = yes`.

Done automatically: results, win/loss records (your Oct 2, 2026 baseline plus new results), title changes and reign history, corrections (a fixed result re-scores and rebuilds title history), injury clearing (a wrestler marked injured is cleared when they wrestle again), and short news lines written from results.

Not automatic yet: Royal Rumble and Elimination Chamber matches (held, because elimination counts are needed), Money in the Bank cash-ins (held), new injuries (they come from your seed file for now), and adding brand-new wrestlers (their matches are held and the names are listed on the status page).

## One-time setup (about 30 minutes)

You need a free [Cloudflare](https://dash.cloudflare.com/sign-up) account, a free [GitHub](https://github.com/signup) account, and Node.js 22.18 or newer on your computer.

**1. Put the code on GitHub.** Create a new **public** repository (public repos get unlimited free Actions minutes) and upload this folder to it.

**2. Create the database** (in a terminal, inside this folder):
```
npx wrangler@latest login          # opens a browser to log in to Cloudflare
npm run db:create                  # prints a database_id
```
Paste the `database_id` into `wrangler.toml`, then:
```
npm run db:migrate                 # creates the tables and records the Cagematch permission
npm run seed:build                 # builds seed/seed.sql from data/seed/*.csv and prints an import report
npm run db:seed                    # loads your 261 wrestlers and 30 championships
npm run deploy                     # publishes the Worker; note the *.workers.dev URL it prints
```

**3. Create an API key for the fantasy app:**
```
npm run make-key fantasy-app
```
It prints a key (save it) and a command. Run that command to store the key's hash.

**4. Create a Cloudflare API token for the runner.** In the Cloudflare dashboard, go to My Profile > API Tokens > Create Token > Custom token, and give it the permission **Account · D1 · Edit**. Copy the token. Your **Account ID** is on the right side of the Workers & Pages overview page.

**5. Add GitHub secrets.** In the repo, go to Settings > Secrets and variables > Actions > New repository secret, and add:

| Name | Value |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | your account ID |
| `CLOUDFLARE_API_TOKEN` | the token from step 4 |
| `D1_DATABASE_ID` | the database_id from step 2 |
| `CONTACT_EMAIL` | your email. It goes in the User-Agent so Wikipedia can reach you |

**6. First run, as a test.** Go to Actions > Ingest results > Run workflow, and tick **Dry run** and **Capture**. It reads Cagematch (about 3–8 gentle requests) and Wikipedia, and writes nothing. Download the artifact from the run page: `dry-run.json` shows exactly what would be saved, and `capture/` has the raw pages. **Send those files to Claude before going live**: the Cagematch and Wikipedia readers were built from each site's usual layout and tested on sample pages, so this is their first look at the real ones.

**7. Go live.** Run the workflow again with the boxes unticked. After that it runs by itself every 6 hours. GitHub emails you if a run fails.

## Check that it's working

- `https://<your-worker>.workers.dev/status` (public, no key): last runs, counts, held matches with reasons, unknown names, today's free-tier usage.
- `https://<your-worker>.workers.dev/api/v1/openapi.json`: the API description.

## Connect the fantasy app

Send `Authorization: Bearer <api key>` with every request.

- **Sync:** `GET /api/v1/changes?cursor=0` returns changes in order plus a `next_cursor`. Store it and ask for `?cursor=<next_cursor>` every 6 hours. Seed rows are in the feed too, so starting from 0 gets everything.
- **Full lists:** `/api/v1/wrestlers`, `/api/v1/shows?from=2027-01-04`, `/api/v1/championships`
- **CSV with your original columns:** `/api/v1/export/players.csv`, `/api/v1/export/championships.csv`, and `/api/v1/export/results.csv` (one row per wrestler per match)

The database stores facts only (who won, how, title outcome, Rumble and MITB details). The fantasy app applies its own scoring table.

## Settings and fixes (SQL, run with `npx wrangler@latest d1 execute ringside --remote --command "..."`)

- Add a tag team or stable so team names in results expand to their members:
  `INSERT INTO stables(id,name,name_search,type,promotion) VALUES('s_young_bucks','The Young Bucks','the young bucks','tag','AEW'); INSERT INTO stable_members(stable_id,wrestler_id) VALUES('s_young_bucks','w_matt_jackson'),('s_young_bucks','w_nick_jackson');`
- Teach it another spelling of a name: `INSERT INTO aliases(alias_search,alias,wrestler_id,source) VALUES('the tribal chief','the tribal chief','w_roman_reigns','manual');`
- Only take events from a later date: `UPDATE config SET value='2027-01-01' WHERE key='min_event_date';` (the default is 2026-01-01)
- Cagematch permission is recorded in `config` (`cagematch_permission_confirmed`, `cagematch_permission_note`) by `migrations/0002_cagematch.sql`. To switch Cagematch off: `UPDATE config SET value='false' WHERE key='source.cagematch.enabled';` (Wikipedia then adds events again only if you also set `source.wikipedia.events` to `true`).
- Which promotions to follow: `cagematch.promotions` (JSON). The promotion **name** Cagematch shows decides; the number is only a fallback. Check them against your first Capture run.
- If you already loaded Wikipedia events before turning Cagematch on, remove them so shows aren't doubled: `UPDATE matches SET deleted_at=datetime('now') WHERE show_id IN (SELECT id FROM shows WHERE source='wikipedia'); UPDATE shows SET deleted_at=datetime('now') WHERE source='wikipedia';`

Matches held for an unknown name publish automatically on the next run after you add the wrestler (or an alias).

## Free-tier budget

| Limit (free) | Expected use |
|---|---|
| Workers: 100,000 requests/day, 10 ms CPU each | A few hundred API calls/day. Responses are cached for 1–10 minutes |
| D1: 100,000 rows written/day | Normally a few hundred, since only changed shows are written. The first full run writes a few thousand |
| D1: 5 million rows read/day, 5 GB | Well under |
| D1: 50 queries per Worker call | Read endpoints use about 12. Writes don't go through the Worker |
| GitHub Actions (public repo) | Free. About 2–5 minutes per run |
| Wikipedia | About 20–60 API calls per run at 1 per second, with a descriptive User-Agent |

## Development

```
npm test          # parser, publishing rules, title history, idempotency, sync feed (in-memory SQLite)
npm run typecheck
```
The test pages in `tests/fixtures/wikipedia/` are **synthetic** (made-up events in Wikipedia's format). Add real pages from a Capture run to tighten the parser.

Wikipedia content is CC BY-SA 4.0. The API and status page include attribution, and every show keeps its source link.
