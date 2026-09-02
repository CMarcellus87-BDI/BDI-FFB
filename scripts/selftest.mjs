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
  assert.ok(G.constructionScore(full, slots, bench).score
    > G.constructionScore(noKicker, slots, bench).score);
  assert.ok(G.constructionScore(noKicker, slots, bench).notes.some(n => /starting slot/.test(n)));
});

test('the value component does not reward the early draft slot', () => {
  // Two identical drafters: one picks 1,20,21,40; the other 10,11,30,31.
  // With a slot baseline their value should be near identical.
  const fp = [];
  for (let i = 1; i <= 200; i++) fp.push({ name: `Player ${i}`, position: 'RB', adp_ppr: i, points_ppr: 300 - i });
  const levels = G.replacementLevels(fp, 'ppr', G.startingSlots(LEAGUE), 10);
  const baseline = G.buildBaseline(fp, 'ppr', 200, levels);
  const valueOf = picks => picks.reduce((s, n) =>
    s + (G.vorOf(300 - n, 'RB', levels) - baseline(n)), 0);
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

test('mock drafts grade even though their picks have no roster_id', () => {
  // Sleeper mocks are not attached to a league, so roster_id is null and the
  // only grouping key is draft_slot. Rehearsing has to work on those.
  const fp = [];
  for (let i = 1; i <= 160; i++) {
    fp.push({ name: `Player ${i}`, position: ['QB','RB','WR','TE','K','DST'][i % 6],
      team: 'SF', adp_ppr: i, ecr_ppr: i, points_ppr: 320 - i * 1.5 });
  }
  const picks = [];
  let no = 1;
  for (let round = 1; round <= 15; round++) {
    for (let slot = 1; slot <= 10; slot++) {
      const idx = ((no * 7) % 160) + 1;
      picks.push({
        pick_no: no, round, roster_id: null, draft_slot: slot, player_id: String(idx),
        metadata: { first_name: 'Player', last_name: String(idx), position: fp[idx - 1].position }
      });
      no++;
    }
  }
  const { grades, diagnostics } = G.buildGrades(
    [{ code: 'A', league: LEAGUE, picks }], fp, () => null, WEIGHTS);
  assert.equal(grades.length, 10, 'ten slots should become ten graded teams');
  assert.equal(diagnostics.picks, 150);
  assert.ok(grades.every(g => /^Slot \d+$/.test(g.team.name)), 'unrostered teams are named by slot');
  assert.ok(new Set(grades.map(g => g.letter)).size > 2);
});

test('kickers and defenses stop being automatic steals', () => {
  // Mirrors reality: K and DST rank ~200 overall but get taken around pick 130.
  // Uncentred, every one of them looks like a +70 bargain.
  const fp = [];
  for (let i = 1; i <= 140; i++) {
    fp.push({ name: `Skill ${i}`, position: ['RB','WR','QB','TE'][i % 4], team: 'SF',
      adp_ppr: i, points_ppr: 300 - i * 1.2 });
  }
  for (let i = 1; i <= 20; i++) {
    fp.push({ name: `Kicker ${i}`, position: 'K', team: 'SF', adp_ppr: 190 + i, points_ppr: 145 - i });
    fp.push({ name: `Def ${i}`, position: 'DST', team: 'SF', adp_ppr: 210 + i, points_ppr: 135 - i });
  }
  const picks = [];
  let no = 1;
  const take = (name, position, roster) => picks.push({
    pick_no: no, round: Math.ceil(no / 10), roster_id: roster, player_id: String(no),
    metadata: { first_name: name.split(' ')[0], last_name: name.split(' ')[1],
      position: position === 'DST' ? 'DEF' : position }
  });
  for (let round = 1; round <= 13; round++) {
    for (let team = 1; team <= 10; team++) {
      const idx = ((no * 3) % 140) + 1;
      take(fp[idx - 1].name, fp[idx - 1].position, team); no++;
    }
  }
  for (let team = 1; team <= 10; team++) { take(`Kicker ${team}`, 'K', team); no++; }
  for (let team = 1; team <= 10; team++) { take(`Def ${team}`, 'DST', team); no++; }

  const { grades } = G.buildGrades([{ code: 'A', league: LEAGUE, picks }], fp,
    (code, rid) => ({ key: `${code}:${rid}`, code, name: `Team ${rid}` }), WEIGHTS);

  // Excluded outright, not merely de-weighted.
  const bestPositions = grades.map(g => g.best.pos);
  assert.ok(!bestPositions.some(p => p === 'K' || p === 'DST'),
    `no kicker or defense may be a best pick, got ${bestPositions.join(',')}`);
  const reaches = grades.map(g => g.reach && g.reach.pos).filter(Boolean);
  assert.ok(!reaches.some(p => p === 'K' || p === 'DST'),
    `no kicker or defense may be the biggest reach, got ${reaches.join(',')}`);
  const mvps = grades.map(g => g.mvp.pos);
  assert.ok(!mvps.some(p => p === 'K' || p === 'DST'),
    `a kicker or defense can never be draft MVP, got ${mvps.join(',')}`);
});

test('value over replacement ranks a starting receiver above an equal-scoring kicker', () => {
  const fp = [
    { name: 'Good Receiver', position: 'WR', adp_ppr: 5, points_ppr: 150 },
    { name: 'Good Kicker', position: 'K', adp_ppr: 190, points_ppr: 150 }
  ];
  for (let i = 1; i <= 40; i++) fp.push({ name: `WR Filler ${i}`, position: 'WR', adp_ppr: 10 + i, points_ppr: 145 - i * 2 });
  for (let i = 1; i <= 20; i++) fp.push({ name: `K Filler ${i}`, position: 'K', adp_ppr: 200 + i, points_ppr: 148 - i });
  const levels = G.replacementLevels(fp, 'ppr', G.startingSlots(LEAGUE), 10);
  assert.ok(levels.K > levels.WR, 'kicker replacement level should sit above receiver');
  assert.ok(G.vorOf(150, 'WR', levels) > G.vorOf(150, 'K', levels),
    'equal points must not mean equal value across positions');
});

const rosterOf = list => list.map(([pos, proj, bye]) => ({ pos, proj, vor: proj, bye }));
const SLOTS = G.startingSlots(LEAGUE), BENCH = G.benchCount(LEAGUE);
const clean = [['QB',300,5],['RB',240,6],['RB',210,7],['WR',250,8],['WR',230,9],
  ['TE',150,10],['RB',180,11],['WR',190,12],['WR',170,13],['RB',160,14],
  ['WR',150,5],['TE',120,6],['RB',140,7],['K',140,8],['DST',130,9]];

test('a third quarterback and a third tight end cost construction points', () => {
  const base = G.constructionScore(rosterOf(clean), SLOTS, BENCH);
  const threeQb = [...clean]; threeQb[10] = ['QB',180,5]; threeQb[12] = ['QB',170,7];
  const hoarded = G.constructionScore(rosterOf(threeQb), SLOTS, BENCH);
  assert.ok(hoarded.score < base.score, `expected a penalty, ${hoarded.score} vs ${base.score}`);
  assert.ok(hoarded.notes.some(n => /quarterback/.test(n)), `notes should say why: ${hoarded.notes}`);

  const threeTe = [...clean]; threeTe[10] = ['TE',130,5];
  const teHoard = G.constructionScore(rosterOf(threeTe), SLOTS, BENCH);
  assert.ok(teHoard.score < base.score);
  assert.ok(teHoard.notes.some(n => /tight end/.test(n)));
});

test('a second kicker is punished harder than a spare running back', () => {
  const twoK = [...clean]; twoK[12] = ['K',135,7];
  const spareRb = [...clean];
  assert.ok(G.constructionScore(rosterOf(twoK), SLOTS, BENCH).score
    < G.constructionScore(rosterOf(spareRb), SLOTS, BENCH).score);
});

test('stacking starters on one bye week costs points and is explained', () => {
  const staggered = G.constructionScore(rosterOf(clean), SLOTS, BENCH);
  const stacked = G.constructionScore(rosterOf(clean.map(([p, v]) => [p, v, 9])), SLOTS, BENCH);
  assert.ok(stacked.score < staggered.score, `bye stack should cost, ${stacked.score} vs ${staggered.score}`);
  assert.ok(stacked.notes.some(n => /on bye in week 9/.test(n)), `notes: ${stacked.notes}`);
});

test('missing bye data skips the penalty rather than inventing one', () => {
  const noByes = clean.map(([p, v]) => [p, v, null]);
  const a = G.constructionScore(rosterOf(noByes), SLOTS, BENCH);
  assert.ok(!a.notes.some(n => /bye/.test(n)));
  assert.equal(a.score, G.constructionScore(rosterOf(clean), SLOTS, BENCH).score);
});

test('construction is percentiled, so identical rosters do not all get an A+', () => {
  const fp = [];
  for (let i = 1; i <= 160; i++) {
    fp.push({ name: `Player ${i}`, position: ['QB','RB','WR','TE','K','DST'][i % 6],
      team: 'SF', adp_ppr: i, points_ppr: 320 - i * 1.5, bye: (i % 10) + 5 });
  }
  const picks = [];
  let no = 1;
  for (let round = 1; round <= 15; round++) {
    for (let team = 1; team <= 10; team++) {
      const idx = ((no * 7) % 160) + 1;
      picks.push({ pick_no: no, round, roster_id: team, player_id: String(idx),
        metadata: { first_name: 'Player', last_name: String(idx), position: fp[idx - 1].position } });
      no++;
    }
  }
  const { grades } = G.buildGrades([{ code: 'A', league: LEAGUE, picks }], fp,
    (code, rid) => ({ key: `${code}:${rid}`, code, name: `Team ${rid}` }), WEIGHTS);
  const constructGrades = new Set(grades.map(g => g.components.rosterConstruction));
  assert.ok(!(constructGrades.size === 1 && [...constructGrades][0] === 'A+'),
    'construction must not hand every team an A+');
  assert.ok(grades.every(g => Array.isArray(g.constructionNotes)), 'notes should reach the report');
});

test('a roster of nothing but kickers still names a best pick', () => {
  // Degenerate, but the narrative pool must not come back empty and crash.
  const fp = [
    { name: 'Only Kicker', position: 'K', adp_ppr: 190, points_ppr: 140 },
    { name: 'Other Kicker', position: 'K', adp_ppr: 200, points_ppr: 130 }
  ];
  const picks = [
    { pick_no: 1, round: 1, roster_id: 1, metadata: { first_name: 'Only', last_name: 'Kicker', position: 'K' } },
    { pick_no: 2, round: 1, roster_id: 1, metadata: { first_name: 'Other', last_name: 'Kicker', position: 'K' } }
  ];
  const { grades } = G.buildGrades([{ code: 'A', league: LEAGUE, picks }], fp,
    (code, rid) => ({ key: `${code}:${rid}`, code, name: `Team ${rid}` }), WEIGHTS);
  assert.equal(grades.length, 1);
  assert.ok(grades[0].best, 'should fall back rather than return null');
  assert.ok(grades[0].mvp);
});
