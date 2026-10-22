import { ORIGIN_COLORS, ORIGIN_LABELS, Q_STATUS_LABELS, QUALITY_STEPS, type QSteps, type QStatus, type QualityOrigin, type StepKey, type StepState } from '@shared/quality';
import { dmy, STATUS_TONE, STEP_STATE_LABELS, STEP_TONE } from '../../lib/quality';
import { cx } from '../ui';

export function QStatusBadge({ status }: { status: QStatus }) {
  return <span className={cx('inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', STATUS_TONE[status])}>{Q_STATUS_LABELS[status]}</span>;
}

export function OriginTag({ origin, short }: { origin: QualityOrigin; short?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-gray-700">
      <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: ORIGIN_COLORS[origin] }} />
      {short ? ORIGIN_LABELS[origin].replace('NC ', '') : ORIGIN_LABELS[origin]}
    </span>
  );
}

/** The 11 steps as a compact strip (one square per step). */
export function StepDots({ states, steps, size = 'sm' }: { states: Record<StepKey, StepState>; steps: QSteps; size?: 'sm' | 'md' }) {
  return (
    <span className="inline-flex gap-[3px]" role="img" aria-label={QUALITY_STEPS.map((s) => `${s.label}: ${STEP_STATE_LABELS[states[s.key]]}`).join('; ')}>
      {QUALITY_STEPS.map((s) => {
        const st = states[s.key];
        const step = steps[s.key];
        return (
          <span key={s.key}
            title={`${s.label} — ${STEP_STATE_LABELS[st]} · prazo ${dmy(step.plan)}${step.done ? ` · realizada ${dmy(step.done)}` : ''}`}
            className={cx('inline-block rounded-[3px] border', size === 'sm' ? 'h-3 w-2.5' : 'h-4 w-3.5', STEP_TONE[st], st === 'na' && 'bg-[repeating-linear-gradient(135deg,#e5e7eb_0_2px,#fff_2px_4px)]')} />
        );
      })}
    </span>
  );
}

export function StepLegend() {
  const order: StepState[] = ['feito', 'feito_atrasado', 'atrasado', 'pendente', 'hold', 'na'];
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-600">
      {order.map((s) => (
        <span key={s} className="inline-flex items-center gap-1">
          <span className={cx('inline-block h-3 w-2.5 rounded-[3px] border', STEP_TONE[s], s === 'na' && 'bg-[repeating-linear-gradient(135deg,#e5e7eb_0_2px,#fff_2px_4px)]')} />
          {STEP_STATE_LABELS[s]}
        </span>
      ))}
    </div>
  );
}
