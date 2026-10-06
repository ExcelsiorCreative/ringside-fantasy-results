// Name normalization shared by the runner, the Worker and the seed script.

/** Lowercase, accent-free, single-spaced key used for matching names. */
export function nameKey(raw: string): string {
  return raw
    .normalize('NFKC')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')       // accents
    .replace(/[​-‍﻿­]/g, '') // zero-width + soft hyphen (stray characters)
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, '-')
    .toLowerCase()
    .replace(/[^a-z0-9'&.\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Stable, readable ID for a wrestler, e.g. "w_roman_reigns". Never changes once created. */
export function wrestlerId(name: string): string {
  return 'w_' + nameKey(name).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export function slug(s: string): string {
  return nameKey(s).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** Extra alias forms generated automatically from a canonical name. */
export function autoAliases(name: string): string[] {
  const out = new Set<string>();
  const k = nameKey(name);
  out.add(k);
  // "Hangman Adam Page" -> "Adam Page"; "Andrade El Ídolo" -> "Andrade"
  const nick = k.match(/^(hangman|the)\s+(.+)$/);
  if (nick) out.add(nick[2]);
  const el = k.match(/^(.+?)\s+el\s+idolo$/);
  if (el) out.add(el[1]);
  // "A.J. Francis" <-> "AJ Francis"
  if (/[a-z]\.[a-z]\./.test(k)) out.add(k.replace(/\./g, ''));
  return [...out].filter(a => a.length >= 2);
}

/** Small stable hash (FNV-1a, hex) used to detect changed content. */
export function contentHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
