# BDI Fantasy HQ — v0.7.0

A static GitHub Pages site that pulls BDI's two 10-team Sleeper redraft leagues
into one place. No build step, no framework, no backend.

    index.html      markup
    styles.css      styling
    config.js       league IDs, weights, playoff format — the only file you edit
    grade.js        draft grading maths, no DOM, no network
    app.js          everything that touches the page or the network
    data/           the frozen FantasyPros snapshot
    scripts/        snapshot builder and tests (not deployed)

## FantasyPros

The browser never calls FantasyPros and no API key exists anywhere in this
repository. The snapshot builder goes through the Cloudflare worker already
deployed for Dynasty of Legends, which holds the key as an encrypted secret.

Node sends no `Origin` header, so the worker's CORS allowlist does not apply
and **no worker change is needed for this project**. Nothing in `wrangler.toml`
has to be touched.

Before draft day, check what the API is actually returning:

```powershell
node scripts/fetch-snapshot.mjs --probe
```

That tries each `type` value for consensus-rankings and prints which one returns
redraft data, which field carries consensus rank, and which fields carry projected points.
It writes nothing. If a field name it reports is not in the candidate lists at
the top of the script, add it there.

Then build the snapshot:

```powershell
node scripts/fetch-snapshot.mjs
git add data/fantasypros-2026.json
git commit -m "Freeze the FantasyPros snapshot before the drafts"
git push
```

The script **refuses to write** a snapshot that is too thin — too few players,
or too few carrying points or a consensus rank. A silently empty snapshot is worse than none:
it publishes twenty identical grades with nothing on screen saying why.

Point at a different worker with `BDI_FP_PROXY` if that URL ever changes.

## Why the snapshot is frozen

Grades are computed against consensus rankings as they stood on draft day. If
the site read live rankings, everyone's grade would quietly drift all season as
ADP moved and players got hurt. Freezing it means the grade you get on Thursday
is the grade you argue about in December.

## Draft grading

Each drafted roster is scored on four things, then ranked against the whole
field. All twenty teams are normalised together once both drafts finish.

- **Value at the slot, 35%.** Projected points against a smoothed baseline of
  what a consensus drafter would have got at that exact pick. This is
  deliberately slot-neutral — scoring raw points per pick just rewards whoever
  drew the 1.01, which is not a draft decision.
- **Rank discipline, 25%.** Mean gap between each pick and consensus rank, with
  each pick clamped at three rounds so one flier cannot swamp nine sound picks.
- **Roster construction, 25%.** Read from each league's own `roster_positions`:
  can you legally field a lineup, and did you hoard at a one-slot position.
- **Projected lineup, 15%.** Best legal starting lineup on frozen projections.

Each league publishes its own 1–10 the moment its draft ends. The combined 1–20
follows once both are done.

The Grades tab shows a match-rate line — how many picks found a FantasyPros
ranking, and which ones did not. Check it before you let anyone see the grades.

## Playoffs

Configured in `config.js` rather than hardcoded. Top four from each league
qualify on the standings **through Week 14**, rebuilt from weekly matchups
rather than read live, because Sleeper keeps adding wins to roster settings
during the playoff weeks. Week 15 cuts eight to four, Week 16 cuts four to two,
Week 17 decides it. No head-to-head — every round is one combined leaderboard.

The site opens on the Playoffs tab from Week 15 and refreshes the live board
every 90 seconds while that tab is open.

## Manager names

Sleeper team and display names are used once managers join. To force a real
name, add the Sleeper user ID to `managerNameOverrides` in `config.js`. Find IDs
at `https://api.sleeper.app/v1/league/<LEAGUE_ID>/users`.

## Tests

```powershell
npm install
node --test scripts/selftest.mjs
node --test --test-concurrency=4 scripts/smoketest.mjs
```

`selftest` covers the grading maths. `smoketest` boots the real `index.html` in
jsdom against a fake Sleeper and asserts the page actually renders — standings,
grades, the board, transactions, all three playoff rounds, and the offline path.
jsdom is a dev dependency only; the deployed site has none.

## Deploy

Copy `index.html`, `styles.css`, `config.js`, `grade.js`, `app.js`,
`bdi-logo.png` and `data/` to the root of the Pages repo. `scripts/`,
`package.json` and `node_modules/` are not needed in production.

## Design

Broadcast scoreboard. Two colour systems that never overlap: BDI green means
status only — live, advancing, in the hunt — and position colours (QB/RB/WR/TE/
K/DST) carry the football information. Hairline rules instead of floating cards,
3px corners, no gradients as decoration, no shadows outside the modal. Barlow
Condensed for names and numbers, Barlow for body, tabular figures throughout so
columns stop jittering.

The home hero is a live ticker rather than a sentence. The draft board is a real
board — a column per draft slot, a row per round — which collapses to the
position-coloured list on mobile, where the width does not exist.

## Changes in v0.6.0

Fixed:

- Every component grade in every draft report rendered **C**. The mapping
  spanned 72 to 72.25.
- Defenses never matched FantasyPros. Sleeper says `DEF`, FantasyPros says
  `DST`, and the lookup key was name plus position.
- League B was graded with League A's scoring settings and roster slots.
- The value metric rewarded whoever drafted earliest, independent of skill.
- The home activity feed printed raw Sleeper player IDs.
- Bench depth was never penalised — the calculation counted bench slots as
  starters, so the number was always zero.
- The playoff field could change during the playoffs.
- Draft grades and power rankings raced; the preseason fallback usually lost.
- The 5 MB Sleeper player file was re-downloaded on every roster open. Now
  trimmed and cached for 20 hours.
- Trades listed both sides' assets in one undifferentiated pile.

Added: a Draft Board tab with every pick from both drafts and ADP deltas,
snapshot match-rate reporting, hash routing so a refresh keeps your tab,
loading skeletons, a playoff cut line in the standings, keyboard focus styles,
and reduced-motion support.

## A note on the benchmark

FantasyPros' `consensus-rankings` endpoint exposes no ADP field. A live probe on
1 September returned `rank_ecr`, `rank_min`, `rank_max`, `rank_ave`, `rank_std`,
`pos_rank` and `tier` — and nothing else. Grades therefore compare each pick
against `rank_ave`, the average expert rank, and the site says "consensus rank"
rather than "ADP" because that is what it is.

The distinction matters if anyone checks: consensus rank is where experts say a
player should go, ADP is where people actually take him. They diverge most on
rookies and injury returns. If real ADP is wanted later, add `adp` to the
`ENDPOINTS` array in the DOL worker, redeploy, and re-probe.

The projections endpoint returns all three scoring formats in one response
(`stats.points`, `stats.points_half`, `stats.points_ppr`), so the snapshot is
genuinely scoring-aware. Reading `points` into a PPR league would have cost
Jahmyr Gibbs 71 projected points.
