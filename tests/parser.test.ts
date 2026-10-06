import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMatchLine, parseDate, cleanWikitext } from '../src/shared/wikitext.ts';
import { eventToShows, infoboxHolders } from '../runner/wikipedia.ts';
import { nameKey, wrestlerId, autoAliases } from '../src/shared/normalize.ts';

const fx = (f: string) => readFileSync(new URL(`./fixtures/wikipedia/${f}`, import.meta.url), 'utf8');

test('names normalize accent-free and ignore stray characters', () => {
  assert.equal(nameKey('Mercedes Moné'), 'mercedes mone');
  assert.equal(nameKey('Léi Yǐng​ Lee'), 'lei ying lee');
  assert.equal(nameKey('"Hangman" Adam Page'), 'hangman adam page');
  assert.equal(wrestlerId('A.J. Francis'), 'w_a_j_francis');
  assert.ok(autoAliases('Hangman Adam Page').includes('adam page'));
  assert.ok(!autoAliases('LA Knight').includes('knight'));
});

test('dates from infobox templates and text', () => {
  assert.equal(parseDate('{{Start date|2026|11|28}}'), '2026-11-28');
  assert.equal(parseDate('November 15, 2026'), '2026-11-15');
  assert.equal(parseDate('2 August 2025'), '2025-08-02');
  assert.equal(parseDate('August 2–3, 2025'), '2025-08-02');
});

test('singles title change: (c) on the losing side, manager ignored', () => {
  const m = parseMatchLine('[[CM Punk]] defeated [[Roman Reigns]] (c) (with [[Paul Heyman]]) by pinfall', 'Singles match for the [[World Heavyweight Championship (WWE)|World Heavyweight Championship]]', 1);
  assert.equal(m.title_name, 'World Heavyweight Championship');
  assert.equal(m.title_outcome, 'changed');
  assert.equal(m.finish, 'pinfall');
  assert.deepEqual(m.participants.map(p => [p.raw, p.side, p.result, p.champion_going_in]), [['CM Punk', 1, 'win', false], ['Roman Reigns', 2, 'loss', true]]);
  assert.equal(m.problems.length, 0);
});

test('DQ marks the loser, title retained', () => {
  const m = parseMatchLine('[[Chelsea Green]] (c) defeated [[Tiffany Stratton]] by disqualification', "Singles match for the [[WWE Women's Championship]]", 1);
  assert.equal(m.finish, 'dq'); assert.equal(m.title_outcome, 'retained');
  assert.equal(m.participants[1].lost_by_dq_or_interference, true);
});

test('multi-person: each loser is their own side', () => {
  const m = parseMatchLine('[[Iyo Sky]] defeated [[Lola Vice]], [[Liv Morgan]], and [[Rhea Ripley]] by pinfall', 'Fatal four-way match', 1);
  assert.equal(m.match_type, 'multi');
  assert.deepEqual(m.participants.map(p => p.side), [1, 2, 3, 4]);
});

test('tag team with members in parentheses expands to individuals', () => {
  const m = parseMatchLine('[[The Young Bucks]] ([[Matt Jackson]] and [[Nick Jackson]]) (c) defeated [[FTR (professional wrestling)|FTR]] ([[Cash Wheeler]] and [[Dax Harwood]]) by pinfall', 'Tag team match for the [[AEW World Tag Team Championship]]', 1);
  assert.equal(m.match_type, 'tag');
  assert.deepEqual(m.participants.map(p => [p.raw, p.side, p.result]), [['Matt Jackson', 1, 'win'], ['Nick Jackson', 1, 'win'], ['Cash Wheeler', 2, 'loss'], ['Dax Harwood', 2, 'loss']]);
  assert.equal(m.title_outcome, 'retained');
});

test('no contest has no winner', () => {
  const m = parseMatchLine('[[Seth Rollins]] vs. [[Gunther (wrestler)|Gunther]] ended in a no contest', 'Singles match', 1);
  assert.equal(m.finish, 'no_contest');
  assert.deepEqual(m.participants.map(p => [p.raw, p.result]), [['Seth Rollins', 'no_contest'], ['Gunther', 'no_contest']]);
});

test('Money in the Bank: entries + one winner, publishable', () => {
  const m = parseMatchLine('[[Lola Vice]] defeated [[Becky Lynch]], [[Charlotte Flair]] and [[Sol Ruca]]', '[[Money in the Bank ladder match]]', 1);
  assert.equal(m.match_type, 'mitb_ladder');
  assert.ok(m.participants.every(p => p.mitb_entered));
  assert.equal(m.problems.length, 0);
});

test('Royal Rumble and unparseable lines are held, never guessed', () => {
  const r = parseMatchLine('[[Drew McIntyre]] won by last eliminating [[LA Knight]]', '20-man [[Royal Rumble match]]', 1);
  assert.ok(r.problems.length > 0); assert.equal(r.confidence, 0);
});

test('event article -> two nights, pre-show flagged, main event = last match', () => {
  const { shows } = eventToShows(1, 'Test Slam (2026)', fx('synthetic-wwe-event.wikitext'), '2026-12-01');
  assert.equal(shows.length, 2);
  assert.deepEqual(shows.map(s => [s.name, s.date, s.promotion]), [['Test Slam Night 1', '2026-11-28', 'WWE'], ['Test Slam Night 2', '2026-11-29', 'WWE']]);
  assert.equal(shows[0].matches.length, 6);
  assert.equal(shows[0].matches[0].pre_show, true);
  assert.equal(shows[0].matches.filter(m => m.is_main_event).map(m => m.match_number)[0], 6);
});

test('future events are skipped', () => {
  const r = eventToShows(1, 'Test Slam (2026)', fx('synthetic-wwe-event.wikitext'), '2026-11-01');
  assert.equal(r.shows.length, 0); assert.match(r.skipped!, /not happened/);
});

test('championship infobox holders (team with members)', () => {
  assert.deepEqual(infoboxHolders(fx('synthetic-title-infobox.wikitext')), ['Matt Jackson', 'Nick Jackson']);
});

test('cleanWikitext strips refs and formatting', () => {
  assert.equal(cleanWikitext("'''Bold'''<ref name=a>{{cite web|x}}</ref> text<!-- c -->"), 'Bold text');
});
