/* Boots index.html in jsdom against a fake Sleeper, so runtime errors surface
 * here rather than on draft night. Run with: node scripts/smoketest.mjs
 * jsdom is a dev-only dependency; the site itself has none. */
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------ fake Sleeper */

const LEAGUE = size => ({
  name: `BDI League ${size}`,
  scoring_settings: { rec: 1 },
  roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF',
    'BN', 'BN', 'BN', 'BN', 'BN', 'BN']
});
const rosters = (code, played = 10) => Array.from({ length: 10 }, (_, i) => {
  // Games played tracks the week, so the results/projection blend is exercised.
  const wins = Math.max(0, Math.min(played, 10 - i));
  return {
    roster_id: i + 1, owner_id: `${code}u${i + 1}`,
    settings: { wins, losses: played - wins, fpts: 1500 - i * 40, fpts_decimal: 50, fpts_against: 1400 },
    players: [`p${i}1`, `p${i}2`], starters: [`p${i}1`], reserve: [], taxi: []
  };
});
const users = code => Array.from({ length: 10 }, (_, i) => ({
  user_id: `${code}u${i + 1}`, display_name: `${code} Manager ${i + 1}`, metadata: {}
}));

/* Rest-of-season board keyed on the same names the player directory returns,
 * so roster strength can actually resolve a lineup. */
const ROS_PLAYERS = [];
for (let i = 0; i < 22; i++) {
  for (let j = 1; j <= 2; j++) {
    ROS_PLAYERS.push({
      name: `Rostered ${i}-${j}`, position: j === 1 ? 'RB' : 'WR', team: 'KC',
      points_ppr: 20 - i * 0.4 + j, rank_ppr: i * 2 + j, tier: 1
    });
  }
}

const FP_PLAYERS = [];
for (let i = 1; i <= 200; i++) {
  FP_PLAYERS.push({
    name: `Player ${i}`, position: ['QB', 'RB', 'WR', 'TE', 'K', 'DST'][i % 6],
    team: 'SF', adp_ppr: i, ecr_ppr: i, points_ppr: 320 - i * 1.2
  });
}
const picksFor = () => {
  const out = [];
  let no = 1;
  for (let round = 1; round <= 15; round++) {
    for (let team = 1; team <= 10; team++) {
      const idx = ((no * 7) % 200) + 1;
      out.push({
        pick_no: no, round, roster_id: team, player_id: String(idx),
        // Sleeper's draft_slot is the board column, so it stays fixed for a
        // team across every round. The pick order snakes; the column does not.
        draft_slot: team,
        metadata: { first_name: 'Player', last_name: String(idx), position: FP_PLAYERS[idx - 1].position }
      });
      no++;
    }
  }
  return out;
};

function makeFetch({ week = 0, seasonType = 'pre', draftStatus = 'complete', snapshot = 'ready', ros = 'ready' } = {}) {
  const calls = [];
  return {
    calls,
    fetch: async url => {
      const u = String(url);
      calls.push(u);
      const json = body => ({ ok: true, status: 200, json: async () => body });
      if (u.includes('/state/nfl')) return json({ season_type: seasonType, week, season: '2026' });
      if (u.includes('/users')) return json(users(u.includes('1398722946876309504') ? 'A' : 'B'));
      if (/\/league\/\d+$/.test(u)) return json(LEAGUE(u.includes('1398722946876309504') ? 'A' : 'B'));
      if (u.includes('/rosters')) return json(rosters(
        u.includes('1398722946876309504') ? 'A' : 'B',
        seasonType === 'regular' ? Math.max(0, week - 1) : 0));
      if (u.includes('/drafts')) return json([{ draft_id: 'd1', season: '2026', status: draftStatus }]);
      if (u.includes('/draft/')) return json(picksFor());
      if (u.includes('/players/nfl')) {
        const dir = {};
        for (let i = 0; i < 22; i++) for (let j = 1; j <= 2; j++) {
          dir[`p${i}${j}`] = { full_name: `Rostered ${i}-${j}`, position: j === 1 ? 'RB' : 'WR', team: 'KC' };
        }
        dir.px = { full_name: 'Traded Guy', position: 'WR', team: 'BUF' };
        return json(dir);
      }
      if (u.includes('/transactions/')) {
        return json([
          { type: 'trade', status_updated: Date.now(), roster_ids: [1, 2], adds: { px: 1 }, drops: { px: 2 }, draft_picks: [] },
          { type: 'waiver', status_updated: Date.now(), roster_ids: [3], adds: { p01: 3 }, drops: {}, settings: { waiver_bid: 14 } }
        ]);
      }
      if (u.includes('/matchups/')) {
        const w = Number(u.split('/matchups/')[1]);
        return json(Array.from({ length: 10 }, (_, i) => ({
          roster_id: i + 1, matchup_id: Math.floor(i / 2) + 1, points: 90 + ((i * 7 + w * 3) % 45)
        })));
      }
      if (u.includes('fantasypros-ros.json')) {
        if (ros === 'missing') return { ok: false, status: 404, json: async () => ({}) };
        return json({ season: 2026, week: 1, status: 'ready', players: ROS_PLAYERS });
      }
      if (u.includes('fantasypros-2026.json')) {
        return json(snapshot === 'ready'
          ? { season: 2026, generated_at: '2026-09-03T12:00:00Z', status: 'ready', players: FP_PLAYERS }
          : { season: 2026, status: 'placeholder', players: [] });
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }
  };
}

/* ---------------------------------------------------------------- harness */

async function boot(opts = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(e.message));
  vc.on('error', (...a) => errors.push(a.join(' ')));

  const { fetch } = makeFetch(opts);
  const dom = new JSDOM(readFileSync(resolve(ROOT, 'index.html'), 'utf8'), {
    runScripts: 'outside-only', url: 'https://example.test/', virtualConsole: vc
  });
  const w = dom.window;
  w.fetch = fetch;
  w.scrollTo = () => {};
  try { w.localStorage.clear(); } catch { /* jsdom supplies its own */ }
  for (const file of ['config.js', 'grade.js', 'app.js']) {
    w.eval(readFileSync(resolve(ROOT, file), 'utf8'));
  }
  await drain();
  return { w, doc: w.document, errors };
}

/* Long enough to cover fetchJSON's retry backoff (400ms + 800ms) plus the
 * per-week pauses in the playoff and power-ranking loaders. */
const drain = async (ms = 4000) => {
  for (let i = 0; i < ms / 15; i++) await new Promise(r => setTimeout(r, 15));
};

const text = (doc, id) => doc.getElementById(id).textContent.trim();

/* ------------------------------------------------------------------ tests */

test('boots clean and fills both standings tables', async () => {
  const { doc, errors } = await boot();
  assert.deepEqual(errors, []);
  assert.equal(text(doc, 'statusText'), 'Sleeper connected');
  assert.equal(doc.querySelectorAll('#standingsA tr').length, 10);
  assert.equal(doc.querySelectorAll('#standingsB tr').length, 10);
  assert.equal(text(doc, 'joinedStat'), '20/20');
  // Preseason: no games played, so the ticker should say so rather than
  // crowning whoever happens to sort first.
  assert.equal(text(doc, 'leaderA'), '\u2014');
  assert.match(text(doc, 'leaderASub'), /No games played|Waiting/);
  assert.equal(doc.querySelectorAll('#teamGrid .team-card').length, 20);
});

test('the standings cut line matches the configured playoff spots', async () => {
  const { doc, w } = await boot();
  const perLeague = w.BDI_FANTASY_CONFIG.playoffs.teamsPerLeague;
  const rows = [...doc.querySelectorAll('#standingsA tr')];
  // Read from config rather than hardcoded, so changing the format cannot
  // leave the page and the test disagreeing.
  assert.equal(rows.filter(r => r.classList.contains('in-hunt')).length, perLeague);
  assert.ok(rows[perLeague - 1].classList.contains('cutline'));
});

test('the stated qualifying rule matches the configured format', async () => {
  const { doc, w } = await boot();
  const cfg = w.BDI_FANTASY_CONFIG.playoffs;
  const stated = text(doc, 'qualifyingRule');
  assert.match(stated, new RegExp(`Top ${cfg.teamsPerLeague} in each league`),
    `rules text should state the configured count, got "${stated}"`);
  assert.match(stated, new RegExp(`Week ${cfg.qualifyThroughWeek}`));
  if (cfg.wildcards > 0) assert.match(stated, /wildcard|left over/i);
  else assert.doesNotMatch(stated, /wildcard|left over/i,
    'must not promise wildcards when none are configured');
});

test('grades publish for all twenty teams and spread across letters', async () => {
  const { w, doc } = await boot();
  const cards = doc.querySelectorAll('#draftRankList .grade-row');
  assert.equal(cards.length, 20);
  assert.match(text(doc, 'draftStatus'), /Overall BDI, 1 to 20/);
  const letters = new Set([...doc.querySelectorAll('.grade-big')].map(e => e.textContent.trim()));
  assert.ok(letters.size > 2, `expected a spread of letters, got ${[...letters]}`);
  assert.ok(!doc.querySelector('#snapshotHealth').innerHTML.includes('undefined'));
  assert.match(doc.querySelector('#snapshotHealth').textContent, /% of picks matched/);
  void w;
});

test('a draft report opens with real component grades, not four Cs', async () => {
  const { doc } = await boot();
  doc.querySelector('#draftRankList .grade-row').dispatchEvent(
    new doc.defaultView.MouseEvent('click', { bubbles: true }));
  const metrics = [...doc.querySelectorAll('#modalBody .metric b')].map(e => e.textContent.trim());
  assert.equal(metrics.length, 4);
  assert.ok(doc.getElementById('modal').classList.contains('open'));
  assert.ok(!metrics.every(m => m === 'C'), `component grades collapsed to ${metrics}`);
  assert.match(doc.getElementById('modalTitle').textContent, /of 20/);
});

test('the draft board lists every pick from both leagues', async () => {
  const { doc } = await boot();
  const board = doc.getElementById('boardList');
  assert.equal(board.querySelectorAll('.board-pick').length, 300);
  assert.ok(board.querySelectorAll('.board-round').length >= 15);
  assert.ok(doc.querySelectorAll('#boardGrid .dboard').length === 2, 'a grid per league');
  assert.ok(doc.querySelectorAll('#boardGrid .dboard-cell.head').length >= 20, 'a column header per slot');
  // With real draft_slot values the grid must still be exactly 10 columns per
  // league, not 20 from snake ordering creating phantom slots.
  const headers = [...doc.querySelectorAll('#boardGrid .dboard')].map(
    d => d.querySelectorAll(':scope > .dboard-cell.head').length);
  assert.deepEqual(headers, [11, 11], `expected a round column plus ten slots, got ${headers}`);
  const filled = doc.querySelectorAll('#boardGrid .dboard-cell:not(.head):not(.rnd):not(.empty-cell)').length;
  assert.equal(filled, 300, `every pick should land in a cell, got ${filled}`);
  // A column must belong to exactly one team, or the board is lying about who
  // picked what.
  const firstBoard = doc.querySelector('#boardGrid .dboard');
  const cols = firstBoard.querySelectorAll(':scope > .dboard-cell.head').length - 1;
  const owners = new Map();
  [...firstBoard.querySelectorAll(':scope > .dboard-cell')].forEach((cell, i) => {
    if (cell.classList.contains('head') || cell.classList.contains('rnd')) return;
    const col = i % (cols + 1);
    const team = cell.getAttribute('data-boardteam');
    if (!team) return;
    if (!owners.has(col)) owners.set(col, team);
    assert.equal(owners.get(col), team, `column ${col} has two owners`);
  });
  assert.match(text(doc, 'boardMeta'), /matched to consensus rank/);
  assert.ok(board.querySelector('.board-pick.steal'), 'expect at least one value pick');
  assert.ok(board.querySelector('.board-pick.pos-col-RB'), 'position colour should be applied');
  assert.ok(board.querySelector('.board-pick.reach'), 'expect at least one reach');
});

test('transactions show player names, never raw Sleeper IDs', async () => {
  const { doc } = await boot({ seasonType: 'regular', week: 3 });
  const home = doc.getElementById('homeActivity').textContent;
  assert.ok(home.includes('Traded Guy'), 'the home feed should resolve names');
  assert.ok(!/Player p\d/.test(home), `raw player IDs leaked: ${home.slice(0, 200)}`);
  assert.match(home, /receives/, 'a trade should say who received what');
});

test('power rankings compute once weeks are complete', async () => {
  // Week 10 means nine games played, so results carry full weight and the
  // underlying results formula is what gets reported.
  const { doc } = await boot({ seasonType: 'regular', week: 10 });
  assert.equal(doc.querySelectorAll('#powerList .power-row').length, 5);
  assert.match(text(doc, 'powerMethod'), /all-play/);
  assert.notEqual(text(doc, 'leaderA'), '\u2014', 'a leader is named once games are played');
});

test('preseason falls back to draft-grade ordering instead of an empty panel', async () => {
  // Only when there is no rest-of-season file; otherwise projections win.
  const { doc } = await boot({ ros: 'missing' });
  assert.equal(doc.querySelectorAll('#powerList .power-row').length, 5);
  assert.match(text(doc, 'powerMethod'), /draft grade/i);
});

test('a missing snapshot says exactly what to run', async () => {
  const { doc, errors } = await boot({ snapshot: 'missing' });
  assert.deepEqual(errors, []);
  assert.match(text(doc, 'draftStatus'), /fetch_fantasypros\.py/);
  assert.equal(doc.querySelectorAll('#draftRankList .grade-row').length, 0);
  // The board must still work without FantasyPros.
  assert.equal(doc.querySelectorAll('#boardList .board-pick').length, 300);
});

test('an unfinished draft waits rather than publishing half a grade', async () => {
  const { doc } = await boot({ draftStatus: 'drafting' });
  assert.match(text(doc, 'draftStatus'), /armed/);
  assert.equal(doc.querySelectorAll('#draftRankList .grade-row').length, 0);
});

test('the playoff view opens itself in week 15 and shows a cut line', async () => {
  const { doc, w } = await boot({ seasonType: 'regular', week: 15 });
  assert.ok(doc.getElementById('view-playoffs').classList.contains('active'),
    'week 15 should land on the playoffs tab');
  const rows = doc.querySelectorAll('#playoffLiveBoard .survivor-row');
  assert.equal(rows.length, 8, 'eight qualifiers should be listed');
  assert.equal(doc.querySelectorAll('#playoffLiveBoard .survivor-row.advancing').length, 4);
  assert.ok(doc.querySelector('#playoffLiveBoard .cut-line'));
  const chips = doc.querySelectorAll('#playoffPicture .qualified-chips span');
  const cfg = w.BDI_FANTASY_CONFIG.playoffs;
  assert.equal(chips.length, cfg.teamsPerLeague * 2 + cfg.wildcards);
  assert.equal([...chips].filter(c => c.classList.contains('wild')).length, cfg.wildcards,
    'wildcard flags must match the configured count');
});

test('week 16 narrows the field to four', async () => {
  const { doc } = await boot({ seasonType: 'regular', week: 16 });
  assert.equal(doc.querySelectorAll('#playoffLiveBoard .survivor-row').length, 4);
  assert.equal(doc.querySelectorAll('#playoffLiveBoard .survivor-row.advancing').length, 2);
});

test('week 17 narrows to two and names a leader', async () => {
  const { doc } = await boot({ seasonType: 'regular', week: 17 });
  assert.equal(doc.querySelectorAll('#playoffLiveBoard .survivor-row').length, 2);
  assert.ok(doc.querySelector('.champion-callout'));
});

test('navigating updates the hash and survives a reload', async () => {
  const { w, doc } = await boot();
  doc.querySelector('.nav button[data-view="board"]').dispatchEvent(
    new w.MouseEvent('click', { bubbles: true }));
  assert.equal(w.location.hash, '#board');
  assert.ok(doc.getElementById('view-board').classList.contains('active'));
});

test('Sleeper being down still renders the expected roster of managers', async () => {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(readFileSync(resolve(ROOT, 'index.html'), 'utf8'),
    { runScripts: 'outside-only', url: 'https://example.test/', virtualConsole: vc });
  const w = dom.window;
  w.fetch = async () => { throw new Error('offline'); };
  w.scrollTo = () => {};
  for (const f of ['config.js', 'grade.js', 'app.js']) w.eval(readFileSync(resolve(ROOT, f), 'utf8'));
  await drain();
  const doc = w.document;
  assert.equal(doc.getElementById('statusText').textContent, 'Sleeper unreachable');
  assert.equal(doc.querySelectorAll('#standingsA tr').length, 10);
  assert.equal(doc.querySelectorAll('#teamGrid .team-card').length, 20);
});

test('the player directory is downloaded once, not per roster open', async () => {
  const { fetch } = makeFetch({ seasonType: 'regular', week: 3 });
  const dom = new JSDOM(readFileSync(resolve(ROOT, 'index.html'), 'utf8'),
    { runScripts: 'outside-only', url: 'https://example.test/', virtualConsole: new VirtualConsole() });
  const w = dom.window;
  const calls = [];
  w.fetch = (...a) => { calls.push(String(a[0])); return fetch(...a); };
  w.scrollTo = () => {};
  try { w.localStorage.clear(); } catch { /* jsdom supplies its own */ }
  for (const f of ['config.js', 'grade.js', 'app.js']) w.eval(readFileSync(resolve(ROOT, f), 'utf8'));
  await drain();

  const cards = w.document.querySelectorAll('#teamGrid .team-card');
  for (const card of [...cards].slice(0, 4)) card.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await drain(800);

  const dirCalls = calls.filter(u => u.includes('/players/nfl')).length;
  assert.equal(dirCalls, 1, `player directory fetched ${dirCalls} times`);
});

test('before any games the rankings use projected roster strength', async () => {
  const { doc } = await boot();
  assert.equal(doc.querySelectorAll('#powerList .power-row').length, 5);
  assert.match(text(doc, 'powerMethod'), /projected/i,
    'preseason should say it is ranking on projections');
  assert.match(doc.getElementById('powerList').textContent, /projected points a week/);
});

test('once games are played the method line states the blend', async () => {
  const { doc } = await boot({ seasonType: 'regular', week: 4 });
  assert.equal(doc.querySelectorAll('#powerList .power-row').length, 5);
  assert.match(text(doc, 'powerMethod'), /% results, \d+% projected roster/,
    `expected a blend, got "${text(doc, 'powerMethod')}"`);
});

test('rosters show headshots that collapse when the CDN has no image', async () => {
  const { doc } = await boot();
  doc.querySelector('#teamGrid .team-card').dispatchEvent(
    new doc.defaultView.MouseEvent('click', { bubbles: true }));
  await drain(400);
  const players = doc.querySelectorAll('#modalBody .roster-player');
  assert.ok(players.length >= 2, 'roster should list players');
  const mugs = doc.querySelectorAll('#modalBody .mug');
  assert.equal(mugs.length, players.length, 'every player gets an image slot');
  const imgs = [...doc.querySelectorAll('#modalBody .mug img')];
  assert.ok(imgs.length, 'images should be requested');
  assert.ok(imgs.every(i => i.getAttribute('src').startsWith('https://sleepercdn.com/')),
    'headshots must come from Sleeper\'s CDN');
  assert.ok(imgs.every(i => i.getAttribute('loading') === 'lazy'),
    'images must be lazy so a roster open is not 15 requests');
});
