import { normalizePn } from './maintenance.js';

/** A registered part number, as offered when opening an order. */
export interface PartNumber {
  code: string;
  description: string | null;
  customer: string | null;
  machine: string | null;
}

export interface PnMatch extends PartNumber {
  /** how the typed text matched: exact code, start of the code, part of the code, the description, or a close code (typo) */
  how: 'exato' | 'inicio' | 'trecho' | 'descricao' | 'parecido';
  /** edit distance for 'parecido' */
  distance?: number;
}

/** Letters and digits only, upper case: "10001-060 542" and "10001060542" compare equal. */
export const pnKey = (v: string | null | undefined) => (v ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');

/** Machine as written in the plant lists: "MC-05", "05" and "5" are the same machine. */
const machineKey = (v: string | null | undefined) => pnKey(v).replace(/^MC(?=\d)/, '').replace(/^0+(?=[0-9A-Z])/, '');

/** Optimal string alignment distance: insertions, deletions, substitutions and swaps of neighbouring characters (typical typos). */
export function typoDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** The registered part number written exactly as typed (ignoring case, spaces and punctuation), if any. */
export function findPn(list: PartNumber[], typed: string | null | undefined): PartNumber | null {
  const k = pnKey(typed);
  return k ? list.find((p) => pnKey(p.code) === k) ?? null : null;
}

/**
 * Part numbers closest to what is being typed, best first. While typing, codes that start with or contain the
 * digits come first; a code that differs by a typo (a wrong, missing, extra or swapped digit) is still found.
 * Codes whose standard machine is the chosen machine come first among equals.
 */
export function matchPn(list: PartNumber[], typed: string, opts: { machine?: string | null; limit?: number } = {}): PnMatch[] {
  const limit = opts.limit ?? 8;
  const k = pnKey(typed);
  const machine = machineKey(opts.machine);
  const onMachine = (p: PartNumber) => !!machine && machineKey(p.machine) === machine;
  if (!k) return machine ? list.filter(onMachine).slice(0, limit).map((p) => ({ ...p, how: 'inicio' as const })) : [];
  const text = normalizePn(typed) ?? '';
  // allowed typos grow with the length typed: 1 up to 7 characters, 2 from 8
  const maxTypos = k.length >= 8 ? 2 : k.length >= 4 ? 1 : 0;
  const scored: { m: PnMatch; score: number }[] = [];
  for (const p of list) {
    const c = pnKey(p.code);
    let m: PnMatch | null = null;
    let score = 0;
    if (c === k) { m = { ...p, how: 'exato' }; score = 0; }
    else if (c.startsWith(k)) { m = { ...p, how: 'inicio' }; score = 1; }
    else if (c.includes(k)) { m = { ...p, how: 'trecho' }; score = 2; }
    else if (k.length >= 3 && /[A-Z]{3}/.test(text) && (p.description ?? '').toUpperCase().includes(text)) { m = { ...p, how: 'descricao' }; score = 3; }
    else if (maxTypos) {
      // compare with the whole code and with its beginning (the code may still be being typed)
      const dist = Math.min(typoDistance(k, c), k.length < c.length ? typoDistance(k, c.slice(0, k.length)) + 0.5 : Infinity);
      if (dist <= maxTypos) { m = { ...p, how: 'parecido', distance: Math.ceil(dist) }; score = 4 + dist; }
    }
    if (m) scored.push({ m, score: score - (onMachine(p) ? 0.25 : 0) });
  }
  return scored.sort((a, b) => a.score - b.score || a.m.code.localeCompare(b.m.code, 'pt-BR', { numeric: true })).slice(0, limit).map((x) => x.m);
}
