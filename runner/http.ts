// Polite HTTP client: one request at a time per host, minimum gap, descriptive User-Agent, backoff.
const lastHit = new Map<string, number>();
export let requestsMade = 0;

export class SourceBlocked extends Error {}

export async function politeGet(url: string, opts: { userAgent: string; minGapMs: number; maxRetries?: number }): Promise<Response> {
  const host = new URL(url).host;
  for (let attempt = 1; ; attempt++) {
    const wait = (lastHit.get(host) || 0) + opts.minGapMs - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastHit.set(host, Date.now()); requestsMade++;
    const res = await fetch(url, { headers: { 'user-agent': opts.userAgent, 'api-user-agent': opts.userAgent, accept: 'application/json' } });
    if (res.status === 403) throw new SourceBlocked(`${host} answered 403 Forbidden; stopping this source for this run`);
    if ((res.status === 429 || res.status === 503) && attempt <= (opts.maxRetries ?? 3)) {
      const ra = Number(res.headers.get('retry-after')) || 5 * attempt;
      await new Promise(r => setTimeout(r, Math.min(ra, 60) * 1000));
      continue;
    }
    if (res.status === 429) throw new SourceBlocked(`${host} kept answering 429 Too Many Requests; stopping this source for this run`);
    return res;
  }
}
