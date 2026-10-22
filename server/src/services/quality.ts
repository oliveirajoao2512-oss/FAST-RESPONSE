import {
  addDays, evaluate, normalizeSteps, PROCEDENTE, QUALITY_DUE_DAYS, QUALITY_ORIGINS, QUALITY_STEPS, STEP_KEYS,
  type Procedente, type QStatus, type QSteps, type QualityOrigin, type StepKey,
} from '../../../shared/quality.js';
import { colName, dateToSerial, serialToDate, type CellValue, type OutCell, type OutSheet, type Workbook } from './xlsx.js';

/** One non-conformity as stored (dates YYYY-MM-DD). */
export interface QualityRecord {
  origin: QualityOrigin;
  number: string;
  opened_on: string;
  kind: string | null;
  partner: string | null;
  claim_type: string | null;
  product: string | null;
  internal_code: string | null;
  customer_code: string | null;
  customer_claim: string | null;
  description: string | null;
  primary_problem: string | null;
  safety: boolean;
  recurrent: boolean;
  leader: string | null;
  steps: QSteps;
  action_plan: string | null;
  due_on: string;
  on_hold: boolean;
  on_hold_reason: string | null;
  procedente: Procedente | null;
}

/** Fields that an import or an edit may change, in display order. */
export const RECORD_FIELDS = [
  'opened_on', 'kind', 'partner', 'claim_type', 'product', 'internal_code', 'customer_code', 'customer_claim', 'description',
  'primary_problem', 'safety', 'recurrent', 'leader', 'steps', 'action_plan', 'due_on', 'on_hold', 'on_hold_reason', 'procedente',
] as const;
export type RecordField = (typeof RECORD_FIELDS)[number];
export const FIELD_LABELS: Record<RecordField, string> = {
  opened_on: 'Data de abertura', kind: 'Tipo', partner: 'Cliente/fornecedor', claim_type: 'Reclamação', product: 'Produto',
  internal_code: 'Código interno', customer_code: 'Código cliente', customer_claim: 'Nº reclamação cliente',
  description: 'Descrição do problema', primary_problem: 'Problema primário', safety: 'Segurança/regulatório', recurrent: 'Reincidente',
  leader: 'Líder', steps: 'Etapas', action_plan: 'Plano de ação', due_on: 'Prazo', on_hold: 'On hold', on_hold_reason: 'Motivo do on hold',
  procedente: 'Procedente',
};

export const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const STEP_HEADERS: Record<string, StepKey> = {
  CONTENCAO: 'contencao', CAUSARAIZ: 'causa_raiz', ACOESCORRETIVAS: 'acoes_corretivas', POKAYOKE: 'poka_yoke',
  VALIDACAODAEFICACIADAACOES: 'validacao', VALIDACAODAEFICACIADASACOES: 'validacao', VALIDACAODAEFICACIA: 'validacao',
  PFMEA: 'pfmea', PLANODECONTROLE: 'plano_controle', TRABALHOPADRONIZADO: 'trabalho_padronizado', TREINAMENTO: 'treinamento',
  LPA: 'lpa', LICOESAPRENDIDAS: 'licoes',
};
const FIELD_HEADERS: Record<string, string> = {
  NUMERODAOCORRENCIA: 'number', DATADEABERTURA: 'opened', TIPO: 'kind', CLIENTE: 'partner', FORNECEDOR: 'partner',
  RECLAMACAO: 'claim_type', DESCRICAODOPRODUTO: 'product', CODIGOINTERNO: 'internal_code', CODIGOCLIENTE: 'customer_code',
  NUMERODARECLAMACAOCLIENTE: 'customer_claim', DESCRICAODOPROBLEMA: 'description', PROBLEMAPRIMARIO: 'primary_problem',
  SEGURANCAREGULATORIO: 'safety', REINCIDENTE: 'recurrent', LIDER: 'leader', PLANODEACAOCONTRAMEDIDAS: 'action_plan',
  PRAZO: 'due', ONHOLDGERAL: 'on_hold', MOTIVODEONHOLD: 'on_hold_reason', INCIDENTEPROCEDENTE: 'procedente',
};

export function originOfSheet(name: string): QualityOrigin | null {
  const n = norm(name);
  if (n.includes('EXTERN')) return 'externa';
  if (n.includes('INTERN')) return 'interna';
  if (n.includes('FORNEC')) return 'fornecedor';
  return null;
}

function text(v: CellValue | undefined): string | null {
  if (v === null || v === undefined || typeof v === 'boolean') return null;
  const s = String(v).replace(/\r\n?/g, '\n').trim();
  return s === '' || s === '-' ? null : s.slice(0, 4000);
}
function toDate(v: CellValue | undefined, date1904: boolean): string | null {
  if (typeof v === 'number') return serialToDate(v, date1904);
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    const iso = `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return Number.isNaN(Date.parse(iso)) ? null : iso;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
const yes = (v: CellValue | undefined) => typeof v === 'boolean' ? v : norm(String(v ?? '')) === 'SIM';
function procedente(v: CellValue | undefined): Procedente | null {
  const n = norm(String(v ?? ''));
  return PROCEDENTE.find((p) => norm(p) === n) ?? null;
}

export interface ParsedImport {
  records: QualityRecord[];
  sheets: { name: string; origin: QualityOrigin; count: number }[];
  catalog: { kind: 'tipo' | 'cliente' | 'fornecedor' | 'problema'; value: string }[];
  warnings: string[];
}

/** Reads the "Resposta Rápida" workbook: each NC uses two rows (planned dates, then realized dates). */
export function parseRespostaRapida(wb: Workbook, today: string): ParsedImport {
  const out: ParsedImport = { records: [], sheets: [], catalog: [], warnings: [] };
  for (const sheet of wb.sheets) {
    const origin = originOfSheet(sheet.name);
    if (!origin) {
      if (norm(sheet.name).includes('CADASTRO')) out.catalog.push(...parseCatalog(sheet.rows));
      continue;
    }
    let headerRow = -1;
    const cols: Record<string, number> = {};
    const stepCols: Partial<Record<StepKey, number>> = {};
    for (const [r, cells] of [...sheet.rows].sort((a, b) => a[0] - b[0])) {
      if (r > 40) break;
      if (![...cells.values()].some((v) => typeof v === 'string' && norm(v) === 'NUMERODAOCORRENCIA')) continue;
      headerRow = r;
      for (const [c, v] of cells) {
        if (typeof v !== 'string') continue;
        const h = norm(v);
        if (FIELD_HEADERS[h] && cols[FIELD_HEADERS[h]] === undefined) cols[FIELD_HEADERS[h]] = c;
        const step = STEP_HEADERS[h] ?? (h.startsWith('VALIDACAODAEFICACIA') ? 'validacao' : undefined);
        if (step && stepCols[step] === undefined) stepCols[step] = c;
      }
      break;
    }
    if (headerRow < 0) {
      out.warnings.push(`Aba "${sheet.name}": cabeçalho "NÚMERO DA OCORRÊNCIA" não encontrado; aba ignorada.`);
      continue;
    }
    const missingSteps = STEP_KEYS.filter((k) => stepCols[k] === undefined);
    if (missingSteps.length) out.warnings.push(`Aba "${sheet.name}": colunas de etapas não encontradas (${missingSteps.join(', ')}).`);

    const seen = new Set<string>();
    let count = 0;
    const lastRow = Math.max(...sheet.rows.keys());
    for (let r = headerRow + 1; r <= lastRow; r++) {
      const row = sheet.rows.get(r);
      const number = text(row?.get(cols.number));
      if (!row || !number) continue;
      const where = `${sheet.name}, linha ${r}`;
      const opened = toDate(row.get(cols.opened), wb.date1904);
      if (!opened) {
        out.warnings.push(`${where}: ocorrência ${number} sem data de abertura válida; ignorada.`);
        continue;
      }
      if (seen.has(number)) {
        out.warnings.push(`${where}: ocorrência ${number} repetida na aba; mantida a primeira.`);
        continue;
      }
      seen.add(number);
      // realized dates are on the line below, which has no occurrence number
      const next = sheet.rows.get(r + 1);
      const done = next && !text(next.get(cols.number)) ? next : undefined;
      const steps = {} as QSteps;
      for (const k of STEP_KEYS) {
        const c = stepCols[k];
        const plan = c === undefined ? null : toDate(row.get(c), wb.date1904);
        const raw = c === undefined ? undefined : done?.get(c);
        let doneOn: string | null = null;
        let mark: QSteps[StepKey]['mark'] = null;
        if (raw !== undefined) {
          const n = typeof raw === 'string' ? norm(raw) : '';
          if (n === 'NA') mark = 'na';
          else if (n === 'ONHOLD') mark = 'hold';
          else {
            doneOn = toDate(raw, wb.date1904);
            if (!doneOn) out.warnings.push(`${where}: valor "${String(raw).slice(0, 30)}" em ${QUALITY_STEPS.find((s) => s.key === k)!.label} não é data, N/A nem ON HOLD; ignorado.`);
            else if (doneOn > addDays(today, 1)) out.warnings.push(`${where}: ${QUALITY_STEPS.find((s) => s.key === k)!.label} realizada em data futura (${doneOn.split('-').reverse().join('/')}).`);
          }
        }
        steps[k] = { plan, done: doneOn, mark };
      }
      const get = (f: string) => (cols[f] === undefined ? undefined : row.get(cols[f]));
      out.records.push({
        origin,
        number,
        opened_on: opened,
        kind: text(get('kind')),
        partner: text(get('partner')),
        claim_type: text(get('claim_type')),
        product: text(get('product')),
        internal_code: text(get('internal_code')),
        customer_code: text(get('customer_code')),
        customer_claim: text(get('customer_claim')),
        description: text(get('description')),
        primary_problem: text(get('primary_problem')),
        safety: yes(get('safety')),
        recurrent: yes(get('recurrent')),
        leader: text(get('leader')),
        steps: normalizeSteps(opened, steps),
        action_plan: text(get('action_plan')),
        due_on: toDate(get('due') ?? null, wb.date1904) ?? addDays(opened, QUALITY_DUE_DAYS),
        on_hold: yes(get('on_hold')),
        on_hold_reason: text(get('on_hold_reason')),
        procedente: procedente(get('procedente')),
      });
      count++;
    }
    out.sheets.push({ name: sheet.name, origin, count });
  }
  return out;
}

function parseCatalog(rows: Map<number, Map<number, CellValue>>): ParsedImport['catalog'] {
  const kinds: Record<string, ParsedImport['catalog'][number]['kind']> = {
    TIPO: 'tipo', CLIENTE: 'cliente', CLIENTES: 'cliente', FORNECEDOR: 'fornecedor', FORNECEDORES: 'fornecedor', PROBLEMAPRIMARIO: 'problema',
  };
  const sorted = [...rows].sort((a, b) => a[0] - b[0]);
  const header = sorted.find(([, cells]) => [...cells.values()].some((v) => typeof v === 'string' && kinds[norm(v)]));
  if (!header) return [];
  const cols = new Map<number, ParsedImport['catalog'][number]['kind']>();
  for (const [c, v] of header[1]) if (typeof v === 'string' && kinds[norm(v)]) cols.set(c, kinds[norm(v)]);
  const out: ParsedImport['catalog'] = [];
  for (const [r, cells] of sorted) {
    if (r <= header[0]) continue;
    for (const [c, kind] of cols) {
      const v = text(cells.get(c));
      if (v && v.length <= 120) out.push({ kind, value: v });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------- comparison

const stepsEqual = (a: QSteps, b: QSteps) =>
  STEP_KEYS.every((k) => (a[k]?.plan ?? null) === (b[k]?.plan ?? null) && (a[k]?.done ?? null) === (b[k]?.done ?? null) && (a[k]?.mark ?? null) === (b[k]?.mark ?? null));

export function diffRecords(before: QualityRecord, after: QualityRecord): RecordField[] {
  return RECORD_FIELDS.filter((f) => (f === 'steps' ? !stepsEqual(before.steps, after.steps) : (before[f] ?? null) !== (after[f] ?? null)));
}

/** Readable step changes, e.g. "Causa raiz: realizada 26/08/2026". */
export function describeStepChanges(before: QSteps, after: QSteps): string[] {
  const d = (s: string | null) => (s ? s.split('-').reverse().join('/') : 'vazio');
  const show = (s: QSteps[StepKey]) => (s.mark === 'na' ? 'N/A' : s.mark === 'hold' ? 'ON HOLD' : d(s.done));
  const out: string[] = [];
  for (const st of QUALITY_STEPS) {
    const a = before[st.key];
    const b = after[st.key];
    if (!a || !b) continue;
    if ((a.plan ?? null) !== (b.plan ?? null)) out.push(`${st.label}: prazo ${d(a.plan)} → ${d(b.plan)}`);
    if (show(a) !== show(b)) out.push(`${st.label}: realizado ${show(a)} → ${show(b)}`);
  }
  return out;
}

// ---------------------------------------------------------------------------- export

const STATUS_TEXT: Record<QStatus, string> = {
  atrasado: 'ATRASADO', no_prazo: 'PENDENTE NO PRAZO', on_hold: 'ON HOLD',
  concluido_no_prazo: 'CONCLUÍDO NO PRAZO', concluido_fora: 'CONCLUÍDO FORA DO PRAZO', na: 'N/A',
};
const SHEET_NAMES: Record<QualityOrigin, string> = { externa: 'NC Externa', interna: 'NC Interna', fornecedor: 'NC Fornecedor' };

/** Same layout as the company spreadsheet (planned line + realized line), so it can be imported again. */
export function buildExport(records: QualityRecord[], today: string): OutSheet[] {
  return QUALITY_ORIGINS.map((origin) => {
    type Col = { h: string; w: number; plan: (r: QualityRecord) => OutCell | null; done?: (r: QualityRecord) => OutCell | null };
    const t = (v: string | null | undefined, wrap = false): OutCell | null => (v ? { v, s: wrap ? 4 : 0 } : { v: null, s: 0 });
    const dt = (v: string | null | undefined): OutCell => (v ? { v: dateToSerial(v), s: 1 } : { v: null, s: 1 });
    const cols: Col[] = [
      { h: 'NÚMERO DA OCORRÊNCIA', w: 12, plan: (r) => t(r.number) },
      { h: 'DATA DE ABERTURA', w: 12, plan: (r) => dt(r.opened_on) },
      { h: 'TIPO', w: 12, plan: (r) => t(r.kind) },
      { h: origin === 'fornecedor' ? 'FORNECEDOR' : 'CLIENTE', w: 16, plan: (r) => t(r.partner) },
      { h: 'RECLAMAÇÃO', w: 12, plan: (r) => t(r.claim_type) },
      { h: 'DESCRIÇÃO DO PRODUTO', w: 22, plan: (r) => t(r.product, true) },
      { h: 'CÓDIGO INTERNO', w: 16, plan: (r) => t(r.internal_code, true) },
      ...(origin !== 'fornecedor' ? [{ h: 'CÓDIGO CLIENTE', w: 14, plan: (r: QualityRecord) => t(r.customer_code, true) }] : []),
      ...(origin === 'externa' ? [{ h: 'NÚMERO DA RECLAMAÇÃO CLIENTE', w: 16, plan: (r: QualityRecord) => t(r.customer_claim) }] : []),
      { h: 'DESCRIÇÃO DO PROBLEMA', w: 30, plan: (r) => t(r.description, true) },
      { h: 'PROBLEMA PRIMÁRIO', w: 22, plan: (r) => t(r.primary_problem, true) },
      { h: 'SEGURANÇA / REGULATÓRIO?', w: 12, plan: (r) => t(r.safety ? 'SIM' : 'NÃO') },
      { h: 'REINCIDENTE', w: 11, plan: (r) => t(r.recurrent ? 'SIM' : 'NÃO') },
      { h: 'LÍDER', w: 12, plan: (r) => t(r.leader) },
      ...QUALITY_STEPS.map((st): Col => ({
        h: st.key === 'validacao' ? 'VALIDAÇÃO DA EFICÁCIA DA AÇÕES' : st.label.toUpperCase(),
        w: 12,
        plan: (r) => dt(r.steps[st.key]?.plan),
        done: (r) => {
          const s = r.steps[st.key];
          if (s?.mark === 'na') return { v: 'N/A', s: 0 };
          if (s?.mark === 'hold') return { v: 'ON HOLD', s: 0 };
          return dt(s?.done);
        },
      })),
      { h: 'PLANO DE AÇÃO/CONTRAMEDIDAS', w: 30, plan: (r) => t(r.action_plan, true) },
      { h: 'PRAZO', w: 12, plan: (r) => dt(r.due_on) },
      { h: 'FECHAMENTO', w: 12, plan: (r) => dt(evaluate(r, today).closedOn) },
      { h: 'DIAS TOTAIS', w: 9, plan: (r) => ({ v: evaluate(r, today).totalDays, s: 0 }) },
      { h: 'DIAS ACIMA DO PRAZO', w: 9, plan: (r) => ({ v: evaluate(r, today).daysOver, s: 0 }) },
      { h: 'STATUS GERAL', w: 20, plan: (r) => t(STATUS_TEXT[evaluate(r, today).status]) },
      { h: 'ON HOLD GERAL?', w: 10, plan: (r) => t(r.on_hold ? 'SIM' : 'N/A') },
      { h: 'MOTIVO DE ON HOLD', w: 20, plan: (r) => t(r.on_hold_reason, true) },
      { h: 'INCIDENTE PROCEDENTE?', w: 12, plan: (r) => t(r.procedente) },
      { h: 'FECHADO NO PRAZO?', w: 14, plan: (r) => t(evaluate(r, today).closedOnTime) },
    ];
    const criteria: Record<number, string> = { 1: '24 H', 7: '7 D', 14: '14 D', 34: '34 D', 35: '35 D', 40: '40 D' };
    const rows: (OutCell | null)[][] = [
      [{ v: 'QUADRO DE RESPOSTA RÁPIDA', s: 3 }],
      [{ v: 'DATA:', s: 0 }, { v: dateToSerial(today), s: 1 }],
      [{ v: 'Exportado do Fast Response. Cada ocorrência ocupa duas linhas: prazo (em cima) e realizado (embaixo).', s: 0 }],
      cols.map((c) => {
        const st = QUALITY_STEPS.find((s) => (s.key === 'validacao' ? 'VALIDAÇÃO DA EFICÁCIA DA AÇÕES' : s.label.toUpperCase()) === c.h);
        return st ? { v: `CRITÉRIO ${criteria[st.days]}`, s: 0 } : null;
      }),
      cols.map((c) => ({ v: c.h, s: 2 })),
    ];
    const merges: string[] = [];
    const list = records.filter((r) => r.origin === origin).sort((a, b) => a.opened_on.localeCompare(b.opened_on) || a.number.localeCompare(b.number, 'pt-BR', { numeric: true }));
    for (const r of list) {
      rows.push(cols.map((c) => c.plan(r)));
      rows.push(cols.map((c) => (c.done ? c.done(r) : { v: null, s: 0 })));
      const top = rows.length - 1;
      cols.forEach((c, i) => {
        if (!c.done) {
          const col = colName(i);
          merges.push(`${col}${top}:${col}${top + 1}`);
        }
      });
    }
    return { name: SHEET_NAMES[origin], rows, widths: cols.map((c) => c.w), freezeRow: 5, autoFilterRow: 5, merges };
  });
}
