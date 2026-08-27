#!/usr/bin/env python3
"""Build the frozen FantasyPros snapshot used by BDI Fantasy HQ.

Usage:
  FANTASYPROS_API_KEY=... python scripts/fetch_fantasypros.py

The API key is read from the environment only and is never written to output.
"""
from __future__ import annotations
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

SEASON = int(os.getenv("FANTASY_SEASON", "2026"))
API_KEY = os.getenv("FANTASYPROS_API_KEY", "").strip()
BASE = "https://api.fantasypros.com/public/v2/json"
OUT = Path(__file__).resolve().parents[1] / "data" / f"fantasypros-{SEASON}.json"
POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"]

if not API_KEY:
    sys.exit("Missing FANTASYPROS_API_KEY environment variable.")

def get(path: str, params: dict[str, str | int] | None = None) -> dict:
    query = urllib.parse.urlencode(params or {})
    url = f"{BASE}/{path}" + (f"?{query}" if query else "")
    req = urllib.request.Request(url, headers={"x-api-key": API_KEY, "User-Agent": "BDI-Fantasy-HQ/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)

def norm(s: str | None) -> str:
    return "".join(ch for ch in (s or "").lower() if ch.isalnum())

def key(name: str | None, pos: str | None) -> str:
    return f"{norm(name)}|{(pos or '').upper()}"

print(f"Fetching FantasyPros {SEASON} redraft data...")
# ADP and ECR are requested in all three common scoring formats so the browser can
# choose the correct one after reading Sleeper league settings.
rankings: dict[str, dict[str, dict]] = {"STD": {}, "HALF": {}, "PPR": {}}
for scoring in rankings:
    for kind in ("ADP", "DRAFT"):
        try:
            data = get(f"nfl/{SEASON}/consensus-rankings", {
                "position": "ALL", "type": kind, "scoring": scoring
            })
        except Exception as exc:
            print(f"WARNING: {scoring} {kind} rankings failed: {exc}", file=sys.stderr)
            continue
        for p in data.get("players", []):
            pos = p.get("player_position_id") or p.get("player_positions") or p.get("position_id") or ""
            if "," in str(pos):
                pos = str(pos).split(",", 1)[0]
            name = p.get("player_name") or p.get("name") or ""
            rec = rankings[scoring].setdefault(key(name, pos), {})
            rec.update({
                "name": name,
                "position": str(pos).upper(),
                "team": p.get("player_team_id") or p.get("team_id") or "",
                "fpid": p.get("player_id") or p.get("fpid"),
            })
            rank = p.get("rank_ecr") or p.get("rank_ave") or p.get("rank")
            try:
                rank = float(rank) if rank is not None else None
            except (TypeError, ValueError):
                rank = None
            if kind == "ADP": rec["adp"] = rank
            else: rec["ecr"] = rank
        time.sleep(0.15)

projections: dict[str, dict] = {}
for pos in POSITIONS:
    try:
        data = get(f"nfl/{SEASON}/projections", {"position": pos, "week": 0})
    except Exception as exc:
        print(f"WARNING: {pos} projections failed: {exc}", file=sys.stderr)
        continue
    for p in data.get("players", []):
        name = p.get("name") or p.get("player_name") or ""
        position = p.get("position_id") or pos
        stats = p.get("stats") or {}
        if isinstance(stats, list):
            stats = stats[0] if stats else {}
        projections[key(name, position)] = {
            "name": name,
            "position": str(position).upper(),
            "team": p.get("team_id") or "",
            "fpid": p.get("fpid"),
            "points_std": stats.get("points"),
            "points_half": stats.get("points_half"),
            "points_ppr": stats.get("points_ppr"),
        }
    time.sleep(0.15)

keys = set(projections)
for by_scoring in rankings.values():
    keys.update(by_scoring)
players = []
for k in sorted(keys):
    base = projections.get(k, {}).copy()
    for scoring, by_key in rankings.items():
        r = by_key.get(k, {})
        if not base:
            base = {x: r.get(x) for x in ("name", "position", "team", "fpid")}
        base[f"adp_{scoring.lower()}"] = r.get("adp")
        base[f"ecr_{scoring.lower()}"] = r.get("ecr")
    if base.get("name"):
        players.append(base)

payload = {
    "season": SEASON,
    "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "source": "FantasyPros Public API v2",
    "status": "ready",
    "players": players,
}
OUT.write_text(json.dumps(payload, indent=2), encoding="utf-8")
print(f"Wrote {len(players)} players to {OUT}")
