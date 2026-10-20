import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useOpenIssue } from '../components/issues';
import { Button, cx, Empty, ErrorBox, Spinner } from '../components/ui';
import { get, post } from '../lib/api';
import { fmtDateTime } from '../lib/format';

export function NotificationsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['notifications', 'all'], queryFn: () => get('/api/notifications?limit=200') });
  const openIssue = useOpenIssue();
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Notificações</h1>
        <Button onClick={() => post('/api/notifications/read', { all: true }).then(() => qc.invalidateQueries())}>Marcar todas como lidas</Button>
      </div>
      {q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} /> : q.data.length === 0 ? <Empty>Nenhuma notificação.</Empty> : (
        <ul className="divide-y rounded-xl border border-gray-200 bg-white">
          {q.data.map((n: any) => (
            <li key={n.id}>
              <button className={cx('block w-full px-4 py-3 text-left hover:bg-gray-50', !n.read_at && 'bg-brand-50')}
                onClick={() => { post('/api/notifications/read', { ids: [n.id] }).then(() => qc.invalidateQueries({ queryKey: ['notifications'] })); if (n.issue_id) openIssue(n.issue_id); }}>
                <div className={cx('font-medium', ['atrasada', 'seguranca_critica', 'escalonamento'].includes(n.type) && 'text-red-700')}>{n.title}</div>
                {n.body && <div className="text-sm text-gray-600">{n.body}</div>}
                <div className="text-xs text-gray-400">{fmtDateTime(n.created_at)}</div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
