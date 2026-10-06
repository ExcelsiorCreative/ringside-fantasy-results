// Publish rules. A match is only published automatically when this returns no problems.
import type { ParsedMatch } from './types.ts';

export interface TitleContext { holders: string[]; holders_per_reign: number }

export function validateMatch(m: ParsedMatch, title: TitleContext | null): string[] {
  const p = m.participants, problems: string[] = [];
  if (p.length < 2) problems.push('fewer than 2 participants');
  const unresolved = p.filter(x => !x.wrestler_id).map(x => x.raw);
  if (unresolved.length) problems.push('unknown name: ' + unresolved.join(', '));
  const ids = p.map(x => x.wrestler_id).filter(Boolean) as string[];
  if (new Set(ids).size !== ids.length) problems.push('a wrestler appears twice');

  const results = new Set(p.map(x => x.result));
  if (m.finish === 'no_contest' && [...results].some(r => r !== 'no_contest')) problems.push('no contest must have no winner');
  if (m.finish === 'draw' && [...results].some(r => r !== 'draw')) problems.push('draw must have no winner');
  if (m.finish !== 'no_contest' && m.finish !== 'draw') {
    const winSides = new Set(p.filter(x => x.result === 'win').map(x => x.side));
    if (winSides.size !== 1) problems.push('needs exactly one winning side');
    if (p.some(x => x.result !== 'win' && x.result !== 'loss')) problems.push('mixed results');
    if (p.some(x => x.result === 'loss' && winSides.has(x.side))) problems.push('a side both won and lost');
  }
  if (p.some(x => x.lost_by_dq_or_interference && x.result !== 'loss')) problems.push('DQ loss on a non-loser');

  if (m.match_type === 'tag' || m.match_type === 'trios') {
    const sizes = new Map<number, number>(); p.forEach(x => sizes.set(x.side, (sizes.get(x.side) || 0) + 1));
    if (new Set(sizes.values()).size > 1) problems.push('tag sides are uneven (handicap?)');
  }
  if (m.match_type === 'mitb_ladder' && p.filter(x => x.result === 'win').length !== 1) problems.push('Money in the Bank needs exactly one winner');
  if (m.match_type === 'royal_rumble') {
    const firsts = p.filter(x => x.rumble_place === 1);
    if (firsts.length !== 1 || firsts[0].result !== 'win') problems.push('Royal Rumble needs exactly one winner in 1st place');
  }

  if (m.title_name) {
    if (!m.title_championship_id) problems.push('championship not recognised: ' + m.title_name);
    else if (title) {
      const winners = p.filter(x => x.result === 'win').map(x => x.wrestler_id!);
      const losers = p.filter(x => x.result === 'loss').map(x => x.wrestler_id!);
      if (m.title_outcome === 'retained' && m.finish !== 'no_contest' && m.finish !== 'draw' && title.holders.length && !title.holders.some(h => winners.includes(h)))
        problems.push('title "retained" but no current holder won');
      if (m.title_outcome === 'changed') {
        if (title.holders.length && !title.holders.some(h => losers.includes(h))) problems.push('title "changed" but no current holder lost');
        if (winners.length !== title.holders_per_reign) problems.push(`new champions count ${winners.length} ≠ ${title.holders_per_reign} holders per reign`);
      }
      if (m.title_outcome === 'unknown') problems.push('title outcome unclear');
    }
  }
  return [...new Set(problems.concat(m.problems))];
}
