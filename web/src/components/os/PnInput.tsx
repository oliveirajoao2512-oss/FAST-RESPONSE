import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { findPn, matchPn, type PartNumber, type PnMatch } from '@shared/partNumbers';
import { get } from '../../lib/api';
import { useWoDomain } from '../../lib/workOrders';
import { cx, Input } from '../ui';

export const usePartNumbers = () => {
  const D = useWoDomain();
  return useQuery<PartNumber[]>({ queryKey: ['os', 'part-numbers'], queryFn: () => get(`${D.api}/part-numbers`), staleTime: 10 * 60_000 });
};

/** Whether the typed PN can be sent: empty, registered, or anything while no PN is registered yet. */
export const pnAccepted = (list: PartNumber[] | undefined, value: string) => !value.trim() || !list?.length || !!findPn(list, value);

const HOW: Record<PnMatch['how'], string> = { exato: '', inicio: '', trecho: '', descricao: 'pela descrição', parecido: 'parecido' };

/**
 * Part number field that recognizes the code while it is typed: it lists the registered PNs that start with,
 * contain or are one or two digits away from the text (a typo), with description and customer, and confirms
 * when the code is a registered one. PNs that run on the chosen machine come first.
 */
export function PnInput({ value, onChange, machine, error }: { value: string; onChange: (v: string) => void; machine?: string | null; error?: boolean }) {
  const list = usePartNumbers();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const id = useId();
  const all = list.data ?? [];
  const exact = findPn(all, value);
  const matches = useMemo(() => matchPn(all, value, { machine, limit: 8 }), [all, value, machine]);
  const showList = open && matches.length > 0 && !(exact && matches.length === 1);
  const pick = (p: PartNumber) => { onChange(p.code); setOpen(false); };
  const best = !exact && value.trim() ? matches[0] : null;

  return (
    <div className="relative">
      <Input id={`${id}-pn`} value={value} autoComplete="off" maxLength={60} inputMode="text" placeholder={all.length ? 'Digite o código ou parte dele' : 'Opcional'}
        role="combobox" aria-expanded={showList} aria-controls={`${id}-list`} aria-autocomplete="list" aria-label="Part number"
        className={cx(error && 'border-red-500', exact && 'border-green-600')}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setActive(0); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (!showList) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, matches.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          else if (e.key === 'Enter') { e.preventDefault(); pick(matches[active]); }
          else if (e.key === 'Escape') setOpen(false);
        }} />
      {showList && (
        <ul id={`${id}-list`} role="listbox" className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
          {!value.trim() && machine && <li className="px-3 pb-1 pt-0.5 text-xs text-gray-500">PNs da máquina {machine}</li>}
          {matches.map((m, i) => (
            <li key={m.code} role="option" aria-selected={i === active}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(m)} onMouseEnter={() => setActive(i)}
                className={cx('block w-full px-3 py-1.5 text-left', i === active ? 'bg-brand-50' : 'hover:bg-gray-50')}>
                <span className="font-mono text-sm font-semibold text-gray-900">{m.code}</span>
                {HOW[m.how] && <span className="ml-2 rounded bg-amber-100 px-1.5 text-[11px] text-amber-800">{HOW[m.how]}</span>}
                {(m.description || m.customer) && (
                  <span className="block truncate text-xs text-gray-600">{[m.description, m.customer].filter(Boolean).join(' · ')}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {exact ? (
        <p className="mt-1 flex items-start gap-1 text-xs text-green-800"><CheckCircle2 size={14} className="mt-px shrink-0" />
          <span>PN cadastrado{exact.description ? `: ${exact.description}` : ''}{exact.customer ? ` · ${exact.customer}` : ''}</span></p>
      ) : value.trim() && all.length ? (
        <p className="mt-1 flex items-start gap-1 text-xs text-amber-800" role="status"><AlertTriangle size={14} className="mt-px shrink-0" />
          <span>
            {best ? <>Esse PN não está na base. Você quis dizer <button type="button" className="font-mono font-semibold underline" onClick={() => pick(best)}>{best.code}</button>{best.description ? ` (${best.description})` : ''}?</>
              : <>Esse PN não está na base. Confira o código ou peça o cadastro ao gestor.</>}
          </span>
        </p>
      ) : null}
    </div>
  );
}
