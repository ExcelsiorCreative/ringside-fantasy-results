// Builds migrations/seed.sql from the three CSVs in data/seed/.
// Run: node scripts/seed.ts   then: npx wrangler d1 execute ringside --remote --file=seed/seed.sql
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { nameKey, wrestlerId, slug, autoAliases } from '../src/shared/normalize.ts';

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []; let row: string[] = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const [head, ...body] = rows.filter(r => r.some(x => x.trim()));
  return body.map(r => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

const sq = (v: unknown) => v === null || v === undefined || v === '' ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
const num = (v: string) => (v === '' ? null : Number(v));

function asOfIso(s: string): string { // "Oct 2, 2026" -> 2026-10-02
  const d = new Date(s + ' 12:00 UTC');
  return isNaN(+d) ? '2026-10-02' : d.toISOString().slice(0, 10);
}

export function buildSeed(dir: string): { sql: string; report: string[] } {
  const players = parseCsv(readFileSync(`${dir}/ringside_players.csv`, 'utf8'));
  const champs = parseCsv(readFileSync(`${dir}/ringside_championships.csv`, 'utf8'));
  const rules = parseCsv(readFileSync(`${dir}/ringside_scoring_rules.csv`, 'utf8'));
  const out: string[] = []; const report: string[] = [];
  const ids = new Map<string, string>(); const aliasTaken = new Map<string, string>();

  for (const p of players) {
    const id = wrestlerId(p.player_name); ids.set(nameKey(p.player_name), id);
    const asOf = asOfIso(p.news_as_of || 'Oct 2, 2026');
    out.push(`INSERT INTO wrestlers(id,name,name_search,promotion,gender,active,overall_rank,rank_in_gender,baseline_2026_wins,baseline_2026_losses,baseline_career_wins,baseline_career_losses,baseline_as_of) VALUES(${[id, p.player_name, nameKey(p.player_name), p.promotion, p.gender === 'Women' ? 'W' : 'M', 1, num(p.overall_rank), num(p.rank_in_gender), num(p.record_2026_wins), num(p.record_2026_losses), num(p.career_wins), num(p.career_losses), asOf].map(sq).join(',')});`);
    for (const a of autoAliases(p.player_name)) {
      if (aliasTaken.has(a) && aliasTaken.get(a) !== id) { report.push(`Alias "${a}" is shared by ${aliasTaken.get(a)} and ${id}; kept the first.`); continue; }
      if (aliasTaken.has(a)) continue;
      aliasTaken.set(a, id); out.push(`INSERT INTO aliases(alias_search,alias,wrestler_id,source) VALUES(${[a, a, id, 'seed'].map(sq).join(',')});`);
    }
    if (p.injured === 'yes') out.push(`INSERT INTO status_entries(id,wrestler_id,kind,note,started_on,source) VALUES(${[`st_${id}_inj`, id, 'injured', p.injury_note, asOf, 'seed'].map(sq).join(',')});`);
    if (p.away_out === 'yes') out.push(`INSERT INTO status_entries(id,wrestler_id,kind,note,started_on,source) VALUES(${[`st_${id}_away`, id, /suspend/i.test(p.away_note) ? 'suspended' : 'away', p.away_note || 'Away', asOf, 'seed'].map(sq).join(',')});`);
    if (p.news) out.push(`INSERT INTO news_items(id,wrestler_id,text,as_of,kind) VALUES(${[`nw_${id}_seed`, id, p.news, asOf, 'imported'].map(sq).join(',')});`);
    // report computed win % differences
    const w = num(p.career_wins) ?? num(p.record_2026_wins), l = num(p.career_losses) ?? num(p.record_2026_losses);
    if (w != null && l != null && p.win_pct) { const calc = Math.round(100 * w / (w + l || 1)); const file = parseInt(p.win_pct); if (Math.abs(calc - file) > 1) report.push(`${p.player_name}: file says ${p.win_pct}, record works out to ${calc}%.`); }
    out.push(`INSERT INTO change_log(entity,entity_id,action) VALUES('wrestler',${sq(id)},'upsert');`);
  }

  // championships: one row per title, holders grouped
  const byTitle = new Map<string, { promo: string; gender: string; holders: string[] }>();
  for (const c of champs) {
    const t = byTitle.get(c.championship) || { promo: c.promotion, gender: c.gender === 'Women' ? 'W' : 'M', holders: [] };
    t.holders.push(c.current_holder); byTitle.set(c.championship, t);
  }
  for (const [name, t] of byTitle) {
    const cid = 'c_' + slug(name); const rid = `r_${cid}_seed`;
    out.push(`INSERT INTO championships(id,name,name_search,promotion,gender,holders_per_reign) VALUES(${[cid, name, nameKey(name), t.promo, t.gender, t.holders.length].map(sq).join(',')});`);
    out.push(`INSERT INTO reigns(id,championship_id,started_on,source) VALUES(${[rid, cid, null, 'seed (as of Oct 2, 2026)'].map(sq).join(',')});`);
    for (const h of t.holders) {
      const wid = ids.get(nameKey(h));
      if (!wid) { report.push(`Champion "${h}" (${name}) is not in the players file.`); continue; }
      out.push(`INSERT INTO reign_holders(reign_id,wrestler_id) VALUES(${sq(rid)},${sq(wid)});`);
    }
    out.push(`INSERT INTO change_log(entity,entity_id,action) VALUES('championship',${sq(cid)},'upsert');`);
  }
  // cross-check is_champion in the players file
  const holderSet = new Set(champs.map(c => nameKey(c.current_holder)));
  for (const p of players) {
    if (p.is_champion === 'yes' && !holderSet.has(nameKey(p.player_name))) report.push(`${p.player_name} is marked champion but holds nothing in the championships file.`);
    if (p.is_champion !== 'yes' && holderSet.has(nameKey(p.player_name))) report.push(`${p.player_name} holds a tag/trios title: counted as an individual champion (the players file said no).`);
  }
  // scoring rules: every event key needs a fact field
  const covered: Record<string, string> = { win: 'result=win', main: 'is_main_event', title: 'title_outcome=changed', def: 'title_outcome=retained', tl: 'title_outcome=changed (losing holder)', qual: 'is_qualifier', loss: 'result=loss', dq: 'lost_by_dq_or_interference', elim: 'rumble_eliminations', p3: 'rumble_place', p2: 'rumble_place', p1: 'rumble_place', ce: 'chamber_entered', cx: 'chamber_eliminations', cw: 'chamber winner (result=win)', mi: 'mitb_entered', mw: 'MITB winner (result=win)', cs: 'cash_ins.success', cf: 'cash_ins.success=0' };
  for (const r of rules) if (!covered[r.event_key]) report.push(`Scoring event "${r.event_key}" has no fact field.`);
  report.unshift(`${players.length} wrestlers, ${byTitle.size} championships, ${rules.length} scoring rules checked (all ${rules.filter(r => covered[r.event_key]).length} covered).`);
  return { sql: out.join('\n') + '\n', report };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { sql, report } = buildSeed('data/seed');
  mkdirSync('seed', { recursive: true });
  writeFileSync('seed/seed.sql', sql);
  writeFileSync('seed/import-report.txt', report.join('\n') + '\n');
  console.log(report.join('\n'));
  console.log(`\nWrote seed/seed.sql (${sql.split('\n').length - 1} statements).`);
}
