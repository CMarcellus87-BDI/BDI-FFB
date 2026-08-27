# BDI Fantasy HQ — Pre-Draft Build v0.2.0

A lightweight GitHub Pages site that combines BDI's two 10-team Sleeper redraft leagues into one shared experience.

## Locked Phase 1 scope

- League A + League B standings, clearly separated
- Combined BDI Top-5 power rankings once games begin
- All 20 teams and cross-league roster visibility
- Combined activity feed for trades, waivers, free-agent adds and drops
- Post-draft grades ranked #1–20 across both leagues

## Sleeper leagues

- League A: `1398722946876309504`
- League B: `1398724315200913408`

Sleeper remains the source of truth. This site is read-only.

## Draft grading methodology (frozen before the drafts)

The grader is deliberately redraft-only:

- **35% Projection Value vs. Draft Slot** — projected season points, weighted by how expensive the pick was.
- **25% ADP Efficiency** — how far each selection was taken before/after FantasyPros consensus ADP.
- **25% Roster Construction** — starter-slot coverage and sensible positional allocation based on Sleeper league settings.
- **15% Projected Optimal-Lineup Strength** — best legal starting lineup based on FantasyPros preseason projections.

All 20 teams are normalized together before letter grades are assigned. The report also derives best pick, biggest reach, draft MVP, strongest position, weakest position and a deterministic verdict.

## FantasyPros snapshot — keep the API key out of GitHub

The browser never calls FantasyPros directly and no API key belongs in this repository.

1. Rotate/regenerate the API key if it has ever been shared publicly.
2. In a terminal, set it only as an environment variable:

```bash
export FANTASYPROS_API_KEY="YOUR_KEY_HERE"
python scripts/fetch_fantasypros.py
```

On Windows PowerShell:

```powershell
$env:FANTASYPROS_API_KEY="YOUR_KEY_HERE"
python scripts/fetch_fantasypros.py
```

The script writes `data/fantasypros-2026.json`. Commit that JSON snapshot, **not the key**. This freezes the grading benchmark near draft day so later injuries/ranking changes do not rewrite the original grades.

## Deploy

Upload the project contents to the root of a GitHub Pages repository:

- `index.html`
- `styles.css`
- `app.js`
- `config.js`
- `bdi-logo.png`
- `data/fantasypros-2026.json`
- `scripts/fetch_fantasypros.py` (optional to keep in repo; safe because it contains no key)

## Manager names

Before all managers join, the expected BDI names are stored in `config.js`. Once Sleeper rosters have owners, the site uses Sleeper team/display names. To force real names, add the Sleeper user ID to `managerNameOverrides` in `config.js`.

## Notes

- Power rankings use: 40% Points For, 30% record, 20% recent form, 10% cross-league all-play performance.
- During preseason, power rankings can fall back to draft grades after both drafts are complete.
- Activity is fetched by week rather than crawling the full season, keeping mobile loads light.


## Instant draft publishing
- Each completed league immediately publishes its own 1–10 grades.
- Once both drafts are complete, grades are recalculated across all 20 teams and the overall BDI 1–20 ranking publishes.
- Every stage uses the same frozen FantasyPros snapshot.
