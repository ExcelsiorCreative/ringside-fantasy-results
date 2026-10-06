// End to end: seed -> parse fixtures -> resolve -> apply -> API, on an in-memory database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { D1Sqlite } from './d1sqlite.ts';
import { buildSeed } from '../scripts/seed.ts';
import { lookup, applyBatch } from '../src/shared/ingest.ts';
import { Resolver } from '../runner/resolve.ts';
import { eventToShows, infoboxHolders } from '../runner/wikipedia.ts';
import { wrestlers, championships, changes, exportPlayers, status } from '../src/worker/api.ts';

const fx = (f: string) => readFileSync(new URL(`./fixtures/wikipedia/${f}`, import.meta.url), 'utf8');
const TODAY = '2026-12-01';

async function fresh() {
  const dir = mkdtempSync(tmpdir() + '/rs-');
  writeFileSync(dir + '/seed.sql', buildSeed('data/seed').sql);
  return new D1Sqlite(['migrations/0001_init.sql', dir + '/seed.sql']);
}
async function ingest(db: D1Sqlite, wwe = fx('synthetic-wwe-event.wikitext')) {
  const R = new Resolver(await lookup(db));
  const shows = [...eventToShows(1001, 'Test Slam (2026)', wwe, TODAY).shows, ...eventToShows(1002, 'Test Revolution (2026)', fx('synthetic-aew-event.wikitext'), TODAY).shows].map(s => R.show(s));
  const out = [];
  for (let i = 0; i < shows.length; i++)
    out.push(await applyBatch(db, { run: { id: 'r' + Date.now(), source: 'wikipedia', started_at: new Date().toISOString(), pages_fetched: 2, errors: [] }, shows: [shows[i]], title_holders: [], unknown_names: i === shows.length - 1 ? [...R.unknown.values()] : [], finish: i === shows.length - 1 }));
  return { out, R };
}
const one = async (db: D1Sqlite, sql: string, ...p: unknown[]) => (await db.prepare(sql).bind(...p).first<any>());

test('full pipeline: publish, hold, title change, DQ, injuries, news, records', async () => {
  const db = await fresh();
  const { R } = await ingest(db);
  // statuses
  const counts = await one(db, `SELECT sum(status='published') pub, sum(status='held') held FROM matches`);
  assert.equal(counts.pub, 9); // 6 on night 1 + MITB on night 2 + 2 AEW
  const held = (await db.prepare(`SELECT id, hold_reason FROM matches WHERE status='held' ORDER BY id`).all<any>()).results;
  assert.deepEqual(held.map((h: any) => h.id), ['wikipedia:1001:n2:1', 'wikipedia:1001:n2:3']);
  assert.match(held[0].hold_reason, /unknown name: Mystery Newcomer/);
  assert.ok(R.unknown.has('mystery newcomer'));
  // title change moved the belt
  const whc = (await championships(db)).find(c => c.name === 'World Heavyweight Championship')!;
  assert.deepEqual(whc.current.map((h: any) => h.name), ['CM Punk']);
  assert.equal(whc.reigns.length, 2);
  // DQ loss recorded
  assert.equal((await one(db, `SELECT lost_by_dq_or_interference d FROM match_participants WHERE raw_name='Tiffany Stratton'`)).d, 1);
  // Rhea Ripley wrestled -> injury closed automatically
  assert.equal((await one(db, `SELECT ended_reason r FROM status_entries WHERE wrestler_id='w_rhea_ripley'`)).r, 'appeared in a match');
  // records = baseline + new results; news written from facts
  const ws = await wrestlers(db);
  const punk = ws.find(w => w.id === 'w_cm_punk')!;
  assert.deepEqual([punk.record_year_wins, punk.record_year_losses, punk.champion], [35, 2, true]);
  assert.match(punk.news[0].text, /^Won the World Heavyweight Championship from Roman Reigns at Test Slam Night 1/);
  assert.equal(ws.find(w => w.id === 'w_roman_reigns')!.champion, false);
  // tag team expanded; Young Bucks retained
  const bucks = (await championships(db)).find(c => c.name === 'AEW World Tag Team Championship')!;
  assert.deepEqual(bucks.current.map((h: any) => h.name).sort(), ['Matt Jackson', 'Nick Jackson']);
  // CSV export keeps the original columns
  const csv = await (await exportPlayers(db)).text();
  assert.match(csv.split('\n')[0], /^wrestler_id,player_name,promotion,gender,overall_rank,rank_in_gender,is_champion,championships,injured,injury_note/);
  // status page
  const st = await status(db);
  assert.equal(st.counts.held, 2); assert.ok(st.unknown_names.some((u: any) => u.raw_name === 'Mystery Newcomer'));
});

test('tag team title holders count as individual champions', async () => {
  const db = await fresh();
  const ws = await wrestlers(db);
  for (const id of ['w_bron_breakker', 'w_austin_theory', 'w_tama_tonga', 'w_talla_tonga', 'w_fallon_henley', 'w_lainey_reid', 'w_matt_jackson'])
    assert.equal(ws.find(w => w.id === id)!.champion, true, id);
  assert.deepEqual(ws.find(w => w.id === 'w_bron_breakker')!.championships, ['World Tag Team Championship']);
  const row = (await (await exportPlayers(db)).text()).split('\n').find(l => l.startsWith('w_fallon_henley,'))!;
  assert.match(row, /,yes,Women's Tag Team Championship,/);
});

test('re-running the same input writes nothing new (idempotent)', async () => {
  const db = await fresh();
  await ingest(db);
  const before = await one(db, 'SELECT max(sequence) s FROM change_log');
  const verBefore = await one(db, 'SELECT sum(version) v FROM matches');
  await ingest(db);
  assert.equal((await one(db, 'SELECT sum(version) v FROM matches')).v, verBefore.v);
  const after = await one(db, `SELECT count(*) c FROM change_log WHERE sequence > ? AND entity IN ('show','match')`, before.s);
  assert.equal(after.c, 0);
});

test('a corrected result updates once and rebuilds title history', async () => {
  const db = await fresh();
  await ingest(db);
  const corrected = fx('synthetic-wwe-event.wikitext').replace('[[CM Punk]] defeated [[Roman Reigns]] (c) (with [[Paul Heyman]]) by pinfall', '[[Roman Reigns]] (c) (with [[Paul Heyman]]) defeated [[CM Punk]] by pinfall');
  await ingest(db, corrected);
  const whc = (await championships(db)).find(c => c.name === 'World Heavyweight Championship')!;
  assert.deepEqual(whc.current.map((h: any) => h.name), ['Roman Reigns']);
  assert.equal(whc.reigns.length, 1);
  assert.equal((await one(db, `SELECT version v FROM matches WHERE id='wikipedia:1001:n1:2'`)).v, 2);
});

test('an unknown name publishes once the wrestler is added', async () => {
  const db = await fresh();
  await ingest(db);
  await db.batch([db.prepare(`INSERT INTO wrestlers(id,name,name_search,promotion,gender) VALUES('w_mystery_newcomer','Mystery Newcomer','mystery newcomer','WWE','M')`),
    db.prepare(`INSERT INTO aliases(alias_search,alias,wrestler_id) VALUES('mystery newcomer','mystery newcomer','w_mystery_newcomer')`)]);
  await ingest(db);
  assert.equal((await one(db, `SELECT status FROM matches WHERE id='wikipedia:1001:n2:1'`)).status, 'published');
});

test('sync feed returns changes after a cursor with current data', async () => {
  const db = await fresh();
  const start = (await one(db, 'SELECT max(sequence) s FROM change_log')).s;
  await ingest(db);
  const page = await changes(db, start, 500);
  assert.ok(page.items.length > 0);
  const show = page.items.find(i => i.entity === 'show' && i.id === 'wikipedia:1001:n1')!;
  assert.equal((show.data as any).matches.length, 6);
  assert.equal((await changes(db, page.next_cursor, 500)).items.length, 0);
});

test('title holder check from a championship infobox', async () => {
  const db = await fresh();
  const R = new Resolver(await lookup(db));
  const f = R.holders({ championship_id: 'c_aew_world_tag_team_championship', holder_names: infoboxHolders(fx('synthetic-title-infobox.wikitext')), as_of: TODAY, source: 'wikipedia_infobox', source_url: 'x' });
  const r = await applyBatch(db, { run: { id: 'r1', source: 'wikipedia', started_at: 'x', pages_fetched: 1, errors: [] }, shows: [], title_holders: [f], unknown_names: [], finish: true });
  assert.equal(r.writes, 0, 'same holders as the seed -> nothing written');
});
