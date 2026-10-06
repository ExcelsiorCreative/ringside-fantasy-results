// In-memory D1 stand-in for tests, backed by node:sqlite.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

class Stmt implements D1PreparedStatement {
  d: DatabaseSync; sql: string; params: unknown[];
  constructor(d: DatabaseSync, sql: string, params: unknown[] = []) { this.d = d; this.sql = sql; this.params = params; }
  bind(...v: unknown[]) { return new Stmt(this.d, this.sql, v.map(x => (typeof x === 'boolean' ? +x : x === undefined ? null : x))); }
  exec(): D1Result<any> {
    const s = this.d.prepare(this.sql);
    if (/^\s*(SELECT|WITH)/i.test(this.sql)) return { results: s.all(...(this.params as any[])).map(r => ({ ...r })), success: true, meta: {} };
    const r = s.run(...(this.params as any[])); return { results: [], success: true, meta: { changes: Number(r.changes) } };
  }
  async all<T>() { return this.exec() as D1Result<T>; }
  async first<T>() { return (this.exec().results[0] ?? null) as T | null; }
  async run() { return this.exec(); }
}

export class D1Sqlite implements D1Database {
  d = new DatabaseSync(':memory:'); writes = 0;
  constructor(files: string[] = []) { files.forEach(f => this.d.exec(readFileSync(f, 'utf8'))); }
  prepare(sql: string) { return new Stmt(this.d, sql); }
  async batch(stmts: D1PreparedStatement[]) {
    this.d.exec('BEGIN');
    try { const r = (stmts as Stmt[]).map(s => s.exec()); this.writes += (stmts as Stmt[]).filter(s => !/^\s*SELECT/i.test(s.sql)).length; this.d.exec('COMMIT'); return r; }
    catch (e) { this.d.exec('ROLLBACK'); throw e; }
  }
}
