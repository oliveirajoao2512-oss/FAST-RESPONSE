import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ValidateModal } from '../components/actions';
import { useOpenIssue } from '../components/issues';
import { Button, Card, Empty, ErrorBox, Spinner } from '../components/ui';
import { errorMessage, get, post } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { useIssues } from '../lib/hooks';
import { useMeta } from '../lib/meta';
import { can, useMe } from '../lib/session';
import { useToast } from '../lib/toast';

export function ApprovalsPage() {
  const me = useMe();
  const meta = useMeta();
  const qc = useQueryClient();
  const toast = useToast();
  const openIssue = useOpenIssue();
  const val = useIssues({ flag: 'awaiting_validation', limit: 300, sort: 'updated' });
  const dl = useQuery({ queryKey: ['deadline-changes'], queryFn: () => get('/api/deadline-changes') });
  const [validating, setValidating] = useState<any>(null);
  const allowSelf = meta?.config.workflow.allowSelfValidation ?? false;
  const mine = (val.data?.items ?? []).filter((i: any) =>
    can.validate(me, { areaId: i.area_id, originAreaId: i.origin_area_id, assigneeId: i.assignee_id, openedById: i.opened_by, completedById: i.completed_by }, allowSelf));
  const decide = async (id: string, approve: boolean) => {
    let note: string | null = null;
    if (!approve) {
      note = prompt('Motivo da rejeição:');
      if (note === null) return;
    }
    try {
      await post(`/api/deadline-changes/${id}/decide`, { approve, note });
      toast('ok', approve ? 'Prazo aprovado' : 'Solicitação rejeitada');
    } catch (e) {
      toast('error', errorMessage(e));
    }
    qc.invalidateQueries();
  };
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">Aprovações</h1>
      <Card title={`Soluções aguardando minha validação (${mine.length})`}>
        {val.isLoading ? <Spinner /> : val.error ? <ErrorBox error={val.error} /> : mine.length === 0 ? <Empty>Nenhuma solução aguardando sua validação.</Empty> : (
          <ul className="divide-y">
            {mine.map((i: any) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 py-2">
                <button className="min-w-0 flex-1 text-left" onClick={() => openIssue(i.id)}>
                  <span className="font-mono text-xs text-gray-500">{i.code}</span> <span className="font-medium hover:underline">{i.title}</span>
                  <div className="text-xs text-gray-600">{i.area_name} · concluída por {i.assignee_name} em {fmtDateTime(i.completed_at)}</div>
                </button>
                <Button kind="success" size="sm" onClick={async () => setValidating(await get(`/api/issues/${i.id}`))}>Validar</Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title={`Solicitações de alteração de prazo (${dl.data?.length ?? 0})`}>
        {dl.isLoading ? <Spinner /> : dl.error ? <ErrorBox error={dl.error} /> : dl.data.length === 0 ? <Empty>Nenhuma solicitação pendente.</Empty> : (
          <ul className="divide-y">
            {dl.data.map((d: any) => (
              <li key={d.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <button className="min-w-0 flex-1 text-left" onClick={() => openIssue(d.issue_id)}>
                  <span className="font-mono text-xs text-gray-500">{d.code}</span> <span className="font-medium hover:underline">{d.title}</span>
                  <div className="text-xs text-gray-600">
                    {d.requested_by_name} pediu {d.step_title ? `prazo da etapa "${d.step_title}"` : 'novo prazo'}: {fmtDateTime(d.old_due_at)} → <strong>{fmtDateTime(d.new_due_at)}</strong> — {d.reason}
                  </div>
                </button>
                {d.requested_by !== me.id ? (
                  <div className="flex gap-2">
                    <Button size="sm" kind="success" onClick={() => decide(d.id, true)}>Aprovar</Button>
                    <Button size="sm" kind="danger" onClick={() => decide(d.id, false)}>Rejeitar</Button>
                  </div>
                ) : <span className="text-xs text-gray-500">Aguardando aprovação</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {validating && <ValidateModal issue={validating} onClose={() => setValidating(null)} />}
    </div>
  );
}
