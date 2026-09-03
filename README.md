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
It writes nothing.

The build output reports points coverage per position and dumps the raw API row
for any position that came back with no points at all. A whole position arriving
without projections is the failure that matters, and the totals hide it. If a field name it reports is not in the candidate lists at
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

- **Value at the slot, 35%.** Value over replacement against a smoothed
  baseline of what a consensus drafter would have got at that exact pick.
  Slot-neutral, because scoring raw points per pick just rewards whoever drew
  the 1.01. Position-fair, because points are not a common currency: replacement
  level at kicker is around 130 and at receiver around 90, so a kicker and a
  receiver projecting the same total are worth very different amounts.
- **Rank discipline, 25%.** Mean gap between each pick and consensus rank,
  centred on the median gap for that pick's own position, and clamped at three
  rounds so one flier cannot swamp nine sound picks. The centring matters:
  FantasyPros ranks kickers and defenses around 200 overall but everyone takes
  one around pick 140, so uncentred they all read as identical +60 bargains.
- **Roster construction, 25%.** Read from each league's own `roster_positions`.
  Penalises what actually costs weeks: a third quarterback or tight end that can
  never start, a second kicker, thin flex depth, and starters stacked on the same
  bye week. Percentiled like every other component, so if all twenty rosters
  really are shaped the same it grades everyone in the middle rather than handing
  out twenty A pluses. The reasons appear on the report as "Roster shape".
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

## Rehearsing draft night

Both drafts run at the same time, so there is no margin to discover a problem
live. Rehearse instead:

```powershell
npm run dry-run
```

That invents a plausible draft from the frozen snapshot, runs the real grader,
and prints the match rate, per-position coverage, all twenty grades and a set of
sanity checks. It writes nothing.

The build output reports points coverage per position and dumps the raw API row
for any position that came back with no points at all. A whole position arriving
without projections is the failure that matters, and the totals hide it.

The stronger version uses real Sleeper picks, because only real picks carry real
pick metadata — and defenses and kickers are where name matching breaks. Run a
Sleeper mock draft, take the draft id out of the URL, then:

```powershell
node scripts/dry-run.mjs --draft-a <MOCK_DRAFT_ID> --no-sim
```

`--no-sim` grades only the league you gave real picks for. Use it when
comparing the same draft against two different snapshots: without it the other
league is re-simulated each run, and since all twenty teams are normalised
together that alone moves the grades.

Note that grades are relative to the field. When one league publishes alone it
is ranked 1 to 10 among its own ten teams; when the second finishes, all twenty
are normalised together and the first league's numbers shift. That is intended,
but it does mean a team's letter can move without anybody drafting again.

To see it in the actual interface rather than a terminal, open the site with the
same id: `https://your-domain/?draftA=<MOCK_DRAFT_ID>`. The Grades tab renders
from that draft and labels itself a rehearsal so nobody mistakes it for real.

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

## Why construction was rewritten

The first version started at 100 and docked five points here and there, so any
roster that could field a lineup scored 100 and the component graded A+ for all
twenty teams. A quarter of the grade was doing no work.

It now docks meaningfully — nine points per surplus quarterback or tight end,
eleven for a second kicker, up to eighteen for missing flex depth, five per
starter beyond two sharing a bye week — and is percentiled rather than mapped
from a fixed band. Bye weeks come from `player_bye_week` in the rankings
response, and if a snapshot lacks them the penalty is skipped rather than
guessed at.

`npm run dry-run` simulates a few managers hoarding quarterbacks, collecting
tight ends, taking two kickers and ignoring bye weeks, so the component has
something to separate and you can see the reasons it gives.

## The sign bug

Until v0.8.9 the rank gap was computed as `consensus_rank - pick_number`. It is
the other way round. Consensus rank is where a player should have gone; the pick
number is where he actually went. Taking the 21st-ranked player at pick 30 is
nine picks of value, and the old formula called it a nine-pick reach.

The effect was that the grader rewarded reaching and punished bargains, on both
the rank-discipline component and the best-value and biggest-reach awards, for
every version before this one. Two tests now pin the direction, one on a single
pick and one on a whole draft where one manager only takes bargains and another
only reaches.

## Why kickers are not steals

The first real dry run had a kicker or a defense as the best-value pick on
sixteen of twenty rosters. That was not a quirk of the data, it was structural:
overall consensus rank puts those positions far below where anyone actually
drafts them, so the gap is a constant and everybody gets the same free credit.

Two fixes, both in `grade.js`. Rank gaps are centred per position, so a kicker
only reads as a steal if it beat the other kickers. And projected points are
converted to value over replacement, where replacement level is the last
startable player at that position given the league's own starting slots and team
count. A kicker projecting 145 clears replacement by about 10. A receiver
projecting 145 clears it by 55.

Best pick and best value are deliberately different awards. **Best pick** is
70% value over replacement and 30% how cheaply the player came, so at 1.01 it is
the elite back you paid full price for — obviously the best thing you did, even
though it is not a bargain. **Best value** is the pure bargain, measured against
what the field paid at that position. They are frequently different players, and
the verdict says so when they are.

Then a blunter rule on top, because the arithmetic fix was not enough: kickers
and defenses are excluded from every narrative award outright. Best value,
biggest reach, draft MVP and the notable picks all draw from quarterbacks,
running backs, receivers and tight ends only. However the numbers shake out,
a kicker was never anybody's best pick.

`scripts/selftest.mjs` asserts that no kicker or defense can appear as a best
pick, a reach, or an MVP, and that a roster of nothing but kickers still names
something rather than crashing.

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
