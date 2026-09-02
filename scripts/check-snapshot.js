const d = require(process.cwd() + '/data/fantasypros-2026.json');
const rank = p => p.adp_ppr ?? p.adp_half ?? p.adp_std;
const pts  = p => p.points_ppr ?? p.points_half ?? p.points_std;
const ranked = d.players.filter(p => rank(p) != null).sort((a,b) => rank(a)-rank(b));

console.log(`snapshot ${d.generated_at} · ${d.players.length} players · benchmark ${d.fields_used.adp_field}`);
for (const n of [100, 200, 300]) {
  const top = ranked.slice(0, n);
  const missing = top.filter(p => !pts(p));
  console.log(`  top ${n} by rank: ${n - missing.length}/${n} have projections` +
    (missing.length ? ` — missing ${missing.slice(0,5).map(p=>p.name).join(', ')}` : ''));
}
for (const pos of ['QB','RB','WR','TE','K','DST']) {
  const at = ranked.filter(p => p.position === pos).slice(0, 32);
  const ok = at.filter(p => pts(p)).length;
  console.log(`  ${pos.padEnd(3)} top ${String(at.length).padStart(2)}: ${ok} projected` + (ok < at.length ? '   <-- gap' : ''));
}
