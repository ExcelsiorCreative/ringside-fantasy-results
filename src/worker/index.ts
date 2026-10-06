// Cloudflare Worker entry: read-only API, public status and a tiny daily cron.
// Writes are done by the GitHub Actions runner through Cloudflare's D1 API (see runner/).
import { dailyMaintenance } from '../shared/ingest.ts';
import { json, checkApiKey, wrestlers, shows, championships, changes, exportPlayers, exportChampionships, exportResults, status, OPENAPI } from './api.ts';

async function cached(req: Request, ctx: ExecutionContext, seconds: number, make: () => Promise<Response>): Promise<Response> {
  const key = new Request(new URL(req.url).toString(), { method: 'GET' });
  const hit = await caches.default.match(key); if (hit) return hit;
  const res = await make();
  if (res.ok) { const copy = new Response(res.clone().body, res); copy.headers.set('cache-control', `public, max-age=${seconds}`); ctx.waitUntil(caches.default.put(key, copy)); }
  return res;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url); const p = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (req.method === 'OPTIONS') return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, OPTIONS' } });
      if (p === '/' || p === '/health') return json({ ok: true, service: 'ringside-results-db', docs: '/api/v1/openapi.json', status: '/status' });
      if (p === '/status') return cached(req, ctx, 120, async () => json(await status(env.DB)));
      if (p === '/api/v1/openapi.json') return json(OPENAPI);

      if (p.startsWith('/api/v1/')) {
        if (req.method !== 'GET') return json({ error: 'read-only API' }, 405);
        if (!(await checkApiKey(env.DB, req))) return json({ error: 'missing or invalid API key' }, 401);
        ctx.waitUntil(env.DB.prepare(`INSERT INTO usage_daily(day,api_requests) VALUES(date('now'),1) ON CONFLICT(day) DO UPDATE SET api_requests=usage_daily.api_requests+1`).run());
        const q = url.searchParams;
        switch (p) {
          case '/api/v1/changes': {
            const cursor = Math.max(0, parseInt(q.get('cursor') || '0') || 0), limit = Math.min(500, Math.max(1, parseInt(q.get('limit') || '500') || 500));
            return cached(req, ctx, 60, async () => json(await changes(env.DB, cursor, limit)));
          }
          case '/api/v1/wrestlers': return cached(req, ctx, 600, async () => json({ items: await wrestlers(env.DB, undefined, q.get('updated_since') || undefined) }));
          case '/api/v1/shows': return cached(req, ctx, 300, async () => json({ items: await shows(env.DB, { from: q.get('from') || undefined, to: q.get('to') || undefined, updatedSince: q.get('updated_since') || undefined }) }));
          case '/api/v1/championships': return cached(req, ctx, 600, async () => json({ items: await championships(env.DB) }));
          case '/api/v1/aliases': return cached(req, ctx, 600, async () => json({ items: (await env.DB.prepare('SELECT alias_search AS alias, wrestler_id FROM aliases').all()).results }));
          case '/api/v1/stables': return cached(req, ctx, 600, async () => json({ items: (await env.DB.prepare(`SELECT s.id, s.name, s.type, s.promotion, group_concat(m.wrestler_id) AS members FROM stables s LEFT JOIN stable_members m ON m.stable_id=s.id AND m.left_on IS NULL GROUP BY s.id`).all()).results }));
          case '/api/v1/export/players.csv': return cached(req, ctx, 600, () => exportPlayers(env.DB));
          case '/api/v1/export/championships.csv': return cached(req, ctx, 600, () => exportChampionships(env.DB));
          case '/api/v1/export/results.csv': return cached(req, ctx, 600, () => exportResults(env.DB, q.get('from') || undefined, q.get('to') || undefined));
        }
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      console.error(JSON.stringify({ path: p, error: String(e) }));
      return json({ error: 'server error' }, 500);
    }
  },

  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(dailyMaintenance(env.DB));
  },
};
