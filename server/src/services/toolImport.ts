import { pnDigits, toolCodesIn } from '../../../shared/tools.js';
import { type CellValue, type Workbook } from './xlsx.js';

export interface ImportedTool { code: string; type: 'dispositivo' | 'trim_die'; description: string | null; molds: string | null; part_numbers: string[] }

const text = (v: CellValue | undefined) => (v == null ? '' : String(v)).trim().replace(/\s+/g, ' ');
const norm = (v: CellValue | undefined) => text(v).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[“”]/g, '"');
const isNa = (s: string) => !s || /^(NA|N\/A|-|NAO|NAO TEM|SEM)$/i.test(s);
/** Part numbers in a cell: "10001007817", "100.01.0290.03", several per cell. */
const pnsIn = (v: CellValue | undefined) =>
  [...text(v).matchAll(/\d[\d.\-]{7,18}\d/g)].map((m) => pnDigits(m[0])).filter((p) => p.length >= 9 && p.length <= 13);

interface Cols { row: number; pn: number; mold?: number; trim?: number; device?: number; product?: number }

/** Finds the header of a sheet that lists part numbers with their devices and/or trim dies. */
function header(rows: Workbook['sheets'][number]['rows']): Cols | null {
  for (const r of [...rows.keys()].sort((a, b) => a - b).slice(0, 12)) {
    const c: Partial<Cols> = {};
    for (const [i, v] of rows.get(r)!) {
      const h = norm(v);
      if (c.mold == null && (/^MOLDES?$/.test(h) || /^CODIGO "?M"?\s*\(MOLDES?\)/.test(h))) c.mold = i;
      else if (c.trim == null && (/^TRI[NM]\s*-?\s*DIE$/.test(h) || /^CODIGO "?T"?\s*TRI[NM]/.test(h))) c.trim = i;
      else if (c.device == null && (/^DISP(OSITIVOS?)?\.?$/.test(h) || /^CODIGO "?D"?\s*\(DISPOSITIVOS?\)/.test(h))) c.device = i;
      else if (c.pn == null && (/^CODIGO (DO )?PRODUTO$/.test(h) || /^PART ?NUMBER( PRODUTO| ABC)?$/.test(h) || /^PN$/.test(h))) c.pn = i;
      else if (c.product == null && (/^D?R?ESCRI[CÇ]AO( (DO )?PRODUTO)?$/.test(h) || /^DRESCRICAO PRODUTO$/.test(h) || /^PRODUTO$/.test(h))) c.product = i;
    }
    if (c.pn != null && (c.device != null || c.trim != null)) return { ...c, row: r } as Cols;
  }
  return null;
}

/**
 * Reads the "Controle de Moldes e Dispositivos" spreadsheet: every sheet with a part number column and a device
 * ("Dispositivo", "Disp.", "Código D") or trim die column. A row with a mold starts a block; the devices and trim dies
 * of the block are linked to every part number of the block (a mold makes several products with the same devices).
 */
export function parseTools(wb: Workbook): { items: ImportedTool[]; sheets: string[] } {
  const tools = new Map<string, { type: ImportedTool['type']; products: Set<string>; molds: Set<string>; pns: Set<string> }>();
  const sheets: string[] = [];
  const link = (code: string, type: ImportedTool['type'], pns: string[], product: string, mold: string) => {
    const t = tools.get(code) ?? { type, products: new Set(), molds: new Set(), pns: new Set() };
    pns.forEach((p) => t.pns.add(p));
    if (product) t.products.add(product);
    if (mold) t.molds.add(mold);
    tools.set(code, t);
  };
  for (const sh of wb.sheets) {
    const h = header(sh.rows);
    if (!h) continue;
    type Block = { mold: string; devices: string[]; trims: string[]; items: { pns: string[]; product: string }[] };
    const blocks: Block[] = [];
    let block: Block | null = null;
    for (const r of [...sh.rows.keys()].sort((a, b) => a - b)) {
      if (r <= h.row) continue;
      const cells = sh.rows.get(r)!;
      const mold = h.mold == null ? '' : text(cells.get(h.mold));
      if ((mold && !isNa(mold)) || h.mold == null || !block) {
        block = { mold: isNa(mold) ? '' : mold, devices: [], trims: [], items: [] };
        blocks.push(block);
      }
      if (h.device != null) block.devices.push(...toolCodesIn(text(cells.get(h.device)), 'dispositivo'));
      if (h.trim != null) {
        const raw = text(cells.get(h.trim));
        // the trim die column may hold just the number ("67" = T067)
        if (!isNa(raw)) block.trims.push(...(/T/i.test(raw) ? toolCodesIn(raw, 'trim_die') : toolCodesIn(raw.replace(/(\d{1,4})/g, 'T$1'), 'trim_die')));
      }
      const pns = pnsIn(cells.get(h.pn));
      const product = h.product == null ? '' : text(cells.get(h.product)).slice(0, 120);
      if (pns.length || product) block.items.push({ pns, product });
    }
    let n = 0;
    for (const b of blocks) {
      for (const code of new Set(b.devices)) for (const it of b.items.length ? b.items : [{ pns: [], product: '' }]) { link(code, 'dispositivo', it.pns, it.product, b.mold); n++; }
      for (const code of new Set(b.trims)) for (const it of b.items.length ? b.items : [{ pns: [], product: '' }]) { link(code, 'trim_die', it.pns, it.product, b.mold); n++; }
    }
    if (n) sheets.push(sh.name);
  }
  const items = [...tools.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([code, t]) => ({
    code, type: t.type,
    description: [...t.products].slice(0, 4).join('; ').slice(0, 300) || null,
    molds: [...t.molds].join(', ').slice(0, 200) || null,
    part_numbers: [...t.pns].sort(),
  }));
  return { items, sheets };
}
