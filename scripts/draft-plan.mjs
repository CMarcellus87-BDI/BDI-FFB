#!/usr/bin/env node
/* Build a draft plan for one seat, from the FantasyPros snapshot on disk.
 *
 *   node scripts/draft-plan.mjs --slot 12 --teams 12
 *   node scripts/draft-plan.mjs --slot 12 --teams 12 --league <sleeper_id>
 *   node scripts/draft-plan.mjs --slot 12 --teams 12 --scoring half --rounds 15
 *
 * No network unless --league is given, in which case Sleeper is asked for that
 * league's real scoring settings and roster slots.
 *
 * How it works. Consensus rank is treated as where a player goes. Every other
 * seat is assumed to take the best available by rank, which is what a room
 * mostly does; at your picks the plan takes the best player by value over
 * replacement among positions you still need. So the board that reaches you is
 * a realistic one rather than a wishlist.
 *
 * What it is not. It has no injury news, no camp reports and no idea who is
 * suspended. It only knows what the snapshot knew when it was pulled. Check the
 * snapshot date in the header before trusting any of it, and cross-check
 * anything surprising against a live source.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const G = createRequire(import.meta.url)('../grade.js');

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 || i + 1 >= argv.length ? fallback : argv[i + 1];
};
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

const SLOT = num(arg('slot'), 12);
const TEAMS = num(arg('teams'), 12);
const ROUNDS = num(arg('rounds'), 15);
const LEAGUE_ID = arg('league');
let SCORING = (arg('scoring') || 'ppr').toLowerCase();

const DEFAULT_SLOTS = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 };
const DEFAULT_BENCH = 6;

/* ------------------------------------------------------------------ input */

function loadSnapshot() {
  const ros = resolve(ROOT, 'data', 'fantasypros-ros.json');
  const draft = resolve(ROOT, 'data', 'fantasypros-2026.json');
  // Rest-of-season first: it is the fresher of the two.
  for (const path of [ros, draft]) {
    if (!existsSync(path)) continue;
    try {
      const data = JSON.parse(readFileSync(path, 'utf8'));
      if (data.status === 'ready' && (data.players || []).length) {
        return { data, path: path.endsWith('ros.json') ? 'rest-of-season' : 'draft-day (frozen)' };
      }
    } catch { /* try the next */ }
  }
  return null;
}

async function leagueSettings(id) {
  const res = await fetch(`https://api.sleeper.app/v1/league/${id}`);
  if (!res.ok) throw new Error(`Sleeper ${res.status}`);
  const league = await res.json();
  return {
    slots: G.startingSlots(league),
    bench: G.benchCount(league),
    scoring: G.scoringCode(league),
    teams: Number(league.total_rosters) || TEAMS,
    name: league.name
  };
}

/* Rank and projection readers that tolerate either snapshot shape. */
const rankOf = (p, code) =>
  p[`rank_${code}`] ?? p[`adp_${code}`] ?? p.rank_ppr ?? p.adp_ppr ?? p.rank_half ?? p.adp_half ?? null;
const projOf = (p, code) =>
  p[`points_${code}`] ?? p.points_ppr ?? p.points_half ?? p.points_std ?? 0;

/* --------------------------------------------------------------- the plan */

/** Overall pick numbers for one seat in a snake draft. */
function pickNumbers(slot, teams, rounds) {
  const picks = [];
  for (let r = 1; r <= rounds; r++) {
    picks.push(r % 2 ? (r - 1) * teams + slot : r * teams - slot + 1);
  }
  return picks;
}

function positionalNeed(slots, bench) {
  // Starters, then a sensible bench shape: depth where injuries actually bite.
  const need = {};
  for (const [slot, n] of Object.entries(slots)) {
    if (slot === 'FLEX' || slot === 'SUPER_FLEX' || slot === 'WRRB_FLEX' || slot === 'REC_FLEX') continue;
    need[slot] = n;
  }
  const flex = Object.entries(slots)
    .filter(([s]) => s.includes('FLEX'))
    .reduce((n, [, v]) => n + v, 0);
  need.RB = (need.RB || 0) + Math.ceil(flex * 0.5) + Math.ceil(bench * 0.4);
  need.WR = (need.WR || 0) + Math.ceil(flex * 0.5) + Math.ceil(bench * 0.4);
  need.QB = (need.QB || 0) + 1;
  need.TE = (need.TE || 0) + 1;
  return need;
}

function buildPlan(players, code, slots, bench, slot, teams, rounds) {
  const pool = players
    .map(p => ({
      name: p.name,
      pos: G.normPos(p.position),
      team: p.team || '',
      rank: rankOf(p, code),
      proj: projOf(p, code),
      tier: p.tier ?? null,
      bye: p.bye ?? null,
      spread: p.rank_std ?? null
    }))
    .filter(p => p.rank !== null && p.pos)
    .sort((a, b) => a.rank - b.rank);

  const levels = G.replacementLevels(players, code, slots, teams);
  for (const p of pool) p.vor = Math.round((p.proj - (levels[p.pos] ?? 0)) * 10) / 10;

  const mine = new Set(pickNumbers(slot, teams, rounds));
  const need = positionalNeed(slots, bench);
  // The starting eleven, flex excluded: these must be filled or the roster is illegal.
  const startersNeeded = {};
  for (const [pos, n] of Object.entries(slots)) {
    if (!pos.includes('FLEX')) startersNeeded[pos] = n;
  }
  const have = {};
  const roster = [];
  const board = [];
  const taken = new Set();
  const totalPicks = teams * rounds;

  for (let overall = 1; overall <= totalPicks; overall++) {
    const available = pool.filter(p => !taken.has(p.name));
    if (!available.length) break;

    if (!mine.has(overall)) {
      // Everyone else takes the best available by consensus.
      taken.add(available[0].name);
      continue;
    }

    const roundNo = Math.ceil(overall / teams);
    const picksLeft = rounds - roundNo + 1;

    /* Value over replacement is negative at quarterback, kicker and defence by
     * construction, so on VOR alone they never win a comparison and the plan
     * drafts fifteen backs and receivers. A roster that cannot start a
     * quarterback is worth nothing, so once the picks remaining equal the
     * starting slots still unfilled, only those positions are eligible. */
    const unmet = Object.entries(startersNeeded)
      .filter(([pos, n]) => (have[pos] || 0) < n)
      .map(([pos]) => pos);
    const mustFill = unmet.length >= picksLeft;

    const wanted = available.filter(p => (have[p.pos] || 0) < (need[p.pos] ?? 0));
    // Kickers and defences only at the very end, as any sane room does.
    const sensible = wanted.filter(p =>
      !['K', 'DST'].includes(p.pos) || roundNo > rounds - 3);
    let field = (sensible.length ? sensible : wanted.length ? wanted : available);
    if (mustFill) {
      const forced = available.filter(p => unmet.includes(p.pos));
      if (forced.length) field = forced;
    }

    const ranked = [...field].sort((a, b) => b.vor - a.vor || a.rank - b.rank);
    const pick = ranked[0];
    taken.add(pick.name);
    have[pick.pos] = (have[pick.pos] || 0) + 1;
    roster.push({ ...pick, overall, round: roundNo });
    board.push({
      overall, round: roundNo, pick,
      alternatives: ranked.slice(1, 4),
      // A tier break at your pick means waiting costs you a whole grade of player.
      forced: mustFill,
      tierBreak: pick.tier !== null
        && available.filter(p => p.pos === pick.pos && p.tier === pick.tier && p.name !== pick.name).length <= 1
    });
  }
  return { roster, board, levels, pool };
}

/* ------------------------------------------------------------------ output */

const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const posLabel = p => `${p.pos}${p.team ? ' ' + p.team : ''}`;

function report(plan, meta) {
  const { roster, board } = plan;
  console.log(`\n  Draft plan: seat ${meta.slot} of ${meta.teams}, ${meta.rounds} rounds, ${meta.scoring.toUpperCase()}`);
  if (meta.leagueName) console.log(`  League: ${meta.leagueName}`);
  console.log(`  Source: ${meta.source}, generated ${meta.generated || 'unknown'}`);
  console.log(`  Your picks: ${pickNumbers(meta.slot, meta.teams, meta.rounds).join(', ')}\n`);

  console.log('  ROUND BY ROUND');
  console.log('  ' + '-'.repeat(96));
  for (const row of board) {
    const p = row.pick;
    const flag = row.forced ? '  <- must fill this slot'
      : row.tierBreak ? '  <- last of his tier' : '';
    console.log(`  R${pad(row.round, 3)} pick ${pad(row.overall, 4)} ${pad(p.name, 24)} ${pad(posLabel(p), 8)}` +
      ` rank ${pad(Math.round(p.rank), 4)} proj ${pad(p.proj.toFixed(1), 6)} vor ${pad(p.vor, 6)}` +
      ` bye ${pad(p.bye ?? '?', 3)}${flag}`);
    if (row.alternatives.length) {
      console.log(`         also there: ${row.alternatives.map(a => `${a.name} (${a.pos}, vor ${a.vor})`).join(' | ')}`);
    }
  }

  console.log('\n  THE ROSTER');
  console.log('  ' + '-'.repeat(96));
  const byPos = {};
  for (const p of roster) (byPos[p.pos] ||= []).push(p);
  for (const pos of ['QB', 'RB', 'WR', 'TE', 'K', 'DST']) {
    if (!byPos[pos]) continue;
    console.log(`  ${pad(pos, 4)} ${byPos[pos].map(p => `${p.name} (R${p.round})`).join(', ')}`);
  }

  const starters = G.optimalLineupPicks(
    roster.map(p => ({ ...p, proj: p.proj })), meta.slots);
  const weekly = starters.reduce((s, p) => s + p.proj, 0);
  console.log(`\n  Projected starting lineup: ${weekly.toFixed(1)} points`);

  const byes = {};
  for (const p of starters) if (p.bye) byes[p.bye] = (byes[p.bye] || 0) + 1;
  const clashes = Object.entries(byes).filter(([, n]) => n >= 3);
  console.log(clashes.length
    ? `  Bye trouble: ${clashes.map(([w, n]) => `${n} starters out in week ${w}`).join(', ')}`
    : '  Bye weeks: no week loses more than two starters');

  const thin = Object.entries(byPos).filter(([pos, list]) =>
    ['RB', 'WR'].includes(pos) && list.length < 4);
  if (thin.length) {
    console.log(`  Thin at: ${thin.map(([pos, l]) => `${pos} (${l.length})`).join(', ')}`);
  }
  console.log('\n  This assumes every other seat drafts to consensus. Real rooms reach,');
  console.log('  so treat each round as a shortlist rather than a script.\n');
}

/* -------------------------------------------------------------------- main */

async function main() {
  const found = loadSnapshot();
  if (!found) {
    console.error('No usable snapshot in data/. Run scripts/fetch-ros.mjs first.');
    return 1;
  }
  let slots = DEFAULT_SLOTS, bench = DEFAULT_BENCH, teams = TEAMS, leagueName = null;
  if (LEAGUE_ID) {
    try {
      const s = await leagueSettings(LEAGUE_ID);
      slots = s.slots; bench = s.bench; SCORING = s.scoring; teams = s.teams; leagueName = s.name;
      console.log(`  Using real settings from Sleeper league ${LEAGUE_ID}`);
    } catch (err) {
      console.warn(`  Could not read that league (${err.message}); using defaults.`);
    }
  }
  const plan = buildPlan(found.data.players, SCORING, slots, bench, SLOT, teams, ROUNDS);
  report(plan, {
    slot: SLOT, teams, rounds: ROUNDS, scoring: SCORING, slots,
    source: found.path, generated: found.data.generated_at, leagueName
  });
  return 0;
}

main().then(c => process.exit(c)).catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
