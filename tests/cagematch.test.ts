import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseEventList, eventToShow, toWikiLine, isBlockPage, followed, fetchCagematch, type CmState } from '../runner/cagematch.ts';
import { D1Sqlite } from './d1sqlite.ts';
import { buildSeed } from '../scripts/seed.ts';
import { lookup, applyBatch } from '../src/shared/ingest.ts';
import { Resolver } from '../runner/resolve.ts';
import { championships, status } from '../src/worker/api.ts';

const fx = (f: string) => readFileSync(new URL(`./fixtures/cagematch/${f}`, import.meta.url), 'utf8');
const PROMOS = [{ code: 'WWE' as const, nr: 1, match: '^(World Wrestling Entertainment|WWE)\\b' }, { code: 'AEW' as const, nr: 2287, match: 'All Elite Wrestling|^AEW\\b' }, { code: 'TNA' as const, nr: 5, match: 'Total Nonstop Action|^TNA\\b|Impact Wrestling' }];
const TITLES = ['World Heavyweight Championship', "WWE Women's Championship", 'World Tag Team Championship'];

test('results list: events, dates and promotions; only followed promotions kept', () => {
  const ev = parseEventList(fx('synthetic-results-list.html'));
  assert.equal(ev.length, 4);
  assert.deepEqual(ev[0], { id: '501001', date: '2026-10-12', name: 'WWE Monday Night RAW #1700', promotionNr: 1, promotionName: 'World Wrestling Entertainment' });
  assert.deepEqual(ev.filter(e => followed(PROMOS, e.promotionNr, e.promotionName)).map(e => e.id), ['501001', '501002', '501003']);
});

test('promotion name decides; the number is only a fallback', () => {
  assert.equal(followed(PROMOS, 5, 'Some Other Promotion'), undefined);
  assert.equal(followed(PROMOS, 5, '')?.code, 'TNA');
});

test('result lines convert to the shared format', () => {
  assert.equal(toWikiLine('<a href="?id=2&amp;nr=3">CM Punk</a> defeats <a href="?id=2&amp;nr=4">Roman Reigns</a> (c) (24:51) - TITLE CHANGE !!!').line, '[[CM Punk]] defeated [[Roman Reigns]] (c)');
  assert.equal(toWikiLine('<a href="?id=2&amp;nr=6">A</a> defeats <a href="?id=2&amp;nr=7">B</a> by DQ (6:01)').line, '[[A]] defeated [[B]] by disqualification');
  assert.equal(toWikiLine('<a href="?id=2&amp;nr=1">A</a> vs. <a href="?id=2&amp;nr=2">B</a> - Time Limit Draw (20:00)').line, '[[A]] vs. [[B]] ended in a draw');
  assert.ok(toWikiLine('<a href="?id=2&amp;nr=1">A</a> vs. <a href="?id=2&amp;nr=2">B</a> - Double Count Out').problem);
});

test('event page -> show with every match parsed', () => {
  const { show } = eventToShow('501001', fx('synthetic-event-raw.html'), { promotions: PROMOS, championships: TITLES });
  assert.ok(show);
  assert.deepEqual([show!.name, show!.date, show!.promotion, show!.show_type], ['WWE Monday Night RAW #1700', '2026-10-12', 'WWE', 'weekly']);
  const m = show!.matches;
  assert.equal(m.length, 6);
  assert.deepEqual([m[1].title_name, m[1].title_outcome, m[1].problems], ['World Heavyweight Championship', 'changed', []]);
  assert.deepEqual(m[1].participants.map(p => p.raw), ['CM Punk', 'Roman Reigns']);   // manager dropped
  assert.equal(m[2].finish, 'dq'); assert.equal(m[2].title_outcome, 'retained');
  assert.deepEqual(m[3].participants.map(p => [p.raw, p.side]), [['Jey Uso', 1], ['Jimmy Uso', 1], ['Bron Breakker', 2], ['Austin Theory', 2]]);
  assert.equal(m[4].finish, 'no_contest');
  assert.equal(m[5].finish, 'submission'); assert.equal(m[5].is_main_event, true);
});

test('NXT shows under WWE are filed as NXT', () => {
  const html = fx('synthetic-event-raw.html').replace(/WWE Monday Night RAW #1700/g, 'WWE NXT #800');
  assert.equal(eventToShow('501002', html, { promotions: PROMOS, championships: TITLES }).show!.promotion, 'NXT');
});

test('firewall pages are recognised', () => {
  assert.equal(isBlockPage(200, fx('synthetic-event-blocked.html')), true);
  assert.equal(isBlockPage(429, ''), true);
  assert.equal(isBlockPage(200, fx('synthetic-event-raw.html')), false);
});

test('fetching: gentle, budgeted, and stops for 24h on a firewall response', async () => {
  const calls: string[] = []; const real = globalThis.fetch;
  const pages: Record<string, string> = { list: fx('synthetic-results-list.html'), '501001': fx('synthetic-event-raw.html'), '501002': fx('synthetic-event-blocked.html') };
  globalThis.fetch = (async (url: string, init: any) => { calls.push(url); assert.match(init.headers['user-agent'], /RingsideResultsDB.*@/);
    const key = /nr=(\d+)/.exec(url)?.[1] || 'list'; return new Response(pages[key] ?? '<html></html>', { status: 200 }); }) as any;
  try {
    const st: CmState = { day: '', used: 0, blockedUntil: 0, seen: {} };
    const o = { userAgent: 'RingsideResultsDB/1.0 (test; me@example.com)', today: '2026-10-14', minDate: '2026-01-01', promotions: PROMOS, dailyBudget: 40, minGapMs: 0, recheckDays: 2, championships: TITLES };
    const r = await fetchCagematch(st, o, () => {});
    assert.equal(r.shows.length, 1);
    assert.ok(r.errors.some(e => /firewall/.test(e)));
    assert.ok(st.blockedUntil > Date.now() + 23 * 3600e3);
    assert.equal(calls.length, 3, 'list + 2 events, then it stopped');
    const again = await fetchCagematch(st, o, () => {});
    assert.equal(again.pages, 0, 'paused: no requests at all');
    const st2: CmState = { day: '2026-10-14', used: 40, blockedUntil: 0, seen: {} };
    await assert.rejects(fetchCagematch(st2, o, () => {}), /budget/);
  } finally { globalThis.fetch = real; }
});

test('pipeline: Cagematch show saves, moves the belt, and is idempotent', async () => {
  const dir = mkdtempSync(tmpdir() + '/cm-'); writeFileSync(dir + '/seed.sql', buildSeed('data/seed').sql);
  const db = new D1Sqlite(['migrations/0001_init.sql', 'migrations/0002_cagematch.sql', dir + '/seed.sql']);
  const L = await lookup(db);
  assert.equal(L.config['cagematch_permission_confirmed'], 'true');
  const promos = JSON.parse(L.config['cagematch.promotions']); assert.equal(promos.length, 3);
  const run = async () => { const R = new Resolver(await lookup(db)); const s = R.show(eventToShow('501001', fx('synthetic-event-raw.html'), { promotions: promos, championships: L.championships.map(c => c.name) }).show!);
    return applyBatch(db, { run: { id: 'r' + Math.random(), source: 'cagematch', started_at: 'x', pages_fetched: 1, errors: [] }, shows: [s], title_holders: [], unknown_names: [...R.unknown.values()], finish: true }); };
  const first: any = await run();
  assert.equal(first.newM, 6, 'all six matches publish');
  const whc = (await championships(db)).find(c => c.name === 'World Heavyweight Championship')!;
  assert.deepEqual(whc.current.map((h: any) => h.name), ['CM Punk']);
  const second: any = await run();
  assert.equal(second.newM + second.changed, 0);
  assert.equal((await status(db)).sources.cagematch, true);
});
