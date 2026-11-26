import { useState } from 'react';
import type { WoDomain } from '@shared/maintenance';
import { AnalyticsDashboard } from '../components/os/Analytics';
import { WoDetail } from '../components/os/WoDetail';
import { cx } from '../components/ui';
import { WoDomainProvider } from '../lib/workOrders';

/** Indicadores → "Manutenção e ajustes": the analytical dashboard of OS or OA on a single page (administrator and gestor of Produção). */
export function OrdersAnalyticsPage() {
  const [domain, setDomain] = useState<WoDomain>('manutencao');
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Manutenção e ajustes</h1>
        <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5" role="radiogroup" aria-label="Módulo">
          {([['manutencao', 'Manutenção (OS)'], ['ajuste', 'Ajustes (OA)']] as [WoDomain, string][]).map(([v, l]) => (
            <button key={v} role="radio" aria-checked={domain === v} onClick={() => { setDomain(v); setOpen(null); }}
              className={cx('rounded-md px-3 py-1.5 text-sm font-medium', domain === v ? 'bg-brand-600 text-white' : 'text-gray-600 hover:text-gray-900')}>{l}</button>
          ))}
        </div>
      </div>
      <WoDomainProvider value={domain}>
        <AnalyticsDashboard key={domain} onOpen={setOpen} />
        {open && <WoDetail id={open} onClose={() => setOpen(null)} />}
      </WoDomainProvider>
    </div>
  );
}
