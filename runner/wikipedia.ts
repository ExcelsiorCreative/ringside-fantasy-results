// Wikipedia adapter: discovers event pages through categories, fetches wikitext through the
// MediaWiki Action API (allowed for bots with a descriptive User-Agent), and parses results.
import { politeGet, SourceBlocked } from './http.ts';
import { resultsTables, parseResultsTable, infobox, parseDate, promotionOf, cleanWikitext, splitTop, firstLink } from '../src/shared/wikitext.ts';
import { nameKey } from '../src/shared/normalize.ts';
import type { ParsedShow, TitleHolderFact } from '../src/shared/types.ts';

const API = 'https://en.wikipedia.org/w/api.php';
const CATEGORY_RE = /\b(WWE|NXT|All Elite Wrestling|AEW|Total Nonstop Action|TNA)\b.*\b(events|pay-per-view|supercards|specials?)\b/i;

export interface WikiState { revs: Record<string, number>; titlePages: Record<string, string | null>; titleRevs: Record<string, number> }
export interface WikiOptions { userAgent: string; today: string; minDate: string; extraCategories: string[]; capture?: (name: string, text: string) => void }

async function api(params: Record<string, string>, o: WikiOptions): Promise<any> {
  const qs = new URLSearchParams({ format: 'json', formatversion: '2', maxlag: '5', ...params });
  for (let i = 0; i < 4; i++) {
    const res = await politeGet(`${API}?${qs}`, { userAgent: o.userAgent, minGapMs: 1100 });
    const body: any = await res.json();
    if (body?.error?.code === 'maxlag') { await new Promise(r => setTimeout(r, 5000)); continue; }
    if (body?.error) throw new Error(`Wikipedia API: ${body.error.code} ${body.error.info}`);
    return body;
  }
  throw new Error('Wikipedia API stayed lagged; try next run');
}

/** Categories like "2026 WWE pay-per-view events", found by prefix so nothing is hard-coded. */
export async function discoverCategories(years: number[], o: WikiOptions): Promise<string[]> {
  const out = new Set<string>(o.extraCategories);
  for (const y of years) {
    let cont: Record<string, string> = {};
    do {
      const b = await api({ action: 'query', list: 'allcategories', acprefix: `${y} `, aclimit: '500', ...cont }, o);
      (b.query?.allcategories || []).forEach((c: any) => { const name = c.category ?? c['*']; if (CATEGORY_RE.test(name) && !/wrestlers|births|deaths|templates/i.test(name)) out.add(name); });
      cont = b.continue ? { accontinue: b.continue.accontinue } : {};
    } while (cont.accontinue);
  }
  return [...out];
}

export async function categoryPages(cat: string, o: WikiOptions): Promise<{ pageid: number; title: string }[]> {
  const out: { pageid: number; title: string }[] = []; let cont: Record<string, string> = {};
  do {
    const b = await api({ action: 'query', list: 'categorymembers', cmtitle: `Category:${cat}`, cmtype: 'page', cmlimit: '500', ...cont }, o);
    (b.query?.categorymembers || []).forEach((m: any) => out.push({ pageid: m.pageid, title: m.title }));
    cont = b.continue ? { cmcontinue: b.continue.cmcontinue } : {};
  } while (cont.cmcontinue);
  return out;
}

export async function lastRevisions(pageids: number[], o: WikiOptions): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (let i = 0; i < pageids.length; i += 50) {
    const b = await api({ action: 'query', prop: 'info', pageids: pageids.slice(i, i + 50).join('|') }, o);
    (b.query?.pages || []).forEach((p: any) => out.set(p.pageid, p.lastrevid));
  }
  return out;
}

async function wikitext(pageid: number, o: WikiOptions, section?: string): Promise<{ title: string; text: string }> {
  const b = await api({ action: 'parse', pageid: String(pageid), prop: 'wikitext', ...(section ? { section } : {}) }, o);
  return { title: b.parse.title, text: b.parse.wikitext };
}

/** Turn one event article into 1+ shows (one per night). Exported for tests. */
export function eventToShows(pageid: number, title: string, text: string, today: string): { shows: ParsedShow[]; skipped?: string } {
  const box = infobox(text);
  const promotion = promotionOf(box);
  if (!promotion) return { shows: [], skipped: 'promotion not WWE/AEW/TNA/NXT' };
  const start = parseDate(box['date'] || box['dates']);
  if (!start) return { shows: [], skipped: 'no date in infobox' };
  if (start > today) return { shows: [], skipped: 'event has not happened yet' };
  const tables = resultsTables(text);
  if (!tables.length) return { shows: [], skipped: 'no results table yet' };
  const nights = new Map<number, typeof tables>();
  tables.forEach(t => { const n = +(/night\s*(\d)/i.exec(t.heading)?.[1] || 1); nights.set(n, [...(nights.get(n) || []), t]); });
  const name = title.replace(/\s*\((?:\d{4}|[^)]*wrestling[^)]*)\)\s*$/i, '').trim();
  const shows: ParsedShow[] = [];
  for (const [n, ts] of [...nights].sort((a, b) => a[0] - b[0])) {
    const d = new Date(start + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n - 1);
    const date = d.toISOString().slice(0, 10);
    if (date > today) continue;
    let k = 0; const matches = ts.flatMap(t => parseResultsTable(t.params)).map(m => ({ ...m, match_number: ++k }));
    matches.forEach(m => (m.is_main_event = false));
    const main = [...matches].reverse().find(m => !m.pre_show); if (main) main.is_main_event = true;
    shows.push({ source: 'wikipedia', source_event_id: `${pageid}:n${n}`, source_url: `https://en.wikipedia.org/?curid=${pageid}`, promotion, name: nights.size > 1 ? `${name} Night ${n}` : name,
      show_type: 'ple', date, local_start_time: null, time_zone: null, matches, content_hash: '', problems: [] });
  }
  return { shows };
}

/** Current holder(s) from a championship article's infobox. */
export function infoboxHolders(text: string): string[] {
  const box = infobox(text);
  const raw = box['champion'] || box['champions'] || box['current champion'] || box['current champions'] || box['currentchampion'] || '';
  if (!raw || /vacant/i.test(raw)) return [];
  const clean = cleanWikitext(raw).replace(/\((?:[^()]*\[\[[^()]*)\)/g, m => m); // keep member lists
  // "[[The Young Bucks]] ([[Matt Jackson]] and [[Nick Jackson]])" -> members; "[[X]]" -> X
  const paren = /\(([^()]*\[\[[^()]*)\)/.exec(clean);
  const list = paren ? paren[1] : clean.replace(/\([^()]*\)/g, '');
  return splitTop(list, /,\s*(?:and\s+)?|\s+and\s+|\s*&\s*|\s*<br\s*\/?>\s*/y).map(x => firstLink(x).display).filter(Boolean);
}

export async function findTitlePage(name: string, promotion: string, o: WikiOptions): Promise<string | null> {
  const b = await api({ action: 'query', list: 'search', srsearch: `intitle:"${name}"`, srnamespace: '0', srlimit: '10' }, o);
  const hits: string[] = (b.query?.search || []).map((s: any) => s.title);
  const key = nameKey(name);
  const exact = hits.filter(t => nameKey(t.replace(/\s*\([^)]*\)\s*$/, '')) === key);
  return exact.find(t => new RegExp(promotion === 'NXT' ? 'WWE|NXT' : promotion, 'i').test(t)) || exact[0] || null;
}

export async function fetchEvents(state: WikiState, o: WikiOptions, log: (s: string) => void): Promise<{ shows: ParsedShow[]; pages: number; errors: string[] }> {
  const errors: string[] = []; const shows: ParsedShow[] = []; let pages = 0;
  const years = [...new Set([+o.today.slice(0, 4), +o.minDate.slice(0, 4)])];
  const cats = await discoverCategories(years, o);
  log(`Wikipedia categories: ${cats.join(' | ') || 'none found'}`);
  const all = new Map<number, string>();
  for (const c of cats) (await categoryPages(c, o)).forEach(p => all.set(p.pageid, p.title));
  const yearsRe = new RegExp(`\\b(${years.join('|')})\\b`);
  const candidates = [...all].filter(([, t]) => yearsRe.test(t) || !/\b(19|20)\d{2}\b/.test(t)).map(([id]) => id);
  const revs = await lastRevisions(candidates, o);
  for (const id of candidates) {
    const rev = revs.get(id); if (!rev || state.revs[id] === rev) continue;
    try {
      const { title, text } = await wikitext(id, o); pages++;
      o.capture?.(title, text);
      const r = eventToShows(id, title, text, o.today);
      if (r.skipped) log(`skip ${title}: ${r.skipped}`);
      shows.push(...r.shows.filter(s => s.date >= o.minDate));
      if (!r.skipped || r.skipped === 'promotion not WWE/AEW/TNA/NXT') state.revs[id] = rev; // retry pages without results next run
    } catch (e) { if (e instanceof SourceBlocked) throw e; errors.push(`${all.get(id)}: ${String(e)}`); }
  }
  return { shows, pages, errors };
}

export async function fetchTitleHolders(champs: { id: string; name: string; promotion: string }[], state: WikiState, o: WikiOptions, log: (s: string) => void): Promise<{ facts: TitleHolderFact[]; pages: number; errors: string[] }> {
  const facts: TitleHolderFact[] = []; const errors: string[] = []; let pages = 0;
  for (const c of champs) {
    if (!(c.id in state.titlePages)) { state.titlePages[c.id] = await findTitlePage(c.name, c.promotion, o); log(`title page for ${c.name}: ${state.titlePages[c.id] ?? 'not found'}`); }
  }
  const titles = champs.map(c => state.titlePages[c.id]).filter(Boolean) as string[];
  for (let i = 0; i < titles.length; i += 50) {
    const b = await api({ action: 'query', prop: 'info', titles: titles.slice(i, i + 50).join('|') }, o);
    for (const p of b.query?.pages || []) {
      const c = champs.find(x => state.titlePages[x.id] === p.title); if (!c || p.missing) continue;
      if (state.titleRevs[c.id] === p.lastrevid) continue;
      try {
        const { text } = await wikitext(p.pageid, o, '0'); pages++;
        const holders = infoboxHolders(text);
        if (holders.length) facts.push({ championship_id: c.id, holder_names: holders, as_of: o.today, source: 'wikipedia_infobox', source_url: `https://en.wikipedia.org/?curid=${p.pageid}` });
        state.titleRevs[c.id] = p.lastrevid;
      } catch (e) { if (e instanceof SourceBlocked) throw e; errors.push(`${c.name}: ${String(e)}`); }
    }
  }
  return { facts, pages, errors };
}
