#!/usr/bin/env node
/* Rehearse draft night without a draft.
 *
 *   node scripts/dry-run.mjs --simulate
 *   node scripts/dry-run.mjs --draft-a 1234567890 --draft-b 9876543210
 *
 * Runs the real grade.js against the real frozen snapshot and prints what the
 * site would show. Nothing is written and nothing is deployed.
 *
 * --simulate  invents a plausible draft from the snapshot. Catches grading
 *             maths, roster construction against your actual roster_positions,
 *             and whether the grade spread is sane.
 *
 * --draft-a / --draft-b  reads real Sleeper picks from any draft id, including
 *             a mock you ran ten minutes ago. This is the one that matters,
 *             because only real Sleeper picks carry real pick metadata — and
 *             name matching on defenses and kickers is where this breaks.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const G = require('../grade.js');
const API = 'https://api.sleeper.app/v1';

const argv = process.argv.slice(2);
const arg = name => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1];
};

/** config.js is a browser file; give it a window and read it back. */
function loadConfig() {
  const src = readFileSync(resolve(ROOT, 'config.js'), 'utf8');
  const window = {};
  new Function('window', src)(window);
  return window.BDI_FANTASY_CONFIG;
}

async function sleeper(path) {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`Sleeper ${res.status} on ${path}`);
  return res.json();
}

/* ------------------------------------------------------------- simulation */

/**
 * A believable draft: managers take the best available at a position they
 * still need, with enough noise that the grades are not all identical.
 * Defenses and kickers get Sleeper's real shape — city and nickname split
 * across first_name and last_name — because that is exactly the case that
 * silently broke before.
 */
function simulateDraft(snapshot, league, teams, rounds, seed) {
  /* Real drafts are not tidy. A couple of managers hoard quarterbacks, one
   * collects tight ends, one takes two kickers, and somebody ignores bye weeks
   * entirely. Without that variety the construction component has nothing to
   * separate and the rehearsal tells you nothing about it. */
  const baseNeed = { QB: 1, RB: 5, WR: 6, TE: 1, K: 1, DST: 1 };
  const quirks = {
    2: { QB: 3, WR: 4 }, 5: { TE: 3, RB: 4 }, 7: { K: 2, WR: 5 },
    9: { QB: 2, TE: 2, RB: 4 }
  };
  const byeBlind = new Set([3, 8]);
  // Ties broken by name, because the API returns a slightly different player
  // count run to run and an unstable sort made two rehearsals incomparable.
  const pool = snapshot.players
    .map(p => ({ ...p, rank: p.adp_ppr ?? p.adp_half ?? p.adp_std }))
    .filter(p => p.rank != null)
    .sort((a, b) => (a.rank - b.rank) || a.name.localeCompare(b.name));

  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  const rosters = Array.from({ length: teams }, () => ({ counts: {}, picks: [] }));
  const taken = new Set();
  const picks = [];
  let no = 1;

  for (let round = 1; round <= rounds; round++) {
    const order = round % 2 ? [...rosters.keys()] : [...rosters.keys()].reverse();
    for (const t of order) {
      const roster = rosters[t];
      const need = { ...baseNeed, ...(quirks[t + 1] || {}) };
      // Look a few deep and take one, so two managers never draft identically.
      // Late rounds: take the mandatory kicker and defense first, or the
      // roster cannot legally start a lineup and gets docked for my bug.
      const mustHave = ['K', 'DST'].filter(pos =>
        (roster.counts[pos] || 0) < 1 && rounds - round < 2);
      const eligible = (mustHave.length
        ? pool.filter(p => !taken.has(p.name) && p.position === mustHave[0])
        : pool.filter(p => {
          if (taken.has(p.name)) return false;
          const have = roster.counts[p.position] || 0;
          if (have >= (need[p.position] ?? 0)) return false;
          if ((p.position === 'K' || p.position === 'DST') && round < rounds - 2) return false;
          return true;
        })).slice(0, 6);
      let choice;
      if (byeBlind.has(t + 1)) {
        // Actively prefers players sharing one bye, which is what stacking looks like.
        choice = eligible.find(p => Number(p.bye) === 9) || eligible[Math.floor(rnd() * eligible.length)];
      } else {
        choice = eligible[Math.floor(rnd() * eligible.length)];
      }
      choice = choice || pool.find(p => !taken.has(p.name));
      if (!choice) continue;
      taken.add(choice.name);
      roster.counts[choice.position] = (roster.counts[choice.position] || 0) + 1;

      const parts = choice.name.split(' ');
      picks.push({
        pick_no: no, round, roster_id: t + 1, draft_slot: (round % 2 ? t : teams - 1 - t) + 1,
        player_id: choice.position === 'DST' ? (choice.team || 'DST') : String(no),
        metadata: {
          first_name: parts[0],
          last_name: parts.slice(1).join(' '),
          position: choice.position === 'DST' ? 'DEF' : choice.position,
          team: choice.team || ''
        }
      });
      no++;
    }
  }
  void league;
  return picks;
}

/* ------------------------------------------------------------------ report */

function report(result, snapshot) {
  const { grades, diagnostics: d } = result;
  const pct = n => Math.round(100 * n / Math.max(1, d.picks));

  console.log('\n--- snapshot ------------------------------------------------');
  console.log(`  ${snapshot.players.length} players, frozen ${snapshot.generated_at || 'never'}`);
  console.log(`  benchmark: ${snapshot.fields_used?.adp_field || 'unknown'}`);

  console.log('\n--- matching ------------------------------------------------');
  console.log(`  ${d.matched}/${d.picks} picks matched (${pct(d.matched)}%)`);
  console.log(`  ${d.projected}/${d.picks} carry a projection (${pct(d.projected)}%)`);
  console.log(`  ${d.withAdp}/${d.picks} carry a consensus rank (${pct(d.withAdp)}%)`);
  if (d.unmatched.length) {
    console.log(`  UNMATCHED (${d.unmatched.length}): ${d.unmatched.slice(0, 25).join(', ')}`);
  } else {
    console.log('  nothing was dropped');
  }

  // Position coverage is where defenses and kickers go missing.
  const byPos = {};
  for (const g of grades) {
    for (const p of g.players) {
      const rec = (byPos[p.pos] ||= { n: 0, proj: 0, rank: 0 });
      rec.n++;
      if (p.proj > 0) rec.proj++;
      if (p.adp !== null) rec.rank++;
    }
  }
  console.log('\n--- coverage by position -----------------------------------');
  for (const [pos, r] of Object.entries(byPos).sort()) {
    const gap = r.proj < r.n || r.rank < r.n ? '   <-- gap' : '';
    console.log(`  ${String(pos || '??').padEnd(4)} ${String(r.n).padStart(3)} drafted   ` +
      `${String(r.proj).padStart(3)} projected   ${String(r.rank).padStart(3)} ranked${gap}`);
  }

  console.log('\n--- grades --------------------------------------------------');
  for (const g of grades) {
    console.log(`  ${String(g.rank).padStart(2)}. ${g.letter.padEnd(3)} ${g.team.name.slice(0, 26).padEnd(27)}` +
      `${Object.values(g.components).join(' ')}   pick: ${(g.bestPick?.name || '—').slice(0, 17).padEnd(18)}` +
      `value: ${(g.best?.name || '—').slice(0, 17).padEnd(18)}` +
      `${(g.constructionNotes || []).join('; ').slice(0, 46)}`);
  }

  const letters = new Set(grades.map(g => g.letter));
  const components = new Set(grades.flatMap(g => Object.values(g.components)));
  console.log('\n--- sanity --------------------------------------------------');
  const flag = (ok, msg) => console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  flag(letters.size >= 3, `grades spread across ${letters.size} letters`);
  flag(components.size >= 3, `component grades spread across ${components.size} values`);
  flag(pct(d.matched) >= 95, `match rate ${pct(d.matched)}%`);
  flag(pct(d.projected) >= 90, `projection rate ${pct(d.projected)}%`);
  flag(grades.every(g => g.best && g.mvp), 'every team has a best pick and an MVP');
  // A component every team ties on is contributing nothing to the ranking.
  for (const key of Object.keys(grades[0].components)) {
    const spread = new Set(grades.map(g => g.components[key]));
    flag(spread.size > 1, `${key} separates teams (${spread.size} distinct grades)`);
  }
  flag(!grades.some(g => g.players.some(p => !p.pos)), 'every pick resolved a position');
}

/* -------------------------------------------------------------------- main */

async function main() {
  const CFG = loadConfig();
  const snapshot = JSON.parse(readFileSync(resolve(ROOT, 'data', `fantasypros-${CFG.season}.json`), 'utf8'));
  if (snapshot.status !== 'ready' || !snapshot.players.length) {
    console.error('The snapshot is a placeholder. Run scripts/fetch-snapshot.mjs first.');
    return 1;
  }

  const inputs = [];
  const teamName = new Map();

  for (const [code, cfg] of [['A', CFG.leagueA], ['B', CFG.leagueB]]) {
    const league = await sleeper(`/league/${cfg.id}`);
    const rosters = await sleeper(`/league/${cfg.id}/rosters`);
    const users = await sleeper(`/league/${cfg.id}/users`);
    for (const r of rosters) {
      const u = users.find(x => x.user_id === r.owner_id);
      teamName.set(`${code}:${r.roster_id}`,
        CFG.managerNameOverrides?.[r.owner_id] || u?.metadata?.team_name || u?.display_name || `Roster ${r.roster_id}`);
    }

    const override = arg(`draft-${code.toLowerCase()}`);
    if (!override && argv.includes('--no-sim')) {
      console.log(`League ${code}: skipped`);
      continue;
    }
    let picks;
    if (override) {
      picks = await sleeper(`/draft/${override}/picks`);
      const mock = picks.length && picks.every(p => p.roster_id === null || p.roster_id === undefined);
      console.log(`League ${code}: ${picks.length} real picks from draft ${override}` +
        (mock ? ' (mock draft, grouped by draft slot)' : ''));
    } else {
      const rounds = (league.roster_positions || []).length;
      picks = simulateDraft(snapshot, league, rosters.length || 10, rounds, code === 'A' ? 7 : 13);
      console.log(`League ${code}: simulated ${picks.length} picks over ${rounds} rounds`);
    }
    inputs.push({ code, league, picks });
  }

  const result = G.buildGrades(inputs, snapshot.players,
    (code, rid) => ({ key: `${code}:${rid}`, code, name: teamName.get(`${code}:${rid}`) || `Roster ${rid}` }),
    CFG.draftGradeWeights);

  report(result, snapshot);
  console.log('\nNothing was written. This was a rehearsal.\n');
  return 0;
}

main().then(code => process.exit(code)).catch(err => {
  console.error('\nDry run failed:', err.message);
  process.exit(1);
});
