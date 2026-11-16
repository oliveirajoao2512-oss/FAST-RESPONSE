import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, HelpCircle, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { normalizeToolCode, TOOL_PREFIX, type ToolType } from '@shared/maintenance';
import { findPn, matchPn, pnKey, type PartNumber } from '@shared/partNumbers';
import { machineKey, pnDigits, TOOL_REASON_LABELS, toolMatches, type Tool, type ToolReason } from '@shared/tools';
import { get, qs } from '../../lib/api';
import { useWoDomain } from '../../lib/workOrders';
import { cx, Input } from '../ui';
import { PnInput, usePartNumbers } from './PnInput';

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
 * Picks the device (D) or trim die (T) of an order on a machine, and with `onPn` also the part number, in one field:
 * typing the D fills the PN (or offers the PNs of that D), typing the PN finds its D (selected when there is only one,
 * offered as options when there are several). Without anything typed it brings the ones of the machine and, when
 * there is only one, selects it by itself, so the opener only confirms. "Não sei qual" leaves it for the maintainer.
 * `value`: the code, null for "não sei", undefined while nothing was chosen.
 */
export function ToolPicker({ type, asset, pn, onPn, pnError, value, onChange }: {
  type: ToolType; asset: string; pn: string; value: string | null | undefined; onChange: (code: string | null | undefined) => void;
  /** when given, the picker also sets the part number (the opening then has no separate PN field) */
  onPn?: (pn: string) => void; pnError?: boolean;
}) {
  const res = useTools(asset, pn);
  const pnList = usePartNumbers();
  const w = WHAT[type];
  const [search, setSearch] = useState('');
  const [otherPn, setOtherPn] = useState(false);
  const touched = useRef(false);
  const all = useMemo(() => (res.data?.tools ?? []).filter((t) => t.type === type), [res.data, type]);
  const byCode = useMemo(() => new Map(all.map((t) => [t.code, t])), [all]);
  const pns = pnList.data ?? [];
  const suggested = useMemo(() => {
    const s = (res.data?.suggested ?? []).filter((x) => byCode.has(x.code));
    // the part number is the surest link: when it gives any, those are the ones
    const fromPn = s.filter((x) => x.why === 'pn');
    return (fromPn.length ? fromPn : s).slice(0, 8);
  }, [res.data, byCode]);
  const pnTyped = pn.trim();
  const pnSet = onPn && pnTyped ? findPn(pns, pnTyped) : null;

  // only one candidate: select it, until the person chooses by hand
  useEffect(() => {
    if (touched.current || !res.data) return;
    if (suggested.length === 1) onChange(suggested[0].code);
    else if (value) onChange(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggested.map((s) => s.code).join(), res.data]);

  /** Registered part numbers made with a tool, those of this machine first. */
  const pnsOf = (code: string | null | undefined): PartNumber[] => {
    const t = code ? byCode.get(code) : null;
    if (!t?.part_numbers.length) return [];
    const set = new Set(t.part_numbers);
    const mk = machineKey(asset);
    return pns.filter((p) => set.has(pnDigits(p.code))).sort((a, b) => Number(machineKey(b.machine) === mk) - Number(machineKey(a.machine) === mk));
  };
  const fits = (code: string, p: string) => !!byCode.get(code)?.part_numbers.includes(pnDigits(p));

  const choose = (code: string | null) => {
    touched.current = true; setSearch(''); setOtherPn(false); onChange(code);
    if (!onPn || !code) return;
    // the D brings its PN: the only one it makes, or none (options shown) when the one typed is not of this D
    if (pnTyped && fits(code, pnTyped)) return;
    const own = pnsOf(code);
    if (own.length === 1) onPn(own[0].code);
    else if (pnTyped && own.length) onPn('');
  };
  /** The PN brings its D: the suggestions of that PN are selected (one) or offered (several). */
  const choosePn = (code: string) => {
    setSearch(''); setOtherPn(false); onPn?.(code);
    // keep a D chosen by hand that makes this product; otherwise let the PN's own D(s) come
    if (value && fits(value, code)) { touched.current = true; return; }
    touched.current = false;
    if (value) onChange(undefined);
  };
  /** Picks the product of a D already chosen: the D stays. */
  const pickPnOfTool = (code: string) => { touched.current = true; setOtherPn(false); onPn?.(code); };

  const q = search.trim();
  const results = q ? all.filter((t) => toolMatches(t, q)).slice(0, 8) : [];
  // short numbers are D numbers ("405"); a PN needs more digits, or a product name
  const pnResults = useMemo(() => (onPn && q && (pnKey(q).length >= 5 || /[A-Za-zÀ-ú]{3}/.test(q)) ? matchPn(pns, q, { machine: asset, limit: 6 }) : []),
    [onPn, q, pns, asset]);
  const typed = normalizeToolCode(search, type);
  const chosen = value ? byCode.get(value) : null;
  const auto = value && !touched.current;
  const own = onPn && value ? pnsOf(value) : [];

  const pnLine = pnSet || (onPn && pnTyped) ? (
    <div className="mt-2 flex items-center gap-2 border-t border-gray-100 pt-2 text-sm">
      <span className="text-xs text-gray-500">Produto:</span>
      <span className="font-mono font-semibold text-gray-900">{pnSet?.code ?? pnTyped}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-gray-600">{pnSet?.description ?? ''}</span>
      <button type="button" className="shrink-0 text-xs font-medium text-brand-700 hover:underline" onClick={() => { touched.current = true; onPn!(''); }}>Trocar produto</button>
    </div>
  ) : null;
  const pnField = (label: string) => (
    <div className="mt-2">
      <span className="mb-1 block text-xs text-gray-600">{label}</span>
      <PnInput value={pn} onChange={(v) => { touched.current = true; onPn!(v); }} machine={asset} error={pnError} />
    </div>
  );

  return (
    <div className="rounded-xl border-2 border-gray-900/80 bg-gray-50 p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-gray-900">Qual {w.name.toLowerCase()}? <span className="font-normal text-gray-500">({TOOL_PREFIX[type]} da planilha{onPn ? ' ou part number' : ''})</span></span>
        {res.isFetching && <span className="text-xs text-gray-400">buscando…</span>}
      </div>

      {value ? (
        <div className="rounded-lg border border-green-600 bg-white px-3 py-2" role="status">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="shrink-0 text-green-600" size={20} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2"><ToolCode code={value} className="text-lg" />
                {auto && <span className="rounded bg-green-100 px-1.5 text-[11px] font-medium text-green-800">encontrado automaticamente</span>}</div>
              {chosen?.description && <div className="mt-0.5 truncate text-xs text-gray-600">{chosen.description}</div>}
            </div>
            <button type="button" className="shrink-0 text-sm font-medium text-brand-700 hover:underline" onClick={() => { touched.current = true; onChange(undefined); }}>Trocar</button>
          </div>
          {onPn && (pnLine ?? (own.length && !otherPn ? (
            <div className="mt-2 border-t border-gray-100 pt-2">
              <span className="mb-1 block text-xs text-gray-600">Qual produto está na máquina? <span className="text-gray-400">(opcional)</span></span>
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Produto">
                {own.slice(0, 8).map((p) => (
                  <button key={p.code} type="button" role="radio" aria-checked={false} onClick={() => pickPnOfTool(p.code)} title={p.description ?? undefined}
                    className="rounded-md border border-gray-300 bg-white px-2 py-1 text-left hover:border-brand-500 hover:bg-brand-50">
                    <span className="block font-mono text-xs font-semibold text-gray-900">{p.code}</span>
                    {p.description && <span className="block max-w-[14rem] truncate text-[11px] text-gray-600">{p.description}</span>}
                  </button>
                ))}
                <button type="button" onClick={() => setOtherPn(true)} className="rounded-md px-2 py-1 text-xs font-medium text-gray-600 hover:underline">Outro</button>
              </div>
            </div>
          ) : pnField('Part number (opcional): o produto que está na máquina')))}
        </div>
      ) : value === null ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
          <div className="flex items-center gap-3">
            <HelpCircle size={18} className="shrink-0" />
            <span className="flex-1">Sem {w.name.toLowerCase()} informado: o manutentor informa na OS.</span>
            <button type="button" className="shrink-0 font-medium text-brand-700 hover:underline" onClick={() => onChange(undefined)}>Escolher</button>
          </div>
          {onPn && pnField('Part number (opcional): o produto que está na máquina')}
        </div>
      ) : (
        <>
          {pnLine && <div className="-mt-2 mb-2">{pnLine}</div>}
          {suggested.length > 0 && (
            <div className="mb-2">
              <span className="mb-1 block text-xs text-gray-500">
                {suggested[0].why === 'pn'
                  ? (suggested.length > 1 ? `O part number ${pnTyped} usa mais de um ${w.name.toLowerCase()}. Escolha:` : `Do part number ${pnTyped}:`)
                  : `Da máquina ${asset}:`}
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
                ? `Nenhum ${w.name.toLowerCase()} ligado à máquina ${asset}${pnTyped ? ' nem ao part number' : ''}. Busque pelo número${onPn && !pnTyped ? ' ou pelo part number' : ''}.`
                : `Digite o número d${type === 'dispositivo' ? 'o dispositivo' : 'o trim die'} (ex.: ${w.ex}).`}
            </p>
          )}
          <div className="relative">
            <Search size={16} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} autoComplete="off" className="pl-8"
              placeholder={onPn ? `Digite o ${TOOL_PREFIX[type]} (${w.ex.slice(1)}) ou o part number` : `Buscar: número (${w.ex.slice(1)}), produto ou molde`}
              aria-label={onPn ? `Buscar ${w.name.toLowerCase()} ou part number` : `Buscar ${w.name.toLowerCase()}`} />
          </div>
          {q && (
            <ul className="mt-1 max-h-72 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1" role="listbox">
              {pnResults.length > 0 && <li className="px-3 pb-0.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">{w.name}s</li>}
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
              {pnResults.length > 0 && <>
                <li className="mt-1 border-t border-gray-100 px-3 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Part numbers</li>
                {pnResults.map((p) => (
                  <li key={p.code} role="option" aria-selected={false}>
                    <button type="button" onClick={() => choosePn(p.code)} className="block w-full px-3 py-1.5 text-left hover:bg-brand-50">
                      <span className="font-mono text-sm font-semibold text-gray-900">{p.code}</span>
                      {p.how === 'parecido' && <span className="ml-2 rounded bg-amber-100 px-1.5 text-[11px] text-amber-800">parecido</span>}
                      {p.description && <span className="block truncate text-xs text-gray-600">{p.description}</span>}
                    </button>
                  </li>
                ))}
              </>}
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
