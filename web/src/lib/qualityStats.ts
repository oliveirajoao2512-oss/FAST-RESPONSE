import { daysBetween, ORIGIN_LABELS, Q_OPEN_STATUSES, QUALITY_ORIGINS, QUALITY_STEPS, STEP_LABELS, type QualityOrigin, type StepKey } from '@shared/quality';
import { dmy, monthLabel, type QualityNc } from './quality';

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : null);
const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : null);

export interface ActionItem { nc: QualityNc; step: StepKey | null; plan: string | null; days: number }

/** Everything the panel shows, computed from the filtered list. */
export function qualityStats(list: QualityNc[], today: string, year: string) {
  const open = list.filter((n) => Q_OPEN_STATUSES.includes(n.eval.status));
  const closed = list.filter((n) => n.eval.status === 'concluido_no_prazo' || n.eval.status === 'concluido_fora');
  const onTime = closed.filter((n) => n.eval.status === 'concluido_no_prazo').length;

  // next step of each open NC: overdue first (most days late), then the closest deadline
  const actions: ActionItem[] = open
    .map((nc) => {
      const step = nc.eval.currentStep;
      const plan = step ? nc.steps[step].plan : nc.due_on;
      return { nc, step, plan, days: plan ? daysBetween(plan, today) : 0 };
    })
    .sort((a, b) => Number(b.nc.eval.status !== 'on_hold') - Number(a.nc.eval.status !== 'on_hold') || b.days - a.days);

  // months shown: the selected year, or the last 12 months
  const refYear = year === 'todos' ? null : year;
  const months: string[] = [];
  if (refYear) for (let m = 1; m <= 12; m++) months.push(`${refYear}-${String(m).padStart(2, '0')}`);
  else {
    const [y, m] = today.split('-').map(Number);
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(y, m - 1 - i, 1));
      months.push(d.toISOString().slice(0, 7));
    }
  }
  const byMonth = months.map((ym) => {
    const row: Record<string, string | number> = { ym, label: monthLabel(ym) };
    for (const o of QUALITY_ORIGINS) row[o] = list.filter((n) => n.origin === o && n.opened_on.startsWith(ym)).length;
    return row as { ym: string; label: string } & Record<QualityOrigin, number>;
  });
  const thisMonth = today.slice(0, 7);
  const farol = months.map((ym) => {
    const ext = list.filter((n) => n.origin === 'externa' && n.opened_on.startsWith(ym));
    return { ym, label: monthLabel(ym), count: ext.length, official: ext.filter((n) => n.claim_type?.toLowerCase() === 'oficial').length, future: ym > thisMonth, noData: false };
  });

  const group = <K extends string>(key: (n: QualityNc) => K | null) => {
    const m = new Map<K, QualityNc[]>();
    for (const n of list) {
      const k = key(n);
      if (!k) continue;
      m.set(k, [...(m.get(k) ?? []), n]);
    }
    return m;
  };
  const problems = [...group((n) => n.primary_problem)].map(([name, ns]) => ({ name, count: ns.length })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  let acc = 0;
  const total = problems.reduce((s, p) => s + p.count, 0);
  const pareto = problems.map((p) => ({ ...p, cum: Math.round(((acc += p.count) / total) * 100) }));

  const steps = QUALITY_STEPS.map((s) => ({
    key: s.key,
    label: s.label,
    overdue: list.filter((n) => n.eval.stepStates[s.key] === 'atrasado' && Q_OPEN_STATUSES.includes(n.eval.status)).length,
    late: list.filter((n) => n.eval.stepStates[s.key] === 'feito_atrasado').length,
  }));

  const partners = [...group((n) => n.partner)].map(([name, ns]) => ({
    name,
    total: ns.length,
    open: ns.filter((n) => Q_OPEN_STATUSES.includes(n.eval.status)).length,
    late: ns.filter((n) => n.eval.status === 'atrasado').length,
    origins: [...new Set(ns.map((n) => n.origin))],
  })).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  const leaders = [...group((n) => n.leader)].map(([name, ns]) => {
    const cl = ns.filter((n) => n.eval.status === 'concluido_no_prazo' || n.eval.status === 'concluido_fora');
    return {
      name,
      open: ns.filter((n) => Q_OPEN_STATUSES.includes(n.eval.status)).length,
      late: ns.filter((n) => n.eval.status === 'atrasado').length,
      closed: cl.length,
      onTimePct: pct(cl.filter((n) => n.eval.status === 'concluido_no_prazo').length, cl.length),
      avgDays: avg(cl.map((n) => n.eval.totalDays)),
    };
  }).sort((a, b) => b.open - a.open || b.closed - a.closed);

  return {
    kpi: {
      total: list.length,
      open: open.length,
      late: list.filter((n) => n.eval.status === 'atrasado').length,
      hold: list.filter((n) => n.eval.status === 'on_hold').length,
      closed: closed.length,
      onTime,
      onTimePct: pct(onTime, closed.length),
      avgDays: avg(closed.map((n) => n.eval.totalDays)),
      safety: list.filter((n) => n.safety).length,
      recurrent: list.filter((n) => n.recurrent).length,
    },
    actions,
    byMonth,
    farol,
    pareto,
    steps,
    partners,
    leaders,
  };
}

export type QualityStats = ReturnType<typeof qualityStats>;

/** Short text summary to paste in e-mail, Teams or WhatsApp. */
export function summaryText(s: QualityStats, today: string, scope: string) {
  const lines = [
    `*Resposta Rápida — situação em ${dmy(today)}*${scope ? ` (${scope})` : ''}`,
    `• ${s.kpi.open} ocorrência(s) em aberto: ${s.kpi.late} atrasada(s), ${s.kpi.hold} em on hold`,
    `• Encerradas: ${s.kpi.closed}${s.kpi.onTimePct != null ? `, ${s.kpi.onTimePct}% no prazo` : ''}${s.kpi.avgDays != null ? ` · tempo médio ${s.kpi.avgDays} dias` : ''}`,
  ];
  const cur = s.farol.find((f) => f.ym === today.slice(0, 7));
  if (cur) lines.push(`• Reclamações de clientes em ${cur.label}: ${cur.count} (meta: zero)`);
  if (s.pareto[0]) lines.push(`• Principal problema: ${s.pareto[0].name} (${s.pareto[0].count})`);
  const late = s.actions.filter((a) => a.nc.eval.status === 'atrasado').slice(0, 5);
  if (late.length) {
    lines.push('', '*Maiores atrasos*');
    for (const a of late) lines.push(`• ${a.nc.number} ${ORIGIN_LABELS[a.nc.origin].replace('NC ', '')} · ${a.nc.partner ?? '—'} · ${a.step ? STEP_LABELS[a.step] : 'encerramento'} · ${a.days} dia(s) · ${a.nc.leader ?? 'sem líder'}`);
  }
  return lines.join('\n');
}
