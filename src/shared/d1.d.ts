// Minimal D1 / Workers types used by this project (no dependency on @cloudflare/workers-types).
interface D1Result<T = Record<string, unknown>> { results: T[]; success: boolean; meta: { changes?: number; rows_read?: number; rows_written?: number } }
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(col?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}
interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(stmts: D1PreparedStatement[]): Promise<D1Result[]>;
}
interface ExecutionContext { waitUntil(p: Promise<unknown>): void }
interface ScheduledController { cron: string; scheduledTime: number }
interface Env { DB: D1Database }
interface CacheStorage { readonly default: Cache } // Workers adds caches.default
