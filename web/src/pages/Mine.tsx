import { Card, ErrorBox, Spinner } from '../components/ui';
import { IssueTable } from '../components/issues';
import { useIssues } from '../lib/hooks';
import { useMe } from '../lib/session';

export function MinePage() {
  const me = useMe();
  const mine = useIssues({ assigneeId: me.id, flag: 'open', sort: 'urgency', limit: 300 });
  const opened = useIssues({ openedById: me.id, flag: 'open', sort: 'urgency', limit: 100 });
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Minhas pendências</h1>
        <p className="text-sm text-gray-500">O que você precisa executar, das mais urgentes para as menos urgentes.</p>
      </div>
      <Card title={`Sou responsável${mine.data ? ` (${mine.data.total})` : ''}`}>
        {mine.isLoading ? <Spinner /> : mine.error ? <ErrorBox error={mine.error} /> : <IssueTable items={mine.data.items} />}
      </Card>
      <MySteps />
      <Card title={`Abri e acompanho${opened.data ? ` (${opened.data.total})` : ''}`}>
        {opened.isLoading ? <Spinner /> : opened.error ? <ErrorBox error={opened.error} /> : <IssueTable items={opened.data.items} />}
      </Card>
    </div>
  );
}

function MySteps() {
  const me = useMe();
  const q = useIssues({ stepAssigneeId: me.id, flag: 'open', sort: 'urgency', limit: 200 });
  const items = (q.data?.items ?? []).filter((i: any) => i.assignee_id !== me.id);
  if (!items.length) return null;
  return (
    <Card title={`Etapas atribuídas a mim em pendências de outros (${items.length})`}>
      <IssueTable items={items} />
    </Card>
  );
}
