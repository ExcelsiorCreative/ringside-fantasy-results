// Applies batches from the runner to D1: validate, publish or hold, title lineage, injuries, auto news.
import type { IngestBatch, LookupData, ParsedMatch, ParsedShow, TitleHolderFact } from './types.ts';
import { validateMatch } from './validate.ts';
import { contentHash } from './normalize.ts';

const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const BASE_DATE_DEFAULT = '2026-10-02'; // the "as of" date of the seed files

export async function lookup(db: D1Database, sinceDays = 400): Promise<LookupData> {
  const [aliases, names, stables, champs, holders, shows, cfg] = await db.batch([
    db.prepare('SELECT alias_search, wrestler_id FROM aliases'),
    db.prepare('SELECT id, name FROM wrestlers WHERE deleted_at IS NULL'),
    db.prepare(`SELECT s.name_search, group_concat(m.wrestler_id) AS members FROM stables s JOIN stable_members m ON m.stable_id=s.id WHERE m.left_on IS NULL GROUP BY s.id`),
    db.prepare('SELECT id, name, name_search, promotion, gender, holders_per_reign, wiki_page FROM championships WHERE active=1'),
    db.prepare('SELECT r.championship_id, h.wrestler_id FROM reigns r JOIN reign_holders h ON h.reign_id=r.id WHERE r.ended_on IS NULL'),
    db.prepare(`SELECT id, content_hash FROM shows WHERE date >= date('now', ?)`).bind(`-${sinceDays} days`),
    db.prepare('SELECT key, value FROM config'),
  ]);
  const hmap = new Map<string, string[]>();
  (holders.results as { championship_id: string; wrestler_id: string }[]).forEach(r => hmap.set(r.championship_id, [...(hmap.get(r.championship_id) || []), r.wrestler_id]));
  return {
    aliases: (aliases.results as { alias_search: string; wrestler_id: string }[]).map(r => [r.alias_search, r.wrestler_id]),
    names: Object.fromEntries((names.results as { id: string; name: string }[]).map(r => [r.id, r.name])),
    stables: (stables.results as { name_search: string; members: string }[]).map(r => ({ name_search: r.name_search, members: (r.members || '').split(',') })),
    championships: (champs.results as LookupData['championships']).map(c => ({ ...c, holders: hmap.get(c.id) || [] })),
    show_hashes: Object.fromEntries((shows.results as { id: string; content_hash: string }[]).map(r => [r.id, r.content_hash])),
    config: Object.fromEntries((cfg.results as { key: string; value: string }[]).map(r => [r.key, r.value])),
  };
}

async function holdersAt(db: D1Database, championshipId: string, date: string): Promise<{ holders: string[]; hpr: number } | null> {
  const c = await db.prepare('SELECT holders_per_reign FROM championships WHERE id=?').bind(championshipId).first<{ holders_per_reign: number }>();
  if (!c) return null;
  const r = await db.prepare(`SELECT id FROM reigns WHERE championship_id=? AND COALESCE(started_on, ?) <= ? AND (ended_on IS NULL OR ended_on > ?) ORDER BY COALESCE(started_on,'') DESC LIMIT 1`)
    .bind(championshipId, BASE_DATE_DEFAULT, date, date).first<{ id: string }>();
  if (!r) return null; // before our history starts: can't check, so don't
  const h = await db.prepare('SELECT wrestler_id FROM reign_holders WHERE reign_id=?').bind(r.id).all<{ wrestler_id: string }>();
  return { holders: h.results.map(x => x.wrestler_id), hpr: c.holders_per_reign };
}

/** Rebuild a title's reigns from its base reign plus every published title change after it (handles corrections). */
export async function rebuildLineage(db: D1Database, championshipId: string): Promise<number> {
  const base = await db.prepare(`SELECT id, COALESCE(started_on, ?) AS d FROM reigns WHERE championship_id=? AND source!='match' ORDER BY COALESCE(started_on,'') DESC LIMIT 1`)
    .bind(BASE_DATE_DEFAULT, championshipId).first<{ id: string; d: string }>();
  if (!base) return 0;
  const derived = await db.prepare(`SELECT id FROM reigns WHERE championship_id=? AND source='match'`).bind(championshipId).all<{ id: string }>();
  const stmts: D1PreparedStatement[] = [];
  derived.results.forEach(r => { stmts.push(db.prepare('DELETE FROM reign_holders WHERE reign_id=?').bind(r.id)); stmts.push(db.prepare('DELETE FROM reigns WHERE id=?').bind(r.id)); });
  stmts.push(db.prepare('UPDATE reigns SET ended_on=NULL, ended_match_id=NULL WHERE id=?').bind(base.id));
  const changes = await db.prepare(`SELECT m.id, s.date FROM matches m JOIN shows s ON s.id=m.show_id
    WHERE m.title_championship_id=? AND m.status='published' AND m.title_outcome='changed' AND m.deleted_at IS NULL AND s.date > ? ORDER BY s.date, m.match_number`)
    .bind(championshipId, base.d).all<{ id: string; date: string }>();
  let open = base.id;
  for (const ch of changes.results) {
    const winners = await db.prepare(`SELECT wrestler_id FROM match_participants WHERE match_id=? AND result='win'`).bind(ch.id).all<{ wrestler_id: string }>();
    const rid = `r_${ch.id}`;
    stmts.push(db.prepare('UPDATE reigns SET ended_on=?, ended_match_id=? WHERE id=?').bind(ch.date, ch.id, open));
    stmts.push(db.prepare(`INSERT INTO reigns(id,championship_id,started_on,started_match_id,source) VALUES(?,?,?,?,'match')`).bind(rid, championshipId, ch.date, ch.id));
    winners.results.forEach(w => stmts.push(db.prepare('INSERT INTO reign_holders(reign_id,wrestler_id) VALUES(?,?)').bind(rid, w.wrestler_id)));
    open = rid;
  }
  stmts.push(db.prepare(`UPDATE championships SET updated_at=?, version=version+1 WHERE id=?`).bind(now(), championshipId));
  stmts.push(db.prepare(`INSERT INTO change_log(entity,entity_id,action) VALUES('championship',?,'upsert')`).bind(championshipId));
  await db.batch(stmts);
  return stmts.length;
}

function matchHash(m: ParsedMatch): string {
  return contentHash(JSON.stringify([m.raw_text, m.stipulation, m.match_type, m.finish, m.title_outcome, m.title_championship_id, m.is_main_event, m.pre_show,
    m.participants.map(p => [p.raw, p.wrestler_id, p.side, p.result, p.champion_going_in, p.rumble_place, p.rumble_eliminations])]));
}

function newsLine(m: ParsedMatch, showName: string, date: string, pid: string, title: string | null): string | null {
  const me = m.participants.find(p => p.wrestler_id === pid); if (!me) return null;
  const opp = m.participants.filter(p => p.side !== me.side).map(p => p.raw);
  const vs = opp.length > 3 ? `${opp.slice(0, 3).join(', ')} and others` : opp.join(', ').replace(/, ([^,]*)$/, ' and $1');
  const d = new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  if (me.result === 'win' && m.title_outcome === 'changed' && title) return `Won the ${title} from ${vs} at ${showName} (${d}).`;
  if (me.result === 'win' && m.title_outcome === 'retained' && title) return `Retained the ${title} against ${vs} at ${showName} (${d}).`;
  if (me.result === 'loss' && m.title_outcome === 'changed' && title && me.champion_going_in) return `Lost the ${title} to ${vs} at ${showName} (${d}).`;
  if (me.result === 'win') return `Beat ${vs} at ${showName} (${d}).`;
  if (me.result === 'loss') return `Lost to ${vs} at ${showName} (${d}).`;
  return `${m.finish === 'draw' ? 'Drew with' : 'Went to a no contest with'} ${vs} at ${showName} (${d}).`;
}

export async function applyShow(db: D1Database, s: ParsedShow, cfg: Record<string, string>): Promise<{ newM: number; changed: number; held: number; writes: number; titles: Set<string> }> {
  const showId = `${s.source}:${s.source_event_id}`;
  const stats = { newM: 0, changed: 0, held: 0, writes: 0, titles: new Set<string>() };
  const existing = await db.prepare('SELECT content_hash, version FROM shows WHERE id=?').bind(showId).first<{ content_hash: string; version: number }>();
  if (existing && existing.content_hash === s.content_hash) return stats;
  const ts = now(); const stmts: D1PreparedStatement[] = [];
  stmts.push(db.prepare(`INSERT INTO shows(id,promotion,name,show_type,date,local_start_time,time_zone,status,confidence,source,source_url,source_event_id,content_hash,hold_reason)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET promotion=excluded.promotion,name=excluded.name,show_type=excluded.show_type,date=excluded.date,
    local_start_time=excluded.local_start_time,time_zone=excluded.time_zone,status=excluded.status,source_url=excluded.source_url,content_hash=excluded.content_hash,
    hold_reason=excluded.hold_reason,updated_at=?,version=shows.version+1`)
    .bind(showId, s.promotion, s.name, s.show_type, s.date, s.local_start_time, s.time_zone, s.problems.length ? 'held' : 'published', 1, s.source, s.source_url, s.source_event_id, s.content_hash, s.problems.join('; ') || null, ts));
  stmts.push(db.prepare(`INSERT INTO change_log(entity,entity_id,action) VALUES('show',?,'upsert')`).bind(showId));

  const prev = await db.prepare('SELECT id, content_hash, status, first_held_at, title_championship_id FROM matches WHERE show_id=?').bind(showId).all<{ id: string; content_hash: string; status: string; first_held_at: string | null; title_championship_id: string | null }>();
  const prevMap = new Map(prev.results.map(r => [r.id, r]));
  const retry = +(cfg['hold_retry_days'] || 14);
  const titleNames = new Map<string, string>();

  for (const m of s.matches) {
    const mid = `${showId}:${m.match_number}`; const h = matchHash(m); const old = prevMap.get(mid); prevMap.delete(mid);
    if (old && old.content_hash === h && old.status === 'published') continue;
    let ctx = null;
    if (m.title_championship_id) { const at = await holdersAt(db, m.title_championship_id, s.date); if (at) ctx = { holders: at.holders, holders_per_reign: at.hpr }; }
    const problems = s.problems.length ? s.problems.concat(validateMatch(m, ctx)) : validateMatch(m, ctx);
    const firstHeld = problems.length ? (old?.first_held_at || ts) : null;
    const expired = firstHeld && (Date.now() - Date.parse(firstHeld)) / 864e5 > retry;
    const status = problems.length ? (expired ? 'expired' : 'held') : 'published';
    if (status !== 'published') stats.held++; else if (old) stats.changed++; else stats.newM++;
    stmts.push(db.prepare(`INSERT INTO matches(id,show_id,match_number,is_main_event,pre_show,match_type,stipulation,is_qualifier,is_tournament,finish,title_championship_id,title_outcome,status,confidence,hold_reason,first_held_at,raw_text,source_url,content_hash)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET is_main_event=excluded.is_main_event,pre_show=excluded.pre_show,match_type=excluded.match_type,stipulation=excluded.stipulation,
      is_qualifier=excluded.is_qualifier,is_tournament=excluded.is_tournament,finish=excluded.finish,title_championship_id=excluded.title_championship_id,title_outcome=excluded.title_outcome,status=excluded.status,
      confidence=excluded.confidence,hold_reason=excluded.hold_reason,first_held_at=excluded.first_held_at,raw_text=excluded.raw_text,source_url=excluded.source_url,content_hash=excluded.content_hash,deleted_at=NULL,updated_at=?,version=matches.version+1`)
      .bind(mid, showId, m.match_number, +m.is_main_event, +m.pre_show, m.match_type, m.stipulation, +m.is_qualifier, +m.is_tournament, m.finish, m.title_championship_id || null, m.title_outcome, status,
        problems.length ? Math.min(m.confidence, 0.5) : m.confidence, problems.join('; ') || null, firstHeld, m.raw_text, s.source_url, h, ts));
    stmts.push(db.prepare('DELETE FROM match_participants WHERE match_id=?').bind(mid));
    for (const p of m.participants) {
      stmts.push(db.prepare(`INSERT OR REPLACE INTO match_participants(match_id,wrestler_id,raw_name,side,result,champion_going_in,lost_by_dq_or_interference,rumble_entry,rumble_eliminations,rumble_place,chamber_entered,chamber_eliminations,mitb_entered)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(mid, p.wrestler_id || null, p.raw, p.side, p.result, +!!p.champion_going_in, +!!p.lost_by_dq_or_interference, p.rumble_entry ?? null, p.rumble_eliminations ?? null, p.rumble_place ?? null, +!!p.chamber_entered, null, +!!p.mitb_entered));
    }
    stmts.push(db.prepare(`INSERT INTO change_log(entity,entity_id,action) VALUES('match',?,'upsert')`).bind(mid));
    if (m.title_championship_id && (m.title_outcome === 'changed' || old?.title_championship_id)) stats.titles.add(m.title_championship_id);
    if (old?.title_championship_id && old.title_championship_id !== m.title_championship_id) stats.titles.add(old.title_championship_id);

    if (status === 'published') {
      const ids = m.participants.map(p => p.wrestler_id!).filter(Boolean);
      // Back from injury/absence: close open statuses that started before this show
      for (const id of ids) {
        stmts.push(db.prepare(`UPDATE status_entries SET ended_on=?, ended_reason='appeared in a match', updated_at=? WHERE wrestler_id=? AND ended_on IS NULL AND kind IN ('injured','away','suspended') AND COALESCE(started_on,'') < ?`).bind(s.date, ts, id, s.date));
        let title: string | null = null;
        if (m.title_championship_id) { title = titleNames.get(m.title_championship_id) ?? null; if (!title) { const c = await db.prepare('SELECT name FROM championships WHERE id=?').bind(m.title_championship_id).first<{ name: string }>(); title = c?.name ?? null; if (title) titleNames.set(m.title_championship_id, title); } }
        const line = newsLine(m, s.name, s.date, id, title);
        if (line) stmts.push(db.prepare(`INSERT OR REPLACE INTO news_items(id,wrestler_id,text,as_of,kind) VALUES(?,?,?,?,'auto')`).bind(`nw_${id}_${mid}`, id, line, s.date));
        stmts.push(db.prepare(`INSERT INTO change_log(entity,entity_id,action) VALUES('wrestler',?,'upsert')`).bind(id));
      }
    }
  }
  // matches that vanished from the source page: soft delete
  for (const gone of prevMap.values()) {
    stmts.push(db.prepare(`UPDATE matches SET deleted_at=?, updated_at=?, version=version+1 WHERE id=?`).bind(ts, ts, gone.id));
    stmts.push(db.prepare(`INSERT INTO change_log(entity,entity_id,action) VALUES('match',?,'delete')`).bind(gone.id));
    if (gone.title_championship_id) stats.titles.add(gone.title_championship_id);
  }
  // D1 batches are transactional; keep each under ~400 statements
  for (let i = 0; i < stmts.length; i += 400) await db.batch(stmts.slice(i, i + 400));
  stats.writes += stmts.length;
  return stats;
}

/** A title's current holders per an infobox differ from ours -> start a new base reign as of that date. */
export async function applyTitleHolders(db: D1Database, f: TitleHolderFact): Promise<number> {
  if (!f.holder_ids || f.holder_ids.length !== f.holder_names.length) return 0;
  const cur = await db.prepare('SELECT r.id FROM reigns r WHERE r.championship_id=? AND r.ended_on IS NULL').bind(f.championship_id).first<{ id: string }>();
  if (cur) {
    const h = await db.prepare('SELECT wrestler_id FROM reign_holders WHERE reign_id=?').bind(cur.id).all<{ wrestler_id: string }>();
    const a = h.results.map(x => x.wrestler_id).sort().join(','), b = [...f.holder_ids].sort().join(',');
    if (a === b) return 0;
  }
  const rid = `r_${f.championship_id}_${f.source}_${f.as_of}`;
  const stmts = [
    ...(cur ? [db.prepare('UPDATE reigns SET ended_on=? WHERE id=?').bind(f.as_of, cur.id)] : []),
    db.prepare(`INSERT OR REPLACE INTO reigns(id,championship_id,started_on,source) VALUES(?,?,?,?)`).bind(rid, f.championship_id, f.as_of, f.source),
    db.prepare('DELETE FROM reign_holders WHERE reign_id=?').bind(rid),
    ...f.holder_ids.map(w => db.prepare('INSERT INTO reign_holders(reign_id,wrestler_id) VALUES(?,?)').bind(rid, w)),
    db.prepare(`INSERT INTO change_log(entity,entity_id,action) VALUES('championship',?,'upsert')`).bind(f.championship_id),
  ];
  await db.batch(stmts);
  return stmts.length + (await rebuildLineage(db, f.championship_id));
}

export async function applyBatch(db: D1Database, b: IngestBatch): Promise<Record<string, unknown>> {
  const cfg = Object.fromEntries((await db.prepare('SELECT key, value FROM config').all<{ key: string; value: string }>()).results.map(r => [r.key, r.value]));
  const tot = { shows: 0, newM: 0, changed: 0, held: 0, writes: 0 }; const titles = new Set<string>();
  for (const s of b.shows) { const r = await applyShow(db, s, cfg); tot.shows++; tot.newM += r.newM; tot.changed += r.changed; tot.held += r.held; tot.writes += r.writes; r.titles.forEach(t => titles.add(t)); }
  for (const t of titles) tot.writes += await rebuildLineage(db, t);
  for (const f of b.title_holders) tot.writes += await applyTitleHolders(db, f);
  const ts = now(); const un: D1PreparedStatement[] = [];
  for (const u of b.unknown_names) un.push(db.prepare(`INSERT INTO unknown_names(normalized,raw_name,source_url,first_seen,last_seen) VALUES(?,?,?,?,?)
    ON CONFLICT(normalized) DO UPDATE SET last_seen=excluded.last_seen, times_seen=unknown_names.times_seen+1, source_url=excluded.source_url`).bind(u.normalized, u.raw, u.source_url, ts, ts));
  un.push(db.prepare(`INSERT INTO ingestion_runs(id,source,started_at,pages_fetched,shows_seen,matches_new,matches_changed,matches_held,unknown_names,d1_writes,errors,finished_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET pages_fetched=excluded.pages_fetched, shows_seen=ingestion_runs.shows_seen+excluded.shows_seen,
    matches_new=ingestion_runs.matches_new+excluded.matches_new, matches_changed=ingestion_runs.matches_changed+excluded.matches_changed, matches_held=ingestion_runs.matches_held+excluded.matches_held,
    unknown_names=ingestion_runs.unknown_names+excluded.unknown_names, d1_writes=ingestion_runs.d1_writes+excluded.d1_writes, errors=excluded.errors, finished_at=excluded.finished_at`)
    .bind(b.run.id, b.run.source, b.run.started_at, b.run.pages_fetched, tot.shows, tot.newM, tot.changed, tot.held, b.unknown_names.length, tot.writes + un.length, b.run.errors.join('\n') || null, b.finish ? ts : null));
  un.push(db.prepare(`INSERT INTO usage_daily(day,writes) VALUES(date('now'),?) ON CONFLICT(day) DO UPDATE SET writes=usage_daily.writes+excluded.writes`).bind(tot.writes + un.length));
  await db.batch(un);
  return { ...tot, title_rebuilds: titles.size };
}

/** Daily cron: expire holds older than the retry window. Small and fast (10 ms CPU budget). */
export async function dailyMaintenance(db: D1Database): Promise<void> {
  const d = await db.prepare(`SELECT value FROM config WHERE key='hold_retry_days'`).first<{ value: string }>();
  await db.prepare(`UPDATE matches SET status='expired', updated_at=? WHERE status='held' AND first_held_at < datetime('now', ?)`).bind(now(), `-${+(d?.value || 14)} days`).run();
}
