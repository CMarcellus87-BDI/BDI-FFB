#!/usr/bin/env node
/* Rest-of-season FantasyPros data for the weekly power rankings.
 *
 *   node scripts/fetch-ros.mjs --probe    # what does the API actually return?
 *   node scripts/fetch-ros.mjs            # write data/fantasypros-ros.json
 *
 * Deliberately a separate file from the draft snapshot.
 *
 *   data/fantasypros-2026.json   frozen on draft day, never touched again
 *   data/fantasypros-ros.json    refreshed weekly, always current
 *
 * Draft grades judge a decision made at a moment, so their data must not move.
 * Power rankings judge a team as it exists now, so their data must. Pointing
 * the weekly refresh at the draft snapshot would silently un-freeze every
 * grade, so this script refuses to write to that path at all.
 *
 * Goes through the same Cloudflare worker, so there is no API key here either.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROXY = process.env.BDI_FP_PROXY || 'https://dol-fantasypros.dol-fantasypros.workers.dev';
const SEASON = Number(process.env.FANTASY_SEASON || 2026);
const SCORINGS = ['STD', 'HALF', 'PPR'];
const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];

/* Confirmed on the draft snapshot: rankings carry rank_ecr / rank_ave / tier,
 * projections carry stats.points, stats.points_half and stats.points_ppr. */
const RANK_FIELDS = ['rank_ave', 'adp', 'average_pick'];
const ECR_FIELDS = ['rank_ecr', 'rank'];
const POINT_FIELDS = {
  std: ['points', 'fpts', 'projected_points'],
  half: ['points_half', 'points', 'fpts'],
  ppr: ['points_ppr', 'points', 'fpts']
};
const NESTS = ['stats', 'projection', 'projections'];

/* `draft` and `dynasty` are confirmed to work; `ADP`, `adp` and `redraft` all
 * return HTTP 400. Rest-of-season is one of these and --probe will say which. */
const ROS_TYPES = ['ros', 'ROS', 'rest-of-season', 'weekly', 'draft'];

const argv = new Set(process.argv.slice(2));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(params, attempts = 4) {
  const url = new URL(PROXY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      const body = await res.text();
      if (!res.ok) {
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          throw new Error(`HTTP ${res.status} — ${body.slice(0, 240)}`);
        }
        throw Object.assign(new Error(`HTTP ${res.status}`), { retryable: true });
      }
      try { return JSON.parse(body); } catch { throw new Error(`Not JSON — ${body.slice(0, 160)}`); }
    } catch (err) {
      last = err;
      const retryable = err.retryable || /fetch failed|network|ECONN|timeout/i.test(err.message);
      if (!retryable || attempt === attempts) break;
      console.warn(`  retry ${attempt}/${attempts - 1}: ${err.message.slice(0, 80)}`);
      await sleep(600 * attempt);
    }
  }
  throw last;
}

const rowsOf = p => (Array.isArray(p) ? p
  : ['players', 'data', 'results', 'rankings'].map(k => p?.[k]).find(Array.isArray) || []);

function firstNumber(row, candidates) {
  const boxes = [row];
  for (const n of NESTS) {
    const v = row?.[n];
    if (v && typeof v === 'object') boxes.push(Array.isArray(v) ? v[0] || {} : v);
  }
  for (const box of boxes) {
    for (const field of candidates) {
      const raw = box?.[field];
      if (raw === null || raw === undefined || raw === '' || raw === '-') continue;
      const n = Number(String(raw).replace(/,/g, ''));
      if (Number.isFinite(n)) return [n, field];
    }
  }
  return [null, null];
}

const nameOf = r => ['player_name', 'name', 'player'].map(k => r?.[k])
  .find(v => typeof v === 'string' && v.trim())?.trim() || '';
const posOf = (r, fallback = '') => {
  const raw = ['player_position_id', 'position_id', 'player_positions', 'position', 'pos']
    .map(k => r?.[k]).find(v => typeof v === 'string' && v.trim()) || fallback;
  const p = String(raw).split(',')[0].trim().toUpperCase();
  return p === 'DEF' || p === 'D/ST' ? 'DST' : p;
};
const teamOf = r => (['player_team_id', 'team_id', 'team'].map(k => r?.[k])
  .find(v => typeof v === 'string' && v.trim()) || '').toUpperCase();
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const keyOf = (name, pos) => `${norm(name)}|${posOf({ position: pos })}`;

async function nflWeek() {
  try {
    const state = await (await fetch('https://api.sleeper.app/v1/state/nfl')).json();
    return { week: Number(state.week) || 1, seasonType: state.season_type };
  } catch {
    return { week: 1, seasonType: 'unknown' };
  }
}

/* --------------------------------------------------------------- probe */

async function probe() {
  const { week, seasonType } = await nflWeek();
  console.log(`Probing ${PROXY} for ${SEASON} rest-of-season data.`);
  console.log(`Sleeper reports week ${week} (${seasonType}). Nothing will be written.\n`);

  console.log('consensus-rankings, which `type` returns rest-of-season:');
  for (const type of ROS_TYPES) {
    try {
      const payload = await call({
        endpoint: 'consensus-rankings', season: SEASON, type,
        scoring: 'PPR', position: 'ALL', limit: 600
      });
      const rows = rowsOf(payload);
      const [rank, rankField] = rows[0] ? firstNumber(rows[0], RANK_FIELDS) : [null, null];
      console.log(`  type=${type.padEnd(15)} ${String(rows.length).padStart(4)} rows` +
        `  rank=${rank} (${rankField})` + (payload?.public_api_limited ? '  CAPPED' : ''));
      if (rows[0] && !argv.has('--quiet')) {
        console.log('    keys: ' + Object.keys(rows[0]).join(', '));
      }
    } catch (err) {
      console.log(`  type=${type.padEnd(15)} failed: ${err.message.slice(0, 90)}`);
    }
    await sleep(250);
  }

  console.log(`\nprojections, does week=${week} give a weekly projection:`);
  for (const w of [week, 'ros', 0]) {
    try {
      const payload = await call({
        endpoint: 'projections', season: SEASON, position: 'RB', week: w, scoring: 'PPR'
      });
      const rows = rowsOf(payload);
      const line = ['std', 'half', 'ppr'].map(s => {
        const [v, f] = rows[0] ? firstNumber(rows[0], POINT_FIELDS[s]) : [null, null];
        return `${s}=${v}(${f})`;
      }).join('  ');
      console.log(`  week=${String(w).padEnd(4)} ${rows.length} rows  ${line}`);
      if (rows[0]) console.log(`    ${nameOf(rows[0])} ${posOf(rows[0])} ${teamOf(rows[0])}`);
    } catch (err) {
      console.log(`  week=${String(w).padEnd(4)} failed: ${err.message.slice(0, 90)}`);
    }
    await sleep(250);
  }

  console.log('\nWhat to look for. A `type` returning several hundred rows with a\n' +
    'real rank field is the rest-of-season board. On projections, a weekly number\n' +
    'should be far smaller than a season total — roughly 15 rather than 300.\n' +
    'If none of the types work, rest-of-season may not be exposed, and roster\n' +
    'strength can still be built from season projections plus games remaining.\n');
}

/* --------------------------------------------------------------- build */

async function fetchRankings(type) {
  const out = {};
  const fields = {};
  for (const scoring of SCORINGS) {
    let payload;
    try {
      payload = await call({
        endpoint: 'consensus-rankings', season: SEASON, type,
        scoring, position: 'ALL', limit: 600
      });
    } catch (err) {
      console.warn(`  warning: ${scoring} rankings failed — ${err.message.slice(0, 80)}`);
      continue;
    }
    for (const row of rowsOf(payload)) {
      const name = nameOf(row);
      if (!name) continue;
      const pos = posOf(row);
      /* Everything cheap to store now. Discarding fields is exactly how the
       * draft snapshot ended up needing a re-fetch for bye weeks. */
      const rec = (out[keyOf(name, pos)] ||= {
        name, position: pos, team: teamOf(row),
        tier: firstNumber(row, ['tier'])[0],
        bye: firstNumber(row, ['player_bye_week', 'bye_week', 'bye'])[0],
        rank_std: firstNumber(row, ['rank_std'])[0],
        rank_min: firstNumber(row, ['rank_min'])[0],
        rank_max: firstNumber(row, ['rank_max'])[0],
        ecr_delta: firstNumber(row, ['player_ecr_delta'])[0],
        owned: firstNumber(row, ['player_owned_avg'])[0],
        pos_rank: typeof row.pos_rank === 'string' ? row.pos_rank : null
      });
      const [rank, rankField] = firstNumber(row, RANK_FIELDS);
      const [ecr, ecrField] = firstNumber(row, ECR_FIELDS);
      if (rank !== null) { rec[`rank_${scoring.toLowerCase()}`] = rank; fields.rank_field = rankField; }
      if (ecr !== null) { rec[`ecr_${scoring.toLowerCase()}`] = ecr; fields.ecr_field = ecrField; }
    }
    await sleep(250);
  }
  return { out, fields };
}

async function fetchProjections(week) {
  const out = {};
  const fields = {};
  for (const position of POSITIONS) {
    let payload;
    try {
      payload = await call({ endpoint: 'projections', season: SEASON, position, week });
    } catch (err) {
      console.warn(`  warning: ${position} projections failed — ${err.message.slice(0, 80)}`);
      continue;
    }
    const rows = rowsOf(payload);
    console.log(`  ${position}: ${rows.length} rows`);
    for (const row of rows) {
      const name = nameOf(row);
      if (!name) continue;
      const pos = posOf(row, position);
      const rec = (out[keyOf(name, pos)] ||= { name, position: pos, team: teamOf(row) });
      for (const scoring of ['std', 'half', 'ppr']) {
        const [points, field] = firstNumber(row, POINT_FIELDS[scoring]);
        if (points !== null) { rec[`points_${scoring}`] = points; fields[`points_${scoring}_field`] = field; }
      }
    }
    await sleep(250);
  }
  return { out, fields };
}

/**
 * type=weekly is the only board carrying this week's opponent and FantasyPros'
 * start/sit call. Fetched separately because it is a different shape and a
 * different lifetime — it is only true for the current week.
 */
async function fetchWeeklyBoard() {
  const out = {};
  try {
    const payload = await call({
      endpoint: 'consensus-rankings', season: SEASON, type: 'weekly',
      scoring: 'PPR', position: 'ALL', limit: 600
    });
    for (const row of rowsOf(payload)) {
      const name = nameOf(row);
      if (!name) continue;
      const pos = posOf(row);
      out[keyOf(name, pos)] = {
        opponent: typeof row.player_opponent === 'string' ? row.player_opponent : null,
        rank: firstNumber(row, RANK_FIELDS)[0],
        pos_rank: typeof row.pos_rank === 'string' ? row.pos_rank : null,
        recommendation: typeof row.recommendation === 'string' ? row.recommendation
          : (row.recommendation ?? null),
        tag: typeof row.tag === 'string' ? row.tag : null,
        note: typeof row.note === 'string' ? row.note : null
      };
    }
  } catch (err) {
    console.warn(`  warning: weekly board unavailable — ${err.message.slice(0, 80)}`);
  }
  return out;
}

async function build() {
  const { week, seasonType } = await nflWeek();
  console.log(`Building rest-of-season data for ${SEASON}, week ${week} (${seasonType})\n`);

  let rankings = null, rankFields = {}, usedType = null;
  for (const type of ROS_TYPES) {
    const { out, fields } = await fetchRankings(type);
    const count = Object.keys(out).length;
    if (count > 100) { rankings = out; rankFields = fields; usedType = type; break; }
    console.log(`  type=${type} returned ${count} players, trying the next`);
  }
  if (!rankings) {
    console.error('\nNo consensus-rankings type returned usable data. Run --probe.');
    return 1;
  }
  console.log(`  using type=${usedType}\n`);

  const { out: projections, fields: projFields } = await fetchProjections(week);
  const weekly = await fetchWeeklyBoard();
  const weeklyCount = Object.keys(weekly).length;
  console.log(`  weekly board: ${weeklyCount} players with opponent and start/sit`);

  const keys = new Set([...Object.keys(rankings), ...Object.keys(projections)]);
  const players = [];
  for (const k of [...keys].sort()) {
    const merged = { ...(rankings[k] || {}), ...(projections[k] || {}) };
    if (weekly[k]) merged.week = weekly[k];
    // Rankings win on identity; projections win on points.
    if (rankings[k]) Object.assign(merged, {
      name: rankings[k].name, position: rankings[k].position,
      team: rankings[k].team || merged.team, tier: rankings[k].tier, bye: rankings[k].bye
    });
    if (merged.name) players.push(merged);
  }

  const has = (p, prefix) => ['std', 'half', 'ppr'].some(s => p[`${prefix}_${s}`]);
  const withRank = players.filter(p => has(p, 'rank')).length;
  const withPoints = players.filter(p => has(p, 'points')).length;

  console.log(`\n  players: ${players.length}`);
  console.log(`  with rest-of-season rank: ${withRank}  (field: ${rankFields.rank_field || 'NONE'})`);
  console.log(`  with weekly projection: ${withPoints}`);
  console.log('  points coverage by position:');
  const problems = [];
  for (const pos of POSITIONS) {
    const at = players.filter(p => p.position === pos);
    const withPts = at.filter(p => has(p, 'points')).length;
    const flag = at.length && !withPts ? '   <-- NONE' : '';
    console.log(`    ${pos.padEnd(4)} ${String(at.length).padStart(4)} players   ${String(withPts).padStart(4)} with points${flag}`);
    if (at.length && !withPts) problems.push(`every ${pos} is missing points`);
  }
  if (players.length < 250) problems.push(`only ${players.length} players`);
  if (withRank < 150) problems.push(`only ${withRank} carry a rank`);
  if (problems.length) {
    console.error('\nRefusing to write:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('\nA whole position missing is usually the API dropping a request, so try\n' +
      'again first. If it repeats, run --probe.');
    return 1;
  }

  const out = resolve(ROOT, 'data', 'fantasypros-ros.json');
  // The draft snapshot is frozen. Nothing here may ever write to it.
  if (basename(out) !== 'fantasypros-ros.json') {
    console.error('Refusing to write anywhere but fantasypros-ros.json');
    return 1;
  }
  const frozen = resolve(ROOT, 'data', `fantasypros-${SEASON}.json`);
  if (existsSync(frozen) && out === frozen) {
    console.error('Refusing to overwrite the frozen draft snapshot');
    return 1;
  }

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({
    season: SEASON,
    week,
    generated_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    source: `FantasyPros public API v2 via ${new URL(PROXY).host}`,
    status: 'ready',
    ranking_type: usedType,
    fields_used: { ...rankFields, ...projFields },
    counts: {
      players: players.length, with_rank: withRank, with_points: withPoints,
      with_weekly: players.filter(p => p.week).length
    },
    players
  }, null, 2));
  console.log(`\nWrote ${players.length} players to ${out}`);
  console.log('The frozen draft snapshot was not touched.');
  return 0;
}

process.exit(argv.has('--probe') ? (await probe(), 0) : await build());
