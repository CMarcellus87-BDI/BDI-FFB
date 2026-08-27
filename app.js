(() => {
  'use strict';
  const CFG = window.BDI_FANTASY_CONFIG;
  const API = 'https://api.sleeper.app/v1';
  const state = {
    nfl: null,
    leagues: {}, users: {}, rosters: {}, drafts: {}, picks: {},
    teams: [], playerDir: null, fp: null, draftGrades: [],
    activity: [], activityFilter: 'all', teamFilter: 'all'
  };
  const $ = (id) => document.getElementById(id);
  const esc = (s='') => String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const clamp = (n,a,b) => Math.max(a,Math.min(b,n));
  const fmt = (n,d=1) => Number.isFinite(Number(n)) ? Number(n).toLocaleString(undefined,{maximumFractionDigits:d,minimumFractionDigits:d}) : '—';
  const fpts = (settings, prefix='fpts') => Number(settings?.[prefix] || 0) + Number(settings?.[`${prefix}_decimal`] || 0)/100;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function fetchJSON(url, timeout=12000) {
    const ctrl = new AbortController(); const timer = setTimeout(()=>ctrl.abort(), timeout);
    try { const r = await fetch(url,{signal:ctrl.signal,cache:'no-store'}); if(!r.ok) throw new Error(`${r.status}`); return await r.json(); }
    finally { clearTimeout(timer); }
  }
  async function sleeper(path){ return fetchJSON(`${API}${path}`); }

  function leagueConfig(code){ return code==='A' ? CFG.leagueA : CFG.leagueB; }
  function userName(code, ownerId) {
    if (!ownerId) return 'Open Team';
    if (CFG.managerNameOverrides?.[ownerId]) return CFG.managerNameOverrides[ownerId];
    const u = (state.users[code]||[]).find(x=>x.user_id===ownerId);
    return u?.metadata?.team_name || u?.display_name || u?.username || `Manager ${ownerId.slice(-4)}`;
  }
  function buildTeams(){
    const teams=[];
    for (const code of ['A','B']) {
      for (const r of (state.rosters[code]||[])) {
        const s=r.settings||{};
        teams.push({
          key:`${code}:${r.roster_id}`, code, leagueId:leagueConfig(code).id, rosterId:r.roster_id,
          ownerId:r.owner_id, name:userName(code,r.owner_id), wins:Number(s.wins||0), losses:Number(s.losses||0),
          pf:fpts(s,'fpts'), pa:fpts(s,'fpts_against'), players:r.players||[], starters:r.starters||[], reserve:r.reserve||[], taxi:r.taxi||[]
        });
      }
    }
    state.teams=teams;
  }
  function sortStandings(arr){ return [...arr].sort((a,b)=>(b.wins-a.wins)||(a.losses-b.losses)||(b.pf-a.pf)); }
  function renderStandings(code){
    const rows=sortStandings(state.teams.filter(t=>t.code===code));
    $(code==='A'?'standingsA':'standingsB').innerHTML = rows.length ? rows.map((t,i)=>`<tr><td class="rank">${i+1}</td><td><b>${esc(t.name)}</b></td><td>${t.wins}-${t.losses}</td><td>${fmt(t.pf)}</td><td class="hide-mobile">${fmt(t.pa)}</td></tr>`).join('') : `<tr><td colspan="5">Waiting for managers to join.</td></tr>`;
  }
  function renderTeams(){
    const list=state.teams.filter(t=>state.teamFilter==='all'||t.code===state.teamFilter).sort((a,b)=>a.name.localeCompare(b.name));
    $('teamGrid').innerHTML = list.length ? list.map(t=>`<article class="team-card" data-teamkey="${t.key}" tabindex="0"><span class="league-pill">League ${t.code}</span><h4>${esc(t.name)}</h4><p>${t.wins}-${t.losses} · ${fmt(t.pf)} PF · ${t.players.length} rostered</p></article>`).join('') : `<div class="empty">Teams will populate as managers claim rosters in Sleeper.</div>`;
    document.querySelectorAll('[data-teamkey]').forEach(el=>{ const fn=()=>openTeam(el.dataset.teamkey); el.addEventListener('click',fn); el.addEventListener('keydown',e=>{if(e.key==='Enter')fn()}); });
  }
  async function loadPlayerDir(){
    if(state.playerDir) return state.playerDir;
    try { state.playerDir = await sleeper('/players/nfl'); } catch { state.playerDir={}; }
    return state.playerDir;
  }
  async function openTeam(key){
    const t=state.teams.find(x=>x.key===key); if(!t) return;
    openModal(`${t.name} · League ${t.code}`, `<div class="empty">Loading roster…</div>`);
    const dir=await loadPlayerDir();
    const rows=(t.players||[]).map(id=>{ const p=dir[id]||{}; return {id,name:p.full_name||`${p.first_name||''} ${p.last_name||''}`.trim()||`Player ${id}`,pos:p.position||'',team:p.team||'', starter:t.starters.includes(id), reserve:t.reserve.includes(id), taxi:t.taxi.includes(id)}; });
    rows.sort((a,b)=>(Number(b.starter)-Number(a.starter))||['QB','RB','WR','TE','K','DEF'].indexOf(a.pos)-['QB','RB','WR','TE','K','DEF'].indexOf(b.pos));
    $('modalBody').innerHTML = `<div class="mini-grid" style="margin-bottom:14px"><div class="mini-stat"><b>${t.wins}-${t.losses}</b><span>Record</span></div><div class="mini-stat"><b>${fmt(t.pf)}</b><span>Points for</span></div></div><div class="roster-list">${rows.map(p=>`<div class="roster-player"><b>${esc(p.name)}</b><span>${esc(p.pos)} · ${esc(p.team||'FA')} ${p.starter?'· STARTER':''}${p.reserve?' · IR':''}${p.taxi?' · TAXI':''}</span></div>`).join('')||'<div class="empty">Roster not drafted yet.</div>'}</div>`;
  }

  async function loadBase(){
    try {
      const [nfl, la, lb, ua, ub, ra, rb] = await Promise.all([
        sleeper('/state/nfl'), sleeper(`/league/${CFG.leagueA.id}`), sleeper(`/league/${CFG.leagueB.id}`),
        sleeper(`/league/${CFG.leagueA.id}/users`), sleeper(`/league/${CFG.leagueB.id}/users`),
        sleeper(`/league/${CFG.leagueA.id}/rosters`), sleeper(`/league/${CFG.leagueB.id}/rosters`)
      ]);
      state.nfl=nfl; state.leagues.A=la; state.leagues.B=lb; state.users.A=ua; state.users.B=ub; state.rosters.A=ra; state.rosters.B=rb;
      buildTeams(); renderStandings('A'); renderStandings('B'); renderTeams();
      $('teamCount').textContent=state.teams.length || 20;
      $('joinedStat').textContent=`${state.teams.filter(t=>t.ownerId).length}/20`;
      const wk = nfl.season_type==='regular' ? `W${nfl.week}` : 'Pre'; $('weekStat').textContent=wk;
      $('statusText').textContent='Sleeper connected'; $('statusSub').textContent=`${la.name||'League A'} + ${lb.name||'League B'}`;
      await Promise.allSettled([loadDraftData(), loadPowerRankings(), loadHomeActivity()]);
      await renderPlayoffs();
      if(playoffWeek()>=15) showView('playoffs');
    } catch(e) {
      console.error(e); $('statusText').textContent='Sleeper unavailable'; $('statusSub').textContent='Refresh to retry';
      renderExpectedManagers();
    }
  }
  function renderExpectedManagers(){
    state.teams=[];
    for(const code of ['A','B']) for(const name of leagueConfig(code).expectedManagers) state.teams.push({key:`expected:${code}:${name}`,code,name,wins:0,losses:0,pf:0,pa:0,players:[],starters:[],reserve:[],taxi:[]});
    renderStandings('A');renderStandings('B');renderTeams();
  }

  async function loadCompletedWeeks(){
    const current = state.nfl?.season_type==='regular' ? Number(state.nfl.week||1) : 1;
    const last = Math.max(0,current-1); if(!last) return [];
    const all=[];
    for(let w=1;w<=last;w++) {
      const [a,b]=await Promise.allSettled([sleeper(`/league/${CFG.leagueA.id}/matchups/${w}`),sleeper(`/league/${CFG.leagueB.id}/matchups/${w}`)]);
      if(a.status==='fulfilled') all.push({week:w,code:'A',rows:a.value}); if(b.status==='fulfilled') all.push({week:w,code:'B',rows:b.value});
      await sleep(30);
    }
    return all;
  }
  function percentile(value, values){ const sorted=[...values].sort((a,b)=>a-b); if(sorted.length<2)return 50; const below=sorted.filter(x=>x<value).length; const equal=sorted.filter(x=>x===value).length; return 100*(below+.5*equal)/sorted.length; }
  async function loadPowerRankings(){
    const weeks=await loadCompletedWeeks();
    if(!weeks.length){
      if(state.draftGrades.length) renderDraftBasedPower();
      return;
    }
    const byTeam=new Map(state.teams.map(t=>[t.key,{team:t,scores:[],allWins:0,allGames:0}]));
    const weekScores=new Map();
    for(const block of weeks){
      const mapId=new Map(state.teams.filter(t=>t.code===block.code).map(t=>[t.rosterId,t.key]));
      const ws=[];
      for(const m of block.rows||[]){ const key=mapId.get(m.roster_id); if(!key)continue; const score=Number(m.points||0); byTeam.get(key).scores.push(score); ws.push({key,score}); }
      const arr=weekScores.get(block.week)||[]; arr.push(...ws); weekScores.set(block.week,arr);
    }
    for(const arr of weekScores.values()) for(const x of arr) for(const y of arr) if(x.key!==y.key){ byTeam.get(x.key).allGames++; if(x.score>y.score)byTeam.get(x.key).allWins++; else if(x.score===y.score)byTeam.get(x.key).allWins+=.5; }
    const metrics=[...byTeam.values()].map(x=>{ const games=x.team.wins+x.team.losses; return { ...x, winPct:games?x.team.wins/games:0, recent:x.scores.slice(-3).reduce((a,b)=>a+b,0)/Math.max(1,x.scores.slice(-3).length), allPct:x.allGames?x.allWins/x.allGames:0 }; });
    const pfs=metrics.map(x=>x.team.pf), wins=metrics.map(x=>x.winPct), recents=metrics.map(x=>x.recent), alls=metrics.map(x=>x.allPct), W=CFG.powerRankingWeights;
    metrics.forEach(x=>x.score=percentile(x.team.pf,pfs)*W.pointsFor+percentile(x.winPct,wins)*W.record+percentile(x.recent,recents)*W.recentForm+percentile(x.allPct,alls)*W.allPlay);
    metrics.sort((a,b)=>b.score-a.score);
    $('powerMethod').textContent='PF 40% · Record 30% · Recent 20% · All-Play 10%';
    $('powerList').innerHTML=metrics.slice(0,5).map((x,i)=>`<div class="power-row"><div class="num">#${i+1}</div><div><b>${esc(x.team.name)}</b><small>League ${x.team.code} · ${x.team.wins}-${x.team.losses} · ${fmt(x.team.pf)} PF</small></div><span class="tag">${fmt(x.score,0)}</span></div>`).join('');
  }
  function renderDraftBasedPower(){
    $('powerMethod').textContent='Preseason · based on draft grades';
    $('powerList').innerHTML=state.draftGrades.slice(0,5).map((x,i)=>`<div class="power-row"><div class="num">#${i+1}</div><div><b>${esc(x.team.name)}</b><small>League ${x.team.code} · Draft grade ${x.letter}</small></div><span class="grade">${x.letter}</span></div>`).join('');
  }

  async function loadHomeActivity(){
    const week=state.nfl?.season_type==='regular'?Number(state.nfl.week||1):1;
    try { const items=await loadTransactions(week,false); renderActivityItems(items.slice(0,5),$('homeActivity')); } catch {}
  }
  async function loadTransactions(week, names=true){
    const [a,b]=await Promise.allSettled([sleeper(`/league/${CFG.leagueA.id}/transactions/${week}`),sleeper(`/league/${CFG.leagueB.id}/transactions/${week}`)]);
    const out=[]; for(const [code,res] of [['A',a],['B',b]]) if(res.status==='fulfilled') for(const tx of res.value||[]) out.push({...tx,code});
    out.sort((x,y)=>(y.status_updated||y.created||0)-(x.status_updated||x.created||0));
    if(names && out.length) await loadPlayerDir(); return out;
  }
  function txPlayer(id){ const p=state.playerDir?.[id]; return p?.full_name||`${p?.first_name||''} ${p?.last_name||''}`.trim()||`Player ${id}`; }
  function txManagers(tx){ const ids=new Set([...(tx.roster_ids||[]), ...Object.keys(tx.adds||{}).map(k=>tx.adds[k]), ...Object.keys(tx.drops||{}).map(k=>tx.drops[k])]); return [...ids].map(rid=>state.teams.find(t=>t.code===tx.code&&String(t.rosterId)===String(rid))?.name).filter(Boolean); }
  function describeTx(tx){
    const managers=txManagers(tx); const adds=Object.keys(tx.adds||{}).map(txPlayer); const drops=Object.keys(tx.drops||{}).map(txPlayer); const faab=Object.values(tx.waiver_budget||{}).reduce((s,x)=>s+Math.abs(Number(x.amount||0)),0);
    if(tx.type==='trade') return `<b>🤝 ${esc(managers.join(' ↔ ')||'Trade')}</b><br>${adds.length?`Assets moved: ${adds.map(esc).join(', ')}`:'Trade completed'}`;
    if(tx.type==='waiver') return `<b>🔄 ${esc(managers[0]||'Manager')} waiver claim</b><br>${adds.length?`Added ${adds.map(esc).join(', ')}`:''}${drops.length?` · Dropped ${drops.map(esc).join(', ')}`:''}${faab?` · $${faab} FAAB`:''}`;
    return `<b>➕ ${esc(managers[0]||'Manager')} roster move</b><br>${adds.length?`Added ${adds.map(esc).join(', ')}`:''}${drops.length?` · Dropped ${drops.map(esc).join(', ')}`:''}`;
  }
  function renderActivityItems(items,target){
    if(!items.length){target.innerHTML='<div class="empty">No transactions found for this week.</div>';return;}
    target.innerHTML=items.map(tx=>`<div class="activity-item"><span class="league-pill">League ${tx.code}</span> ${describeTx(tx)}<br><small>${tx.type.replace('_',' ')} · ${new Date(tx.status_updated||tx.created||Date.now()).toLocaleString()}</small></div>`).join('');
  }
  async function openActivity(){
    const sel=$('activityWeek'); if(!sel.options.length){ for(let w=1;w<=18;w++){const o=document.createElement('option');o.value=w;o.textContent=`Week ${w}`;sel.appendChild(o);} sel.value=state.nfl?.season_type==='regular'?String(state.nfl.week||1):'1'; }
    $('activityList').innerHTML='<div class="empty">Loading combined activity…</div>'; const items=await loadTransactions(Number(sel.value),true); state.activity=items; renderFilteredActivity();
  }
  function renderFilteredActivity(){ let items=state.activity; const f=state.activityFilter; if(['A','B'].includes(f))items=items.filter(x=>x.code===f); else if(f!=='all')items=items.filter(x=>x.type===f); renderActivityItems(items,$('activityList')); }

  function normName(s=''){ return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,''); }
  function fpKey(name,pos){return `${normName(name)}|${String(pos||'').toUpperCase()}`}
  function sleeperPickName(p){ return p.metadata?.first_name&&p.metadata?.last_name ? `${p.metadata.first_name} ${p.metadata.last_name}` : p.metadata?.first_name || p.player_id || 'Unknown'; }
  async function loadFantasyPros(){
    if(state.fp) return state.fp;
    try { state.fp=await fetchJSON(`data/fantasypros-${CFG.season}.json?v=${Date.now()}`,8000); } catch { state.fp={status:'missing',players:[]}; }
    return state.fp;
  }
  function scoringCode(){
    const s=state.leagues.A?.scoring_settings||{}; const rec=Number(s.rec||0); return rec>=0.9?'ppr':rec>=0.4?'half':'std';
  }
  function fpIndex(){ const m=new Map(); for(const p of state.fp?.players||[]) m.set(fpKey(p.name,p.position),p); return m; }
  function matchFP(pick,index){ const name=sleeperPickName(pick), pos=pick.metadata?.position||''; let p=index.get(fpKey(name,pos)); if(p)return p; const n=normName(name); return [...index.values()].find(x=>normName(x.name)===n) || null; }
  function projPoints(fp,score){ return Number(fp?.[`points_${score}`] ?? fp?.points_half ?? fp?.points_ppr ?? fp?.points_std ?? 0); }
  function adp(fp,score){ return Number(fp?.[`adp_${score}`] ?? fp?.adp_half ?? fp?.adp_ppr ?? fp?.adp_std ?? 0) || null; }
  function ecr(fp,score){ return Number(fp?.[`ecr_${score}`] ?? fp?.ecr_half ?? fp?.ecr_ppr ?? fp?.ecr_std ?? 0) || null; }
  function draftComplete(d){ return d?.status==='complete'; }

  async function loadDraftData(){
    const [da,db,fp]=await Promise.allSettled([sleeper(`/league/${CFG.leagueA.id}/drafts`),sleeper(`/league/${CFG.leagueB.id}/drafts`),loadFantasyPros()]);
    state.drafts.A=da.status==='fulfilled'?(da.value||[]):[]; state.drafts.B=db.status==='fulfilled'?(db.value||[]):[];
    const currentDraft=(code)=>state.drafts[code].find(d=>String(d.season)===String(CFG.season))||state.drafts[code][0];
    const A=currentDraft('A'), B=currentDraft('B');
    if(A) state.picks.A=await sleeper(`/draft/${A.draft_id}/picks`).catch(()=>[]); if(B) state.picks.B=await sleeper(`/draft/${B.draft_id}/picks`).catch(()=>[]);
    const completeA=draftComplete(A), completeB=draftComplete(B);
    if(state.fp?.status!=='ready'||!(state.fp.players||[]).length){
      $('draftStatus').innerHTML=`<b>Draft grader armed.</b> ${completeA||completeB?'A draft is complete, but grading data is missing.':'Waiting for draft night.'} Generate the frozen FantasyPros snapshot before the drafts so grades can publish immediately.`;
      $('draftRankList').innerHTML='<div class="empty">FantasyPros grading snapshot is not ready yet.</div>'; return;
    }
    if(!completeA&&!completeB){
      $('draftStatus').innerHTML='<b>Draft grader armed.</b> Snapshot loaded. Each league publishes its own 1–10 grades immediately when its draft finishes; the combined 1–20 ranking unlocks after both drafts are complete.';
      $('draftRankList').innerHTML='<div class="empty">Waiting for the first BDI draft to finish.</div>'; return;
    }
    if(completeA&&completeB){
      state.draftGrades=calculateDraftGrades(A,B); renderDraftGrades('Overall BDI · 1–20');
      if(!(state.nfl?.season_type==='regular'&&Number(state.nfl.week)>1)) renderDraftBasedPower(); return;
    }
    const code=completeA?'A':'B';
    state.draftGrades=calculateDraftGrades(completeA?A:null,completeB?B:null);
    renderDraftGrades(`League ${code} · 1–10`, `League ${code} is complete. The overall BDI 1–20 ranking will publish after League ${code==='A'?'B':'A'} finishes.`);
  }
  function rosterSlots(){
    const pos=state.leagues.A?.roster_positions||[]; const counts={}; pos.forEach(x=>counts[x]=(counts[x]||0)+1); return counts;
  }
  function optimalLineup(players,slots){
    const used=new Set(); let total=0; const pickBest=(eligible,n=1)=>{for(let i=0;i<n;i++){let best=null;players.forEach((p,idx)=>{if(used.has(idx)||!eligible.includes(p.pos))return;if(!best||p.proj>best.p.proj)best={idx,p};});if(best){used.add(best.idx);total+=best.p.proj;}}};
    pickBest(['QB'],slots.QB||0); pickBest(['RB'],slots.RB||0); pickBest(['WR'],slots.WR||0); pickBest(['TE'],slots.TE||0); pickBest(['K'],slots.K||0); pickBest(['DST','DEF'],slots.DEF||slots.DST||0); pickBest(['RB','WR','TE'],slots.FLEX||0); pickBest(['QB','RB','WR','TE'],slots.SUPER_FLEX||0); return total;
  }
  function constructionScore(players,slots){
    const counts={}; players.forEach(p=>counts[p.pos]=(counts[p.pos]||0)+1); let score=100;
    const need=(pos,n)=>{if((counts[pos]||0)<n)score-=22*(n-(counts[pos]||0));}; need('QB',slots.QB||0);need('RB',slots.RB||0);need('WR',slots.WR||0);need('TE',slots.TE||0);
    const bench=Math.max(0,players.length-Object.values(slots).reduce((a,b)=>a+b,0)); if((counts.QB||0)>3&&!(slots.SUPER_FLEX))score-=5*((counts.QB||0)-3); if((counts.TE||0)>3)score-=4*((counts.TE||0)-3); if(bench>3&&((counts.RB||0)+(counts.WR||0))<Math.ceil(players.length*.55))score-=8; return clamp(score,45,100);
  }
  function zScores(values){const mean=values.reduce((a,b)=>a+b,0)/Math.max(1,values.length);const sd=Math.sqrt(values.reduce((s,x)=>s+(x-mean)**2,0)/Math.max(1,values.length))||1;return values.map(x=>(x-mean)/sd)}
  function letter(n){return n>=96?'A+':n>=92?'A':n>=89?'A-':n>=86?'B+':n>=82?'B':n>=79?'B-':n>=76?'C+':n>=72?'C':n>=69?'C-':n>=66?'D+':n>=62?'D':'F'}
  function componentGrade(pct){return letter(72+pct*.25)}
  function calculateDraftGrades(A,B){
    const idx=fpIndex(), score=scoringCode(), slots=rosterSlots(), entries=[];
    for(const code of ['A','B']){
      if((code==='A'&&!A)||(code==='B'&&!B)) continue;
      const picks=state.picks[code]||[]; const byRoster=new Map();
      picks.forEach(p=>{const fp=matchFP(p,idx);const obj={pick:p,fp,pos:p.metadata?.position||fp?.position||'',proj:projPoints(fp,score),adp:adp(fp,score),ecr:ecr(fp,score),overall:Number(p.pick_no||0),name:sleeperPickName(p)};const arr=byRoster.get(p.roster_id)||[];arr.push(obj);byRoster.set(p.roster_id,arr)});
      for(const [rid,players] of byRoster){ const team=state.teams.find(t=>t.code===code&&Number(t.rosterId)===Number(rid))||{name:`Roster ${rid}`,code}; const adpDeltas=players.filter(p=>p.adp).map(p=>p.adp-p.overall); const adpAvg=adpDeltas.reduce((a,b)=>a+b,0)/Math.max(1,adpDeltas.length); const projectionValue=players.reduce((s,p)=>s+p.proj/Math.sqrt(Math.max(1,p.overall)),0); const lineup=optimalLineup(players,slots); const construct=constructionScore(players,slots); entries.push({team,players,raw:{projectionValue,adpAvg,lineup,construct}}); }
    }
    const fields=['projectionValue','adpAvg','lineup']; const pct={}; fields.forEach(f=>{const vals=entries.map(e=>e.raw[f]);entries.forEach((e,i)=>{(pct[i]||(pct[i]={}))[f]=percentile(e.raw[f],vals)/100;});}); entries.forEach((e,i)=>(pct[i]||(pct[i]={})).construct=clamp((e.raw.construct-45)/55,0,1));
    const W=CFG.draftGradeWeights; entries.forEach((e,i)=>{const p=pct[i];e.composite=p.projectionValue*W.projectionValue+p.adpAvg*W.adpEfficiency+p.construct*W.rosterConstruction+p.lineup*W.lineupStrength;});
    const zs=zScores(entries.map(e=>e.composite)); entries.forEach((e,i)=>{e.score=clamp(82+zs[i]*7,62,98);e.letter=letter(e.score);e.components={projectionValue:componentGrade(pct[i].projectionValue),adpEfficiency:componentGrade(pct[i].adpAvg),rosterConstruction:componentGrade(pct[i].construct),lineupStrength:componentGrade(pct[i].lineup)}; const withAdp=e.players.filter(p=>p.adp); e.best=[...withAdp].sort((a,b)=>(b.adp-b.overall)-(a.adp-a.overall))[0]||e.players[0];e.reach=[...withAdp].sort((a,b)=>(a.adp-a.overall)-(b.adp-b.overall))[0]||e.players[e.players.length-1];e.mvp=[...e.players].sort((a,b)=>b.proj-a.proj)[0];});
    const posStrength={}; for(const pos of ['QB','RB','WR','TE']){const vals=entries.map(e=>e.players.filter(p=>p.pos===pos).reduce((s,p)=>s+p.proj,0)); entries.forEach((e,i)=>{(posStrength[i]||(posStrength[i]={}))[pos]=percentile(vals[i],vals);});}
    entries.forEach((e,i)=>{const ps=posStrength[i];e.strength=Object.entries(ps).sort((a,b)=>b[1]-a[1])[0]?.[0]||'Roster';e.weakness=Object.entries(ps).sort((a,b)=>a[1]-b[1])[0]?.[0]||'Depth';});
    return entries.sort((a,b)=>b.score-a.score).map((e,i)=>({...e,rank:i+1}));
  }
  function renderDraftGrades(scopeLabel='Overall BDI · 1–20', extra=''){
    $('draftStatus').innerHTML=`<b>${esc(scopeLabel)} grades published.</b> ${esc(extra)} Frozen FantasyPros snapshot: ${esc(state.fp.generated_at||'unknown date')} · scoring detected: ${scoringCode().toUpperCase()}.`;
    $('draftRankList').innerHTML=state.draftGrades.map(g=>`<article class="draft-rank-card" data-gradekey="${g.team.key}"><div class="place">#${g.rank}</div><div><h4>${esc(g.team.name)} <span class="league-pill">${g.team.code}</span></h4><p>Best pick: ${esc(g.best?.name||'—')} · Strength: ${esc(g.strength)}</p></div><div class="grade-big">${g.letter}</div></article>`).join('');
    document.querySelectorAll('[data-gradekey]').forEach(el=>el.addEventListener('click',()=>openDraftReport(el.dataset.gradekey)));
  }
  function stableHash(text){let h=2166136261;for(const ch of String(text)){h^=ch.charCodeAt(0);h=Math.imul(h,16777619)}return h>>>0}
  function deterministicPick(arr,key){return arr[stableHash(key)%arr.length]}
  function pickDelta(p){return p?.adp?Math.round(p.adp-p.overall):null}
  function pickBlurb(p,type){if(!p)return 'No qualifying pick available.';const d=pickDelta(p), slot=p.overall?`Pick ${p.overall}`:'this selection';
    if(type==='best'){
      if(d!=null&&d>=20)return `${slot} landed ${d} spots later than consensus. Apparently everyone else forgot ${p.name} existed.`;
      if(d!=null&&d>=8)return `${slot} beat consensus by ${d} picks. Nice patience, and the board actually rewarded it.`;
      return `${slot} paired solid market value with ${fmt(p.proj||0)} projected points.`;
    }
    if(type==='reach'){
      if(d!=null&&d<=-25)return `${Math.abs(d)} picks ahead of consensus. Bold is certainly one word for it.`;
      if(d!=null&&d<=-10)return `${Math.abs(d)} spots ahead of ADP. Consensus was apparently treated as more of a suggestion.`;
      return `The largest reach on the roster was relatively mild by draft-room standards.`;
    }
    if(type==='mvp')return `${fmt(p.proj||0)} projected points make this the roster's biggest projected scoring engine.`;
    return '';
  }
  function notablePicks(g){
    const out=[], used=new Set([g.best?.pick?.pick_no,g.reach?.pick?.pick_no,g.mvp?.pick?.pick_no].filter(Boolean));
    const add=(p,label,blurb)=>{if(!p||used.has(p.pick?.pick_no))return;used.add(p.pick.pick_no);out.push({p,label,blurb})};
    const withAdp=g.players.filter(p=>p.adp);
    const steal=[...withAdp].sort((a,b)=>(b.adp-b.overall)-(a.adp-a.overall))[0];
    if(steal&&pickDelta(steal)>=10)add(steal,'Value Pick',`Fell ${pickDelta(steal)} spots past ADP and still carries ${fmt(steal.proj||0)} projected points.`);
    const lateUpside=[...g.players].filter(p=>p.overall>60).sort((a,b)=>b.proj-a.proj)[0];
    add(lateUpside,'Upside Swing',`A later pick with ${fmt(lateUpside?.proj||0)} projected points gives this roster some real ceiling.`);
    const questionable=[...withAdp].filter(p=>pickDelta(p)<=-12).sort((a,b)=>pickDelta(a)-pickDelta(b))[1];
    add(questionable,'Questionable',`Went ${Math.abs(pickDelta(questionable)||0)} spots ahead of consensus. This one will get remembered either way.`);
    const efficient=[...g.players].filter(p=>p.overall>80).sort((a,b)=>(b.proj/Math.max(1,b.overall))-(a.proj/Math.max(1,a.overall)))[0];
    add(efficient,'Late-Round Value',`${fmt(efficient?.proj||0)} projected points from a late slot is the kind of boring value that wins waiver-free weeks.`);
    return out.slice(0,3);
  }
  function rosterCounts(g){const c={};g.players.forEach(p=>c[p.pos]=(c[p.pos]||0)+1);return c}
  function verdict(g){
    const n=state.draftGrades.length,c=rosterCounts(g),bestD=pickDelta(g.best),reachD=pickDelta(g.reach),key=`${g.team.key}-${g.letter}-${g.rank}`;
    const gradeBanks={
      'A+':['Annoyingly competent. There really is not much to make fun of here.','Great value, strong construction, and very few questionable decisions. Disgusting.','The draft room has reviewed the tape and unfortunately this was excellent.'],
      'A':['Excellent work. Please try harder to give the rest of us material next time.','Strong board discipline, strong roster, minimal nonsense. We hate to see it.'],
      'A-':['You knew what you were doing, which frankly takes some of the fun out of this.','Very good throughout, with just enough imperfection to remain technically human.'],
      'B+':['A good draft with just enough questionable decision-making to keep you humble.','Strong overall. Nobody needs to panic, including you.'],
      'B':['Perfectly respectable. Nobody is building a statue, but nobody is calling HR either.','Solid, sensible, and aggressively difficult to make fun of.'],
      'B-':['There is a good team in here. We just need to figure out where you hid it.','Above water, with a few spots that may require adult supervision.'],
      'C+':['Some steals, some reaches, and at least one pick we are going to need you to explain.','A mixed bag, but importantly still a bag.'],
      'C':['Congratulations on assembling a roster of professional football players.','Perfectly average, which is either reassuring or deeply insulting depending on your expectations.'],
      'C-':['The projections say there is a plan here. We remain committed to finding it.','Concerning in places, interesting in others, definitive in none.'],
      'D+':['A few good picks are doing an impressive amount of structural work.','There are building blocks here. Several of them are currently holding up the entire building.'],
      'D':['The draft room was open the entire time, just confirming.','There were warning signs. Then there were more warning signs.'],
      'D-':['FantasyPros has filed a formal objection.','The good news is waivers open soon.'],
      'F':['We checked the API twice because this grade seemed unnecessarily cruel.','You have successfully demonstrated why autodraft exists.','There were other draft strategies available.']
    };
    let opener=deterministicPick(gradeBanks[g.letter]||gradeBanks.C,key);
    const reasons=[];
    if((c.QB||0)>=4&&!rosterSlots().SUPER_FLEX)reasons.push(`${c.QB} quarterbacks for one starting QB slot is an admirably aggressive commitment to optionality.`);
    if((c.TE||0)>=4)reasons.push(`${c.TE} tight ends suggests either a strategy or an unresolved personal issue.`);
    if(bestD!=null&&bestD>=15)reasons.push(`${g.best.name} falling ${bestD} spots past ADP was the clearest win.`);
    if(reachD!=null&&reachD<=-18)reasons.push(`${g.reach.name} went ${Math.abs(reachD)} picks ahead of consensus and will require some explaining.`);
    reasons.push(`${g.strength} is the roster's strongest room; ${g.weakness} is where the depth chart gets less comfortable.`);
    if(g.rank===1)reasons.push('Congratulations on winning the portion of fantasy football that famously guarantees absolutely nothing.');
    if(g.rank===n&&n>1)reasons.push('Someone had to finish last. We appreciate your service.');
    return `${opener} ${reasons.slice(0,3).join(' ')}`;
  }
  function openDraftReport(key){
    const g=state.draftGrades.find(x=>x.team.key===key);if(!g)return;
    const bestD=pickDelta(g.best), reachD=pickDelta(g.reach), talks=notablePicks(g);
    const talksHtml=talks.length?`<div class="notable-block"><h5>👀 Picks Worth Talking About</h5><div class="notable-list">${talks.map(x=>`<div class="notable-pick"><b>${esc(x.label)} · ${esc(x.p.name)}</b><span>Pick ${x.p.overall}${x.p.adp?` · ADP ${Math.round(x.p.adp)}`:''}</span><p>${esc(x.blurb)}</p></div>`).join('')}</div></div>`:'';
    const rankTitle=g.rank===1?' · 🏆 Internet Champion':g.rank===state.draftGrades.length&&state.draftGrades.length>1?' · 🪦 Draft Day Disaster':'';
    openModal(`${g.team.name} · ${g.letter} · #${g.rank} of ${state.draftGrades.length}${rankTitle}`,`<div class="report-grid"><div class="metric"><b>${g.components.projectionValue}</b><span>Draft value</span></div><div class="metric"><b>${g.components.adpEfficiency}</b><span>ADP efficiency</span></div><div class="metric"><b>${g.components.rosterConstruction}</b><span>Roster construction</span></div><div class="metric"><b>${g.components.lineupStrength}</b><span>Projected strength</span></div></div><div class="callout-grid"><div class="callout"><h5>🔥 Best Pick</h5><p><b>${esc(g.best?.name||'—')}</b> ${bestD!=null?`· ${bestD>=0?'+':''}${bestD} picks vs ADP`:''}<br>${esc(pickBlurb(g.best,'best'))}</p></div><div class="callout"><h5>😬 Biggest Reach</h5><p><b>${esc(g.reach?.name||'—')}</b> ${reachD!=null?`· ${reachD>=0?'+':''}${reachD} picks vs ADP`:''}<br>${esc(pickBlurb(g.reach,'reach'))}</p></div><div class="callout"><h5>💪 Strength</h5><p>${esc(g.strength)} room grades strongest relative to the BDI field.</p></div><div class="callout"><h5>⚠️ Weakness</h5><p>${esc(g.weakness)} room grades weakest relative to peers.</p></div><div class="callout"><h5>🎯 Draft MVP</h5><p><b>${esc(g.mvp?.name||'—')}</b><br>${esc(pickBlurb(g.mvp,'mvp'))}</p></div><div class="callout verdict-callout"><h5>📝 Official BDI Verdict</h5><p>${esc(verdict(g))}</p></div></div>${talksHtml}<div class="grade-disclaimer">BDI Draft Grades use frozen consensus redraft rankings, ADP, projections and roster construction to scientifically determine who won fantasy football before any football has been played. Results are therefore unquestionably final.</div>`);
  }

  function openModal(title,body){$('modalTitle').textContent=title;$('modalBody').innerHTML=body;$('modal').classList.add('open')}
  function closeModal(){$('modal').classList.remove('open')}
  function playoffWeek(){
    if(state.nfl?.season_type!=='regular') return 0;
    return Number(state.nfl?.week||0);
  }
  function currentQualifiers(){
    const a=sortStandings(state.teams.filter(t=>t.code==='A')).slice(0,4);
    const b=sortStandings(state.teams.filter(t=>t.code==='B')).slice(0,4);
    return [...a,...b];
  }
  function renderRegularPlayoffPicture(){
    const a=sortStandings(state.teams.filter(t=>t.code==='A'));
    const b=sortStandings(state.teams.filter(t=>t.code==='B'));
    const leagueBlock=(code,rows)=>`<div class="playoff-league"><div class="playoff-league-head"><b>League ${code}</b><span>Top 4 qualify</span></div>${rows.map((t,i)=>`<div class="playoff-team-row ${i<4?'in':'bubble'}"><span class="seed">${i+1}</span><div><b>${esc(t.name)}</b><small>${t.wins}-${t.losses} · ${fmt(t.pf)} PF</small></div><span class="playoff-status">${i<4?'IN':'OUT'}</span></div>`).join('')}</div>`;
    $('playoffPictureTitle').textContent='Current Playoff Teams';
    $('playoffPictureSub').textContent='Top four in each league qualify';
    $('playoffPicture').innerHTML=`<div class="playoff-picture-grid">${leagueBlock('A',a)}${leagueBlock('B',b)}</div>`;
    $('playoffLiveTitle').textContent='Road to the Championship';
    $('playoffLiveSub').textContent='Live scoring activates in Week 15';
    $('playoffLiveBadge').textContent='WEEKS 15–17';
    $('playoffLiveBoard').innerHTML='<div class="empty">Once the playoffs begin, this becomes the live cut-line leaderboard.</div>';
  }
  async function matchupScoresForWeek(week){
    const [a,b]=await Promise.allSettled([sleeper(`/league/${CFG.leagueA.id}/matchups/${week}`),sleeper(`/league/${CFG.leagueB.id}/matchups/${week}`)]);
    const rows=[];
    for(const [code,res] of [['A',a],['B',b]]) if(res.status==='fulfilled'){
      const teamMap=new Map(state.teams.filter(t=>t.code===code).map(t=>[t.rosterId,t]));
      for(const m of res.value||[]){ const team=teamMap.get(m.roster_id); if(team) rows.push({team,score:Number(m.points||0)}); }
    }
    return rows;
  }
  async function determinePlayoffField(){
    // Qualification is based on the official top four from each league. During the postseason,
    // Sleeper's roster standings remain the source of truth for the regular-season finish.
    return currentQualifiers();
  }
  function liveBoardHTML(rows,advanceCount,label){
    const sorted=[...rows].sort((a,b)=>b.score-a.score);
    return `<div class="survivor-board">${sorted.map((x,i)=>`${i===advanceCount?'<div class="cut-line"><span>CUT LINE</span></div>':''}<div class="survivor-row ${i<advanceCount?'advancing':'eliminated'}"><span class="survivor-rank">${i+1}</span><div><b>${esc(x.team.name)}</b><small>League ${x.team.code}</small></div><strong>${fmt(x.score,2)}</strong><span class="survivor-state">${i<advanceCount?'ADVANCING':'OUT'}</span></div>`).join('')}</div><div class="survivor-note">${esc(label)}</div>`;
  }
  async function renderPlayoffs(){
    const wk=playoffWeek();
    if(!wk || wk<15){ renderRegularPlayoffPicture(); return; }
    const field=await determinePlayoffField();
    const keySet=new Set(field.map(t=>t.key));
    $('playoffPictureTitle').textContent='2026 BDI Playoff Field';
    $('playoffPictureSub').textContent='Top four from League A + top four from League B';
    $('playoffPicture').innerHTML=`<div class="qualified-chips">${field.map(t=>`<span><b>${esc(t.name)}</b><small>League ${t.code}</small></span>`).join('')}</div>`;
    try{
      const w15=(await matchupScoresForWeek(15)).filter(x=>keySet.has(x.team.key)).sort((a,b)=>b.score-a.score);
      const survivors15=w15.slice(0,4).map(x=>x.team.key);
      if(wk===15){
        $('playoffLiveTitle').textContent='Week 15 · Elite Eight'; $('playoffLiveSub').textContent='Top 4 scores advance'; $('playoffLiveBadge').textContent='LIVE';
        $('playoffLiveBoard').innerHTML=liveBoardHTML(w15,4,'Eight teams entered. The four highest Week 15 scores survive.'); return;
      }
      const w16=(await matchupScoresForWeek(16)).filter(x=>survivors15.includes(x.team.key)).sort((a,b)=>b.score-a.score);
      const survivors16=w16.slice(0,2).map(x=>x.team.key);
      if(wk===16){
        $('playoffLiveTitle').textContent='Week 16 · Final Four'; $('playoffLiveSub').textContent='Top 2 scores advance'; $('playoffLiveBadge').textContent='LIVE';
        $('playoffLiveBoard').innerHTML=liveBoardHTML(w16,2,'Four remain. The two highest Week 16 scores reach the BDI Championship.'); return;
      }
      const w17=(await matchupScoresForWeek(17)).filter(x=>survivors16.includes(x.team.key)).sort((a,b)=>b.score-a.score);
      $('playoffLiveTitle').textContent='Week 17 · BDI Championship'; $('playoffLiveSub').textContent='Highest score wins'; $('playoffLiveBadge').textContent='CHAMPIONSHIP';
      if(w17.length){
        const html=liveBoardHTML(w17,1,'One week. Two finalists. Highest score is the BDI Champion.');
        $('playoffLiveBoard').innerHTML=html + (w17[0].score>0?`<div class="champion-callout"><span>🏆</span><div><small>Current Championship Leader</small><b>${esc(w17[0].team.name)}</b></div></div>`:'');
      } else $('playoffLiveBoard').innerHTML='<div class="empty">Championship scoring will appear here when Week 17 begins.</div>';
    }catch(e){ console.error('Playoff leaderboard',e); $('playoffLiveBoard').innerHTML='<div class="empty">Playoff scoring is temporarily unavailable. Refresh to retry.</div>'; }
  }

  function showView(name){document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${name}`));document.querySelectorAll('.nav button').forEach(b=>b.classList.toggle('active',b.dataset.view===name));if(name==='activity')openActivity();if(name==='playoffs')renderPlayoffs();}

  document.querySelectorAll('.nav button').forEach(b=>b.addEventListener('click',()=>showView(b.dataset.view)));
  document.querySelectorAll('[data-teamfilter]').forEach(b=>b.addEventListener('click',()=>{state.teamFilter=b.dataset.teamfilter;document.querySelectorAll('[data-teamfilter]').forEach(x=>x.classList.toggle('active',x===b));renderTeams();}));
  document.querySelectorAll('[data-activityfilter]').forEach(b=>b.addEventListener('click',()=>{state.activityFilter=b.dataset.activityfilter;document.querySelectorAll('[data-activityfilter]').forEach(x=>x.classList.toggle('active',x===b));renderFilteredActivity();}));
  $('activityWeek').addEventListener('change',openActivity);$('modalClose').addEventListener('click',closeModal);$('modal').addEventListener('click',e=>{if(e.target===$('modal'))closeModal()});document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal()});
  loadBase();
})();
