/* BDI Fantasy HQ — application shell.
 * Network + DOM only. All grading maths lives in grade.js. */
(() => {
  'use strict';

  const CFG = window.BDI_FANTASY_CONFIG;
  const G = window.BDIGrade;
  const API = 'https://api.sleeper.app/v1';
  const VIEWS = ['home', 'teams', 'draft', 'board', 'activity', 'playoffs'];

  const $ = id => document.getElementById(id);

  if (!CFG || !G) {
    document.body.innerHTML =
      '<div style="max-width:640px;margin:14vh auto;padding:28px;font-family:system-ui;color:#e8eef2">' +
      '<h1 style="margin:0 0 10px">BDI Fantasy HQ could not start</h1>' +
      '<p style="color:#8997a4;line-height:1.6">config.js or grade.js did not load. Check that both files sit ' +
      'next to index.html and that the filenames match exactly, then reload.</p></div>';
    return;
  }

  const state = {
    nfl: null,
    leagues: {}, users: {}, rosters: {}, drafts: {}, picks: {},
    teams: [], playerDir: null, fp: null,
    grades: [], gradeDiagnostics: null, gradeScope: '',
    activity: [], activityCache: new Map(), activityFilter: 'all',
    teamFilter: 'all', boardFilter: 'all', boardSort: 'pick',
    frozenStandings: null, playoffsRendered: false, refreshTimer: null,
    view: 'home'
  };

  /* ------------------------------------------------------------- helpers */

  const esc = (s = '') => String(s).replace(/[&<>'"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
  const fmt = (n, d = 1) => Number.isFinite(Number(n))
    ? Number(n).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }) : '—';
  const signed = n => (n >= 0 ? `+${n}` : `${n}`);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const fpts = (s, prefix = 'fpts') =>
    Number((s && s[prefix]) || 0) + Number((s && s[`${prefix}_decimal`]) || 0) / 100;

  async function fetchJSON(url, { timeout = 12000, retries = 2 } = {}) {
    for (let attempt = 0; ; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      try {
        const r = await fetch(url, { signal: ctrl.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } catch (err) {
        if (attempt >= retries) throw err;
        await sleep(400 * (attempt + 1));
      } finally { clearTimeout(timer); }
    }
  }
  const sleeper = path => fetchJSON(`${API}${path}`);

  function skeleton(rows = 3) {
    return `<div class="skeleton-list">${'<div class="skeleton-row"></div>'.repeat(rows)}</div>`;
  }
  function emptyState(headline, hint) {
    return `<div class="empty"><b>${esc(headline)}</b>${hint ? `<span>${esc(hint)}</span>` : ''}</div>`;
  }

  /* ------------------------------------------------- player directory cache
   * Sleeper's player file is roughly 5 MB and they ask that it be fetched at
   * most once a day. Previously it was re-downloaded on every roster open.
   * Trimming to the three fields actually used gets it small enough to keep
   * in localStorage between visits. */

  const DIR_KEY = 'bdi.playerDir.v1';
  const DIR_TTL = 20 * 60 * 60 * 1000;

  function readDirCache() {
    try {
      const raw = localStorage.getItem(DIR_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || Date.now() - parsed.at > DIR_TTL) return null;
      return parsed.players;
    } catch { return null; }
  }
  function writeDirCache(players) {
    try { localStorage.setItem(DIR_KEY, JSON.stringify({ at: Date.now(), players })); } catch { /* quota */ }
  }
  async function loadPlayerDir() {
    if (state.playerDir) return state.playerDir;
    const cached = readDirCache();
    if (cached) { state.playerDir = cached; return cached; }
    try {
      const full = await fetchJSON(`${API}/players/nfl`, { timeout: 30000, retries: 1 });
      const trimmed = {};
      for (const id of Object.keys(full)) {
        const p = full[id];
        const name = p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim();
        if (!name) continue;
        trimmed[id] = { n: name, p: p.position || '', t: p.team || '' };
      }
      state.playerDir = trimmed;
      writeDirCache(trimmed);
    } catch { state.playerDir = {}; }
    return state.playerDir;
  }
  function playerName(id) {
    const p = state.playerDir && state.playerDir[id];
    return p ? p.n : `Player ${id}`;
  }
  function playerMeta(id) {
    return (state.playerDir && state.playerDir[id]) || { n: `Player ${id}`, p: '', t: '' };
  }

  /* --------------------------------------------------------------- teams */

  const leagueConfig = code => (code === 'A' ? CFG.leagueA : CFG.leagueB);

  function userName(code, ownerId) {
    if (!ownerId) return 'Open team';
    const override = CFG.managerNameOverrides && CFG.managerNameOverrides[ownerId];
    if (override) return override;
    const u = (state.users[code] || []).find(x => x.user_id === ownerId);
    return (u && u.metadata && u.metadata.team_name) || (u && u.display_name) || (u && u.username)
      || `Manager ${String(ownerId).slice(-4)}`;
  }

  function buildTeams() {
    const teams = [];
    for (const code of ['A', 'B']) {
      for (const r of (state.rosters[code] || [])) {
        const s = r.settings || {};
        teams.push({
          key: `${code}:${r.roster_id}`, code, leagueId: leagueConfig(code).id, rosterId: r.roster_id,
          ownerId: r.owner_id, name: userName(code, r.owner_id),
          wins: Number(s.wins || 0), losses: Number(s.losses || 0), ties: Number(s.ties || 0),
          pf: fpts(s, 'fpts'), pa: fpts(s, 'fpts_against'),
          players: r.players || [], starters: r.starters || [], reserve: r.reserve || [], taxi: r.taxi || []
        });
      }
    }
    state.teams = teams;
  }
  const teamFor = (code, rosterId) =>
    state.teams.find(t => t.code === code && Number(t.rosterId) === Number(rosterId)) || null;

  const sortStandings = arr =>
    [...arr].sort((a, b) => (b.wins - a.wins) || (a.losses - b.losses) || (b.pf - a.pf));

  const CUT = () => playoffCfg().teamsPerLeague;

  function renderStandings(code) {
    const rows = sortStandings(state.teams.filter(t => t.code === code));
    const target = $(code === 'A' ? 'standingsA' : 'standingsB');
    if (!rows.length) {
      target.innerHTML = `<tr><td colspan="5" class="cell-empty">Waiting for managers to claim rosters.</td></tr>`;
      return;
    }
    const cut = CUT();
    target.innerHTML = rows.map((t, i) => `<tr class="${i < cut ? 'in-hunt' : ''}${i === cut - 1 ? ' cutline' : ''}">
      <td class="seed">${i + 1}</td>
      <td class="team">${esc(t.name)}</td>
      <td class="rec">${t.wins}-${t.losses}${t.ties ? `-${t.ties}` : ''}</td>
      <td class="n">${fmt(t.pf)}</td>
      <td class="n hide-mobile">${fmt(t.pa)}</td></tr>`).join('');
  }

  function renderTeams() {
    const list = state.teams
      .filter(t => state.teamFilter === 'all' || t.code === state.teamFilter)
      .sort((a, b) => a.name.localeCompare(b.name));
    const grid = $('teamGrid');
    if (!list.length) {
      grid.innerHTML = emptyState('No teams yet', 'Teams appear as managers claim rosters in Sleeper.');
      return;
    }
    grid.innerHTML = list.map(t => {
      const g = state.grades.find(x => x.team.key === t.key);
      return `<button class="team-card league-${t.code.toLowerCase()}" type="button" data-teamkey="${esc(t.key)}">
        <div class="top">
          <span class="pill ${t.code.toLowerCase()}">${t.code}</span>
          ${g ? `<span class="grade-chip tier-${g.tier}">${g.letter}</span>` : ''}
        </div>
        <h4>${esc(t.name)}</h4>
        <div class="line"><span>${t.wins}-${t.losses}</span><em>${fmt(t.pf)} PF</em><em>${t.players.length} rostered</em></div>
      </button>`;
    }).join('');
    grid.querySelectorAll('[data-teamkey]')
      .forEach(el => el.addEventListener('click', () => openTeam(el.dataset.teamkey)));
  }

  const POS_ORDER = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DST'];

  /* Sleeper serves headshots and team logos from an unauthenticated CDN. It is
   * undocumented, so every image needs a fallback: the position tag already
   * carries the information, so a missing face just collapses. */
  function mugUrl(id, pos, team) {
    const p = G.normPos(pos);
    if (p === 'DST') {
      const abbr = (team || id || '').toUpperCase();
      return abbr ? `https://sleepercdn.com/images/team_logos/nfl/${abbr.toLowerCase()}.png` : null;
    }
    return id ? `https://sleepercdn.com/content/nfl/players/thumb/${id}.jpg` : null;
  }
  async function openTeam(key) {
    const t = state.teams.find(x => x.key === key);
    if (!t) return;
    openModal(`${t.name} · League ${t.code}`, skeleton(4));
    await loadPlayerDir();
    const rows = (t.players || []).map(id => {
      const p = playerMeta(id);
      return {
        id, name: p.n, pos: p.p, team: p.t,
        starter: t.starters.includes(id), reserve: t.reserve.includes(id), taxi: t.taxi.includes(id)
      };
    }).sort((a, b) =>
      (Number(b.starter) - Number(a.starter)) ||
      (POS_ORDER.indexOf(a.pos) - POS_ORDER.indexOf(b.pos)) ||
      a.name.localeCompare(b.name));

    const g = state.grades.find(x => x.team.key === key);
    const head = `<div class="report-grid">
      <div class="metric"><b>${t.wins}-${t.losses}</b><span>Record</span></div>
      <div class="metric"><b>${fmt(t.pf)}</b><span>Points for</span></div>
      <div class="metric"><b>${fmt(t.pa)}</b><span>Points against</span></div>
      <div class="metric"><b class="tier-${g ? g.tier : 'b'}">${g ? g.letter : '\u2014'}</b><span>Draft grade</span></div>
    </div>`;
    const body = rows.length
      ? `<div class="roster-list">${rows.map(p => {
          const mug = mugUrl(p.id, p.pos, p.team);
          // Team logos are drawn for light backgrounds and several are mostly
          // black, so they need their own treatment rather than a face crop.
          const isLogo = G.normPos(p.pos) === 'DST';
          return `<div class="roster-player${p.starter ? ' is-starter' : ''}">
            <span class="mug${isLogo ? ' is-logo' : ''}">${mug ? `<img src="${esc(mug)}" alt="" loading="lazy" decoding="async">` : ''}</span>
            <span class="pos-tag pos-${esc(p.pos || 'NA')}">${esc(p.pos || '--')}</span>
            <b>${esc(p.name)}</b>
            <small>${esc(p.team || 'FA')}${p.starter ? ' \u00b7 ST' : ''}${p.reserve ? ' \u00b7 IR' : ''}${p.taxi ? ' \u00b7 TX' : ''}</small>
          </div>`;
        }).join('')}</div>`
      : emptyState('Nothing rostered yet', 'This fills in once the draft runs.');
    $('modalBody').innerHTML = head + body;
    // The CDN is undocumented and not every player has an image.
    $('modalBody').querySelectorAll('.mug img').forEach(img => {
      img.addEventListener('error', () => img.closest('.mug').classList.add('empty'));
    });
  }

  /** The ticker is the hero: live numbers, not a sentence nobody rereads. */
  function renderTicker() {
    const joined = state.teams.filter(t => t.ownerId).length;
    $('joinedStat').textContent = `${joined}/${state.teams.length || 20}`;
    const regular = state.nfl && state.nfl.season_type === 'regular';
    $('weekStat').textContent = regular ? `Week ${state.nfl.week}` : 'Pre';
    $('weekSub').textContent = regular ? `${CFG.season} regular season` : 'Preseason';
    for (const code of ['A', 'B']) {
      const top = sortStandings(state.teams.filter(t => t.code === code))[0];
      const played = top && (top.wins + top.losses + top.ties) > 0;
      $(`leader${code}`).textContent = played ? top.name : '\u2014';
      $(`leader${code}Sub`).textContent = played
        ? `${top.wins}-${top.losses} \u00b7 ${fmt(top.pf)} PF`
        : (top ? 'No games played' : 'Waiting on rosters');
    }
  }

  /* ---------------------------------------------------------------- boot */

  async function loadBase() {
    try {
      const [nfl, la, lb, ua, ub, ra, rb] = await Promise.all([
        sleeper('/state/nfl'),
        sleeper(`/league/${CFG.leagueA.id}`), sleeper(`/league/${CFG.leagueB.id}`),
        sleeper(`/league/${CFG.leagueA.id}/users`), sleeper(`/league/${CFG.leagueB.id}/users`),
        sleeper(`/league/${CFG.leagueA.id}/rosters`), sleeper(`/league/${CFG.leagueB.id}/rosters`)
      ]);
      Object.assign(state, { nfl });
      state.leagues.A = la; state.leagues.B = lb;
      state.users.A = ua; state.users.B = ub;
      state.rosters.A = ra; state.rosters.B = rb;

      buildTeams();
      renderStandings('A'); renderStandings('B'); renderTeams();
      renderTicker();
      applyPlayoffCopy();
      $('statusText').textContent = 'Sleeper connected';
      $('statusSub').textContent = `${la.name || 'League A'} + ${lb.name || 'League B'}`;
      $('app').classList.remove('booting');

      // Draft grades first: the preseason power ranking falls back to them,
      // and running these concurrently used to lose that race.
      await loadDraftData();
      renderTeams();
      renderTicker();
      await Promise.allSettled([loadPowerRankings(), loadHomeActivity()]);

      routeFromHash();
      scheduleRefresh();
    } catch (err) {
      console.error('Sleeper load failed', err);
      $('statusText').textContent = 'Sleeper unreachable';
      $('statusSub').textContent = 'Reload to retry';
      $('app').classList.remove('booting');
      renderExpectedManagers();
    }
  }

  function renderExpectedManagers() {
    state.teams = [];
    for (const code of ['A', 'B']) {
      for (const name of leagueConfig(code).expectedManagers || []) {
        state.teams.push({
          key: `expected:${code}:${name}`, code, name, rosterId: null, ownerId: null,
          wins: 0, losses: 0, ties: 0, pf: 0, pa: 0, players: [], starters: [], reserve: [], taxi: []
        });
      }
    }
    renderStandings('A'); renderStandings('B'); renderTeams();
  }

  /* ----------------------------------------------------- power rankings */

  async function matchupsForWeek(week) {
    const [a, b] = await Promise.allSettled([
      sleeper(`/league/${CFG.leagueA.id}/matchups/${week}`),
      sleeper(`/league/${CFG.leagueB.id}/matchups/${week}`)
    ]);
    return {
      A: a.status === 'fulfilled' ? (a.value || []) : null,
      B: b.status === 'fulfilled' ? (b.value || []) : null
    };
  }

  async function loadCompletedWeeks(through) {
    const last = Math.max(0, through);
    const out = [];
    for (let w = 1; w <= last; w++) {
      const res = await matchupsForWeek(w);
      if (res.A) out.push({ week: w, code: 'A', rows: res.A });
      if (res.B) out.push({ week: w, code: 'B', rows: res.B });
      await sleep(40);
    }
    return out;
  }

  function lastCompletedWeek() {
    if (!state.nfl || state.nfl.season_type !== 'regular') return 0;
    return Math.max(0, Number(state.nfl.week || 1) - 1);
  }

  /* Rankings blend what a roster projects with what it has actually done, on a
   * sliding weight. In Week 1 projections are the only information there is; by
   * Week 8 eight games of scoring says more than any projection. */
  const RESULTS_FULL_WEIGHT_AT = 8;

  async function loadPowerRankings() {
    await Promise.all([loadRos(), loadPlayerDir()]);
    const weeks = await loadCompletedWeeks(lastCompletedWeek());
    if (!weeks.length) { renderRosPower(); return; }

    const byTeam = new Map(state.teams.map(t => [t.key, { team: t, scores: [], allWins: 0, allGames: 0 }]));
    const perWeek = new Map();
    for (const block of weeks) {
      const idToKey = new Map(state.teams.filter(t => t.code === block.code).map(t => [t.rosterId, t.key]));
      for (const m of block.rows) {
        const key = idToKey.get(m.roster_id);
        if (!key) continue;
        const score = Number(m.points || 0);
        byTeam.get(key).scores.push(score);
        const arr = perWeek.get(block.week) || [];
        arr.push({ key, score });
        perWeek.set(block.week, arr);
      }
    }
    // All-play is computed across both leagues in the same week, which is the
    // only cross-league comparison the format allows.
    for (const arr of perWeek.values()) {
      for (const x of arr) for (const y of arr) {
        if (x.key === y.key) continue;
        const rec = byTeam.get(x.key);
        rec.allGames++;
        if (x.score > y.score) rec.allWins++;
        else if (x.score === y.score) rec.allWins += 0.5;
      }
    }

    const metrics = [...byTeam.values()].map(x => {
      const games = x.team.wins + x.team.losses + x.team.ties;
      const recent = x.scores.slice(-3);
      return {
        ...x,
        winPct: games ? (x.team.wins + 0.5 * x.team.ties) / games : 0,
        recent: recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0,
        allPct: x.allGames ? x.allWins / x.allGames : 0
      };
    });
    const W = CFG.powerRankingWeights;
    const pfs = metrics.map(x => x.team.pf), wins = metrics.map(x => x.winPct);
    const recents = metrics.map(x => x.recent), alls = metrics.map(x => x.allPct);
    metrics.forEach(x => {
      x.score = G.percentile(x.team.pf, pfs) * W.pointsFor
        + G.percentile(x.winPct, wins) * W.record
        + G.percentile(x.recent, recents) * W.recentForm
        + G.percentile(x.allPct, alls) * W.allPlay;
    });
    const played = Math.max(0, ...metrics.map(x => x.team.wins + x.team.losses + x.team.ties));
    const resultsWeight = G.clamp(played / RESULTS_FULL_WEIGHT_AT, 0, 1);
    const projections = metrics.map(x => {
      const p = projectedWeekly(x.team);
      x.projected = p ? p.points : null;
      return x.projected;
    }).filter(v => v !== null);

    if (projections.length >= metrics.length * 0.75 && resultsWeight < 1) {
      const median = [...projections].sort((x, y) => x - y)[Math.floor(projections.length / 2)];
      metrics.forEach(x => {
        const projPct = G.percentile(x.projected === null ? median : x.projected, projections);
        x.score = x.score * resultsWeight + projPct * (1 - resultsWeight);
      });
      $('powerMethod').textContent =
        `${Math.round(resultsWeight * 100)}% results, ${Math.round((1 - resultsWeight) * 100)}% projected roster`;
    } else {
      $('powerMethod').textContent = 'Points 40 / record 30 / last three 20 / all-play 10';
    }
    metrics.sort((a, b) => b.score - a.score);
    $('powerList').innerHTML = metrics.slice(0, 5).map((x, i) => `
      <div class="row power-row">
        <span class="rank">${i + 1}</span>
        <div><b>${esc(x.team.name)}</b><small>${x.team.wins}-${x.team.losses} \u00b7 ${fmt(x.team.pf)} PF</small></div>
        <span class="pill ${x.team.code.toLowerCase()}">${x.team.code}</span>
      </div>`).join('');
  }

  /** Before any games, rank on what the rosters project. */
  function renderRosPower() {
    if (!state.ros) { renderDraftBasedPower(); return; }
    const rows = state.teams
      .map(team => ({ team, proj: projectedWeekly(team) }))
      .filter(x => x.proj);
    if (rows.length < state.teams.length * 0.75) { renderDraftBasedPower(); return; }
    rows.sort((a, b) => b.proj.points - a.proj.points);
    $('powerMethod').textContent = `Projected weekly points, week ${state.ros.week}`;
    $('powerList').innerHTML = rows.slice(0, 5).map((x, i) => `
      <div class="row power-row">
        <span class="rank">${i + 1}</span>
        <div><b>${esc(x.team.name)}</b><small>${fmt(x.proj.points, 1)} projected points a week</small></div>
        <span class="pill ${x.team.code.toLowerCase()}">${x.team.code}</span>
      </div>`).join('');
  }

  function renderDraftBasedPower() {
    if (!state.grades.length) {
      $('powerList').innerHTML = emptyState('No games played yet',
        'Rankings appear after Week 1. Until then the draft grades are the closest thing to a pecking order.');
      return;
    }
    $('powerMethod').textContent = 'Preseason, by draft grade';
    $('powerList').innerHTML = state.grades.slice(0, 5).map((x, i) => `
      <div class="row power-row">
        <span class="rank">${i + 1}</span>
        <div><b>${esc(x.team.name)}</b><small>League ${x.team.code}</small></div>
        <span class="grade-chip tier-${x.tier}">${x.letter}</span>
      </div>`).join('');
  }

  /* --------------------------------------------------------- transactions */

  async function loadTransactions(week) {
    if (state.activityCache.has(week)) return state.activityCache.get(week);
    const [a, b] = await Promise.allSettled([
      sleeper(`/league/${CFG.leagueA.id}/transactions/${week}`),
      sleeper(`/league/${CFG.leagueB.id}/transactions/${week}`)
    ]);
    const out = [];
    for (const [code, res] of [['A', a], ['B', b]]) {
      if (res.status === 'fulfilled') for (const tx of (res.value || [])) out.push({ ...tx, code });
    }
    out.sort((x, y) => (y.status_updated || y.created || 0) - (x.status_updated || x.created || 0));
    // Names always, everywhere. The home feed used to skip this and print
    // raw Sleeper player IDs.
    if (out.length) await loadPlayerDir();
    state.activityCache.set(week, out);
    return out;
  }

  const rosterName = (code, rid) => {
    const t = teamFor(code, rid);
    return t ? t.name : `Roster ${rid}`;
  };

  /** Who received what, rather than one flat list of everyone's assets. */
  function tradeSides(tx) {
    const sides = new Map();
    for (const rid of (tx.roster_ids || [])) sides.set(rid, { got: [], sent: [] });
    for (const [pid, rid] of Object.entries(tx.adds || {})) {
      if (!sides.has(rid)) sides.set(rid, { got: [], sent: [] });
      sides.get(rid).got.push(playerName(pid));
    }
    for (const [pid, rid] of Object.entries(tx.drops || {})) {
      if (!sides.has(rid)) sides.set(rid, { got: [], sent: [] });
      sides.get(rid).sent.push(playerName(pid));
    }
    for (const pick of (tx.draft_picks || [])) {
      const label = `${pick.season} round ${pick.round} pick`;
      if (sides.has(pick.owner_id)) sides.get(pick.owner_id).got.push(label);
      if (sides.has(pick.previous_owner_id)) sides.get(pick.previous_owner_id).sent.push(label);
    }
    for (const b of (tx.waiver_budget || [])) {
      if (sides.has(b.receiver)) sides.get(b.receiver).got.push(`$${b.amount} budget`);
      if (sides.has(b.sender)) sides.get(b.sender).sent.push(`$${b.amount} budget`);
    }
    return [...sides.entries()].map(([rid, v]) => ({ rid, ...v }));
  }

  function describeTx(tx) {
    const adds = Object.keys(tx.adds || {}).map(playerName);
    const drops = Object.keys(tx.drops || {}).map(playerName);

    if (tx.type === 'trade') {
      const sides = tradeSides(tx);
      return `<b>Trade · ${esc(sides.map(s => rosterName(tx.code, s.rid)).join(' and '))}</b>
        <div class="trade-sides">${sides.map(s => `<div>
          <span>${esc(rosterName(tx.code, s.rid))} receives</span>
          <b>${s.got.length ? esc(s.got.join(', ')) : 'nothing'}</b>
        </div>`).join('')}</div>`;
    }

    const rid = (tx.roster_ids || [])[0];
    const faab = (tx.waiver_budget || []).reduce((s, x) => s + Math.abs(Number(x.amount || 0)), 0)
      || Math.abs(Number((tx.settings && tx.settings.waiver_bid) || 0));
    const parts = [];
    if (adds.length) parts.push(`added ${adds.join(', ')}`);
    if (drops.length) parts.push(`dropped ${drops.join(', ')}`);
    if (faab) parts.push(`$${faab} FAAB`);
    const verb = tx.type === 'waiver' ? 'Waiver claim' : 'Roster move';
    return `<b>${esc(verb)} · ${esc(rosterName(tx.code, rid))}</b><br>${esc(parts.join(' · ') || 'no players moved')}`;
  }

  function renderActivityItems(items, target, emptyHint) {
    if (!items.length) { target.innerHTML = emptyState('Nothing here yet', emptyHint); return; }
    target.innerHTML = items.map(tx => `
      <div class="move type-${esc(tx.type || 'other')}">
        ${describeTx(tx)}
        <small>League ${tx.code} \u00b7 ${new Date(tx.status_updated || tx.created || Date.now()).toLocaleString()}</small>
      </div>`).join('');
  }

  async function loadHomeActivity() {
    const week = state.nfl && state.nfl.season_type === 'regular' ? Number(state.nfl.week || 1) : 1;
    try {
      const items = await loadTransactions(week);
      renderActivityItems(items.slice(0, 5), $('homeActivity'),
        'Trades, waiver claims and free-agent moves land here once the season starts.');
    } catch { /* leave the placeholder */ }
  }

  async function openActivity() {
    const sel = $('activityWeek');
    if (!sel.options.length) {
      for (let w = 1; w <= 18; w++) {
        const o = document.createElement('option');
        o.value = String(w); o.textContent = `Week ${w}`;
        sel.appendChild(o);
      }
      sel.value = state.nfl && state.nfl.season_type === 'regular' ? String(state.nfl.week || 1) : '1';
    }
    const week = Number(sel.value);
    if (!state.activityCache.has(week)) $('activityList').innerHTML = skeleton(3);
    state.activity = await loadTransactions(week);
    renderFilteredActivity();
  }

  function renderFilteredActivity() {
    const f = state.activityFilter;
    let items = state.activity;
    if (f === 'A' || f === 'B') items = items.filter(x => x.code === f);
    else if (f !== 'all') items = items.filter(x => x.type === f);
    renderActivityItems(items, $('activityList'), 'Try another week or clear the filters.');
  }

  /* --------------------------------------------------------- draft grades */

  /* Rest-of-season data, refreshed weekly, deliberately a different file from
   * the frozen draft snapshot. Absent until scripts/fetch-ros.mjs has run, so
   * every consumer has to cope without it. */
  let rosIndexCache = null;

  async function loadRos() {
    if (state.ros !== undefined) return state.ros;
    try {
      const data = await fetchJSON('data/fantasypros-ros.json', { timeout: 15000, retries: 1 });
      state.ros = data && data.status === 'ready' && (data.players || []).length ? data : null;
    } catch { state.ros = null; }
    if (state.ros) rosIndexCache = G.buildIndex(state.ros.players);
    return state.ros;
  }

  /** A roster's best legal lineup, in projected points for the coming week. */
  function projectedWeekly(team) {
    if (!state.ros || !rosIndexCache || !state.playerDir) return null;
    const league = state.leagues[team.code];
    if (!league) return null;
    const code = G.scoringCode(league);
    const slots = G.startingSlots(league);
    const players = [];
    for (const id of (team.players || [])) {
      const meta = state.playerDir[id];
      if (!meta) continue;
      const fp = G.matchPlayer(
        { player_id: id, metadata: { first_name: meta.n, last_name: '', position: meta.p } },
        rosIndexCache);
      const proj = fp ? G.projPoints(fp, code) : 0;
      players.push({ pos: G.normPos(meta.p), proj, vor: proj });
    }
    if (!players.length) return null;
    const matched = players.filter(p => p.proj > 0).length;
    // A roster we could barely identify would rank low for the wrong reason.
    if (matched < Math.ceil(players.length * 0.5)) return null;
    return { points: G.optimalLineup(players, slots), matched, total: players.length };
  }

  async function loadFantasyPros() {
    if (state.fp) return state.fp;
    try {
      state.fp = await fetchJSON(`data/fantasypros-${CFG.season}.json`, { timeout: 15000, retries: 1 });
    } catch {
      state.fp = { status: 'missing', players: [] };
    }
    return state.fp;
  }

  const draftComplete = d => !!d && d.status === 'complete';

  function setDraftStatus(html, tone = 'notice') {
    const el = $('draftStatus');
    el.className = tone;
    el.innerHTML = (state.rehearsal
      ? '<b>Rehearsal.</b> These grades come from a draft id in the URL, not from your leagues. '
      : '') + html;
  }

  async function loadDraftData() {
    const [da, db] = await Promise.allSettled([
      sleeper(`/league/${CFG.leagueA.id}/drafts`),
      sleeper(`/league/${CFG.leagueB.id}/drafts`)
    ]);
    state.drafts.A = da.status === 'fulfilled' ? (da.value || []) : [];
    state.drafts.B = db.status === 'fulfilled' ? (db.value || []) : [];
    await loadFantasyPros();

    // Rehearsal mode. ?draftA=<id>&draftB=<id> points the grader at any draft,
    // including a Sleeper mock, so draft night is not the first time this runs
    // against real picks. Clearly banner-flagged so nobody mistakes it.
    const params = new URLSearchParams(location.search);
    const rehearse = code => params.get(`draft${code}`);
    state.rehearsal = !!(rehearse('A') || rehearse('B'));

    const pick = code => {
      const forced = rehearse(code);
      if (forced) return { draft_id: forced, season: String(CFG.season), status: 'complete' };
      return (state.drafts[code] || []).find(d => String(d.season) === String(CFG.season))
        || (state.drafts[code] || [])[0] || null;
    };
    const A = pick('A'), B = pick('B');

    const [pa, pb] = await Promise.allSettled([
      A ? sleeper(`/draft/${A.draft_id}/picks`) : Promise.resolve([]),
      B ? sleeper(`/draft/${B.draft_id}/picks`) : Promise.resolve([])
    ]);
    state.picks.A = pa.status === 'fulfilled' ? (pa.value || []) : [];
    state.picks.B = pb.status === 'fulfilled' ? (pb.value || []) : [];

    const completeA = draftComplete(A), completeB = draftComplete(B);
    renderBoard();

    // The drafts cell is the most-watched number on the page this week.
    const done = [completeA, completeB].filter(Boolean).length;
    const live = [A, B].filter(d => d && d.status === 'drafting').length;
    $('draftStat').textContent = live ? 'On the clock' : done === 2 ? 'Complete' : done === 1 ? '1 of 2 done' : 'Not started';
    $('draftStatSub').textContent = live
      ? `${live} draft${live > 1 ? 's' : ''} running now`
      : done === 2 ? 'Both leagues drafted' : 'Grades publish automatically';

    const snapshotReady = state.fp && state.fp.status === 'ready' && (state.fp.players || []).length > 0;
    if (!snapshotReady) {
      setDraftStatus(
        `<b>Grading snapshot is missing.</b> Run <code>scripts/fetch_fantasypros.py</code> and commit ` +
        `<code>data/fantasypros-${CFG.season}.json</code> before the drafts. ` +
        (completeA || completeB
          ? 'A draft has already finished, so grades are waiting on the snapshot alone.'
          : 'Everything else is ready for Thursday.'), 'notice warn');
      $('draftRankList').innerHTML = emptyState('No grades yet',
        'The frozen FantasyPros file has not been generated.');
      return;
    }
    if (!completeA && !completeB) {
      setDraftStatus(
        `<b>Grader is armed.</b> Snapshot from ${esc(state.fp.generated_at || 'an unknown date')} holds ` +
        `${(state.fp.players || []).length} players. Each league publishes its own 1&ndash;10 the moment its ` +
        `draft ends; the combined 1&ndash;20 follows once both are done.`, 'notice');
      $('draftRankList').innerHTML = emptyState('Waiting on draft night',
        'Grades publish automatically. Nothing to press.');
      return;
    }

    const inputs = [];
    if (completeA) inputs.push({ code: 'A', league: state.leagues.A, picks: state.picks.A });
    if (completeB) inputs.push({ code: 'B', league: state.leagues.B, picks: state.picks.B });

    const result = G.buildGrades(inputs, state.fp.players, teamFor, CFG.draftGradeWeights);
    state.grades = result.grades;
    state.gradeDiagnostics = result.diagnostics;
    state.gradeScope = completeA && completeB ? 'Overall BDI, 1 to 20' : `League ${completeA ? 'A' : 'B'}, 1 to 10`;
    renderGrades(completeA && completeB);
  }

  function matchRateHTML() {
    const d = state.gradeDiagnostics;
    if (!d || !d.picks) return '';
    const matched = Math.round(100 * d.matched / d.picks);
    const projected = Math.round(100 * d.projected / d.picks);
    const tone = matched >= 95 && projected >= 90 ? 'ok' : matched >= 85 ? 'warn' : 'bad';
    const missing = d.unmatched.slice(0, 6).join(', ');
    return `<div class="snapshot-health ${tone}">
      <b>${matched}% of picks matched FantasyPros</b>
      <span>${d.matched} of ${d.picks} picks found a ranking, ${projected}% carry a projection.
      ${d.unmatched.length ? `Unmatched: ${esc(missing)}${d.unmatched.length > 6 ? ` and ${d.unmatched.length - 6} more` : ''}.` : 'Nothing was dropped.'}</span>
    </div>`;
  }

  function renderGrades(both) {
    setDraftStatus(
      `<b>${esc(state.gradeScope)} published.</b> ` +
      (both ? '' : 'The other league joins the combined ranking as soon as it finishes. ') +
      `Frozen snapshot ${esc(state.fp.generated_at || 'unknown')}.`, 'notice ok');
    $('snapshotHealth').innerHTML = matchRateHTML();
    $('draftRankList').innerHTML = state.grades.map(g => `
      <button class="row grade-row" type="button" data-gradekey="${esc(g.team.key)}">
        <span class="place">${g.rank}</span>
        <div>
          <h4>${esc(g.team.name)}</h4>
          <small>Best value ${esc(g.best ? g.best.name : '\u2014')} \u00b7 strongest at ${esc(g.strength)}</small>
        </div>
        <span class="pill ${g.team.code.toLowerCase()}">${g.team.code}</span>
        <span class="grade-big tier-${g.tier}">${g.letter}</span>
      </button>`).join('');
    $('draftRankList').querySelectorAll('[data-gradekey]')
      .forEach(el => el.addEventListener('click', () => openDraftReport(el.dataset.gradekey)));
    if (!(state.nfl && state.nfl.season_type === 'regular' && Number(state.nfl.week) > 1)) {
      renderRosPower();
    }
    renderBoard();
  }

  /* --------------------------------------------------------- draft board */

  let fpIndexCache = null;
  function fpIndex() {
    if (!fpIndexCache && state.fp && (state.fp.players || []).length) {
      fpIndexCache = G.buildIndex(state.fp.players);
    }
    return fpIndexCache;
  }

  /* Reuse the grader's position-centred delta when grades exist, so the board
   * and the reports never disagree about what counted as a steal. */
  function gradedDelta(code, overall) {
    for (const g of state.grades) {
      if (g.code !== code) continue;
      const hit = g.players.find(p => p.overall === overall);
      if (hit) return hit.centered ?? null;
    }
    return null;
  }

  function allPicks() {
    const index = fpIndex();
    const out = [];
    for (const code of ['A', 'B']) {
      const code_ = G.scoringCode(state.leagues[code] || {});
      for (const p of (state.picks[code] || [])) {
        // Mock drafts have no rosters; fall back to the draft slot.
        const hasRoster = p.roster_id !== null && p.roster_id !== undefined;
        const team = hasRoster ? teamFor(code, p.roster_id) : null;
        const slotKey = hasRoster ? null : `${code}:slot${p.draft_slot}`;
        // Read the snapshot directly so the board shows value even before
        // grades publish, and while only one draft has finished.
        const fp = index ? G.matchPlayer(p, index) : null;
        out.push({
          code, overall: Number(p.pick_no || 0), round: Number(p.round || 0),
          name: G.pickName(p),
          pos: G.normPos((p.metadata && p.metadata.position) || ''),
          nfl: (p.metadata && p.metadata.team) || '',
          team: team ? team.name : (slotKey ? `Slot ${p.draft_slot}` : `Roster ${p.roster_id}`),
          teamKey: team ? team.key : null,
          draft_slot: p.draft_slot, rosterId: p.roster_id,
          adp: fp ? G.adpOf(fp, code_) : null,
          proj: fp ? G.projPoints(fp, code_) : null,
          centered: gradedDelta(code, Number(p.pick_no))
        });
      }
    }
    return out;
  }

  /** Column for the grid: Sleeper's own draft slot, falling back to roster id. */
  const slotOf = p => Number(p.draft_slot ?? p.rosterId ?? 0) || 0;

  function pickCellHTML(p) {
    const delta = p.centered !== null ? Math.round(p.centered) : (p.adp !== null ? Math.round(p.overall - p.adp) : null);
    const tone = delta === null ? '' : delta >= 10 ? 'steal' : delta <= -10 ? 'reach' : '';
    return `<span class="pick-no">${p.overall}</span>
      <b class="pick-name">${esc(p.name)}</b>
      <span class="pick-meta"><span class="pos-tag pos-${esc(p.pos || 'NA')}">${esc(p.pos || '--')}</span>
      ${p.nfl ? esc(p.nfl) : ''}${delta === null ? '' : ` <em class="${tone}">${signed(delta)}</em>`}</span>`;
  }

  /** The physical draft board: a column per slot, a row per round. */
  function renderBoardGrid(picks) {
    const wrap = $('boardGrid');
    const leagues = state.boardFilter === 'all' ? ['A', 'B'] : [state.boardFilter];
    const out = [];
    for (const code of leagues) {
      const mine = picks.filter(p => p.code === code);
      if (!mine.length) continue;
      const slots = [...new Set(mine.map(slotOf))].sort((x, y) => x - y);
      const rounds = [...new Set(mine.map(p => p.round))].sort((x, y) => x - y);
      const byCell = new Map(mine.map(p => [`${p.round}:${slotOf(p)}`, p]));
      const label = new Map();
      for (const p of mine) if (!label.has(slotOf(p))) label.set(slotOf(p), p.team);

      const cells = [`<div class="dboard-cell rnd head"></div>`];
      for (const s of slots) cells.push(`<div class="dboard-cell head">${esc(label.get(s) || `Slot ${s}`)}</div>`);
      for (const r of rounds) {
        cells.push(`<div class="dboard-cell rnd">${r}</div>`);
        for (const s of slots) {
          const p = byCell.get(`${r}:${s}`);
          if (!p) { cells.push('<div class="dboard-cell empty-cell"></div>'); continue; }
          cells.push(`<div class="dboard-cell pos-col-${esc(p.pos || 'NA')}"${p.teamKey ? ` data-boardteam="${esc(p.teamKey)}"` : ''}>${pickCellHTML(p)}</div>`);
        }
      }
      out.push(`<div class="dboard-title">League ${code}</div>
        <div class="dboard" style="grid-template-columns:46px repeat(${slots.length},minmax(132px,1fr))">${cells.join('')}</div>`);
    }
    wrap.innerHTML = out.join('');
    return out.length > 0;
  }

  function renderBoardList(picks) {
    const wrap = $('boardList');
    const sorted = state.boardSort === 'value'
      ? [...picks].sort((x, y) => (y.overall - (y.adp || 0)) - (x.overall - (x.adp || 0)))
      : [...picks].sort((x, y) => x.overall - y.overall);
    let round = null;
    const html = [];
    for (const p of sorted) {
      if (state.boardSort === 'pick' && p.round !== round) {
        round = p.round;
        html.push(`<div class="board-round">Round ${round}</div>`);
      }
      const delta = p.centered !== null ? Math.round(p.centered) : (p.adp !== null ? Math.round(p.overall - p.adp) : null);
      const tone = delta === null ? '' : delta >= 10 ? 'steal' : delta <= -10 ? 'reach' : '';
      html.push(`<button type="button" class="board-pick pos-col-${esc(p.pos || 'NA')} ${tone}"${p.teamKey ? ` data-boardteam="${esc(p.teamKey)}"` : ''}>
        <span class="board-no">${p.overall}</span>
        <span class="pos-tag pos-${esc(p.pos || 'NA')}">${esc(p.pos || '--')}</span>
        <span class="board-who"><b>${esc(p.name)}</b><small>${p.nfl ? esc(p.nfl) + ' \u00b7 ' : ''}${esc(p.team)} \u00b7 ${p.code}</small></span>
        <span class="board-delta">${delta === null ? '' : `${signed(delta)}`}</span>
      </button>`);
    }
    wrap.innerHTML = html.join('');
  }

  function renderBoard() {
    const all = allPicks();
    const picks = all.filter(p => state.boardFilter === 'all' || p.code === state.boardFilter);
    if (!picks.length) {
      $('boardGrid').innerHTML = '';
      $('boardList').classList.remove('has-grid');
      $('boardList').innerHTML = emptyState('The board is empty',
        'Picks appear live as each draft runs. Reload during the draft to follow along.');
      $('boardMeta').textContent = 'Waiting on the first pick';
      return;
    }
    const matched = picks.filter(p => p.adp !== null).length;
    $('boardMeta').textContent = `${picks.length} picks` +
      (matched ? ` \u00b7 ${matched} matched to consensus rank` : ' \u00b7 rank comparison unlocks with the snapshot');

    // The grid only makes sense in draft order; sorting by value means the list.
    const wantGrid = state.boardSort === 'pick';
    const gridDrawn = wantGrid && renderBoardGrid(picks);
    if (!wantGrid) $('boardGrid').innerHTML = '';
    renderBoardList(picks);
    $('boardList').classList.toggle('has-grid', gridDrawn);

    document.querySelectorAll('[data-boardteam]')
      .forEach(el => el.addEventListener('click', () => openTeam(el.dataset.boardteam)));
  }

  /* ------------------------------------------------------ draft write-ups */

  const ordinal = n => {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };

  const stableHash = text => {
    let h = 2166136261;
    for (const ch of String(text)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
  };
  const deterministicPick = (arr, key) => arr[stableHash(key) % arr.length];
  /* Centred on the median gap for the pick's own position, so a kicker is only
   * a steal if it beat the other kickers. */
  const pickDelta = p => (p && p.centered !== null && p.centered !== undefined ? Math.round(p.centered) : null);

  function pickBlurb(p, type) {
    if (!p) return 'No qualifying pick.';
    const d = pickDelta(p);
    const slot = p.overall ? `Pick ${p.overall}` : 'This selection';
    if (type === 'best') {
      if (d !== null && d >= 20) return `${slot}, ${d} spots later than the field took comparable ${p.pos}s. Everyone else forgot ${p.name} existed.`;
      if (d !== null && d >= 8) return `${slot} beat the going rate at ${p.pos} by ${d} picks. Patience, and the board rewarded it.`;
      return `${slot} paired fair market value with ${fmt(p.proj || 0)} projected points.`;
    }
    if (type === 'reach') {
      if (d !== null && d <= -25) return `${Math.abs(d)} picks ahead of consensus. Bold is one word for it.`;
      if (d !== null && d <= -10) return `${Math.abs(d)} spots ahead of consensus. It was treated as more of a suggestion.`;
      return 'The biggest reach on this roster was mild by draft-room standards.';
    }
    if (type === 'bestPick') {
      const cheap = d !== null && d >= 8 ? ` And ${d} spots cheaper than the field paid at ${p.pos}.` : '';
      return `${fmt(p.vor || 0)} points above replacement at ${p.pos}, the best thing this roster did.${cheap}`;
    }
    if (type === 'mvp') return `${fmt(p.proj || 0)} projected points, ${fmt(p.vor || 0)} of it above replacement at ${p.pos}.`;
    return '';
  }

  function notablePicks(g) {
    const out = [];
    const used = new Set([g.best, g.reach, g.mvp].filter(Boolean).map(p => p.overall));
    const add = (p, label, blurb) => {
      if (!p || used.has(p.overall)) return;
      used.add(p.overall);
      out.push({ p, label, blurb });
    };
    const skill = g.players.filter(p => G.NARRATIVE_POSITIONS.has(p.pos));
    const withAdp = skill.filter(p => p.adp !== null);
    const steal = [...withAdp].sort((a, b) => (b.overall - b.adp) - (a.overall - a.adp))[0];
    if (steal && pickDelta(steal) >= 10) {
      add(steal, 'Value pick', `Fell ${pickDelta(steal)} spots past the going rate at ${steal.pos}, worth ${fmt(steal.vor || 0)} over replacement.`);
    }
    const late = [...skill].filter(p => p.overall > 60 && p.vor > 0).sort((a, b) => b.vor - a.vor)[0];
    if (late) add(late, 'Upside swing', `A later pick worth ${fmt(late.vor)} over replacement at ${late.pos}, which is where ceiling hides.`);
    /* The panel's disagreement on draft day, frozen with the snapshot. A high
     * rank_std means the experts could not agree, so taking that player early
     * was a genuine call rather than following consensus. */
    const bold = [...skill].filter(p => p.spread != null && p.spread >= 12)
      .sort((a, b) => b.spread - a.spread)[0];
    if (bold) {
      const range = bold.rankMin != null && bold.rankMax != null
        ? ` Rankings ranged from ${Math.round(bold.rankMin)} to ${Math.round(bold.rankMax)}.`
        : '';
      add(bold, 'Boldest call',
        `The panel could not agree on him at all.${range} Taking him at ${bold.overall} was a real decision, not consensus-following.`);
    }
    const settled = [...skill].filter(p => p.spread != null && p.spread <= 4 && p.overall <= 60)
      .sort((a, b) => a.spread - b.spread)[0];
    if (settled) {
      add(settled, 'Safest call',
        `Nobody disagreed about him. A settled pick at ${settled.overall}, which is either discipline or a lack of imagination.`);
    }
    const questionable = [...withAdp].filter(p => pickDelta(p) <= -12).sort((a, b) => pickDelta(a) - pickDelta(b))[1];
    if (questionable) add(questionable, 'Questionable', `Went ${Math.abs(pickDelta(questionable))} spots ahead of consensus. This one gets remembered either way.`);
    const efficient = [...skill].filter(p => p.overall > 80 && p.vor > 0)
      .sort((a, b) => b.vor - a.vor)[0];
    if (efficient) add(efficient, 'Late-round value', `${fmt(efficient.vor)} over replacement from pick ${efficient.overall}. Boring, and it wins weeks.`);
    return out.slice(0, 4);
  }

  const GRADE_BANK = {
    'A+': ['Annoyingly competent. There is not much here to make fun of.',
      'Great value, sound construction, very few questionable decisions. Disgusting.',
      'The draft room reviewed the tape and unfortunately this was excellent.'],
    A: ['Excellent work. Please try harder to give the rest of us material next time.',
      'Strong board discipline, strong roster, minimal nonsense. We hate to see it.'],
    'A-': ['You knew what you were doing, which takes some of the fun out of this.',
      'Very good throughout, with just enough imperfection to remain technically human.'],
    'B+': ['A good draft with just enough questionable decision-making to keep you humble.',
      'Strong overall. Nobody needs to panic, including you.'],
    B: ['Perfectly respectable. Nobody is building a statue, but nobody is calling HR either.',
      'Solid, sensible, and aggressively difficult to mock.'],
    'B-': ['There is a good team in here. We just need to work out where you hid it.',
      'Above water, with a few spots that may require adult supervision.'],
    'C+': ['Some steals, some reaches, and at least one pick we need you to explain.',
      'A mixed bag, but importantly still a bag.'],
    C: ['Congratulations on assembling a roster of professional football players.',
      'Perfectly average, which is either reassuring or insulting depending on your expectations.'],
    'C-': ['The projections say there is a plan here. We remain committed to finding it.',
      'Concerning in places, interesting in others, definitive in none.'],
    'D+': ['A few good picks are doing an impressive amount of structural work.',
      'There are building blocks here. Several are currently holding up the whole building.'],
    D: ['The draft room was open the entire time, just confirming.',
      'There were warning signs. Then there were more warning signs.'],
    'D-': ['FantasyPros has filed a formal objection.', 'The good news is that waivers open soon.'],
    F: ['We checked the numbers twice because this grade seemed unnecessarily cruel.',
      'You have successfully demonstrated why autodraft exists.',
      'There were other draft strategies available.']
  };

  function rosterCounts(g) {
    const c = {};
    for (const p of g.players) c[p.pos] = (c[p.pos] || 0) + 1;
    return c;
  }

  function verdict(g) {
    const n = state.grades.length;
    const c = rosterCounts(g);
    const bestD = pickDelta(g.best), reachD = pickDelta(g.reach);
    const opener = deterministicPick(GRADE_BANK[g.letter] || GRADE_BANK.C, `${g.team.key}-${g.letter}-${g.rank}`);
    const slots = G.startingSlots(state.leagues[g.code] || {});
    const reasons = [];
    if ((c.QB || 0) >= 3 && !slots.SUPER_FLEX) {
      reasons.push(`${c.QB} quarterbacks for one starting slot is an admirably aggressive commitment to optionality.`);
    }
    if ((c.TE || 0) >= 3) reasons.push(`${c.TE} tight ends suggests either a strategy or an unresolved personal issue.`);
    const bye = (g.constructionNotes || []).find(n => n.includes('on bye'));
    if (bye) reasons.push(`There are ${bye}, which is a loss you scheduled in advance.`);
    if (bestD !== null && bestD >= 15) reasons.push(`${g.best.name} falling ${bestD} spots past the going rate at ${g.best.pos} was the clearest win.`);
    if (reachD !== null && reachD <= -18) reasons.push(`${g.reach.name} went ${Math.abs(reachD)} picks early and will need explaining.`);
    if (g.bestPick && g.best && g.bestPick.name !== g.best.name) {
      reasons.push(`${g.bestPick.name} is the best player here; ${g.best.name} was the best bargain.`);
    }
    reasons.push(`${g.strength} is the strongest room; ${g.weakness} is where the depth chart gets uncomfortable.`);
    if (g.rank === 1) reasons.push('Congratulations on winning the part of fantasy football that famously guarantees nothing.');
    if (g.rank === n && n > 1) reasons.push('Someone had to finish last. We appreciate your service.');
    return `${opener} ${reasons.slice(0, 3).join(' ')}`;
  }

  function openDraftReport(key) {
    const g = state.grades.find(x => x.team.key === key);
    if (!g) return;
    const bestD = pickDelta(g.best), reachD = pickDelta(g.reach);
    const talks = notablePicks(g);
    const crown = g.rank === 1 ? ' · offseason champion'
      : (g.rank === state.grades.length && state.grades.length > 1) ? ' · draft day disaster' : '';

    const components = [
      ['Value at the slot', g.components.projectionValue],
      ['Rank discipline', g.components.adpEfficiency],
      ['Roster construction', g.components.rosterConstruction],
      ['Projected lineup', g.components.lineupStrength]
    ];
    const callouts = [
            ['Best pick', `<b>${esc(g.bestPick ? g.bestPick.name : '\u2014')}</b>` +
        `${g.bestPick ? ` <span class="delta good">pick ${g.bestPick.overall}</span>` : ''}<br>` +
        `${esc(pickBlurb(g.bestPick, 'bestPick'))}`],
      ['Best value', `<b>${esc(g.best ? g.best.name : '\u2014')}</b>${bestD !== null ? ` <span class="delta good">${signed(bestD)} vs consensus</span>` : ''}<br>${esc(pickBlurb(g.best, 'best'))}`],
      ['Biggest reach', `<b>${esc(g.reach ? g.reach.name : '\u2014')}</b>${reachD !== null ? ` <span class="delta bad">${signed(reachD)} vs consensus</span>` : ''}<br>${esc(pickBlurb(g.reach, 'reach'))}`],
      ['Roster shape', g.constructionNotes && g.constructionNotes.length
        ? esc(g.constructionNotes.join(', '))
        : 'Nothing structurally wrong with it.']
    ];

    openModal(`${g.team.name} · ${g.letter} · ${g.rank} of ${state.grades.length}${crown}`, `
      <div class="report-grid">${components.map(([label, val]) =>
        `<div class="metric"><b class="tier-${val[0] === 'A' ? 'a' : val[0] === 'B' ? 'b' : val[0] === 'C' ? 'c' : 'd'}">${val}</b><span>${esc(label)}</span></div>`).join('')}</div>
      <div class="callout-grid">${callouts.map(([h, body]) =>
        `<div class="callout"><h5>${esc(h)}</h5><p>${body}</p></div>`).join('')}
        <div class="callout wide-callout">
          <h5>Room by room</h5>
          <p>${['QB', 'RB', 'WR', 'TE'].map(p => {
            const rank = g.positionRanks[p] || g.fieldSize;
            const third = g.fieldSize / 3;
            const tone = rank <= third ? 'strong' : rank > g.fieldSize - third ? 'weak' : '';
            return `<span class="room ${tone}"><b>${p}</b>${ordinal(rank)} of ${g.fieldSize}</span>`;
          }).join('')}</p>
          <small class="room-note">Ranked against the rest of the field on value over replacement.</small>
        </div>
        <div class="callout verdict-callout"><h5>The verdict</h5><p>${esc(verdict(g))}</p></div>
      </div>
      ${talks.length ? `<div class="notable-block"><h5>Picks worth talking about</h5><div class="notable-list">${talks.map(x => `
        <div class="notable-pick">
          <b>${esc(x.label)} · ${esc(x.p.name)}</b>
          <span>Pick ${x.p.overall}${x.p.adp !== null ? ` · consensus ${Math.round(x.p.adp)}` : ''}</span>
          <p>${esc(x.blurb)}</p>
        </div>`).join('')}</div></div>` : ''}
      <p class="grade-disclaimer">Grades compare every drafted roster against a frozen FantasyPros snapshot \u2014 consensus rank,
      projections and value over replacement \u2014 and scientifically determine who won fantasy football
      before any football has been played. Results are therefore unquestionably final.</p>`);
  }

  /* -------------------------------------------------------------- playoffs */

  /* The format is stated in several places on the page. Deriving every one of
   * them from config is the only way they cannot contradict each other, which
   * is exactly what went wrong when the copy was hardcoded: config said three
   * plus two wildcards while the markup still said top four. */
  function applyPlayoffCopy() {
    const cfg = playoffCfg();
    const seats = cfg.teamsPerLeague * 2 + cfg.wildcards;
    const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
    const wild = cfg.wildcards > 0;
    set('qualifyingRule',
      `Top ${cfg.teamsPerLeague} in each league on the standings through Week ${cfg.qualifyThroughWeek}`
      + (wild ? `, plus the ${cfg.wildcards} highest-scoring teams left over from either league.` : '.'));
    set('playoffPictureSub', wild
      ? `Top ${cfg.teamsPerLeague} per league plus ${cfg.wildcards} wildcards`
      : `Top ${cfg.teamsPerLeague} in each league qualify`);
    set('playoffHeroLine', (wild
      ? `The top ${cfg.teamsPerLeague} from each league qualify, plus ${cfg.wildcards} wildcards on points scored. `
      : `The top ${cfg.teamsPerLeague} from each league qualify. `)
      + 'There are no head-to-head playoff matchups \u2014 every round is one combined scoring '
      + 'leaderboard across both leagues.');
    set('playoffSeats', `${seats} teams, three weeks, highest scores survive.`);
  }

  const playoffCfg = () => {
    const cfg = CFG.playoffs || {};
    return {
      qualifyThroughWeek: cfg.qualifyThroughWeek ?? 14,
      teamsPerLeague: cfg.teamsPerLeague ?? 3,
      wildcards: cfg.wildcards ?? 2,
      rounds: cfg.rounds || [{ week: 15, advance: 4 }, { week: 16, advance: 2 }, { week: 17, advance: 1 }]
    };
  };
  function currentWeek() {
    if (!state.nfl || state.nfl.season_type !== 'regular') return 0;
    return Number(state.nfl.week || 0);
  }
  const inPlayoffs = () => currentWeek() >= playoffCfg().rounds[0].week;

  /**
   * The qualifying eight, frozen. Sleeper keeps adding wins to roster settings
   * through the playoff weeks, so reading live standings in Week 16 could
   * change who supposedly qualified in Week 14.
   */
  /**
   * Automatic spots by record within each league, then the highest scorers of
   * everyone left over, pooled across both leagues.
   *
   * Points rather than record for the wildcards, because the playoff rounds
   * themselves are decided purely on weekly score, and because a fourth
   * record-based spot would put a twelve-team league and a ten-team league back
   * into the same comparison.
   */
  function withWildcards(seedsByLeague, allTeams, wildcards) {
    const seeded = seedsByLeague.flat();
    const taken = new Set(seeded.map(t => t.key));
    const pool = allTeams
      .filter(t => !taken.has(t.key))
      .sort((x, y) => (y.seedPf ?? y.pf) - (x.seedPf ?? x.pf))
      .slice(0, Math.max(0, wildcards))
      .map(t => ({ ...t, wildcard: true }));
    return [...seeded, ...pool];
  }

  async function frozenQualifiers() {
    const cfg = playoffCfg();
    if (!inPlayoffs()) {
      const seeds = ['A', 'B'].map(code =>
        sortStandings(state.teams.filter(t => t.code === code)).slice(0, cfg.teamsPerLeague));
      return withWildcards(seeds, state.teams, cfg.wildcards);
    }
    if (state.frozenStandings) return state.frozenStandings;
    const weeks = { A: [], B: [] };
    for (let w = 1; w <= cfg.qualifyThroughWeek; w++) {
      const res = await matchupsForWeek(w);
      if (res.A) weeks.A.push(res.A);
      if (res.B) weeks.B.push(res.B);
      await sleep(40);
    }
    const resolved = [];
    const seeds = [];
    for (const code of ['A', 'B']) {
      const rows = [];
      for (const row of G.standingsFromMatchups(weeks[code])) {
        const t = teamFor(code, row.rosterId);
        if (t) rows.push({ ...t, seedWins: row.wins, seedLosses: row.losses, seedPf: row.pf });
      }
      resolved.push(...rows);
      seeds.push(rows.slice(0, cfg.teamsPerLeague));
    }
    const field = withWildcards(seeds, resolved, cfg.wildcards);
    state.frozenStandings = field.length ? field : null;
    return state.frozenStandings || [];
  }

  function renderRegularPlayoffPicture() {
    const cut = playoffCfg().teamsPerLeague;
    const block = (code, rows) => `<div class="playoff-league">
      <div class="playoff-league-head"><b>League ${code}</b><span>Top ${cut} qualify</span></div>
      ${rows.map((t, i) => `<div class="playoff-team-row ${i < cut ? 'in' : 'bubble'}">
        <span class="seed">${i + 1}</span>
        <div><b>${esc(t.name)}</b><small>${t.wins}-${t.losses} \u00b7 ${fmt(t.pf)} PF</small></div>
        <span class="playoff-status">${i < cut ? 'In' : 'Out'}</span>
      </div>`).join('')}</div>`;
    $('playoffPictureTitle').textContent = 'Where the field stands';
    $('playoffPictureSub').textContent = cfg.wildcards > 0
      ? `Top ${cut} in each league, plus ${cfg.wildcards} on points`
      : `Top ${cut} in each league qualify`;
    $('playoffPicture').innerHTML = `<div class="playoff-picture-grid">
      ${block('A', sortStandings(state.teams.filter(t => t.code === 'A')))}
      ${block('B', sortStandings(state.teams.filter(t => t.code === 'B')))}</div>`;
    $('playoffLiveTitle').textContent = 'Road to the championship';
    $('playoffLiveSub').textContent = 'Live scoring starts in Week 15';
    $('playoffLiveBadge').textContent = `Weeks ${playoffCfg().rounds[0].week}\u2013${playoffCfg().rounds[playoffCfg().rounds.length - 1].week}`;
    $('playoffLiveBoard').innerHTML = emptyState('Not yet',
      'This becomes the live cut-line leaderboard when the playoffs begin.');
  }

  async function scoresForWeek(week) {
    const res = await matchupsForWeek(week);
    const rows = [];
    for (const code of ['A', 'B']) {
      if (!res[code]) continue;
      const byId = new Map(state.teams.filter(t => t.code === code).map(t => [t.rosterId, t]));
      for (const m of res[code]) {
        const team = byId.get(m.roster_id);
        if (team) rows.push({ team, score: Number(m.points || 0) });
      }
    }
    return rows;
  }

  function liveBoardHTML(rows, advance, note) {
    const sorted = [...rows].sort((a, b) => b.score - a.score);
    const played = sorted.some(r => r.score > 0);
    return `<div class="survivor-board">${sorted.map((x, i) => `
      ${i === advance && played ? '<div class="cut-line"><span>Cut line</span></div>' : ''}
      <div class="survivor-row ${played && i < advance ? 'advancing' : played ? 'eliminated' : ''}">
        <span class="survivor-rank">${i + 1}</span>
        <div><b>${esc(x.team.name)}</b><small>League ${x.team.code}</small></div>
        <strong>${fmt(x.score, 2)}</strong>
        <span class="survivor-state">${!played ? '' : i < advance ? 'Advancing' : 'Out'}</span>
      </div>`).join('')}</div><p class="survivor-note">${esc(note)}</p>`;
  }

  async function renderPlayoffs(force = false) {
    if (state.playoffsRendered && !force) return;
    state.playoffsRendered = true;
    const cfg = playoffCfg();
    const wk = currentWeek();

    if (!inPlayoffs()) { renderRegularPlayoffPicture(); return; }

    $('playoffPicture').innerHTML = skeleton(2);
    const field = await frozenQualifiers();
    const keys = new Set(field.map(t => t.key));
    $('playoffPictureTitle').textContent = `${CFG.season} BDI playoff field`;
    $('playoffPictureSub').textContent = cfg.wildcards > 0
      ? `Top ${cfg.teamsPerLeague} per league plus ${cfg.wildcards} wildcards, through Week ${cfg.qualifyThroughWeek}`
      : `Seeded on the standings through Week ${cfg.qualifyThroughWeek}`;
    $('playoffPicture').innerHTML = `<div class="qualified-chips">${field.map(t => `
      <span class="${t.wildcard ? 'wild' : ''}"><b>${esc(t.name)}</b><small>${t.code} · ${t.seedWins ?? t.wins}-${t.seedLosses ?? t.losses}${t.wildcard ? ' · wildcard' : ''}</small></span>
    `).join('')}</div>`;

    try {
      let alive = keys;
      for (let i = 0; i < cfg.rounds.length; i++) {
        const round = cfg.rounds[i];
        const rows = (await scoresForWeek(round.week)).filter(x => alive.has(x.team.key));
        if (wk === round.week) {
          const labels = ['Elite eight', 'Final four', 'BDI championship'];
          $('playoffLiveTitle').textContent = `Week ${round.week} · ${labels[i] || 'Playoff round'}`;
          $('playoffLiveSub').textContent = round.advance > 1
            ? `Top ${round.advance} scores advance` : 'Highest score wins';
          $('playoffLiveBadge').textContent = 'Live';
          const note = round.advance > 1
            ? `${rows.length} teams playing. The ${round.advance} highest Week ${round.week} scores survive.`
            : `Two finalists. One week. Highest score is the BDI champion.`;
          $('playoffLiveBoard').innerHTML = liveBoardHTML(rows, round.advance, note);
          if (round.advance === 1 && rows.length && rows[0].score > 0) {
            const leader = [...rows].sort((a, b) => b.score - a.score)[0];
            $('playoffLiveBoard').innerHTML += `<div class="champion-callout">
              <span>🏆</span><div><small>Leading the championship</small><b>${esc(leader.team.name)}</b></div></div>`;
          }
          return;
        }
        alive = new Set([...rows].sort((a, b) => b.score - a.score).slice(0, round.advance).map(x => x.team.key));
      }
      $('playoffLiveBoard').innerHTML = emptyState('The playoffs are over', 'Congratulations to whoever peaked in December.');
    } catch (err) {
      console.error('Playoff board', err);
      $('playoffLiveBoard').innerHTML = emptyState('Scores did not load', 'Sleeper did not answer. Reload to retry.');
    }
  }

  /* ---------------------------------------------------------------- modal */

  let lastFocus = null;
  function openModal(title, body) {
    lastFocus = document.activeElement;
    $('modalTitle').textContent = title;
    $('modalBody').innerHTML = body;
    $('modal').classList.add('open');
    document.body.classList.add('modal-open');
    $('modalClose').focus();
  }
  function closeModal() {
    $('modal').classList.remove('open');
    document.body.classList.remove('modal-open');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  /* -------------------------------------------------------------- routing */

  function showView(name, { pushHash = true } = {}) {
    if (!VIEWS.includes(name)) name = 'home';
    state.view = name;
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
    document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    if (pushHash && location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
    if (name === 'activity') openActivity();
    if (name === 'playoffs') renderPlayoffs();
    if (name === 'board') renderBoard();
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }

  function routeFromHash() {
    const wanted = location.hash.replace('#', '');
    if (VIEWS.includes(wanted)) { showView(wanted, { pushHash: false }); return; }
    showView(inPlayoffs() ? 'playoffs' : 'home');
  }

  /** During the playoffs the live board is the whole point, so refresh it. */
  function scheduleRefresh() {
    clearInterval(state.refreshTimer);
    if (!inPlayoffs()) return;
    state.refreshTimer = setInterval(async () => {
      if (document.hidden || state.view !== 'playoffs') return;
      await renderPlayoffs(true);
    }, 90000);
  }

  /* --------------------------------------------------------------- events */

  document.querySelectorAll('.nav button')
    .forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
  window.addEventListener('hashchange', routeFromHash);

  document.querySelectorAll('[data-teamfilter]').forEach(b => b.addEventListener('click', () => {
    state.teamFilter = b.dataset.teamfilter;
    document.querySelectorAll('[data-teamfilter]').forEach(x => x.classList.toggle('active', x === b));
    renderTeams();
  }));
  document.querySelectorAll('[data-activityfilter]').forEach(b => b.addEventListener('click', () => {
    state.activityFilter = b.dataset.activityfilter;
    document.querySelectorAll('[data-activityfilter]').forEach(x => x.classList.toggle('active', x === b));
    renderFilteredActivity();
  }));
  document.querySelectorAll('[data-boardfilter]').forEach(b => b.addEventListener('click', () => {
    state.boardFilter = b.dataset.boardfilter;
    document.querySelectorAll('[data-boardfilter]').forEach(x => x.classList.toggle('active', x === b));
    renderBoard();
  }));
  document.querySelectorAll('[data-boardsort]').forEach(b => b.addEventListener('click', () => {
    state.boardSort = b.dataset.boardsort;
    document.querySelectorAll('[data-boardsort]').forEach(x => x.classList.toggle('active', x === b));
    renderBoard();
  }));

  $('activityWeek').addEventListener('change', openActivity);
  $('modalClose').addEventListener('click', closeModal);
  $('modal').addEventListener('click', e => { if (e.target === $('modal')) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  loadBase();
})();
