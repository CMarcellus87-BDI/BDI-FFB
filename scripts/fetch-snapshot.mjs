#!/usr/bin/env node
/* Build the frozen FantasyPros snapshot for BDI Fantasy HQ.
 *
 *   node scripts/fetch-snapshot.mjs --probe    # see what the API actually returns
 *   node scripts/fetch-snapshot.mjs            # write data/fantasypros-2026.json
 *
 * There is no API key here and there does not need to be. It goes through the
 * Cloudflare worker already deployed for Dynasty of Legends, which holds the
 * key as an encrypted secret. Node sends no Origin header, so the worker's CORS
 * allowlist does not apply and no worker change is needed for this project.
 *
 * The browser never calls FantasyPros. It reads the committed JSON only, which
 * is the point: grades must not quietly rewrite themselves in October because
 * ADP moved. Run this once before the drafts and commit the result.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PROXY = process.env.BDI_FP_PROXY || 'https://dol-fantasypros.dol-fantasypros.workers.dev';
const SEASON = Number(process.env.FANTASY_SEASON || 2026);
const SCORINGS = ['STD', 'HALF', 'PPR'];
const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];

/* Confirmed from the DOL build: projections rows carry `fpts`, `player_name`
 * and `player_position_id`. The other candidates stay because FantasyPros has
 * changed these across versions and a silent zero is the worst outcome —
 * it makes every draft grade identical with nothing on screen saying why. */
/* Confirmed from a live probe on 2026-09-01. The projections endpoint returns
 * all three scoring formats in one response, so there is no need to request it
 * three times — and no excuse for reading `points` (standard) into a PPR
 * league. Jahmyr Gibbs is 301.8 standard and 373.1 PPR; getting that wrong
 * would quietly misgrade every roster. */
const POINT_FIELDS = {
  std: ['points', 'fpts', 'projected_points'],
  half: ['points_half', 'points', 'fpts'],
  ppr: ['points_ppr', 'points', 'fpts']
};

/* There is no ADP field on consensus-rankings — the response carries rank_ecr,
 * rank_min, rank_max, rank_ave, rank_std, pos_rank and tier. `rank_ave` is the
 * average expert rank, which is the closest thing to a consensus draft slot
 * this endpoint offers. The site calls it "consensus rank", not ADP, because
 * that is what it is. */
const ADP_FIELDS = ['rank_ave', 'adp', 'average_pick'];
const ECR_FIELDS = ['rank_ecr', 'rank'];
const NESTS = ['stats', 'projection', 'projections'];

/* Confirmed: `draft` is redraft. `ADP`, `adp` and `redraft` all return
 * HTTP 400 "Bad value for type". `dynasty` stays as a fallback only. */
const DRAFT_TYPES = ['draft', 'dynasty'];

const args = new Set(process.argv.slice(2));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(params) {
  const url = new URL(PROXY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${body.slice(0, 300)}`);
  try { return JSON.parse(body); } catch { throw new Error(`Not JSON — ${body.slice(0, 200)}`); }
}

const rowsOf = p => (Array.isArray(p) ? p
  : ['players', 'data', 'results', 'rankings'].map(k => p?.[k]).find(Array.isArray) || []);

/** First candidate field holding a real number, and which one it was. */
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

/** Projected points for one scoring format, from the nested stats block. */
function pointsFor(row, scoring) {
  const [value, field] = firstNumber(row, POINT_FIELDS[scoring]);
  return [value, field];
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

/* --------------------------------------------------------------- probe */

async function probe() {
  console.log(`Probing ${PROXY} for season ${SEASON}. Nothing will be written.\n`);

  console.log('Which consensus-rankings `type` returns redraft data:');
  for (const type of DRAFT_TYPES) {
    try {
      const payload = await call({ endpoint: 'consensus-rankings', season: SEASON, type, scoring: 'HALF', position: 'ALL', limit: 600 });
      const rows = rowsOf(payload);
      const [adp, adpField] = rows[0] ? firstNumber(rows[0], ADP_FIELDS) : [null, null];
      const [ecr, ecrField] = rows[0] ? firstNumber(rows[0], ECR_FIELDS) : [null, null];
      console.log(`  type=${type.padEnd(8)} ${String(rows.length).padStart(4)} rows` +
        `  adp=${adp} (${adpField})  ecr=${ecr} (${ecrField})` +
        (payload?.public_api_limited ? '  CAPPED' : ''));
      if (rows[0] && !args.has('--quiet')) {
        console.log('    keys: ' + Object.keys(rows[0]).join(', '));
      }
    } catch (err) {
      console.log(`  type=${type.padEnd(8)} failed: ${err.message}`);
    }
    await sleep(200);
  }

  console.log('\nSeason projections (one call returns all three scoring formats):');
  try {
    const payload = await call({ endpoint: 'projections', season: SEASON, position: 'RB', week: 0 });
    const rows = rowsOf(payload);
    console.log(`  ${rows.length} rows`);
    if (rows[0]) {
      for (const scoring of ['std', 'half', 'ppr']) {
        const [pts, field] = pointsFor(rows[0], scoring);
        console.log(`    ${scoring.padEnd(4)} ${String(pts).padStart(7)}  (from ${field})`);
      }
      console.log(`    name=${nameOf(rows[0])} pos=${posOf(rows[0])} team=${teamOf(rows[0])}`);
    }
  } catch (err) {
    console.log(`  failed: ${err.message}`);
  }

  console.log('\nIf a field name above is not in the candidate lists at the top of\n' +
    'this file, add it there. Then run without --probe.');
}

/* --------------------------------------------------------------- build */

async function fetchRankings(type) {
  const out = { STD: {}, HALF: {}, PPR: {} };
  const fields = {};
  for (const scoring of SCORINGS) {
    let payload;
    try {
      payload = await call({ endpoint: 'consensus-rankings', season: SEASON, type, scoring, position: 'ALL', limit: 600 });
    } catch (err) {
      console.warn(`  warning: ${scoring} rankings failed — ${err.message}`);
      continue;
    }
    const rowCount = rowsOf(payload).length;
    if (payload?.public_api_limited && rowCount < 400) {
      console.warn(`  warning: ${scoring} rankings capped at ${rowCount} rows, which may not cover a full draft`);
    }
    for (const row of rowsOf(payload)) {
      const name = nameOf(row);
      if (!name) continue;
      const pos = posOf(row);
      const rec = (out[scoring][keyOf(name, pos)] ||= { name, position: pos, team: teamOf(row), fpid: row.player_id ?? row.fpid });
      const [adp, adpField] = firstNumber(row, ADP_FIELDS);
      const [ecr, ecrField] = firstNumber(row, ECR_FIELDS);
      if (adp !== null) { rec.adp = adp; fields.adp_field = adpField; }
      if (ecr !== null) { rec.ecr = ecr; fields.ecr_field = ecrField; }
    }
    await sleep(200);
  }
  return { out, fields };
}

async function fetchProjections() {
  const out = {};
  const fields = {};
  for (const position of POSITIONS) {
    let payload;
    try {
      payload = await call({ endpoint: 'projections', season: SEASON, position, week: 0 });
    } catch (err) {
      console.warn(`  warning: ${position} projections failed — ${err.message}`);
      continue;
    }
    for (const row of rowsOf(payload)) {
      const name = nameOf(row);
      if (!name) continue;
      const pos = posOf(row, position);
      const rec = (out[keyOf(name, pos)] ||= {
        name, position: pos, team: teamOf(row), fpid: row.fpid ?? row.player_id
      });
      for (const scoring of ['std', 'half', 'ppr']) {
        const [points, field] = pointsFor(row, scoring);
        if (points !== null) { rec[`points_${scoring}`] = points; fields[`points_${scoring}_field`] = field; }
      }
    }
    await sleep(200);
  }
  return { out, fields };
}

async function build() {
  console.log(`Building the ${SEASON} snapshot through ${PROXY}\n`);

  // Find a working redraft type rather than assuming one.
  let rankings = null, rankFields = {}, usedType = null;
  for (const type of DRAFT_TYPES) {
    const { out, fields } = await fetchRankings(type);
    const count = Object.values(out).reduce((n, m) => n + Object.keys(m).length, 0);
    if (count > 100) { rankings = out; rankFields = fields; usedType = type; break; }
    console.log(`  type=${type} returned ${count} players, trying the next one`);
  }
  if (!rankings) {
    console.error('\nNo consensus-rankings type returned usable redraft data.');
    console.error('Run with --probe to see what the endpoint is actually returning.');
    return 1;
  }
  console.log(`  using type=${usedType}`);

  const { out: projections, fields: projFields } = await fetchProjections();

  const keys = new Set(Object.keys(projections));
  for (const byKey of Object.values(rankings)) for (const k of Object.keys(byKey)) keys.add(k);

  const players = [];
  for (const k of [...keys].sort()) {
    let base = { ...(projections[k] || {}) };
    for (const [scoring, byKey] of Object.entries(rankings)) {
      const r = byKey[k];
      if (!base.name && r) base = { name: r.name, position: r.position, team: r.team, fpid: r.fpid };
      base[`adp_${scoring.toLowerCase()}`] = r?.adp ?? null;
      base[`ecr_${scoring.toLowerCase()}`] = r?.ecr ?? null;
    }
    if (base.name) players.push(base);
  }

  const has = (p, prefix) => SCORINGS.some(s => p[`${prefix}_${s.toLowerCase()}`]);
  const withPoints = players.filter(p => has(p, 'points')).length;
  const withAdp = players.filter(p => has(p, 'adp')).length;
  const scoringVaries = players.some(p => p.points_ppr && p.points_std && p.points_ppr !== p.points_std);

  console.log(`\n  players: ${players.length}`);
  console.log(`  with projected points: ${withPoints}   (std/half/ppr from ` +
    `${projFields.points_std_field || '?'}/${projFields.points_half_field || '?'}/${projFields.points_ppr_field || '?'})`);
  console.log(`  with consensus rank: ${withAdp}   (field: ${rankFields.adp_field || 'NONE FOUND'})`);
  console.log(`  with ECR: ${players.filter(p => has(p, 'ecr')).length}   (field: ${rankFields.ecr_field || 'NONE FOUND'})`);
  if (!scoringVaries && withPoints) {
    console.log('  note: PPR and standard points are identical, so the scoring parameter\n' +
      '        is being ignored upstream. Grades still work but are not scoring-aware.');
  }

  const problems = [];
  if (players.length < 250) problems.push(`only ${players.length} players`);
  if (withPoints < 150) problems.push(`only ${withPoints} carry projected points`);
  if (withAdp < 150) problems.push(`only ${withAdp} carry ADP`);
  if (problems.length) {
    console.error('\nRefusing to write the snapshot:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('\nA snapshot this thin would publish twenty identical grades with\n' +
      'nothing on the page explaining why. Run with --probe and fix the field lists.');
    return 1;
  }

  const out = resolve(ROOT, 'data', `fantasypros-${SEASON}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({
    season: SEASON,
    generated_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    source: `FantasyPros public API v2 via ${new URL(PROXY).host}`,
    status: 'ready',
    ranking_type: usedType,
    benchmark: 'rank_ave (average expert rank). FantasyPros consensus-rankings '
      + 'exposes no ADP field, so grades compare picks against consensus rank.',
    fields_used: { ...projFields, ...rankFields },
    counts: { players: players.length, with_points: withPoints, with_adp: withAdp },
    players
  }, null, 2));
  console.log(`\nWrote ${players.length} players to ${out}`);
  console.log('Commit that file. Nothing secret is in it.');
  return 0;
}

process.exit(args.has('--probe') ? (await probe(), 0) : await build());
