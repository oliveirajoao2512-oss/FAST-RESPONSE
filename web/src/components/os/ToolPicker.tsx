import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, HelpCircle, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { normalizeToolCode, TOOL_PREFIX, type ToolType } from '@shared/maintenance';
import { pnDigits, TOOL_REASON_LABELS, toolMatches, type Tool, type ToolReason } from '@shared/tools';
import { get, qs } from '../../lib/api';
import { useWoDomain } from '../../lib/workOrders';
import { cx, Input } from '../ui';

export interface ToolsResponse { tools: Tool[]; suggested: { code: string; why: ToolReason }[] }

export const useTools = (asset: string, pn?: string | null) => {
  const D = useWoDomain();
  const key = pnDigits(pn);
  return useQuery<ToolsResponse>({
    queryKey: ['os', 'tools', asset, key], queryFn: () => get(`${D.api}/tools${qs({ asset, pn: key || undefined })}`),
    staleTime: 5 * 60_000, placeholderData: (prev) => prev,
  });
};

const WHAT: Record<ToolType, { name: string; the: string; ex: string }> = {
  dispositivo: { name: 'Dispositivo', the: 'o dispositivo', ex: 'D405' },
  trim_die: { name: 'Trim die', the: 'o trim die', ex: 'T129' },
};

/** "D405" in the plant's style: big, monospaced, impossible to miss. */
export function ToolCode({ code, className }: { code: string; className?: string }) {
  return <span className={cx('rounded-md bg-gray-900 px-1.5 py-0.5 font-mono font-bold tracking-wide text-white', className)}>{code}</span>;
}

/**
 * Picks the device (D) or trim die (T) of an order on a machine. It brings the ones of the part number / machine and,
 * when there is only one, selects it by itself, so the opener only confirms. Any other can be searched by number,
 * product or mold, and "Não sei qual" leaves it for the maintainer to inform.
 * `value`: the code, null for "não sei", undefined while nothing was chosen.
 */
export function ToolPicker({ type, asset, pn, value, onChange }: {
  type: ToolType; asset: string; pn: string; value: string | null | undefined; onChange: (code: string | null | undefined) => void;
}) {
  const res = useTools(asset, pn);
  const w = WHAT[type];
  const [search, setSearch] = useState('');
  const touched = useRef(false);
  const all = useMemo(() => (res.data?.tools ?? []).filter((t) => t.type === type), [res.data, type]);
  const byCode = useMemo(() => new Map(all.map((t) => [t.code, t])), [all]);
  const suggested = useMemo(() => {
    const s = (res.data?.suggested ?? []).filter((x) => byCode.has(x.code));
    // the part number is the surest link: when it gives any, those are the ones
    const fromPn = s.filter((x) => x.why === 'pn');
    return (fromPn.length ? fromPn : s).slice(0, 8);
  }, [res.data, byCode]);

  // only one candidate: select it, until the person chooses by hand
  useEffect(() => {
    if (touched.current || !res.data) return;
    if (suggested.length === 1) onChange(suggested[0].code);
    else if (value) onChange(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggested.map((s) => s.code).join(), res.data]);

  const choose = (code: string | null) => { touched.current = true; setSearch(''); onChange(code); };
  const results = search.trim() ? all.filter((t) => toolMatches(t, search)).slice(0, 8) : [];
  const typed = normalizeToolCode(search, type);
  const chosen = value ? byCode.get(value) : null;
  const auto = value && !touched.current;

  return (
    <div className="rounded-xl border-2 border-gray-900/80 bg-gray-50 p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-gray-900">Qual {w.name.toLowerCase()}? <span className="font-normal text-gray-500">({TOOL_PREFIX[type]} da planilha)</span></span>
        {res.isFetching && <span className="text-xs text-gray-400">buscando…</span>}
      </div>

      {value ? (
        <div className="flex items-center gap-3 rounded-lg border border-green-600 bg-white px-3 py-2" role="status">
          <CheckCircle2 className="shrink-0 text-green-600" size={20} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2"><ToolCode code={value} className="text-lg" />
              {auto && <span className="rounded bg-green-100 px-1.5 text-[11px] font-medium text-green-800">encontrado automaticamente</span>}</div>
            {chosen?.description && <div className="mt-0.5 truncate text-xs text-gray-600">{chosen.description}</div>}
          </div>
          <button type="button" className="shrink-0 text-sm font-medium text-brand-700 hover:underline" onClick={() => { touched.current = true; onChange(undefined); }}>Trocar</button>
        </div>
      ) : value === null ? (
        <div className="flex items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
          <HelpCircle size={18} className="shrink-0" />
          <span className="flex-1">Sem {w.name.toLowerCase()} informado: o manutentor informa na OS.</span>
          <button type="button" className="shrink-0 font-medium text-brand-700 hover:underline" onClick={() => onChange(undefined)}>Escolher</button>
        </div>
      ) : (
        <>
          {suggested.length > 0 && (
            <div className="mb-2">
              <span className="mb-1 block text-xs text-gray-500">
                {suggested[0].why === 'pn' ? `Do part number ${pn.trim()}:` : `Da máquina ${asset}:`}
              </span>
              <div className="grid gap-1.5" role="radiogroup" aria-label={`${w.name}s sugeridos`}>
                {suggested.map((s) => {
                  const t = byCode.get(s.code)!;
                  return (
                    <button key={s.code} type="button" role="radio" aria-checked={false} onClick={() => choose(s.code)}
                      className="flex items-center gap-3 rounded-lg border border-gray-300 bg-white px-3 py-2 text-left hover:border-brand-500 hover:bg-brand-50">
                      <ToolCode code={s.code} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-gray-800">{t.description ?? 'sem descrição'}</span>
                        <span className="block text-[11px] text-gray-500">{TOOL_REASON_LABELS[s.why]}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {!res.isLoading && !suggested.length && (
            <p className="mb-2 text-xs text-gray-600">
              {all.length
                ? `Nenhum ${w.name.toLowerCase()} ligado à máquina ${asset}${pn.trim() ? ' nem ao part number' : ''}. ${pn.trim() ? 'Busque' : 'Informe o part number abaixo ou busque'} pelo número.`
                : `Digite o número d${type === 'dispositivo' ? 'o dispositivo' : 'o trim die'} (ex.: ${w.ex}).`}
            </p>
          )}
          <div className="relative">
            <Search size={16} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Buscar: número (${w.ex.slice(1)}), produto ou molde`} aria-label={`Buscar ${w.name.toLowerCase()}`}
              className="pl-8" autoComplete="off" />
          </div>
          {search.trim() && (
            <ul className="mt-1 max-h-60 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1" role="listbox">
              {results.map((t) => (
                <li key={t.code} role="option" aria-selected={false}>
                  <button type="button" onClick={() => choose(t.code)} className="flex w-full items-center gap-3 px-3 py-1.5 text-left hover:bg-brand-50">
                    <ToolCode code={t.code} className="text-sm" /><span className="truncate text-sm text-gray-700">{t.description ?? 'sem descrição'}</span>
                  </button>
                </li>
              ))}
              {!results.length && (!all.length && typed ? (
                <li><button type="button" onClick={() => choose(typed)} className="w-full px-3 py-1.5 text-left text-sm hover:bg-brand-50">Usar <ToolCode code={typed} className="text-sm" /></button></li>
              ) : <li className="px-3 py-1.5 text-sm text-gray-500">Nenhum {w.name.toLowerCase()} encontrado.</li>)}
            </ul>
          )}
          <button type="button" className="mt-2 text-sm font-medium text-gray-600 underline-offset-2 hover:underline" onClick={() => choose(null)}>
            Não sei qual é {w.the}
          </button>
        </>
      )}
    </div>
  );
}
