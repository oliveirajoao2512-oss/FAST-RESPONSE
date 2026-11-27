import { normalizePn } from '../../../shared/maintenance.js';
import { machineKey } from '../../../shared/production.js';
import type { CellValue, Workbook } from './xlsx.js';

/**
 * Standard cycles from the PCP spreadsheet "PLANEJAMENTO APONTAMENTO …" (João, 27/11/2026). Every sheet with a
 * machine, a part number and a cycle column in its first rows is read: "BASE att …" (standard machine, cycle,
 * cavities of each PN) and "PLANEJAMENTO" (what each machine runs today). The daily plan wins over the base, because
 * it is the machine actually used. Only the cycles are taken; the company data stays in the spreadsheet.
 */

export interface PlanCycle { machine: string; pn: string; cycleSeconds: number; cavities: number; sheet: string; perHour: number | null }

const text = (v: CellValue | undefined) => (v == null ? '' : String(v)).trim().replace(/\s+/g, ' ');
const norm = (v: CellValue | undefined) => text(v).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
const num = (v: CellValue | undefined) => (typeof v === 'number' ? v : Number(text(v).replace(',', '.')));

/** "MC-02" → "2", "MC-1A" → "1A", "MC-INJ 120" / "INJEÇÃO 120T" → "INJETORA 120 T" (as a key, without spaces) */
export function planMachineKey(raw: string): string {
  let k = machineKey(raw.normalize('NFD').replace(/[̀-ͯ]/g, ''));
  k = k.replace(/^MC-?/, '');
  const inj = /^(?:INJ|INJECAO|INJETORA)(\d{3})T?$/.exec(k);
  if (inj) return `INJETORA${inj[1]}T`;
  return k.replace(/^0+(?=\d)/, '');
}

interface Header { row: number; machine: number; pn: number; cycle: number; cav?: number; perHour?: number }

function findHeader(rows: Map<number, Map<number, CellValue>>): Header | null {
  for (const r of [...rows.keys()].sort((a, b) => a - b).slice(0, 15)) {
    let machine = -1, pn = -1, cycle = -1, cav: number | undefined, perHour: number | undefined;
    for (const [c, v] of rows.get(r)!) {
      const h = norm(v);
      if (machine < 0 && /^MAQUINA/.test(h)) machine = c;
      else if (pn < 0 && (/^PART ?NUMBER/.test(h) || /^PN( NEO)?$/.test(h))) pn = c;
      else if (cycle < 0 && (/^CICLO/.test(h) || /^TEMPO ?CICLO/.test(h))) cycle = c;
      else if (cav == null && /^CAV/.test(h)) cav = c;
      else if (perHour == null && /^PECAS ?POR ?HORA/.test(h)) perHour = c;
    }
    if (machine >= 0 && pn >= 0 && cycle >= 0) return { row: r, machine, pn, cycle, cav, perHour };
  }
  return null;
}

export function parsePlanCycles(wb: Workbook) {
  const found: { sheet: string; items: PlanCycle[]; daily: boolean }[] = [];
  for (const sh of wb.sheets) {
    const h = findHeader(sh.rows);
    if (!h) continue;
    const items: PlanCycle[] = [];
    for (const [r, cells] of sh.rows) {
      if (r <= h.row) continue;
      const machine = text(cells.get(h.machine));
      const pn = normalizePn(text(cells.get(h.pn)));
      const cycle = num(cells.get(h.cycle));
      if (!machine || !pn || !/\d/.test(pn) || !(cycle > 0) || cycle > 3600) continue;
      const cavRaw = h.cav == null ? 1 : num(cells.get(h.cav));
      const perHour = h.perHour == null ? null : num(cells.get(h.perHour));
      items.push({ machine, pn, cycleSeconds: Math.round(cycle * 100) / 100, cavities: Number.isInteger(cavRaw) && cavRaw >= 1 && cavRaw <= 64 ? cavRaw : 1, sheet: sh.name, perHour: perHour && perHour > 0 ? perHour : null });
    }
    if (items.length) found.push({ sheet: sh.name, items, daily: /PLANEJAMENTO/i.test(sh.name) });
  }
  // base first, daily plan last: the later one wins
  const byKey = new Map<string, PlanCycle>();
  for (const f of found.sort((a, b) => Number(a.daily) - Number(b.daily))) {
    for (const it of f.items) byKey.set(`${planMachineKey(it.machine)}|${it.pn}`, it);
  }
  // the spreadsheet's own "peças por hora" disagrees with cycle × cavities: worth a look
  const mismatches = [...byKey.values()]
    .filter((i) => i.perHour != null && Math.abs(i.perHour - (3600 / i.cycleSeconds) * i.cavities) / i.perHour > 0.02)
    .map((i) => ({ machine: i.machine, pn: i.pn, cycleSeconds: i.cycleSeconds, cavities: i.cavities, perHour: Math.round(i.perHour! * 10) / 10 }));
  return { items: [...byKey.values()], sheets: found.map((f) => f.sheet), mismatches };
}

export interface PlanItem { machine: string; pn: string; shifts: number[]; cycleSeconds: number | null; cavities: number; op: string | null }

/**
 * The day's plan from the "PLANEJAMENTO" sheet: which PN each machine runs in each shift. A shift column (T1, T2, T3)
 * with "X" or empty, or its hours column ("HRS T1") at 0, means the machine does not run that PN in that shift.
 */
export function parseDailyPlan(wb: Workbook): { sheet: string | null; items: PlanItem[] } {
  for (const sh of wb.sheets) {
    if (!/PLANEJAMENTO/i.test(sh.name)) continue;
    for (const r of [...sh.rows.keys()].sort((a, b) => a - b).slice(0, 15)) {
      const cols: Record<string, number> = {};
      for (const [c, v] of sh.rows.get(r)!) {
        const h = norm(v).replace(/\s+/g, ' ');
        if (cols.machine == null && /^MAQUINA/.test(h)) cols.machine = c;
        else if (cols.pn == null && /^PART ?NUMBER/.test(h)) cols.pn = c;
        else if (cols.cycle == null && /^(TEMPO ?)?CICLO/.test(h)) cols.cycle = c;
        else if (cols.cav == null && /^CAV/.test(h)) cols.cav = c;
        else if (cols.op == null && /^NUMERO DA OP|^OP$/.test(h)) cols.op = c;
        else if (/^T[123]$/.test(h)) cols[h] ??= c;
        else if (/^HRS ?T[123]$/.test(h)) cols[`H${h.slice(-1)}`] ??= c;
      }
      if (cols.machine == null || cols.pn == null || cols.T1 == null) continue;
      const items: PlanItem[] = [];
      for (const [row, cells] of sh.rows) {
        if (row <= r) continue;
        const machine = text(cells.get(cols.machine));
        const pn = normalizePn(text(cells.get(cols.pn)));
        if (!machine || !pn || !/\d/.test(pn)) continue;
        const shifts = [1, 2, 3].filter((t) => {
          const v = cols[`T${t}`] == null ? '' : norm(cells.get(cols[`T${t}`]));
          const hrs = cols[`H${t}`] == null ? null : cells.get(cols[`H${t}`]);
          return v !== '' && v !== 'X' && v !== '0' && !(typeof hrs === 'number' && hrs <= 0);
        });
        const cycle = cols.cycle == null ? NaN : num(cells.get(cols.cycle));
        const cav = cols.cav == null ? 1 : num(cells.get(cols.cav));
        const op = cols.op == null ? '' : text(cells.get(cols.op));
        items.push({
          machine, pn, shifts,
          cycleSeconds: cycle > 0 && cycle <= 3600 ? Math.round(cycle * 100) / 100 : null,
          cavities: Number.isInteger(cav) && cav >= 1 && cav <= 64 ? cav : 1,
          op: op && /\d/.test(op) ? op : null,
        });
      }
      return { sheet: sh.name, items };
    }
  }
  return { sheet: null, items: [] };
}

/** "…APONTAMENTO 27112026 SEX…" → "2026-11-27" */
export function planDateFromName(name: string): string | null {
  const m = /(?:^|\D)(\d{2})(\d{2})(20\d{2})(?:\D|$)/.exec(name);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
