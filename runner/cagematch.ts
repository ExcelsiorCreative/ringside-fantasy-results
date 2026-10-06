// Cagematch adapter. Used with written permission from Cagematch (Philip, Oct 2, 2026):
// non-commercial use only, read the HTML pages, stay gentle (the site sits behind a Sucuri firewall).
// Rules this file enforces: one request at a time, at least 6 s apart, a daily request budget,
// a descriptive User-Agent with a contact email, and a 24-hour stop at the first sign of blocking.
import { politeGet, SourceBlocked } from './http.ts';
import { parseMatchLine } from '../src/shared/wikitext.ts';
import type { ParsedShow, Promotion } from '../src/shared/types.ts';

const BASE = 'https://www.cagematch.net/';

export interface CmState { day: string; used: number; blockedUntil: number; seen: Record<string, string> } // seen: event id -> event date
export interface CmOptions {
  userAgent: string; today: string; minDate: string;
  promotions: { code: Promotion; nr: number; match: string }[];   // which Cagematch promotions to keep
  dailyBudget: number; minGapMs: number; recheckDays: number;
  championships: string[];                                          // known title names, to spot title matches
  capture?: (name: string, text: string) => void;
}

/* ---------- small HTML helpers (no dependencies) ---------- */
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };
export const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENT[e.toLowerCase()] ?? m));
const strip = (s: string) => decode(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
/** Inner HTML of every element whose class list contains `cls` (handles nesting of the same tag). */
export function byClass(html: string, cls: string, tag = 'div'): string[] {
  const out: string[] = []; const open = new RegExp(`<${tag}\\b[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>`, 'gi'); let m: RegExpExecArray | null;
  while ((m = open.exec(html))) {
    let depth = 1, i = m.index + m[0].length; const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi'); re.lastIndex = i; let t: RegExpExecArray | null;
    while ((t = re.exec(html))) { depth += t[1] ? -1 : 1; if (depth === 0) { out.push(html.slice(i, t.index)); break; } }
    if (depth !== 0) break;
  }
  return out;
}

export function isBlockPage(status: number, body: string): boolean {
  return status === 403 || status === 429 || status === 503 || /sucuri website firewall|sucuri_cloudproxy|access denied - sucuri|cloudproxy@sucuri/i.test(body.slice(0, 20000));
}

/* ---------- parsing ---------- */
/** Which followed promotion this is. The promotion's name decides; the numeric id is only used when no name is shown. */
export function followed(list: CmOptions['promotions'], nr: number | null, name: string) {
  if (name) return list.find(p => p.match && new RegExp(p.match, 'i').test(name));
  return nr ? list.find(p => p.nr === nr) : undefined;
}
/** "dd.mm.yyyy" -> "yyyy-mm-dd" */
export const cmDate = (s: string) => { const m = /(\d{2})\.(\d{2})\.(\d{4})/.exec(s); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };

/** Recent events from the results list page: [{id, date, name, promotionNr, promotionName}] */
export function parseEventList(html: string): { id: string; date: string; name: string; promotionNr: number | null; promotionName: string }[] {
  const out: { id: string; date: string; name: string; promotionNr: number | null; promotionName: string }[] = [];
  for (const row of html.split(/<tr\b/i).slice(1)) {
    const date = cmDate(row); const ev = /href="\?id=1&(?:amp;)?nr=(\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(row);
    if (!date || !ev) continue;
    const pr = /href="\?id=8&(?:amp;)?nr=(\d+)[^"]*"[^>]*>(?:<img[^>]*alt="([^"]*)"[^>]*>|([\s\S]*?))<\/a>/i.exec(row);
    out.push({ id: ev[1], date, name: strip(ev[2]), promotionNr: pr ? +pr[1] : null, promotionName: pr ? decode(pr[2] || strip(pr[3] || '')) : '' });
  }
  return out;
}

/** Info box rows: "Name of the event:" -> value */
export function infoBox(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<div class="InformationBoxTitle">([\s\S]*?)<\/div>\s*<div class="InformationBoxContents">([\s\S]*?)<\/div>/gi; let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out[strip(m[1]).replace(/:$/, '').toLowerCase()] = m[2];
  return out;
}

/** Convert one Cagematch result line (HTML) into the wiki-style line our shared parser reads. */
export function toWikiLine(resultHtml: string): { line: string; titleChange: boolean; problem?: string } {
  let s = resultHtml
    .replace(/<a\b[^>]*href="\?id=(?:2|28|29)&(?:amp;)?nr=\d+[^"]*"[^>]*>([\s\S]*?)<\/a>/gi, (_, n) => `[[${strip(n)}]]`) // wrestlers, tag teams, stables
    .replace(/<[^>]+>/g, ' ');
  s = decode(s).replace(/\s+/g, ' ').trim();
  const titleChange = /title change/i.test(s);
  s = s.replace(/\s*-\s*TITLE CHANGE\s*!*\s*/gi, ' ').replace(/\(\d{1,2}:\d{2}(?::\d{2})?\)/g, ' ').replace(/\(w\/\s*/gi, '(with ').replace(/\s+/g, ' ').trim();
  let problem: string | undefined;
  if (/\bvs\.?\s/i.test(s) && !/\bdefeats?\b/i.test(s)) {
    if (/double count ?out|double dq|double disqualification/i.test(s)) problem = 'double count-out/DQ: no winner, needs a rule';
    const kind = /no contest/i.test(s) ? 'no contest' : /draw/i.test(s) ? 'draw' : null;
    s = s.replace(/\s*-\s*(time limit draw|draw|no contest|double count ?out|double dq|double disqualification)\s*$/i, '');
    if (kind) s += ` ended in a ${kind}`; else if (!problem) problem = 'no winner or result given';
  } else {
    s = s.replace(/\bdefeats?\b/i, 'defeated')
      .replace(/\bby DQ\b/i, 'by disqualification').replace(/\bby (?:Count ?Out|COR)\b/i, 'by count-out')
      .replace(/\bby (?:Submission|Tap ?out)\b/i, 'by submission').replace(/\bby (?:Pin(?:fall)?)\b/i, 'by pinfall')
      .replace(/\bby (?:Referee'?s? Stoppage|TKO|KO)\b/i, 'by referee stoppage').replace(/\bby Forfeit\b/i, 'by forfeit');
  }
  return { line: s, titleChange, problem };
}

/** Match type text -> stipulation our parser understands; finds a championship name if one is on the line. */
export function toStip(typeText: string, championships: string[]): string {
  const t = typeText.trim();
  const title = championships.filter(c => t.toLowerCase().includes(c.toLowerCase())).sort((a, b) => b.length - a.length)[0];
  return title ? `${t.replace(title, '').trim() || 'Match'} for the [[${title}]]` : t;
}

export function eventToShow(eventId: string, html: string, o: Pick<CmOptions, 'promotions' | 'championships'>): { show?: ParsedShow; skipped?: string } {
  const info = infoBox(html);
  const name = strip(info['name of the event'] || '') || strip((/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html) || [])[1] || '');
  const date = cmDate(strip(info['date'] || ''));
  const promoHtml = info['promotion'] || '';
  const promoNr = +((/nr=(\d+)/.exec(promoHtml) || [])[1] || 0);
  const promoName = strip(promoHtml);
  const conf = followed(o.promotions, promoNr || null, promoName);
  if (!conf) return { skipped: `promotion "${promoName}" is not followed` };
  if (!date) return { skipped: 'no date' };
  let promotion: Promotion = conf.code;
  if (promotion === 'WWE' && /\bNXT\b/i.test(name) && !/raw|smackdown/i.test(name)) promotion = 'NXT';
  const type = strip(info['type'] || '');
  const blocks = byClass(html, 'Match');
  if (!blocks.length) return { skipped: 'no results yet' };
  const matches = blocks.map((b, k) => {
    const typeText = strip((byClass(b, 'MatchType')[0] || ''));
    const res = byClass(b, 'MatchResults')[0] || '';
    const conv = toWikiLine(res);
    const m = parseMatchLine(conv.line, toStip(typeText, o.championships), k + 1);
    if (conv.problem) m.problems.push(conv.problem);
    if (m.title_name && conv.titleChange && m.title_outcome !== 'changed') m.problems.push('source says title change but the (c) marker disagrees');
    if (m.title_name && !conv.titleChange && m.title_outcome === 'changed') m.problems.push('(c) marker suggests a title change the source does not mark');
    if (/dark match|pre-?show/i.test(typeText)) m.pre_show = true;
    m.raw_text = conv.line;
    return m;
  });
  const main = [...matches].reverse().find(m => !m.pre_show); if (main) main.is_main_event = true;
  return { show: { source: 'cagematch', source_event_id: eventId, source_url: `${BASE}?id=1&nr=${eventId}`, promotion, name, date,
    show_type: /tv|show/i.test(type) && !/pay per view|premium/i.test(type) ? 'weekly' : 'ple', local_start_time: null, time_zone: null, matches, content_hash: '', problems: [] } };
}

/* ---------- fetching (gentle) ---------- */
async function get(url: string, state: CmState, o: CmOptions): Promise<string> {
  if (state.day !== o.today) { state.day = o.today; state.used = 0; }
  if (state.used >= o.dailyBudget) throw new SourceBlocked(`Cagematch daily budget of ${o.dailyBudget} requests reached; continuing tomorrow`);
  state.used++;
  let res: Response;
  try { res = await politeGet(url, { userAgent: o.userAgent, minGapMs: o.minGapMs, maxRetries: 0 }); }
  catch (e) { if (e instanceof SourceBlocked) state.blockedUntil = Date.now() + 24 * 3600e3; throw e; }
  const body = await res.text();
  if (isBlockPage(res.status, body)) { state.blockedUntil = Date.now() + 24 * 3600e3; throw new SourceBlocked(`Cagematch firewall answered (HTTP ${res.status}); pausing Cagematch for 24 hours`); }
  if (!res.ok) throw new Error(`Cagematch HTTP ${res.status} for ${url}`);
  return body;
}

export async function fetchCagematch(state: CmState, o: CmOptions, log: (s: string) => void): Promise<{ shows: ParsedShow[]; pages: number; errors: string[] }> {
  const shows: ParsedShow[] = [], errors: string[] = []; let pages = 0;
  if (Date.now() < state.blockedUntil) { log(`Cagematch paused until ${new Date(state.blockedUntil).toISOString()} after a firewall response.`); return { shows, pages, errors }; }
  const list = await get(`${BASE}?id=1&view=results`, state, o); pages++; o.capture?.('cagematch-results-list', list);
  const events = parseEventList(list).filter(e => e.date >= o.minDate && e.date <= o.today)
    .filter(e => followed(o.promotions, e.promotionNr, e.promotionName));
  const recent = (d: string) => (Date.parse(o.today) - Date.parse(d)) / 864e5 <= o.recheckDays;
  const todo = events.filter(e => !(e.id in state.seen) || recent(e.date));
  log(`Cagematch: ${events.length} followed events on the results list, ${todo.length} to (re)read, ${o.dailyBudget - state.used} requests left today.`);
  for (const e of todo) {
    try {
      const html = await get(`${BASE}?id=1&nr=${e.id}`, state, o); pages++; o.capture?.(`cagematch-event-${e.id}`, html);
      const r = eventToShow(e.id, html, o);
      if (r.skipped) { log(`  skip ${e.date} ${e.name}: ${r.skipped}`); continue; }
      shows.push(r.show!); state.seen[e.id] = e.date;
    } catch (err) { if (err instanceof SourceBlocked) { errors.push(String(err.message)); break; } errors.push(`${e.name}: ${String(err)}`); }
  }
  // forget events older than the recheck window so state stays small
  for (const id in state.seen) if (!recent(state.seen[id]) && (Date.parse(o.today) - Date.parse(state.seen[id])) / 864e5 > 30) delete state.seen[id];
  return { shows, pages, errors };
}
