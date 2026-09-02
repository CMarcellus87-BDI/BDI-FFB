/* BDI Fantasy HQ — grading math.
 *
 * Deliberately free of DOM and network so it can be unit tested in Node.
 * Loaded as a plain script in the browser (window.BDIGrade) and required
 * directly by scripts/selftest.mjs.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BDIGrade = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  /** Number(null) is 0 and Number('') is 0. Neither is a real value. */
  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /* ---------------------------------------------------------------- names */

  function normName(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
      .replace(/[^a-z0-9]/g, '');
  }

  /* Sleeper says DEF, FantasyPros says DST, and they mean the same thing.
   * Left unhandled this silently drops every defense from every grade. */
  const POS_ALIAS = { DEF: 'DST', 'D/ST': 'DST', DST: 'DST', PK: 'K' };
  function normPos(p) {
    const up = String(p || '').toUpperCase().split(/[,/]/)[0].trim();
    return POS_ALIAS[up] || up;
  }

  function fpKey(name, pos) {
    return `${normName(name)}|${normPos(pos)}`;
  }

  /** Sleeper draft picks carry the name in metadata; defenses carry the city
   *  and nickname split across the same two fields. */
  function pickName(p) {
    const m = p.metadata || {};
    const full = `${m.first_name || ''} ${m.last_name || ''}`.trim();
    return full || m.player_name || p.player_id || 'Unknown';
  }

  /* -------------------------------------------------------------- indexing */

  /**
   * Three lookups, tried in order of confidence: name+position, name alone,
   * and for defenses the team abbreviation. The name-only map is built once
   * rather than scanned per pick.
   */
  function buildIndex(players) {
    const byKey = new Map(), byName = new Map(), byTeamDst = new Map();
    for (const p of players || []) {
      const pos = normPos(p.position);
      const n = normName(p.name);
      if (!n) continue;
      byKey.set(`${n}|${pos}`, p);
      if (!byName.has(n)) byName.set(n, p);
      if (pos === 'DST' && p.team) byTeamDst.set(String(p.team).toUpperCase(), p);
    }
    return { byKey, byName, byTeamDst };
  }

  function matchPlayer(pick, index) {
    const name = pickName(pick);
    const pos = normPos(pick.metadata && pick.metadata.position);
    const n = normName(name);
    return index.byKey.get(`${n}|${pos}`)
      || (pos === 'DST' ? index.byTeamDst.get(String(pick.player_id || '').toUpperCase()) : null)
      || index.byName.get(n)
      || null;
  }

  /* --------------------------------------------------------------- scoring */

  /** ppr | half | std, read from a Sleeper league's own scoring settings. */
  function scoringCode(league) {
    const rec = num(league && league.scoring_settings && league.scoring_settings.rec) || 0;
    return rec >= 0.9 ? 'ppr' : rec >= 0.4 ? 'half' : 'std';
  }

  function projPoints(fp, code) {
    if (!fp) return 0;
    return num(fp[`points_${code}`]) ?? num(fp.points_half) ?? num(fp.points_ppr) ?? num(fp.points_std) ?? 0;
  }
  function adpOf(fp, code) {
    if (!fp) return null;
    return num(fp[`adp_${code}`]) ?? num(fp.adp_half) ?? num(fp.adp_ppr) ?? num(fp.adp_std);
  }
  function ecrOf(fp, code) {
    if (!fp) return null;
    return num(fp[`ecr_${code}`]) ?? num(fp.ecr_half) ?? num(fp.ecr_ppr) ?? num(fp.ecr_std);
  }

  /* ----------------------------------------------------------------- slots */

  const BENCH_SLOTS = new Set(['BN', 'IR', 'TAXI']);
  const FLEX_ELIGIBILITY = {
    FLEX: ['RB', 'WR', 'TE'],
    WRRB_FLEX: ['RB', 'WR'],
    REC_FLEX: ['WR', 'TE'],
    SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
    IDP_FLEX: ['DL', 'LB', 'DB']
  };

  /** Starting slots only, in fill order: fixed positions first, then the
   *  flexes from most to least restrictive. */
  function startingSlots(league) {
    const positions = (league && league.roster_positions) || [];
    const counts = {};
    for (const raw of positions) {
      const slot = normPos(raw) === 'DST' ? 'DST' : String(raw).toUpperCase();
      if (BENCH_SLOTS.has(slot)) continue;
      counts[slot] = (counts[slot] || 0) + 1;
    }
    return counts;
  }

  function benchCount(league) {
    return ((league && league.roster_positions) || []).filter(p => p === 'BN').length;
  }

  function slotOrder(slots) {
    const fixed = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];
    const flex = ['REC_FLEX', 'WRRB_FLEX', 'FLEX', 'IDP_FLEX', 'SUPER_FLEX'];
    const out = [];
    for (const s of fixed) if (slots[s]) out.push({ slot: s, eligible: [s], n: slots[s] });
    for (const s of flex) if (slots[s]) out.push({ slot: s, eligible: FLEX_ELIGIBILITY[s] || [], n: slots[s] });
    return out;
  }

  /**
   * Best legal starting lineup by projected points. Most-restrictive-first is
   * optimal for nested slot families; the swap pass afterwards covers the
   * configurations that are not nested.
   */
  function optimalLineup(players, slots) {
    const order = slotOrder(slots);
    const used = new Set();
    const chosen = [];
    for (const { eligible, n } of order) {
      for (let i = 0; i < n; i++) {
        let best = null;
        players.forEach((p, idx) => {
          if (used.has(idx) || !eligible.includes(p.pos)) return;
          if (!best || p.proj > players[best].proj) best = idx;
        });
        if (best !== null) { used.add(best); chosen.push({ idx: best, eligible }); }
      }
    }
    let improved = true, guard = 0;
    while (improved && guard++ < 40) {
      improved = false;
      for (const c of chosen) {
        players.forEach((p, idx) => {
          if (used.has(idx) || !c.eligible.includes(p.pos)) return;
          if (p.proj > players[c.idx].proj) {
            used.delete(c.idx); used.add(idx); c.idx = idx; improved = true;
          }
        });
      }
    }
    return chosen.reduce((sum, c) => sum + (players[c.idx].proj || 0), 0);
  }

  /* --------------------------------------------------- baseline at a slot */

  /**
   * What a consensus drafter would have projected at pick N. Built by sorting
   * the FantasyPros pool by ADP, so the Nth-best available player defines the
   * baseline for pick N, then smoothed to stop one outlier from setting it.
   *
   * This is what makes the value component slot-neutral. Scoring raw points
   * per pick rewards whoever drew the 1.01, which is not a draft decision.
   */
  function buildBaseline(fpPlayers, code, maxPick) {
    const pool = (fpPlayers || [])
      .map(p => ({ adp: adpOf(p, code), proj: projPoints(p, code) }))
      .filter(p => p.adp !== null && p.proj > 0)
      .sort((a, b) => a.adp - b.adp)
      .map(p => p.proj);
    if (!pool.length) return null;
    const smoothed = pool.map((_, i) => {
      const lo = Math.max(0, i - 4), hi = Math.min(pool.length, i + 5);
      const win = pool.slice(lo, hi);
      return win.reduce((a, b) => a + b, 0) / win.length;
    });
    const floor = smoothed[smoothed.length - 1];
    return function baselineAt(pickNo) {
      const i = Math.max(0, Math.round(pickNo) - 1);
      return i < smoothed.length ? smoothed[i] : floor;
    };
  }

  /* ---------------------------------------------------------- construction */

  function constructionScore(players, slots, bench) {
    const counts = {};
    for (const p of players) counts[p.pos] = (counts[p.pos] || 0) + 1;
    let score = 100;

    // Can this roster legally field a lineup at all?
    const starters = slotOrder(slots);
    const pool = players.map(p => p.pos);
    for (const { eligible, n } of starters) {
      let filled = 0;
      for (let i = 0; i < n; i++) {
        const at = pool.findIndex(p => eligible.includes(p));
        if (at === -1) break;
        pool.splice(at, 1); filled++;
      }
      score -= 18 * (n - filled);
    }

    // Hoarding at a one-slot position costs real bench space.
    const cap = (pos, allowed) => {
      const over = (counts[pos] || 0) - allowed;
      if (over > 0) score -= 5 * over;
    };
    if (!slots.SUPER_FLEX) cap('QB', (slots.QB || 0) + 1);
    cap('TE', (slots.TE || 0) + 1);
    cap('K', slots.K || 0);
    cap('DST', slots.DST || 0);

    // Bench that is not flex-eligible depth is bench that cannot help you.
    const flexy = (counts.RB || 0) + (counts.WR || 0) + (counts.TE || 0);
    const expected = Object.values(slots).reduce((a, b) => a + b, 0) + bench;
    if (expected > 0 && flexy < Math.ceil(expected * 0.55)) score -= 8;

    return clamp(score, 40, 100);
  }

  /* ------------------------------------------------------------- statistics */

  function percentile(value, values) {
    if (!values.length) return 50;
    const sorted = [...values].sort((a, b) => a - b);
    if (sorted.length < 2) return 50;
    const below = sorted.filter(x => x < value).length;
    const equal = sorted.filter(x => x === value).length;
    return 100 * (below + 0.5 * equal) / sorted.length;
  }

  function zScores(values) {
    const n = Math.max(1, values.length);
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(values.reduce((s, x) => s + (x - mean) ** 2, 0) / n) || 1;
    return values.map(x => (x - mean) / sd);
  }

  function letter(n) {
    return n >= 96 ? 'A+' : n >= 92 ? 'A' : n >= 89 ? 'A-' : n >= 86 ? 'B+' : n >= 82 ? 'B'
      : n >= 79 ? 'B-' : n >= 76 ? 'C+' : n >= 72 ? 'C' : n >= 69 ? 'C-' : n >= 66 ? 'D+'
        : n >= 62 ? 'D' : 'F';
  }

  /* The old version was letter(72 + pct * 0.25), whose whole range was 72 to
   * 72.25 — every component of every team graded C. Percentile now spans the
   * a D+ to A+ band, with a median draft landing on a B. */
  function componentGrade(pct) {
    return letter(66 + clamp(pct, 0, 1) * 32);
  }

  const GRADE_TIER = g => (g[0] === 'A' ? 'a' : g[0] === 'B' ? 'b' : g[0] === 'C' ? 'c' : 'd');

  /* ---------------------------------------------------------------- grades */

  /**
   * @param {Array} leagues  [{ code, league, picks }] for completed drafts only
   * @param {Array} fpPlayers frozen FantasyPros snapshot
   * @param {Function} teamFor (code, rosterId) => team object
   * @param {Object} weights
   */
  function buildGrades(leagues, fpPlayers, teamFor, weights) {
    const index = buildIndex(fpPlayers);
    const entries = [];
    const diag = { picks: 0, matched: 0, projected: 0, withAdp: 0, unmatched: [] };

    for (const { code, league, picks } of leagues) {
      const codeScoring = scoringCode(league);
      const slots = startingSlots(league);
      const bench = benchCount(league);
      const maxPick = Math.max(1, ...picks.map(p => num(p.pick_no) || 0));
      const baseline = buildBaseline(fpPlayers, codeScoring, maxPick);

      const byRoster = new Map();
      for (const p of picks) {
        if (p.roster_id === null || p.roster_id === undefined) continue;
        const fp = matchPlayer(p, index);
        const proj = projPoints(fp, codeScoring);
        const adp = adpOf(fp, codeScoring);
        diag.picks++;
        if (fp) diag.matched++; else diag.unmatched.push(pickName(p));
        if (proj > 0) diag.projected++;
        if (adp !== null) diag.withAdp++;
        const row = {
          pick: p, fp,
          pos: normPos((p.metadata && p.metadata.position) || (fp && fp.position)),
          name: pickName(p),
          nflTeam: (p.metadata && p.metadata.team) || (fp && fp.team) || '',
          overall: num(p.pick_no) || 0,
          round: num(p.round) || 0,
          proj, adp, ecr: ecrOf(fp, codeScoring),
          slotValue: baseline && proj > 0 ? proj - baseline(num(p.pick_no) || 1) : null
        };
        const arr = byRoster.get(p.roster_id) || [];
        arr.push(row);
        byRoster.set(p.roster_id, arr);
      }

      for (const [rid, players] of byRoster) {
        players.sort((a, b) => a.overall - b.overall);
        const team = teamFor(code, rid) || { key: `${code}:${rid}`, code, name: `Roster ${rid}` };
        // Slot-relative value, so the 1.01 carries no built-in advantage.
        const slotValue = players.reduce((s, p) => s + (p.slotValue || 0), 0);
        // Per-pick ADP delta, clamped at three rounds so one flier cannot
        // swamp nine sensible picks in either direction.
        const deltas = players.filter(p => p.adp !== null).map(p => clamp(p.adp - p.overall, -36, 36));
        const adpAvg = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
        entries.push({
          team, players, code,
          raw: {
            slotValue, adpAvg,
            lineup: optimalLineup(players, slots),
            construct: constructionScore(players, slots, bench)
          }
        });
      }
    }
    if (!entries.length) return { grades: [], diagnostics: diag };

    const pct = entries.map(() => ({}));
    for (const field of ['slotValue', 'adpAvg', 'lineup']) {
      const vals = entries.map(e => e.raw[field]);
      entries.forEach((e, i) => { pct[i][field] = percentile(e.raw[field], vals) / 100; });
    }
    entries.forEach((e, i) => { pct[i].construct = clamp((e.raw.construct - 40) / 60, 0, 1); });

    const W = weights;
    entries.forEach((e, i) => {
      e.composite = pct[i].slotValue * W.projectionValue
        + pct[i].adpAvg * W.adpEfficiency
        + pct[i].construct * W.rosterConstruction
        + pct[i].lineup * W.lineupStrength;
    });

    const zs = zScores(entries.map(e => e.composite));
    entries.forEach((e, i) => {
      e.score = clamp(82 + zs[i] * 8, 58, 99);
      e.letter = letter(e.score);
      e.tier = GRADE_TIER(e.letter);
      e.components = {
        projectionValue: componentGrade(pct[i].slotValue),
        adpEfficiency: componentGrade(pct[i].adpAvg),
        rosterConstruction: componentGrade(pct[i].construct),
        lineupStrength: componentGrade(pct[i].lineup)
      };
      const withAdp = e.players.filter(p => p.adp !== null);
      e.best = [...withAdp].sort((a, b) => (b.adp - b.overall) - (a.adp - a.overall))[0] || e.players[0] || null;
      e.reach = [...withAdp].sort((a, b) => (a.adp - a.overall) - (b.adp - b.overall))[0] || null;
      e.mvp = [...e.players].sort((a, b) => b.proj - a.proj)[0] || null;
    });

    const posStrength = entries.map(() => ({}));
    for (const pos of ['QB', 'RB', 'WR', 'TE']) {
      const vals = entries.map(e => e.players.filter(p => p.pos === pos).reduce((s, p) => s + p.proj, 0));
      entries.forEach((e, i) => { posStrength[i][pos] = percentile(vals[i], vals); });
    }
    entries.forEach((e, i) => {
      const ranked = Object.entries(posStrength[i]).sort((a, b) => b[1] - a[1]);
      e.positions = posStrength[i];
      e.strength = ranked[0] ? ranked[0][0] : 'Roster';
      e.weakness = ranked[ranked.length - 1] ? ranked[ranked.length - 1][0] : 'Depth';
    });

    const grades = entries.sort((a, b) => b.score - a.score).map((e, i) => ({ ...e, rank: i + 1 }));
    return { grades, diagnostics: diag };
  }

  /* ------------------------------------------------------------- standings */

  /**
   * Head-to-head records rebuilt from weekly matchups. Used to freeze the
   * playoff field at the end of the regular season: Sleeper's roster settings
   * keep accumulating wins through weeks 15-17, so reading them live would let
   * the qualifying eight change during the playoffs.
   */
  function standingsFromMatchups(weeks) {
    const rec = new Map();
    const get = rid => {
      if (!rec.has(rid)) rec.set(rid, { rosterId: rid, wins: 0, losses: 0, ties: 0, pf: 0, pa: 0 });
      return rec.get(rid);
    };
    for (const rows of weeks) {
      const byMatchup = new Map();
      for (const m of rows || []) {
        if (m.roster_id === null || m.roster_id === undefined) continue;
        const pts = num(m.points) || 0;
        get(m.roster_id).pf += pts;
        const id = m.matchup_id;
        if (id === null || id === undefined) continue;
        const arr = byMatchup.get(id) || [];
        arr.push({ rosterId: m.roster_id, points: pts });
        byMatchup.set(id, arr);
      }
      for (const pair of byMatchup.values()) {
        if (pair.length !== 2) continue;
        const [x, y] = pair;
        get(x.rosterId).pa += y.points;
        get(y.rosterId).pa += x.points;
        if (x.points > y.points) { get(x.rosterId).wins++; get(y.rosterId).losses++; }
        else if (y.points > x.points) { get(y.rosterId).wins++; get(x.rosterId).losses++; }
        else { get(x.rosterId).ties++; get(y.rosterId).ties++; }
      }
    }
    return [...rec.values()].sort((a, b) => (b.wins - a.wins) || (a.losses - b.losses) || (b.pf - a.pf));
  }

  return {
    clamp, num, normName, normPos, fpKey, pickName,
    buildIndex, matchPlayer, scoringCode, projPoints, adpOf, ecrOf,
    startingSlots, benchCount, slotOrder, optimalLineup, buildBaseline,
    constructionScore, percentile, zScores, letter, componentGrade,
    buildGrades, standingsFromMatchups
  };
});
