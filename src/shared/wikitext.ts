// Parser for Wikipedia event articles (wikitext from the MediaWiki API).
// Pure functions only: no network, so it can be unit-tested on saved pages.
import type { Finish, MatchType, ParsedMatch, ParsedParticipant, Promotion, TitleOutcome } from './types.ts';

const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];

/** Remove refs, comments, formatting and most templates; keep [[links]]. */
export function cleanWikitext(s: string): string {
  return s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<ref[^>/]*\/>/gi, '')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?(small|span|sup|sub|nowiki|abbr)[^>]*>/gi, '')
    .replace(/\{\{\s*(?:sfn|efn|refn|cite[^|}]*|nbsp|clarify|citation needed|cn|dead link)[^{}]*\}\}/gi, '')
    .replace(/\{\{\s*(?:nowrap|nobr)\s*\|([^{}]*)\}\}/gi, '$1')
    .replace(/'''?/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Index of the matching "}}" for a "{{" at position i (balanced). */
function closeBraces(s: string, i: number): number {
  let depth = 0;
  for (let j = i; j < s.length - 1; j++) {
    if (s[j] === '{' && s[j + 1] === '{') { depth++; j++; }
    else if (s[j] === '}' && s[j + 1] === '}') { depth--; j++; if (depth === 0) return j + 1; }
  }
  return -1;
}

/** Split on a separator only at the top level (outside [[ ]], {{ }} and ( )). */
export function splitTop(s: string, sep: RegExp): string[] {
  const out: string[] = []; let depthSq = 0, depthCurly = 0, depthParen = 0, last = 0;
  for (let i = 0; i < s.length; i++) {
    const two = s.slice(i, i + 2);
    if (two === '[[') { depthSq++; i++; continue; }
    if (two === ']]') { depthSq--; i++; continue; }
    if (two === '{{') { depthCurly++; i++; continue; }
    if (two === '}}') { depthCurly--; i++; continue; }
    if (s[i] === '(') depthParen++;
    if (s[i] === ')') depthParen--;
    if (depthSq === 0 && depthCurly === 0 && depthParen === 0) {
      sep.lastIndex = 0;
      const m = sep.exec(s.slice(i));
      if (m && m.index === 0) { out.push(s.slice(last, i)); i += m[0].length - 1; last = i + 1; }
    }
  }
  out.push(s.slice(last));
  return out.map(x => x.trim()).filter(Boolean);
}

export function templateParams(body: string): Record<string, string> {
  const parts = splitTop(body, /\|/y);
  const out: Record<string, string> = {};
  parts.slice(1).forEach(p => { const eq = p.indexOf('='); if (eq > 0) out[p.slice(0, eq).trim().toLowerCase()] = p.slice(eq + 1).trim(); });
  return out;
}

/** Find every {{Pro Wrestling results table ...}} with the section heading above it. */
export function resultsTables(wikitext: string): { heading: string; params: Record<string, string> }[] {
  const out: { heading: string; params: Record<string, string> }[] = [];
  const re = /\{\{\s*pro wrestling results table/gi; let m: RegExpExecArray | null;
  while ((m = re.exec(wikitext))) {
    const end = closeBraces(wikitext, m.index);
    if (end < 0) break;
    const body = wikitext.slice(m.index + 2, end - 2);
    const before = wikitext.slice(0, m.index);
    const hs = [...before.matchAll(/^=+\s*([^=\n]+?)\s*=+\s*$/gm)];
    out.push({ heading: hs.length ? hs[hs.length - 1][1] : '', params: templateParams(body) });
    re.lastIndex = end;
  }
  return out;
}

export function infobox(wikitext: string): Record<string, string> {
  const m = /\{\{\s*infobox[^|]*/i.exec(wikitext);
  if (!m) return {};
  const end = closeBraces(wikitext, m.index);
  return templateParams(wikitext.slice(m.index + 2, end - 2));
}

/** Dates from {{Start date|2025|8|2}} or "August 2, 2025" / "2 August 2025". */
export function parseDate(s: string | undefined): string | null {
  if (!s) return null;
  const t = /\{\{\s*start date[^|]*\|\s*(\d{4})\s*\|\s*(\d{1,2})\s*\|\s*(\d{1,2})/i.exec(s);
  if (t) return `${t[1]}-${t[2].padStart(2, '0')}-${t[3].padStart(2, '0')}`;
  const c = cleanWikitext(s).replace(/\[\[|\]\]/g, '');
  let r = /([A-Za-z]+)\s+(\d{1,2})(?:\s*[–-]\s*\d{1,2})?,\s*(\d{4})/.exec(c);
  if (r && MONTHS.includes(r[1].toLowerCase())) return `${r[3]}-${String(MONTHS.indexOf(r[1].toLowerCase()) + 1).padStart(2, '0')}-${r[2].padStart(2, '0')}`;
  r = /(\d{1,2})(?:\s*[–-]\s*\d{1,2})?\s+([A-Za-z]+)\s+(\d{4})/.exec(c);
  if (r && MONTHS.includes(r[2].toLowerCase())) return `${r[3]}-${String(MONTHS.indexOf(r[2].toLowerCase()) + 1).padStart(2, '0')}-${r[1].padStart(2, '0')}`;
  return null;
}

export function promotionOf(box: Record<string, string>): Promotion | null {
  const p = cleanWikitext((box['promotion'] || '') + ' ' + (box['brand'] || '') + ' ' + (box['brands'] || '')).toLowerCase();
  if (/all elite wrestling|\baew\b/.test(p)) return 'AEW';
  if (/total nonstop action|\btna\b|impact wrestling/.test(p)) return 'TNA';
  if (/\bnxt\b/.test(p) && !/\braw\b|smackdown/.test(p)) return 'NXT';
  if (/\bwwe\b/.test(p)) return 'WWE';
  return null;
}

/** A link like [[Target|Display]] -> {display, target}; plain text -> {display}. */
export function firstLink(s: string): { display: string; target?: string } {
  const m = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/.exec(s);
  if (m) return { display: (m[2] || m[1]).trim(), target: m[1].trim() };
  return { display: s.replace(/\(.*?\)/g, '').trim() };
}

interface Entity { name: string; target?: string; members: { name: string; target?: string }[]; champ: boolean }

/** "[[The Young Bucks]] ([[Matt Jackson]] and [[Nick Jackson]]) (c) (with [[X]])" -> entity */
function parseEntity(item: string): Entity {
  const parens = [...item.matchAll(/\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)].map(m => m[1].trim());
  const head = item.replace(/\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g, '').trim();
  const link = firstLink(head);
  const e: Entity = { name: link.display, target: link.target, members: [], champ: false };
  for (const p of parens) {
    if (/^c$/i.test(p)) { e.champ = true; continue; }
    if (/^with\b/i.test(p)) continue;        // managers/valets don't wrestle
    if (/\[\[/.test(p)) e.members = splitTop(p, /,\s*(?:and\s+)?|\s+and\s+|\s*&\s*/y).map(firstLink).map(l => ({ name: l.display, target: l.target }));
  }
  return e;
}

function entities(side: string): Entity[] {
  return splitTop(side, /,\s*(?:and\s+)?|\s+and\s+|\s*&\s*/y).map(parseEntity).filter(e => e.name);
}

function matchType(stip: string, nWin: number, nLoseEntities: number): MatchType {
  const s = stip.toLowerCase();
  if (/royal rumble/.test(s)) return 'royal_rumble';
  if (/elimination chamber/.test(s)) return 'elimination_chamber';
  if (/money in the bank/.test(s) && /ladder/.test(s)) return 'mitb_ladder';
  if (/battle royal/.test(s)) return 'battle_royal';
  if (/handicap/.test(s)) return 'handicap';
  if (/trios|six-(?:man|woman|person) tag/.test(s)) return 'trios';
  if (/tag/.test(s)) return 'tag';
  if (/triple threat|three-way|four-way|fatal|five-way|six-way|seven-way|eight-way|scramble|gauntlet|elimination/.test(s)) return 'multi';
  if (nWin === 1 && nLoseEntities === 1) return 'singles';
  return nLoseEntities > 1 ? 'multi' : 'other';
}

const FINISH: [RegExp, Finish][] = [
  [/technical submission|by submission|submission/i, 'submission'],
  [/disqualification|\bdq\b/i, 'dq'],
  [/count-?out/i, 'countout'],
  [/referee stoppage|knockout|technical knockout/i, 'stoppage'],
  [/forfeit/i, 'forfeit'],
  [/pinfall|pin\b/i, 'pinfall'],
];

/** Parse one result line + its stipulation into a match. */
export function parseMatchLine(raw: string, stipRaw: string, n: number): ParsedMatch {
  const text = cleanWikitext(raw);
  const stipClean = cleanWikitext(stipRaw || '');
  const stip = stipClean.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[|\]\]/g, '');
  const problems: string[] = [];
  let finish: Finish = 'unknown';
  let winners: Entity[] = [], losers: Entity[] = [], resultAll: 'draw' | 'no_contest' | null = null;

  const nc = /\s+(?:ended in|went to) a no contest/i.test(text), dr = /(?:ended in a|fought to a|went to a)\s+(?:time[- ]limit\s+)?draw/i.test(text);
  if (nc || dr) {
    resultAll = nc ? 'no_contest' : 'draw'; finish = nc ? 'no_contest' : 'draw';
    const body = text.replace(/\s+(?:ended in|fought to|went to) a[\s\S]*$/i, '');
    const sides = splitTop(body, /\s+vs?\.?\s+/y);
    winners = []; losers = sides.flatMap(entities); // every entity is listed; results all equal
  } else {
    const parts = splitTop(text, /\s+defeated\s+/y);
    if (parts.length !== 2) {
      return { match_number: n, is_main_event: false, pre_show: false, match_type: 'other', stipulation: stip, is_qualifier: false, is_tournament: false,
        finish: 'unknown', title_name: null, title_outcome: 'unknown', participants: [], raw_text: text, problems: ['could not find "defeated"'], confidence: 0 };
    }
    let right = parts[1];
    for (const [re, f] of FINISH) { const tail = /\s+(?:by|via|in)\s+[\s\S]*$/i.exec(right); if (tail && re.test(tail[0])) { finish = f; break; } }
    right = right.replace(/\s+(?:by|via)\s+(?:last eliminating|pinfall|submission|technical submission|disqualification|count-?out|referee stoppage|knockout|technical knockout|forfeit)[\s\S]*$/i, '')
                 .replace(/\s+(?:to win|to retain|to become|to qualify|to advance|in the final|in a)[\s\S]*$/i, '');
    if (/last eliminating/i.test(parts[1])) finish = finish === 'unknown' ? 'other' : finish;
    winners = entities(parts[0]); losers = entities(right);
  }

  const type = matchType(stip, winners.length, losers.length);
  const separateLosers = ['multi', 'battle_royal', 'royal_rumble', 'elimination_chamber', 'mitb_ladder'].includes(type);
  if (type === 'tag' && /three-way|four-way|triple threat|fatal|elimination/i.test(stip)) problems.push('multi-team tag match: team grouping is uncertain');
  if (type === 'royal_rumble') problems.push('Royal Rumble needs entry, elimination and place data');
  if (type === 'elimination_chamber') problems.push('Elimination Chamber needs elimination counts');
  if (/cash(?:es|ed)?[- ]in/i.test(text + ' ' + stip)) problems.push('Money in the Bank cash-in needs confirming');

  const participants: ParsedParticipant[] = [];
  const push = (e: Entity, side: number, result: ParsedParticipant['result']) => {
    const people = e.members.length ? e.members : [{ name: e.name, target: e.target }];
    for (const p of people) participants.push({ raw: p.name, linkTarget: p.target, side, result, champion_going_in: e.champ,
      lost_by_dq_or_interference: result === 'loss' && finish === 'dq' ? true : undefined,
      mitb_entered: type === 'mitb_ladder' || undefined, chamber_entered: type === 'elimination_chamber' || undefined });
  };
  if (resultAll) losers.forEach((e, i) => push(e, i + 1, resultAll!));
  else {
    winners.forEach(e => push(e, 1, 'win'));
    losers.forEach((e, i) => push(e, separateLosers ? i + 2 : 2, 'loss'));
  }
  if (participants.length < 2) problems.push('fewer than 2 participants found');

  // Championship
  const titleM = /for the\s+(?:vacant\s+)?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/i.exec(stipClean) || /for the\s+(?:vacant\s+)?([A-Z][\w'’.\- ]*Championship)/.exec(stip);
  const title_name = titleM ? (titleM[2] || titleM[1]).trim() : (/\bchampionship\b/i.test(stip) ? stip : null);
  let title_outcome: TitleOutcome = 'none';
  if (title_name) {
    if (/winner takes all|and the\s+\[\[|championships?\s+and\s+/i.test(stipClean)) problems.push('more than one title on the line');
    const champW = participants.some(p => p.result === 'win' && p.champion_going_in);
    const champL = participants.some(p => p.result === 'loss' && p.champion_going_in);
    if (resultAll) title_outcome = 'retained';
    else if (champW) title_outcome = 'retained';
    else if (champL) title_outcome = 'changed';
    else if (/vacant/i.test(stip)) { title_outcome = 'changed'; }
    else { title_outcome = 'unknown'; problems.push('title match without a (c) marker'); }
  }

  return {
    match_number: n, is_main_event: false, pre_show: false, match_type: type, stipulation: stip,
    is_qualifier: /qualif/i.test(stip), is_tournament: /tournament|semi-?final|quarter-?final|first round|second round/i.test(stip),
    finish, title_name, title_outcome, cash_in: null, participants, raw_text: text, problems,
    confidence: problems.length ? 0.4 : (finish === 'unknown' && !resultAll ? 0.85 : 1),
  };
}

/** All matches from one results table, in card order. Main event = last non-pre-show match. */
export function parseResultsTable(params: Record<string, string>): ParsedMatch[] {
  const nums = Object.keys(params).map(k => /^match(\d+)$/.exec(k)).filter(Boolean).map(m => +m![1]).sort((a, b) => a - b);
  const matches = nums.map(i => {
    const m = parseMatchLine(params['match' + i], params['stip' + i] || '', i);
    m.pre_show = /^(y|yes|pre|1|true)$/i.test((params['pre' + i] || params['dark' + i] || '').trim());
    return m;
  });
  const main = [...matches].reverse().find(m => !m.pre_show);
  if (main) main.is_main_event = true;
  return matches;
}
