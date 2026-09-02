/* Run with: node scripts/selftest.mjs
 * Covers the grading math only. No DOM, no network. */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import test from 'node:test';

const require = createRequire(import.meta.url);
const G = require('../grade.js');

const LEAGUE = {
  scoring_settings: { rec: 1 },
  roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF',
    'BN', 'BN', 'BN', 'BN', 'BN', 'BN']
};
const WEIGHTS = { projectionValue: 0.35, adpEfficiency: 0.25, rosterConstruction: 0.25, lineupStrength: 0.15 };

test('component grades span the full range instead of always returning C', () => {
  assert.equal(G.componentGrade(0), 'D+');
  assert.equal(G.componentGrade(0.25), 'C');
  assert.equal(G.componentGrade(0.5), 'B');
  assert.equal(G.componentGrade(0.75), 'A-');
  assert.equal(G.componentGrade(1), 'A+');
  const distinct = new Set([0, 0.25, 0.5, 0.75, 1].map(G.componentGrade));
  assert.ok(distinct.size >= 4, `expected a spread, got ${[...distinct]}`);
});

test('scoring format is read per league, not borrowed from league A', () => {
  assert.equal(G.scoringCode({ scoring_settings: { rec: 1 } }), 'ppr');
  assert.equal(G.scoringCode({ scoring_settings: { rec: 0.5 } }), 'half');
  assert.equal(G.scoringCode({ scoring_settings: {} }), 'std');
});

test('starting slots exclude bench, IR and taxi', () => {
  const slots = G.startingSlots(LEAGUE);
  assert.equal(slots.BN, undefined);
  assert.equal(slots.RB, 2);
  assert.equal(slots.DST, 1, 'DEF should be normalised to DST');
  assert.equal(G.benchCount(LEAGUE), 6);
});

test('defenses match across the Sleeper DEF / FantasyPros DST split', () => {
  const index = G.buildIndex([{ name: 'San Francisco 49ers', position: 'DST', team: 'SF', points_ppr: 130 }]);
  const byName = G.matchPlayer(
    { player_id: 'SF', metadata: { first_name: 'San Francisco', last_name: '49ers', position: 'DEF' } }, index);
  assert.ok(byName, 'DEF pick should match a DST row');
  const byAbbrev = G.matchPlayer(
    { player_id: 'SF', metadata: { first_name: 'SF', last_name: '', position: 'DEF' } }, index);
  assert.ok(byAbbrev, 'defense should fall back to the team abbreviation');
});

test('name matching survives suffixes and punctuation', () => {
  const index = G.buildIndex([{ name: "Ja'Marr Chase", position: 'WR', points_ppr: 300 }]);
  assert.ok(G.matchPlayer({ metadata: { first_name: 'JaMarr', last_name: 'Chase', position: 'WR' } }, index));
  assert.equal(G.normName('Marvin Harrison Jr.'), G.normName('Marvin Harrison'));
});

test('optimal lineup fills flex with the best leftover, not the first', () => {
  const players = [
    { pos: 'QB', proj: 300 }, { pos: 'RB', proj: 200 }, { pos: 'RB', proj: 180 },
    { pos: 'WR', proj: 250 }, { pos: 'WR', proj: 240 }, { pos: 'TE', proj: 120 },
    { pos: 'WR', proj: 230 }, { pos: 'RB', proj: 90 },
    { pos: 'K', proj: 130 }, { pos: 'DST', proj: 110 }
  ];
  const total = G.optimalLineup(players, G.startingSlots(LEAGUE));
  // QB300 + RB200 + RB180 + WR250 + WR240 + TE120 + FLEX(WR230) + K130 + DST110
  assert.equal(total, 1760);
});

test('construction penalises a roster that cannot field a lineup', () => {
  const slots = G.startingSlots(LEAGUE), bench = G.benchCount(LEAGUE);
  const full = Array.from({ length: 15 }, (_, i) =>
    ({ pos: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'K', 'DST', 'RB', 'WR', 'WR', 'RB', 'TE', 'WR', 'RB'][i], proj: 100 }));
  const noKicker = full.filter(p => p.pos !== 'K' && p.pos !== 'DST');
  assert.ok(G.constructionScore(full, slots, bench) > G.constructionScore(noKicker, slots, bench));
});

test('the value component does not reward the early draft slot', () => {
  // Two identical drafters: one picks 1,20,21,40; the other 10,11,30,31.
  // With a slot baseline their value should be near identical.
  const fp = [];
  for (let i = 1; i <= 200; i++) fp.push({ name: `Player ${i}`, position: 'RB', adp_ppr: i, points_ppr: 300 - i });
  const baseline = G.buildBaseline(fp, 'ppr', 200);
  const valueOf = picks => picks.reduce((s, n) => s + ((300 - n) - baseline(n)), 0);
  const early = valueOf([1, 20, 21, 40]);
  const late = valueOf([10, 11, 30, 31]);
  assert.ok(Math.abs(early - late) < 5, `slot bias detected: ${early} vs ${late}`);
});

test('full grade run produces a spread of letters and honest diagnostics', () => {
  const fp = [];
  for (let i = 1; i <= 160; i++) {
    fp.push({
      name: `Player ${i}`, position: ['QB', 'RB', 'WR', 'TE', 'K', 'DST'][i % 6],
      team: 'SF', adp_ppr: i, ecr_ppr: i, points_ppr: 320 - i * 1.5
    });
  }
  const picks = [];
  let no = 1;
  for (let round = 1; round <= 15; round++) {
    for (let team = 1; team <= 10; team++) {
      const idx = ((no * 7) % 160) + 1;
      const src = fp[idx - 1];
      picks.push({
        pick_no: no, round, roster_id: team, player_id: String(idx),
        metadata: { first_name: 'Player', last_name: String(idx), position: src.position }
      });
      no++;
    }
  }
  const { grades, diagnostics } = G.buildGrades(
    [{ code: 'A', league: LEAGUE, picks }], fp,
    (code, rid) => ({ key: `${code}:${rid}`, code, name: `Team ${rid}` }), WEIGHTS);

  assert.equal(grades.length, 10);
  assert.equal(diagnostics.picks, 150);
  assert.ok(diagnostics.matched / diagnostics.picks > 0.9, 'match rate should be high on clean data');
  assert.deepEqual(grades.map(g => g.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(new Set(grades.map(g => g.letter)).size > 2, 'letters should spread across the field');
  for (const g of grades) {
    assert.ok(g.best && g.mvp, 'every team needs a best pick and an MVP');
    assert.ok(new Set(Object.values(g.components)).size >= 1);
    assert.ok(g.score >= 58 && g.score <= 99);
  }
});

test('unmatched picks are reported rather than silently scored as zero', () => {
  const fp = [{ name: 'Real Player', position: 'RB', adp_ppr: 1, points_ppr: 200 }];
  const picks = [
    { pick_no: 1, round: 1, roster_id: 1, metadata: { first_name: 'Real', last_name: 'Player', position: 'RB' } },
    { pick_no: 2, round: 1, roster_id: 2, metadata: { first_name: 'Ghost', last_name: 'Person', position: 'WR' } }
  ];
  const { diagnostics } = G.buildGrades([{ code: 'A', league: LEAGUE, picks }], fp,
    () => null, WEIGHTS);
  assert.equal(diagnostics.matched, 1);
  assert.deepEqual(diagnostics.unmatched, ['Ghost Person']);
});

test('standings rebuilt from matchups pair teams by matchup_id', () => {
  const weeks = [
    [{ roster_id: 1, matchup_id: 1, points: 120 }, { roster_id: 2, matchup_id: 1, points: 100 },
     { roster_id: 3, matchup_id: 2, points: 90 }, { roster_id: 4, matchup_id: 2, points: 95 }],
    [{ roster_id: 1, matchup_id: 1, points: 80 }, { roster_id: 3, matchup_id: 1, points: 110 },
     { roster_id: 2, matchup_id: 2, points: 105 }, { roster_id: 4, matchup_id: 2, points: 105 }]
  ];
  const table = G.standingsFromMatchups(weeks);
  const byId = Object.fromEntries(table.map(t => [t.rosterId, t]));
  assert.equal(byId[1].wins, 1); assert.equal(byId[1].losses, 1);
  assert.equal(byId[1].pf, 200); assert.equal(byId[1].pa, 210);
  assert.equal(byId[3].wins, 1); assert.equal(byId[4].ties, 1);
  assert.equal(byId[2].ties, 1);
});

test('null and empty are not zero', () => {
  assert.equal(G.num(null), null);
  assert.equal(G.num(''), null);
  assert.equal(G.num('12.5'), 12.5);
  assert.equal(G.num(0), 0);
});
