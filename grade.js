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
  /** The chosen starters themselves, not just their total. */
  function optimalLineupPicks(players, slots) {
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
    return chosen.map(c => players[c.idx]);
  }

  function optimalLineup(players, slots) {
    return optimalLineupPicks(players, slots).reduce((sum, p) => sum + (p.proj || 0), 0);
  }

  /* ------------------------------------------------ value over replacement */

  /* How a flex slot is shared out when working out replacement level. A FLEX
   * is mostly a running back or receiver in practice, so it lifts the number
   * of startable players at those positions more than at tight end. */
  const FLEX_SHARE = {
    FLEX: { RB: 0.40, WR: 0.45, TE: 0.15 },
    WRRB_FLEX: { RB: 0.5, WR: 0.5 },
    REC_FLEX: { WR: 0.7, TE: 0.3 },
    SUPER_FLEX: { QB: 0.7, RB: 0.1, WR: 0.15, TE: 0.05 }
  };

  /**
   * The projection of the last startable player at each position, which is what
   * a pick there is really worth beating.
   *
   * Without this, points are compared across positions as if they were the same
   * currency. They are not: a kicker projecting 140 is barely better than the
   * kicker anyone could have had, while a receiver projecting 140 is a starter.
   */
  function replacementLevels(fpPlayers, code, slots, teams) {
    const startable = {};
    for (const [slot, n] of Object.entries(slots)) {
      const share = FLEX_SHARE[slot];
      if (share) {
        for (const [pos, frac] of Object.entries(share)) startable[pos] = (startable[pos] || 0) + n * frac;
      } else {
        startable[slot] = (startable[slot] || 0) + n;
      }
    }
    const byPos = {};
    for (const p of fpPlayers || []) {
      const pos = normPos(p.position);
      const proj = projPoints(p, code);
      if (proj > 0) (byPos[pos] ||= []).push(proj);
    }
    const levels = {};
    for (const [pos, list] of Object.entries(byPos)) {
      list.sort((a, b) => b - a);
      // One past the last starter: the best player nobody had to spend on.
      const idx = clamp(Math.round((startable[pos] || 0) * teams), 1, list.length) - 1;
      levels[pos] = list[idx] ?? list[list.length - 1] ?? 0;
    }
    return levels;
  }

  const vorOf = (proj, pos, levels) => (proj > 0 ? proj - ((levels || {})[normPos(pos)] ?? 0) : 0);

  /* --------------------------------------------------- baseline at a slot */

  /**
   * What a consensus drafter would have projected at pick N. Built by sorting
   * the FantasyPros pool by ADP, so the Nth-best available player defines the
   * baseline for pick N, then smoothed to stop one outlier from setting it.
   *
   * This is what makes the value component slot-neutral. Scoring raw points
   * per pick rewards whoever drew the 1.01, which is not a draft decision.
   */
  function buildBaseline(fpPlayers, code, maxPick, levels) {
    const pool = (fpPlayers || [])
      .map(p => ({ adp: adpOf(p, code), vor: vorOf(projPoints(p, code), p.position, levels) }))
      .filter(p => p.adp !== null && Number.isFinite(p.vor))
      .sort((a, b) => a.adp - b.adp)
      .map(p => p.vor);
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

  /**
   * What a roster is actually shaped like, rather than whether it is legal.
   *
   * The first version started at 100 and only docked small amounts, so every
   * roster that could field a lineup scored 100 and the whole component graded
   * A+ for all twenty teams — a quarter of the grade doing no work. This one
   * punishes the things that genuinely cost you weeks: a third quarterback or
   * tight end you cannot start, a second kicker, no flex depth, and starters
   * stacked on the same bye.
   */
  function constructionScore(players, slots, bench) {
    const counts = {};
    for (const p of players) counts[p.pos] = (counts[p.pos] || 0) + 1;
    let score = 100;
    const notes = [];

    // Can this roster legally field a lineup at all?
    const pool = players.map(p => p.pos);
    for (const { eligible, n } of slotOrder(slots)) {
      let filled = 0;
      for (let i = 0; i < n; i++) {
        const at = pool.findIndex(p => eligible.includes(p));
        if (at === -1) break;
        pool.splice(at, 1); filled++;
      }
      if (filled < n) {
        score -= 20 * (n - filled);
        notes.push(`cannot fill ${n - filled} starting slot${n - filled > 1 ? 's' : ''}`);
      }
    }

    // A third quarterback or tight end is a bench spot that can never start.
    const hoard = (pos, allowed, per, label) => {
      const over = (counts[pos] || 0) - allowed;
      if (over > 0) {
        score -= per * over;
        notes.push(`${counts[pos]} ${label}`);
      }
    };
    if (!slots.SUPER_FLEX) hoard('QB', (slots.QB || 0) + 1, 9, 'quarterbacks');
    hoard('TE', (slots.TE || 0) + 1, 9, 'tight ends');
    hoard('K', slots.K || 0, 11, 'kickers');
    hoard('DST', slots.DST || 0, 8, 'defenses');

    // Flex depth is what covers injuries. Bench bodies at capped positions are not depth.
    const flexy = (counts.RB || 0) + (counts.WR || 0) + (counts.TE || 0);
    const startingFlex = slotOrder(slots)
      .filter(s => s.eligible.some(p => ['RB', 'WR', 'TE'].includes(p)))
      .reduce((n, s) => n + s.n, 0);
    const wantDepth = startingFlex + Math.ceil(bench * 0.6);
    if (flexy < wantDepth) {
      const short = wantDepth - flexy;
      score -= Math.min(18, 4 * short);
      notes.push(`${short} short on flex depth`);
    }

    // Starters stacked on one bye week means a guaranteed bad week.
    const starters = optimalLineupPicks(players, slots);
    const haveByes = starters.filter(p => p.bye != null).length;
    if (haveByes >= Math.ceil(starters.length * 0.6)) {
      const byWeek = {};
      for (const p of starters) if (p.bye != null) byWeek[p.bye] = (byWeek[p.bye] || 0) + 1;
      let worst = 0;
      for (const [week, n] of Object.entries(byWeek)) {
        const over = n - 2;
        if (over > 0) {
          score -= 5 * over;
          if (n > worst) { worst = n; notes.push(`${n} starters on bye in week ${week}`); }
        }
      }
    }

    return { score: clamp(score, 20, 100), notes };
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

  /* Nobody's draft was made or lost by a kicker. They are excluded from every
   * narrative award, not merely de-weighted: a kicker leading a "best pick"
   * list is simply not true, however the arithmetic got there. */
  const NARRATIVE_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);
  const narrativePool = players => {
    const skill = players.filter(p => NARRATIVE_POSITIONS.has(p.pos));
    return skill.length ? skill : players;
  };

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
    const leagueRosters = [];
    const diag = { picks: 0, matched: 0, projected: 0, withAdp: 0, unmatched: [] };

    for (const { code, league, picks } of leagues) {
      const codeScoring = scoringCode(league);
      const slots = startingSlots(league);
      const bench = benchCount(league);
      const maxPick = Math.max(1, ...picks.map(p => num(p.pick_no) || 0));
      const teamCount = new Set(picks.map(p =>
        (p.roster_id ?? (p.draft_slot !== undefined ? `slot${p.draft_slot}` : null)))).size || 10;
      const levels = replacementLevels(fpPlayers, codeScoring, slots, teamCount);
      const baseline = buildBaseline(fpPlayers, codeScoring, maxPick, levels);

      // Mock drafts are not attached to a league, so their picks carry
      // roster_id: null and only a draft_slot. Grouping on slot lets a mock be
      // graded, which is the whole point of being able to rehearse.
      const teamKeyOf = p => {
        if (p.roster_id !== null && p.roster_id !== undefined) return p.roster_id;
        if (p.draft_slot !== null && p.draft_slot !== undefined) return `slot${p.draft_slot}`;
        return null;
      };
      const byRoster = new Map();
      for (const p of picks) {
        const rosterKey = teamKeyOf(p);
        if (rosterKey === null) continue;
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
          bye: fp && fp.bye != null ? num(fp.bye) : null,
          vor: vorOf(proj, normPos((p.metadata && p.metadata.position) || (fp && fp.position)), levels)
        };
        row.slotValue = baseline && proj > 0 ? row.vor - baseline(num(p.pick_no) || 1) : null;
        const arr = byRoster.get(rosterKey) || [];
        arr.push(row);
        byRoster.set(rosterKey, arr);
      }

      leagueRosters.push({ code, slots, bench, byRoster });
    }

    /* Kickers and defenses rank around 200 overall but are always taken around
     * pick 140, so their raw gap against consensus is a constant +60 or so for
     * everybody. Centring each pick on the median gap for its own position
     * removes that, and a kicker only reads as a steal if it beat the other
     * kickers. */
    const allRows = leagueRosters.flatMap(l => [...l.byRoster.values()].flat());
    const medianByPos = {};
    for (const pos of new Set(allRows.map(r => r.pos))) {
      const deltas = allRows.filter(r => r.pos === pos && r.adp !== null)
        .map(r => r.adp - r.overall).sort((a, b) => a - b);
      medianByPos[pos] = deltas.length ? deltas[Math.floor(deltas.length / 2)] : 0;
    }
    for (const r of allRows) {
      r.centered = r.adp === null ? null : (r.adp - r.overall) - (medianByPos[r.pos] || 0);
    }

    for (const { code, slots, bench, byRoster } of leagueRosters) {
      for (const [rid, players] of byRoster) {
        players.sort((a, b) => a.overall - b.overall);
        const team = teamFor(code, rid) || {
          key: `${code}:${rid}`, code,
          name: String(rid).startsWith('slot') ? `Slot ${String(rid).slice(4)}` : `Roster ${rid}`
        };
        // Slot-relative value, so the 1.01 carries no built-in advantage.
        const slotValue = players.reduce((s, p) => s + (p.slotValue || 0), 0);
        // Per-pick ADP delta, clamped at three rounds so one flier cannot
        // swamp nine sensible picks in either direction.
        const deltas = players.filter(p => p.centered !== null).map(p => clamp(p.centered, -36, 36));
        const adpAvg = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
        entries.push({
          team, players, code,
          raw: {
            slotValue, adpAvg,
            lineup: optimalLineup(players, slots),
            ...(() => { const c = constructionScore(players, slots, bench);
              return { construct: c.score, constructNotes: c.notes }; })()
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
    // Percentile, not a fixed band. If every roster is shaped the same the
    // component honestly grades everyone in the middle instead of everyone an A+.
    const constructVals = entries.map(e => e.raw.construct);
    entries.forEach((e, i) => { pct[i].construct = percentile(e.raw.construct, constructVals) / 100; });

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
      // Position-fair: best beats other players at the same position, and the
      // MVP is the biggest edge over replacement rather than the biggest total.
      const pool = narrativePool(e.players);
      const withDelta = pool.filter(p => p.centered !== null);
      e.best = [...withDelta].sort((a, b) => b.centered - a.centered)[0] || pool[0] || null;
      e.reach = [...withDelta].sort((a, b) => a.centered - b.centered)[0] || null;
      e.mvp = [...pool].sort((a, b) => b.vor - a.vor)[0] || null;
    });

    /* A percentile reads as a rank and is not one: "QB 15th" in a ten-team
     * league is nonsense on its face. Rank teams outright at each position by
     * total value over replacement, ties sharing a place. */
    const posStrength = entries.map(() => ({}));
    const posRank = entries.map(() => ({}));
    const posTotal = entries.map(() => ({}));
    for (const pos of ['QB', 'RB', 'WR', 'TE']) {
      const vals = entries.map(e =>
        e.players.filter(p => p.pos === pos).reduce((s, p) => s + Math.max(0, p.vor), 0));
      const sorted = [...vals].sort((a, b) => b - a);
      entries.forEach((e, i) => {
        posStrength[i][pos] = percentile(vals[i], vals);
        posTotal[i][pos] = vals[i];
        posRank[i][pos] = sorted.indexOf(vals[i]) + 1;
      });
    }
    entries.forEach((e, i) => {
      // Percentiles tie constantly with ten teams, which made the strongest and
      // weakest room effectively random. Total value at the position breaks it.
      const totals = {};
      for (const pos of ['QB', 'RB', 'WR', 'TE']) {
        totals[pos] = e.players.filter(p => p.pos === pos).reduce((s, p) => s + Math.max(0, p.vor), 0);
      }
      const ranked = Object.entries(posRank[i])
        .sort((a, b) => (a[1] - b[1]) || (totals[b[0]] - totals[a[0]]));
      e.positions = posStrength[i];
      e.positionRanks = posRank[i];
      e.positionTotals = posTotal[i];
      e.fieldSize = entries.length;
      e.constructionNotes = e.raw.constructNotes;
      e.constructionScore = e.raw.construct;
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
    startingSlots, benchCount, slotOrder, optimalLineup, optimalLineupPicks, buildBaseline,
    constructionScore, replacementLevels, vorOf, percentile, zScores, letter, componentGrade,
    buildGrades, standingsFromMatchups, NARRATIVE_POSITIONS
  };
});
