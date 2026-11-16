/**
 * Devices (D) and trim dies (T) and how the OS opening finds the one of a machine.
 * Pure functions, shared by the server (suggestions, import) and the browser.
 */
import { normalizeToolCode, type ToolType } from './maintenance.js';

export interface Tool {
  code: string;
  type: ToolType;
  description: string | null;
  molds: string | null;
  /** part numbers made with it, as digits only (10001025301): the PN list may carry suffixes such as 10001025301B */
  part_numbers: string[];
  /** machines it runs on, as registered in Cadastros (17A, 24, INJETORA 120 T) */
  machines: string[];
  active: boolean;
}

/** Why a tool was suggested for the order being opened. */
export type ToolReason = 'pn' | 'maquina' | 'pn_maquina' | 'historico';
export const TOOL_REASON_LABELS: Record<ToolReason, string> = {
  pn: 'pelo part number',
  maquina: 'cadastrado nesta máquina',
  pn_maquina: 'produto desta máquina',
  historico: 'já usado em OS desta máquina',
};

/** "10001025301B", "100.01.0253.01" → "10001025301" (what links a PN to a tool). */
export const pnDigits = (pn: string | null | undefined) => String(pn ?? '').replace(/\D/g, '').replace(/^0+(?=\d{11})/, '');

/** "Injeção 120T", "INJETORA 120 T", "Máquina 07" → "120T", "7": compares machines written in different ways. */
export function machineKey(m: string | null | undefined): string {
  const s = String(m ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/\b(MAQUINA|INJETORA|INJECAO|INJ|MAQ)\b\.?/g, '').replace(/[\s._-]+/g, '');
  return s.replace(/^0+(?=\d)/, '');
}

/** Splits a free text list of codes ("D-118 / D119\nd 120") into normalized codes of the given type. */
export function toolCodesIn(text: string | null | undefined, type: ToolType): string[] {
  const letter = type === 'dispositivo' ? 'D' : 'T';
  const out: string[] = [];
  for (const m of String(text ?? '').toUpperCase().matchAll(new RegExp(`${letter}\\s*-?\\s*(\\d{1,4})`, 'g'))) {
    const c = normalizeToolCode(`${letter}${m[1]}`, type);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

/** Text search for the picker: code ("405", "d405", "D-405"), product or mold. */
export function toolMatches(t: Pick<Tool, 'code' | 'description' | 'molds' | 'part_numbers'>, query: string): boolean {
  const q = query.trim();
  if (!q) return true;
  const code = normalizeToolCode(q);
  if (code && t.code === code) return true;
  if (/^\d{1,4}$/.test(q) && t.code.slice(1) === q.padStart(3, '0')) return true;
  const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  const needle = plain(q);
  const digits = pnDigits(q);
  return plain(`${t.code} ${t.description ?? ''} ${t.molds ?? ''}`).includes(needle) || (digits.length >= 5 && t.part_numbers.some((p) => p.includes(digits)));
}
