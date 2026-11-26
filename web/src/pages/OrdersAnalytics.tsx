import { useState } from 'react';
import { orderAnalyticsDomains, type WoDomain } from '@shared/maintenance';
import { AnalyticsDashboard } from '../components/os/Analytics';
import { WoDetail } from '../components/os/WoDetail';
import { cx } from '../components/ui';
import { useMe } from '../lib/session';
import { WoDomainProvider } from '../lib/workOrders';

/** Indicadores → "Manutenção e ajustes": the analytical dashboard of OS or OA on a single page (who sees which module: orderAnalyticsDomains). */
export function OrdersAnalyticsPage() {
  const me = useMe();
  const allowed = orderAnalyticsDomains(me, me.area?.slug);
  const [domain, setDomain] = useState<WoDomain>(allowed[0] ?? 'manutencao');
  const single = allowed.length === 1;
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">{single ? (domain === 'manutencao' ? 'Manutenção' : 'Ajustes') : 'Manutenção e ajustes'}</h1>
        {!single && <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5" role="radiogroup" aria-label="Módulo">
          {([['manutencao', 'Manutenção (OS)'], ['ajuste', 'Ajustes (OA)']] as [WoDomain, string][]).filter(([v]) => allowed.includes(v)).map(([v, l]) => (
            <button key={v} role="radio" aria-checked={domain === v} onClick={() => { setDomain(v); setOpen(null); }}
              className={cx('rounded-md px-3 py-1.5 text-sm font-medium', domain === v ? 'bg-brand-600 text-white' : 'text-gray-600 hover:text-gray-900')}>{l}</button>
          ))}
        </div>}
      </div>
      <WoDomainProvider value={domain}>
        <AnalyticsDashboard key={domain} onOpen={setOpen} />
        {open && <WoDetail id={open} onClose={() => setOpen(null)} />}
      </WoDomainProvider>
    </div>
  );
}
