// Read-only API for the fantasy app, CSV exports and the public status endpoint.
const ATTRIBUTION = 'Results data includes facts derived from Wikipedia (CC BY-SA 4.0, https://en.wikipedia.org). Source links are kept per show.';

export const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', ...extra } });
const csvCell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const csv = (rows: unknown[][], name: string) =>
  new Response(rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n', { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"` } });

async function sha256(s: string): Promise<string> {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
const keyCache = new Map<string, number>();
export async function checkApiKey(db: D1Database, req: Request): Promise<boolean> {
  const m = /^Bearer\s+(.+)$/.exec(req.headers.get('authorization') || ''); if (!m) return false;
  const h = await sha256(m[1].trim()); const t = keyCache.get(h);
  if (t && Date.now() - t < 300_000) return true;
  const row = await db.prepare('SELECT id FROM api_keys WHERE key_hash=? AND revoked_at IS NULL').bind(h).first();
  if (row) keyCache.set(h, Date.now());
  return !!row;
}

type Row = Record<string, any>;

/** Wrestlers with computed records, titles, status, news. */
export async function wrestlers(db: D1Database, ids?: string[], updatedSince?: string): Promise<Row[]> {
  const year = (await db.prepare(`SELECT value FROM config WHERE key='records_year'`).first<{ value: string }>())?.value || '2026';
  let where = 'w.deleted_at IS NULL'; const binds: unknown[] = [];
  if (ids?.length) { where += ` AND w.id IN (${ids.map(() => '?').join(',')})`; binds.push(...ids); }
  const [ws, recs, titles, status, news] = await db.batch([
    db.prepare(`SELECT w.* FROM wrestlers w WHERE ${where} ORDER BY w.overall_rank`).bind(...binds),
    db.prepare(`SELECT mp.wrestler_id AS id,
        SUM(mp.result='win' AND substr(s.date,1,4)=?) AS yw, SUM(mp.result='loss' AND substr(s.date,1,4)=?) AS yl,
        SUM(mp.result='win') AS w, SUM(mp.result='loss') AS l, MAX(m.updated_at) AS last_change
      FROM match_participants mp JOIN matches m ON m.id=mp.match_id JOIN shows s ON s.id=m.show_id JOIN wrestlers w ON w.id=mp.wrestler_id
      WHERE m.status='published' AND m.deleted_at IS NULL AND s.date > COALESCE(w.baseline_as_of,'0000') GROUP BY mp.wrestler_id`).bind(year, year),
    db.prepare(`SELECT h.wrestler_id AS id, c.name FROM reigns r JOIN reign_holders h ON h.reign_id=r.id JOIN championships c ON c.id=r.championship_id WHERE r.ended_on IS NULL`),
    db.prepare(`SELECT wrestler_id AS id, kind, note, started_on, source FROM status_entries WHERE ended_on IS NULL`),
    db.prepare(`SELECT wrestler_id AS id, text, as_of, kind FROM news_items ORDER BY as_of DESC`),
  ]);
  const by = <T extends Row>(rs: T[]) => { const m = new Map<string, T[]>(); rs.forEach(r => m.set(r.id, [...(m.get(r.id) || []), r])); return m; };
  const R = new Map((recs.results as Row[]).map(r => [r.id, r])), T = by(titles.results as Row[]), S = by(status.results as Row[]), N = by(news.results as Row[]);
  const briefs = new Set(((await db.prepare(`SELECT holder_wrestler_id AS id FROM briefcases WHERE status='held'`).all()).results as Row[]).map(r => r.id));
  return (ws.results as Row[]).map(w => {
    const r = R.get(w.id) || { yw: 0, yl: 0, w: 0, l: 0 };
    const yw = (year === '2026' ? (w.baseline_2026_wins ?? 0) : 0) + (r.yw || 0), yl = (year === '2026' ? (w.baseline_2026_losses ?? 0) : 0) + (r.yl || 0);
    const cw = w.baseline_career_wins != null ? w.baseline_career_wins + (r.w || 0) : null, cl = w.baseline_career_losses != null ? w.baseline_career_losses + (r.l || 0) : null;
    const pctBase = cw != null ? [cw, cl] : [yw, yl];
    const st = S.get(w.id) || [];
    return {
      id: w.id, name: w.name, promotion: w.promotion, gender: w.gender, active: !!w.active, overall_rank: w.overall_rank, rank_in_gender: w.rank_in_gender,
      champion: (T.get(w.id) || []).length > 0, championships: (T.get(w.id) || []).map(t => t.name), mitb_briefcase: briefs.has(w.id),
      injured: st.find(s => s.kind === 'injured') || null, away: st.find(s => s.kind !== 'injured') || null,
      record_year: year, record_year_wins: yw, record_year_losses: yl, career_wins: cw, career_losses: cl,
      win_pct: pctBase[0] + pctBase[1] ? Math.round(100 * pctBase[0] / (pctBase[0] + pctBase[1])) : null,
      news: (N.get(w.id) || []).slice(0, 10).map(n => ({ text: n.text, as_of: n.as_of, kind: n.kind })),
      updated_at: [w.updated_at, r.last_change].filter(Boolean).sort().pop(),
    };
  }).filter(w => !updatedSince || (w.updated_at || '') > updatedSince);
}

export async function shows(db: D1Database, opts: { ids?: string[]; from?: string; to?: string; updatedSince?: string }): Promise<Row[]> {
  let where = 's.deleted_at IS NULL'; const b: unknown[] = [];
  if (opts.ids?.length) { where += ` AND s.id IN (${opts.ids.map(() => '?').join(',')})`; b.push(...opts.ids); }
  if (opts.from) { where += ' AND s.date >= ?'; b.push(opts.from); }
  if (opts.to) { where += ' AND s.date <= ?'; b.push(opts.to); }
  if (opts.updatedSince) { where += ' AND (s.updated_at > ? OR EXISTS (SELECT 1 FROM matches mm WHERE mm.show_id=s.id AND mm.updated_at > ?))'; b.push(opts.updatedSince, opts.updatedSince); }
  const ss = (await db.prepare(`SELECT * FROM shows s WHERE ${where} ORDER BY s.date DESC LIMIT 500`).bind(...b).all<Row>()).results;
  if (!ss.length) return [];
  const ph = ss.map(() => '?').join(',');
  const [ms, ps, cs] = await db.batch([
    db.prepare(`SELECT m.*, c.name AS title_name FROM matches m LEFT JOIN championships c ON c.id=m.title_championship_id WHERE m.show_id IN (${ph}) AND m.status='published' AND m.deleted_at IS NULL ORDER BY m.match_number`).bind(...ss.map(s => s.id)),
    db.prepare(`SELECT mp.* FROM match_participants mp JOIN matches m ON m.id=mp.match_id WHERE m.show_id IN (${ph}) AND m.status='published' AND m.deleted_at IS NULL ORDER BY mp.side`).bind(...ss.map(s => s.id)),
    db.prepare(`SELECT ci.* FROM cash_ins ci JOIN matches m ON m.id=ci.match_id WHERE m.show_id IN (${ph})`).bind(...ss.map(s => s.id)),
  ]);
  const P = new Map<string, Row[]>(); (ps.results as Row[]).forEach(p => P.set(p.match_id, [...(P.get(p.match_id) || []), p]));
  const C = new Map((cs.results as Row[]).map(c => [c.match_id, c]));
  const M = new Map<string, Row[]>(); (ms.results as Row[]).forEach(m => M.set(m.show_id, [...(M.get(m.show_id) || []), m]));
  return ss.map(s => ({
    id: s.id, promotion: s.promotion, name: s.name, show_type: s.show_type, date: s.date, local_start_time: s.local_start_time, time_zone: s.time_zone,
    source: s.source, source_url: s.source_url, version: s.version, updated_at: s.updated_at,
    matches: (M.get(s.id) || []).map(m => ({
      id: m.id, match_number: m.match_number, is_main_event: !!m.is_main_event, pre_show: !!m.pre_show, match_type: m.match_type, stipulation: m.stipulation,
      is_qualifier: !!m.is_qualifier, is_tournament: !!m.is_tournament, finish: m.finish, title: m.title_championship_id ? { id: m.title_championship_id, name: m.title_name, outcome: m.title_outcome } : null,
      cash_in: C.get(m.id) ? { wrestler_id: C.get(m.id)!.wrestler_id, success: !!C.get(m.id)!.success } : null, version: m.version, updated_at: m.updated_at,
      participants: (P.get(m.id) || []).map(p => ({ wrestler_id: p.wrestler_id, name: p.raw_name, side: p.side, result: p.result, champion_going_in: !!p.champion_going_in,
        lost_by_dq_or_interference: !!p.lost_by_dq_or_interference, rumble_entry: p.rumble_entry, rumble_eliminations: p.rumble_eliminations, rumble_place: p.rumble_place,
        chamber_entered: !!p.chamber_entered, chamber_eliminations: p.chamber_eliminations, mitb_entered: !!p.mitb_entered })),
    })),
  }));
}

export async function championships(db: D1Database, ids?: string[]): Promise<Row[]> {
  const w = ids?.length ? `WHERE c.id IN (${ids.map(() => '?').join(',')})` : '';
  const cs = (await db.prepare(`SELECT * FROM championships c ${w} ORDER BY promotion, name`).bind(...(ids || [])).all<Row>()).results;
  const rs = (await db.prepare(`SELECT r.*, group_concat(w.id || '|' || w.name, ';') AS holders FROM reigns r LEFT JOIN reign_holders h ON h.reign_id=r.id LEFT JOIN wrestlers w ON w.id=h.wrestler_id GROUP BY r.id ORDER BY COALESCE(r.started_on,'') DESC`).all<Row>()).results;
  return cs.map(c => {
    const reigns = rs.filter(r => r.championship_id === c.id).map(r => ({ started_on: r.started_on, ended_on: r.ended_on, vacated: !!r.vacated, source: r.source, started_match_id: r.started_match_id,
      holders: (r.holders || '').split(';').filter(Boolean).map((x: string) => { const [id, name] = x.split('|'); return { id, name }; }) }));
    return { id: c.id, name: c.name, promotion: c.promotion, gender: c.gender, holders_per_reign: c.holders_per_reign, current: reigns.find(r => !r.ended_on)?.holders || [], reigns, version: c.version, updated_at: c.updated_at };
  });
}

export async function changes(db: D1Database, cursor: number, limit: number) {
  const rows = (await db.prepare('SELECT sequence, entity, entity_id, action, version, changed_at FROM change_log WHERE sequence > ? ORDER BY sequence LIMIT ?').bind(cursor, limit).all<Row>()).results;
  // keep only the last change per entity in this page; fetch current data in bulk
  const last = new Map<string, Row>(); rows.forEach(r => last.set(r.entity + ':' + r.entity_id, r));
  const want = (e: string) => [...last.values()].filter(r => r.entity === e && r.action === 'upsert').map(r => r.entity_id);
  const matchShowIds = want('match').map((id: string) => id.split(':').slice(0, -1).join(':'));
  const showIds = [...new Set(want('show').concat(matchShowIds))];
  const [W, S, C] = await Promise.all([
    want('wrestler').length ? wrestlers(db, want('wrestler')) : [], showIds.length ? shows(db, { ids: showIds }) : [], want('championship').length ? championships(db, want('championship')) : [],
  ]);
  const wm = new Map(W.map(x => [x.id, x])), sm = new Map(S.map(x => [x.id, x])), cm = new Map(C.map(x => [x.id, x]));
  const items = [...last.values()].sort((a, b) => a.sequence - b.sequence).map(r => {
    let data: unknown = null;
    if (r.action === 'upsert') {
      if (r.entity === 'wrestler') data = wm.get(r.entity_id) ?? null;
      else if (r.entity === 'show') data = sm.get(r.entity_id) ?? null;
      else if (r.entity === 'match') { const sid = r.entity_id.split(':').slice(0, -1).join(':'); data = (sm.get(sid)?.matches || []).find((m: Row) => m.id === r.entity_id) ?? { id: r.entity_id, status: 'not published' }; }
      else if (r.entity === 'championship') data = cm.get(r.entity_id) ?? null;
    }
    return { sequence: r.sequence, entity: r.entity, id: r.entity_id, action: r.action, changed_at: r.changed_at, data };
  });
  const next = rows.length ? rows[rows.length - 1].sequence : cursor;
  return { items, next_cursor: next, has_more: rows.length === limit, attribution: ATTRIBUTION, data_as_of: new Date().toISOString() };
}

export async function exportPlayers(db: D1Database): Promise<Response> {
  const ws = await wrestlers(db);
  const head = ['wrestler_id', 'player_name', 'promotion', 'gender', 'overall_rank', 'rank_in_gender', 'is_champion', 'championships', 'injured', 'injury_note', 'away_out', 'away_note', 'mitb_briefcase', 'badges',
    'record_2026_wins', 'record_2026_losses', 'career_wins', 'career_losses', 'win_pct', 'news', 'news_as_of'];
  const rows = ws.map(w => {
    const badges = [w.champion && 'champion', w.injured && 'injured', w.away && 'away', w.mitb_briefcase && 'mitb'].filter(Boolean).join('; ');
    return [w.id, w.name, w.promotion, w.gender === 'W' ? 'Women' : 'Men', w.overall_rank, w.rank_in_gender, w.champion ? 'yes' : 'no', w.championships.join('; '), w.injured ? 'yes' : 'no', w.injured?.note || '',
      w.away ? 'yes' : 'no', w.away?.note || '', w.mitb_briefcase ? 'yes' : 'no', badges, w.record_year === '2026' ? w.record_year_wins : '', w.record_year === '2026' ? w.record_year_losses : '',
      w.career_wins ?? '', w.career_losses ?? '', w.win_pct != null ? w.win_pct + '%' : '', w.news[0]?.text || '', w.news[0]?.as_of || ''];
  });
  return csv([head, ...rows], 'ringside_players.csv');
}

export async function exportChampionships(db: D1Database): Promise<Response> {
  const cs = await championships(db);
  const rows: unknown[][] = [['championship', 'current_holder', 'promotion', 'gender']];
  cs.forEach(c => c.current.forEach((h: Row) => rows.push([c.name, h.name, c.promotion, c.gender === 'W' ? 'Women' : 'Men'])));
  return csv(rows, 'ringside_championships.csv');
}

export async function exportResults(db: D1Database, from?: string, to?: string): Promise<Response> {
  const ss = await shows(db, { from, to });
  const rows: unknown[][] = [['match_id', 'show_date', 'show_local_time', 'time_zone', 'promotion', 'show_name', 'match_number', 'is_main_event', 'match_type', 'is_qualifier', 'finish', 'wrestler_id', 'wrestler_name', 'side', 'result',
    'lost_by_dq_or_interference', 'title_name', 'title_outcome', 'rumble_entry', 'rumble_eliminations', 'rumble_place', 'chamber_entered', 'chamber_eliminations', 'mitb_entered', 'cash_in', 'match_version', 'updated_at']];
  for (const s of ss) for (const m of s.matches) for (const p of m.participants)
    rows.push([m.id, s.date, s.local_start_time, s.time_zone, s.promotion, s.name, m.match_number, m.is_main_event ? 1 : 0, m.match_type, m.is_qualifier ? 1 : 0, m.finish, p.wrestler_id, p.name, p.side, p.result,
      p.lost_by_dq_or_interference ? 1 : 0, m.title?.name || '', m.title?.outcome || 'none', p.rumble_entry, p.rumble_eliminations, p.rumble_place, p.chamber_entered ? 1 : 0, p.chamber_eliminations, p.mitb_entered ? 1 : 0,
      m.cash_in && m.cash_in.wrestler_id === p.wrestler_id ? (m.cash_in.success ? 'success' : 'failed') : 'none', m.version, m.updated_at]);
  return csv(rows, 'ringside_results.csv');
}

export async function status(db: D1Database): Promise<Row> {
  const [runs, counts, held, unknown, usage, cfg] = await db.batch([
    db.prepare('SELECT * FROM ingestion_runs ORDER BY started_at DESC LIMIT 10'),
    db.prepare(`SELECT (SELECT count(*) FROM shows) AS shows, (SELECT count(*) FROM matches WHERE status='published' AND deleted_at IS NULL) AS published,
      (SELECT count(*) FROM matches WHERE status='held') AS held, (SELECT count(*) FROM matches WHERE status='expired') AS expired,
      (SELECT count(*) FROM wrestlers) AS wrestlers, (SELECT count(*) FROM unknown_names WHERE resolved_wrestler_id IS NULL) AS unknown_names, (SELECT max(sequence) FROM change_log) AS latest_cursor`),
    db.prepare(`SELECT m.id, s.name AS show, s.date, m.raw_text, m.hold_reason, m.status, m.source_url FROM matches m JOIN shows s ON s.id=m.show_id WHERE m.status IN ('held','expired') ORDER BY s.date DESC LIMIT 50`),
    db.prepare('SELECT raw_name, times_seen, last_seen, source_url FROM unknown_names WHERE resolved_wrestler_id IS NULL ORDER BY times_seen DESC LIMIT 50'),
    db.prepare(`SELECT * FROM usage_daily WHERE day=date('now')`),
    db.prepare(`SELECT key, value FROM config WHERE key LIKE 'source.%' OR key='cagematch_permission_confirmed'`),
  ]);
  const c = Object.fromEntries((cfg.results as Row[]).map(r => [r.key, r.value]));
  const sources = { wikipedia: c['source.wikipedia.enabled'] === 'true', cagematch: c['source.cagematch.enabled'] === 'true' && c['cagematch_permission_confirmed'] === 'true', official_sites: c['source.official_sites.enabled'] === 'true' };
  const u = (usage.results as Row[])[0] || { writes: 0, api_requests: 0 };
  return {
    sources, coverage_note: sources.cagematch ? 'Weekly TV and events are covered.' : 'Only Wikipedia is enabled: premium live events and title changes are covered; weekly TV coverage is limited.',
    counts: (counts.results as Row[])[0], last_runs: runs.results, held_matches: held.results, unknown_names: unknown.results,
    free_tier_today: { d1_rows_written_est: u.writes, d1_rows_written_limit: 100000, api_requests: u.api_requests, worker_requests_limit: 100000 },
    attribution: ATTRIBUTION, generated_at: new Date().toISOString(),
  };
}

export const OPENAPI = {
  openapi: '3.0.3', info: { title: 'Ringside Results DB', version: '1.0.0', description: 'Read-only wrestling results API. Bearer API key required except /status.' },
  components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } }, security: [{ bearer: [] }],
  paths: {
    '/api/v1/changes': { get: { summary: 'Sync feed. Pass cursor=<next_cursor> from the previous call.', parameters: [{ name: 'cursor', in: 'query', schema: { type: 'integer' } }, { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 500 } }] } },
    '/api/v1/wrestlers': { get: { summary: 'All wrestlers with computed records, titles, status and news', parameters: [{ name: 'updated_since', in: 'query', schema: { type: 'string' } }] } },
    '/api/v1/shows': { get: { summary: 'Shows with published matches', parameters: ['from', 'to', 'updated_since'].map(n => ({ name: n, in: 'query', schema: { type: 'string' } })) } },
    '/api/v1/championships': { get: { summary: 'Titles with current holders and reign history' } },
    '/api/v1/aliases': { get: { summary: 'Alias -> wrestler id' } },
    '/api/v1/stables': { get: { summary: 'Tag teams and stables with members' } },
    '/api/v1/export/players.csv': { get: { summary: 'Same columns as ringside_players.csv plus wrestler_id' } },
    '/api/v1/export/championships.csv': { get: { summary: 'Same columns as ringside_championships.csv' } },
    '/api/v1/export/results.csv': { get: { summary: 'One row per wrestler per published match' } },
    '/status': { get: { summary: 'Public status (no key)', security: [] } },
  },
};
