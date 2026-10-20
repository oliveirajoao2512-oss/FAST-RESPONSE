import { AlertOctagon, Ban, CheckCircle2, Clock, Loader2, ShieldAlert, X } from 'lucide-react';
import { useEffect, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { PRIORITY_LABELS, STATUS_LABELS, type Priority, type Status } from '@shared/constants';
import { errorMessage } from '../lib/api';
import { dueText } from '../lib/format';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

type BtnKind = 'primary' | 'secondary' | 'danger' | 'ghost' | 'success';
export function Button({ kind = 'secondary', loading, className, children, size = 'md', ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: BtnKind; loading?: boolean; size?: 'sm' | 'md' }) {
  const styles: Record<BtnKind, string> = {
    primary: 'bg-brand-600 text-white hover:bg-brand-700 border-brand-600',
    secondary: 'bg-white text-gray-800 hover:bg-gray-50 border-gray-300',
    danger: 'bg-red-600 text-white hover:bg-red-700 border-red-600',
    success: 'bg-emerald-600 text-white hover:bg-emerald-700 border-emerald-600',
    ghost: 'bg-transparent text-gray-700 hover:bg-gray-100 border-transparent',
  };
  return (
    <button
      type="button"
      {...p}
      disabled={p.disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg border font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
        size === 'sm' ? 'px-2.5 py-1 text-sm' : 'px-3.5 py-2 text-sm',
        styles[kind],
        className,
      )}
    >
      {loading && <Loader2 size={16} className="animate-spin" />}
      {children}
    </button>
  );
}

export const STATUS_STYLE: Record<Status, string> = {
  aberta: 'bg-slate-100 text-slate-700 ring-slate-300',
  aguardando_responsavel: 'bg-amber-50 text-amber-800 ring-amber-300',
  planejada: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  em_andamento: 'bg-blue-50 text-blue-700 ring-blue-200',
  bloqueada: 'bg-fuchsia-50 text-fuchsia-800 ring-fuchsia-300',
  aguardando_validacao: 'bg-teal-50 text-teal-800 ring-teal-300',
  concluida: 'bg-emerald-50 text-emerald-800 ring-emerald-300',
  cancelada: 'bg-gray-100 text-gray-500 ring-gray-300',
};
export const STATUS_DOT: Record<Status, string> = {
  aberta: 'bg-slate-400', aguardando_responsavel: 'bg-amber-500', planejada: 'bg-indigo-500', em_andamento: 'bg-blue-600',
  bloqueada: 'bg-fuchsia-600', aguardando_validacao: 'bg-teal-600', concluida: 'bg-emerald-600', cancelada: 'bg-gray-400',
};

export function StatusBadge({ status }: { status: Status }) {
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap', STATUS_STYLE[status])}>
      {status === 'bloqueada' && <Ban size={12} />}
      {status === 'concluida' && <CheckCircle2 size={12} />}
      {STATUS_LABELS[status]}
    </span>
  );
}

const PRIORITY_STYLE: Record<Priority, string> = {
  baixa: 'bg-gray-100 text-gray-600',
  media: 'bg-sky-100 text-sky-800',
  alta: 'bg-orange-100 text-orange-800',
  critica: 'bg-red-600 text-white',
};
export function PriorityBadge({ priority, safety }: { priority: Priority; safety?: boolean }) {
  return (
    <span className={cx('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide whitespace-nowrap', PRIORITY_STYLE[priority])}>
      {safety && <ShieldAlert size={12} aria-label="Segurança" />}
      {PRIORITY_LABELS[priority]}
    </span>
  );
}

export function OverdueBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-red-100 px-1.5 py-0.5 text-xs font-bold text-red-700 ring-1 ring-red-300 whitespace-nowrap">
      <AlertOctagon size={12} /> ATRASADA
    </span>
  );
}

export function DueLabel({ due, overdue, closed }: { due: string | null; overdue?: boolean; closed?: boolean }) {
  if (closed) return null;
  const text = dueText(due);
  const soon = due && !overdue && new Date(due).getTime() - Date.now() < 6 * 3600_000;
  return (
    <span className={cx('inline-flex items-center gap-1 text-xs whitespace-nowrap', overdue ? 'font-semibold text-red-700' : soon ? 'font-medium text-amber-700' : 'text-gray-600')}>
      <Clock size={12} /> {text}
    </span>
  );
}

export function Progress({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cx('h-1.5 w-full rounded-full bg-gray-200', className)} role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100} aria-label="Progresso das etapas">
      <div className={cx('h-1.5 rounded-full', value === 100 ? 'bg-emerald-600' : 'bg-brand-600')} style={{ width: `${value}%` }} />
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    setTimeout(() => ref.current?.querySelector<HTMLElement>('input,textarea,select,button[data-autofocus]')?.focus(), 30);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}
        className={cx('flex max-h-[95vh] w-full flex-col rounded-t-2xl sm:rounded-2xl bg-white shadow-xl', wide ? 'sm:max-w-4xl' : 'sm:max-w-lg')}>
        <div className="flex items-center justify-between gap-3 border-b px-5 py-3">
          <h2 className="text-base font-semibold text-gray-900">{title}</h2>
          <button onClick={onClose} className="rounded p-1 text-gray-500 hover:bg-gray-100" aria-label="Fechar"><X size={20} /></button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, hint, error, required, children, className }: { label: string; hint?: string; error?: string; required?: boolean; children: ReactNode; className?: string }) {
  // hint/error stay outside <label> so the control's accessible name is just the label text
  return (
    <div className={className}>
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-gray-700">
          {label} {required && <span className="text-red-600" aria-hidden>*</span>}
        </span>
        {children}
      </label>
      {hint && !error && <span className="mt-1 block text-xs text-gray-500">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-red-600" role="alert">{error}</span>}
    </div>
  );
}

const inputCls = 'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-200 focus:outline-none disabled:bg-gray-50';
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx(inputCls, p.className)} />;
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea rows={3} {...p} className={cx(inputCls, p.className)} />;
export const Select = ({ children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={cx(inputCls, 'pr-8', p.className)}>{children}</select>;

export function Spinner({ label = 'Carregando…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-gray-500" role="status">
      <Loader2 className="animate-spin" size={18} /> {label}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">
      <AlertOctagon size={18} />
      <span className="flex-1">{errorMessage(error)}</span>
      {onRetry && <Button size="sm" onClick={onRetry}>Tentar novamente</Button>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-gray-300 px-4 py-8 text-center text-sm text-gray-500">{children}</div>;
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-xl border border-gray-200 bg-white', className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-3">
          {title && <h2 className="text-sm font-semibold text-gray-900">{title}</h2>}
          {actions}
        </div>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Kpi({ label, value, tone = 'default', onClick, hint, icon }: { label: string; value: ReactNode; tone?: 'default' | 'danger' | 'warn' | 'ok' | 'info'; onClick?: () => void; hint?: string; icon?: ReactNode }) {
  const tones = {
    default: 'text-gray-900',
    danger: 'text-red-700',
    warn: 'text-amber-700',
    ok: 'text-emerald-700',
    info: 'text-blue-700',
  };
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag onClick={onClick} className={cx('flex flex-col items-start rounded-xl border border-gray-200 bg-white px-4 py-3 text-left', onClick && 'hover:border-brand-400 hover:shadow-sm cursor-pointer')}>
      <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-gray-500">{icon}{label}</span>
      <span className={cx('mt-1 text-2xl font-bold tabular', tones[tone])}>{value}</span>
      {hint && <span className="text-xs text-gray-500">{hint}</span>}
    </Tag>
  );
}

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[] }) {
  return (
    <div className="inline-flex rounded-lg border border-gray-300 bg-white p-0.5" role="tablist">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={value === o.value} onClick={() => onChange(o.value)}
          className={cx('inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm', value === o.value ? 'bg-brand-600 text-white' : 'text-gray-700 hover:bg-gray-100')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function AreaDot({ color }: { color: string }) {
  return <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />;
}
