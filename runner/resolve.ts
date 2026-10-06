// Matches source names to wrestler IDs and titles to championship IDs. Never guesses.
import { nameKey, contentHash } from '../src/shared/normalize.ts';
import type { LookupData, ParsedShow, TitleHolderFact } from '../src/shared/types.ts';

export class Resolver {
  alias = new Map<string, string>(); stable = new Map<string, string[]>(); unknown = new Map<string, { raw: string; normalized: string; source_url: string }>();
  L: LookupData;
  constructor(L: LookupData) {
    this.L = L;
    L.aliases.forEach(([a, id]) => this.alias.set(a, id));
    L.stables.forEach(s => this.stable.set(s.name_search, s.members));
  }
  private keys(raw: string, target?: string): string[] {
    const ks = [nameKey(raw)];
    if (target) { ks.push(nameKey(target.replace(/\s*\([^)]*\)\s*$/, ''))); ks.push(nameKey(target)); }
    return [...new Set(ks)];
  }
  wrestler(raw: string, target?: string): string | undefined {
    for (const k of this.keys(raw, target)) { const id = this.alias.get(k); if (id) return id; }
    return undefined;
  }
  team(raw: string, target?: string): string[] | undefined {
    for (const k of this.keys(raw, target)) { const m = this.stable.get(k); if (m?.length) return m; }
    return undefined;
  }
  miss(raw: string, url: string) { const n = nameKey(raw); if (!this.unknown.has(n)) this.unknown.set(n, { raw, normalized: n, source_url: url }); }

  championship(title: string, promotion: string): string | null {
    const k = nameKey(title);
    const exact = this.L.championships.filter(c => c.name_search === k);
    const pool = exact.length ? exact : this.L.championships.filter(c => k.includes(c.name_search) || c.name_search.includes(k));
    if (pool.length === 1) return pool[0].id;
    const same = pool.filter(c => c.promotion === promotion);
    return same.length === 1 ? same[0].id : null; // ambiguous -> null (match is held)
  }

  show(s: ParsedShow): ParsedShow {
    for (const m of s.matches) {
      const out: typeof m.participants = [];
      for (const p of m.participants) {
        const id = this.wrestler(p.raw, p.linkTarget);
        if (id) { out.push({ ...p, wrestler_id: id }); continue; }
        const members = this.team(p.raw, p.linkTarget);
        if (members) { members.forEach(w => out.push({ ...p, raw: this.L.names[w] || w, wrestler_id: w })); continue; }
        this.miss(p.raw, s.source_url); out.push(p);
      }
      m.participants = out;
      if (m.title_name) m.title_championship_id = this.championship(m.title_name, s.promotion);
    }
    s.content_hash = contentHash(JSON.stringify([s.name, s.date, s.promotion, s.problems, s.matches.map(m => [m.raw_text, m.stipulation, m.title_championship_id, m.pre_show, m.participants.map(p => [p.raw, p.wrestler_id, p.side, p.result])])]));
    return s;
  }

  holders(f: TitleHolderFact): TitleHolderFact {
    const ids: string[] = [];
    for (const n of f.holder_names) {
      const id = this.wrestler(n); if (id) { ids.push(id); continue; }
      const t = this.team(n); if (t) { ids.push(...t); continue; }
      this.miss(n, f.source_url); return f; // leave holder_ids unset -> ignored
    }
    return { ...f, holder_names: ids.map(i => this.L.names[i] || i), holder_ids: ids };
  }
}
