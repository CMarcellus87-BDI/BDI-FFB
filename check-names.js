const LEAGUES = [['A','1398722946876309504'],['B','1398724315200913408']];
const API = 'https://api.sleeper.app/v1';
const get = async p => (await fetch(`${API}${p}`)).json();
for (const [code, id] of LEAGUES) {
  const drafts = await get(`/league/${id}/drafts`);
  const draft = drafts.find(d => String(d.season) === '2026') || drafts[0];
  if (!draft) { console.log(`League ${code}: no draft found`); continue; }
  const [full, rosters, users] = await Promise.all([
    get(`/draft/${draft.draft_id}`), get(`/league/${id}/rosters`), get(`/league/${id}/users`)]);
  const byUser = Object.fromEntries(users.map(u => [u.user_id, u]));
  const name = r => { const u = byUser[r.owner_id];
    return (u?.metadata?.team_name || u?.display_name || u?.username || null); };
  const map = full.slot_to_roster_id || {};
  console.log(`\nLeague ${code}  draft ${draft.draft_id}  status ${draft.status}`);
  console.log(`  slot_to_roster_id entries: ${Object.keys(map).length} (expect 10)`);
  let unnamed = 0;
  for (const slot of Object.keys(map).sort((a,b) => a-b)) {
    const rid = map[slot];
    const roster = rosters.find(r => Number(r.roster_id) === Number(rid));
    const label = roster ? name(roster) : null;
    if (!label) unnamed++;
    console.log(`    slot ${String(slot).padStart(2)} -> roster ${String(rid).padStart(2)}  ${label || "*** NO NAME ***"}`);
  }
  console.log(unnamed ? `  ${unnamed} slot(s) would grade as "Roster N"` : "  every slot resolves to a real team name");
}
