// Scheduled ingestion run (GitHub Actions). Fetch -> parse -> resolve -> diff -> write to D1.
// Env: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (D1 edit), D1_DATABASE_ID, CONTACT_EMAIL, REPO_URL
// Options: DRY_RUN=1 (no writes), CAPTURE=1 (save fetched pages to ./capture), STATE_FILE (default .state/wikipedia.json)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { D1Http } from './d1http.ts';
import { Resolver } from './resolve.ts';
import { fetchEvents, fetchTitleHolders, type WikiState } from './wikipedia.ts';
import { fetchCagematch, type CmState } from './cagematch.ts';
import { requestsMade, SourceBlocked } from './http.ts';
import { lookup, applyBatch, dailyMaintenance } from '../src/shared/ingest.ts';
import type { IngestBatch } from '../src/shared/types.ts';

const env = process.env;
const need = (k: string) => { if (!env[k]) { console.error(`Missing ${k}. Add it under GitHub > Settings > Secrets and variables > Actions.`); process.exit(2); } return env[k]!; };
const log = (s: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);

async function main() {
  const dry = env.DRY_RUN === '1';
  const db = new D1Http(need('CLOUDFLARE_ACCOUNT_ID'), need('D1_DATABASE_ID'), need('CLOUDFLARE_API_TOKEN'), dry);
  const contact = need('CONTACT_EMAIL');
  const userAgent = `RingsideResultsDB/1.0 (${env.REPO_URL || 'personal fantasy wrestling league'}; ${contact})`;
  const today = env.TODAY || new Date().toISOString().slice(0, 10);
  const stateFile = env.STATE_FILE || '.state/wikipedia.json';
  const state: WikiState = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { revs: {}, titlePages: {}, titleRevs: {} };
  if (env.FULL_RECHECK === '1') { state.revs = {}; state.titleRevs = {}; }

  const L = await lookup(db);
  const cmOn = L.config['source.cagematch.enabled'] === 'true' && L.config['cagematch_permission_confirmed'] === 'true';
  if (L.config['source.cagematch.enabled'] === 'true' && !cmOn) log('Cagematch is switched on but permission is not recorded; it stays off.');
  const wikiOn = L.config['source.wikipedia.enabled'] === 'true';
  const wikiEvents = wikiOn && !(cmOn && L.config['source.wikipedia.events'] === 'false');
  const run = { id: `run_${Date.now()}`, source: [cmOn && 'cagematch', wikiOn && 'wikipedia'].filter(Boolean).join('+') || 'none', started_at: new Date().toISOString(), pages_fetched: 0, errors: [] as string[] };
  if (!cmOn && !wikiOn) { log('All sources are disabled in config; nothing to do.'); return; }
  const cmFile = (env.STATE_FILE ? env.STATE_FILE.replace(/[^/]+$/, '') : '.state/') + 'cagematch.json';
  const cmState: CmState = existsSync(cmFile) ? JSON.parse(readFileSync(cmFile, 'utf8')) : { day: '', used: 0, blockedUntil: 0, seen: {} };
  if (env.FULL_RECHECK === '1') cmState.seen = {};

  const capture = env.CAPTURE === '1' ? (name: string, text: string) => { mkdirSync('capture', { recursive: true }); writeFileSync(`capture/${name.replace(/[^\w.-]+/g, '_')}.${name.startsWith('cagematch') ? 'html' : 'wikitext'}`, text); } : undefined;
  const o = { userAgent, today, minDate: env.MIN_DATE || L.config['min_event_date'] || '2026-01-01', extraCategories: (L.config['wikipedia.extra_categories'] || '').split('|').filter(Boolean), capture };
  const R = new Resolver(L);

  let shows: IngestBatch['shows'] = []; let facts: IngestBatch['title_holders'] = [];
  const fresh = (list: IngestBatch['shows']) => list.map(s => R.show(s)).filter(s => L.show_hashes[`${s.source}:${s.source_event_id}`] !== s.content_hash);
  if (cmOn) {
    try {
      let promotions; try { promotions = JSON.parse(L.config['cagematch.promotions'] || '[]'); } catch { promotions = []; run.errors.push('cagematch.promotions config is not valid JSON'); }
      const cm = await fetchCagematch(cmState, { userAgent, today, minDate: o.minDate, promotions, dailyBudget: +(L.config['cagematch.daily_budget'] || 40),
        minGapMs: Math.max(5000, +(L.config['cagematch.min_gap_ms'] || 6000)), recheckDays: +(L.config['cagematch.recheck_days'] || 2), championships: L.championships.map(c => c.name), capture }, log);
      run.pages_fetched += cm.pages; run.errors.push(...cm.errors); shows.push(...fresh(cm.shows));
    } catch (e) { run.errors.push(`Cagematch: ${String(e instanceof Error ? e.message : e)}`); if (!(e instanceof SourceBlocked)) console.error(e); }
  }
  if (wikiOn) {
    try {
      if (wikiEvents) { const ev = await fetchEvents(state, o, log); run.pages_fetched += ev.pages; run.errors.push(...ev.errors); shows.push(...fresh(ev.shows)); }
      const th = await fetchTitleHolders(L.championships, state, o, log); run.pages_fetched += th.pages; run.errors.push(...th.errors);
      facts = th.facts.map(f => R.holders(f)).filter(f => f.holder_ids?.length);
    } catch (e) { run.errors.push(`Wikipedia: ${String(e instanceof Error ? e.message : e)}`); if (!(e instanceof SourceBlocked)) console.error(e); }
  }
  log(`${run.pages_fetched} pages fetched (${requestsMade} requests). ${shows.length} new/changed shows, ${facts.length} title-holder checks, ${R.unknown.size} unknown names.`);
  for (const s of shows) log(`  ${s.date} ${s.promotion} ${s.name}: ${s.matches.length} matches${s.matches.some(m => m.problems.length) ? ' (some need data)' : ''}`);

  if (dry) { writeFileSync('dry-run.json', JSON.stringify({ shows, facts, unknown: [...R.unknown.values()] }, null, 2)); log('Dry run: wrote dry-run.json, no database writes.'); }
  // One show per call keeps each D1 request small; the last call closes the run record.
  const chunks = shows.length ? shows.map(s => [s]) : [[]];
  for (let i = 0; i < chunks.length; i++) {
    const last = i === chunks.length - 1;
    const res = await applyBatch(db, { run, shows: chunks[i], title_holders: last ? facts : [], unknown_names: last ? [...R.unknown.values()] : [], finish: last });
    if (chunks[i][0]) log(`  saved ${chunks[i][0].name}: ${JSON.stringify(res)}`);
  }
  await dailyMaintenance(db);
  if (!dry) { mkdirSync(stateFile.replace(/\/[^/]+$/, ''), { recursive: true }); writeFileSync(stateFile, JSON.stringify(state)); writeFileSync(cmFile, JSON.stringify(cmState)); }
  log(`Done. D1 calls: ${db.calls}, statements written: ${db.writes}.`);
  if (run.errors.length) { log('Errors:\n' + run.errors.join('\n')); if (run.errors.some(e => /403|429|firewall/i.test(e))) process.exitCode = 1; }
}

main().catch(e => { console.error(e); process.exit(1); });
