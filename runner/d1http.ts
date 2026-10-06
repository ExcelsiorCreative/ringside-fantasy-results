// D1 over Cloudflare's REST API, with the same interface the Worker binding has.
// Used by the GitHub Actions runner so writes don't count against Worker CPU/query limits.

class Stmt implements D1PreparedStatement {
  db: D1Http; sql: string; params: unknown[];
  constructor(db: D1Http, sql: string, params: unknown[] = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...values: unknown[]): D1PreparedStatement { return new Stmt(this.db, this.sql, values.map(v => (typeof v === 'boolean' ? +v : v === undefined ? null : v))); }
  async all<T>(): Promise<D1Result<T>> { return (await this.db.batch([this]))[0] as D1Result<T>; }
  async first<T>(): Promise<T | null> { const r = await this.all<T>(); return r.results[0] ?? null; }
  async run(): Promise<D1Result> { return this.all(); }
}

export class D1Http implements D1Database {
  writes = 0; calls = 0;
  private accountId: string; private databaseId: string; private token: string; private dryRun: boolean;
  constructor(accountId: string, databaseId: string, token: string, dryRun = false) { this.accountId = accountId; this.databaseId = databaseId; this.token = token; this.dryRun = dryRun; }
  prepare(sql: string): D1PreparedStatement { return new Stmt(this, sql); }
  async batch(stmts: D1PreparedStatement[]): Promise<D1Result[]> {
    const list = stmts as Stmt[];
    if (this.dryRun && list.some(s => !/^\s*SELECT/i.test(s.sql))) {
      // dry run: execute reads, pretend writes succeeded
      const reads = list.filter(s => /^\s*SELECT/i.test(s.sql));
      const rr = reads.length ? await this.send(reads) : [];
      let i = 0; return list.map(s => (/^\s*SELECT/i.test(s.sql) ? rr[i++] : { results: [], success: true, meta: {} }));
    }
    return this.send(list);
  }
  private async send(list: Stmt[]): Promise<D1Result[]> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/d1/database/${this.databaseId}/query`;
    for (let attempt = 1; ; attempt++) {
      this.calls++;
      const res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ batch: list.map(s => ({ sql: s.sql, params: s.params })) }) });
      const body: any = await res.json().catch(() => ({}));
      if (res.ok && body.success !== false) {
        this.writes += list.filter(s => !/^\s*SELECT/i.test(s.sql)).length;
        return (body.result || []).map((r: any) => ({ results: r.results || [], success: r.success !== false, meta: r.meta || {} }));
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 4) { await new Promise(r => setTimeout(r, 2000 * attempt)); continue; }
      throw new Error(`D1 API ${res.status}: ${JSON.stringify(body.errors || body).slice(0, 500)}`);
    }
  }
}
