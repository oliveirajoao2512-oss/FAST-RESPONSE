import { normalizePn } from '../../../shared/maintenance.js';
import { type CellValue, type Workbook } from './xlsx.js';

export interface ImportedPn { code: string; description: string | null; customer: string | null; machine: string | null }

const text = (v: CellValue | undefined) => (v == null ? '' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(v)) : String(v)).trim().replace(/\s+/g, ' ');
const norm = (v: CellValue | undefined) => text(v).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
/** A part number: letters/digits with optional separators, at least 4 characters and one digit. */
const looksLikePn = (s: string) => /^[0-9A-Z][0-9A-Z.\-/ ]{2,58}[0-9A-Z]$/.test(s) && /\d/.test(s);

/**
 * Reads every sheet of the PCP spreadsheet that has a part number column ("PART NUMBER…", "PN NEO", "PN") in its first
 * rows, with description, customer and standard machine when present. The same PN in several sheets is merged.
 */
export function parsePartNumbers(wb: Workbook): { items: ImportedPn[]; sheets: string[] } {
  const byCode = new Map<string, ImportedPn>();
  const sheets: string[] = [];
  const found: { sh: Workbook['sheets'][number]; header: { row: number; pn: number; desc?: number; customer?: number; machine?: number } }[] = [];
  for (const sh of wb.sheets) {
    for (const r of [...sh.rows.keys()].sort((x, y) => x - y).slice(0, 15)) {
      let pn = -1, desc: number | undefined, customer: number | undefined, machine: number | undefined;
      for (const [c, v] of sh.rows.get(r)!) {
        const h = norm(v);
        if (pn < 0 && (/^PART ?NUMBER/.test(h) || /^PN( NEO)?$/.test(h) || /^P\/N$/.test(h))) pn = c;
        else if (desc == null && /^DESCRI/.test(h)) desc = c;
        else if (customer == null && /^CLIENTE/.test(h)) customer = c;
        else if (machine == null && /^MAQUINA/.test(h)) machine = c;
      }
      if (pn >= 0) { found.push({ sh, header: { row: r, pn, desc, customer, machine } }); break; }
    }
  }
  // the most complete list (description, customer, standard machine) fills the details first
  const richness = (h: (typeof found)[number]['header']) => Number(h.desc != null) + Number(h.customer != null) + Number(h.machine != null);
  for (const { sh, header } of found.sort((x, y) => richness(y.header) - richness(x.header))) {
    let n = 0;
    for (const [r, cells] of sh.rows) {
      if (r <= header.row) continue;
      const code = normalizePn(text(cells.get(header.pn)));
      if (!code || !looksLikePn(code)) continue;
      n++;
      const pick = (c?: number) => (c == null ? null : text(cells.get(c)) || null);
      const cur = byCode.get(code) ?? { code, description: null, customer: null, machine: null };
      cur.description ??= pick(header.desc)?.slice(0, 300) ?? null;
      cur.customer ??= pick(header.customer)?.slice(0, 120) ?? null;
      cur.machine ??= pick(header.machine)?.slice(0, 60) ?? null;
      byCode.set(code, cur);
    }
    if (n) sheets.push(sh.name);
  }
  return { items: [...byCode.values()], sheets };
}
