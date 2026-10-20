import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Pencil, Plus, Save } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { ASSET_TYPE_LABELS, ASSET_TYPES, PRIORITIES, PRIORITY_LABELS, ROLE_LABELS, ROLES } from '@shared/constants';
import { FormError } from '../components/actions';
import { Button, Card, cx, Empty, ErrorBox, Field, Input, Modal, Select, Spinner, Textarea } from '../components/ui';
import { errorMessage, get, post, put, qs } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { useMeta } from '../lib/meta';
import { can, useMe } from '../lib/session';
import { useToast } from '../lib/toast';

// ---------------------------------------------------------------- users

export function UsersPage() {
  const meta = useMeta();
  const q = useQuery({ queryKey: ['admin-users'], queryFn: () => get('/api/admin/users') });
  const [edit, setEdit] = useState<any>(null);
  const [reset, setReset] = useState<any>(null);
  const [filter, setFilter] = useState('');
  const list = (q.data ?? []).filter((u: any) => !filter || `${u.name} ${u.email} ${u.registration ?? ''}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Usuários</h1>
        <div className="flex gap-2">
          <Input placeholder="Filtrar…" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-48" />
          <Button kind="primary" onClick={() => setEdit({})}><Plus size={16} />Novo usuário</Button>
        </div>
      </div>
      <p className="text-sm text-gray-500">Usuários não são excluídos: desative para bloquear o acesso e manter o histórico.</p>
      {q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} /> : (
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500"><tr><th className="px-3 py-2">Nome</th><th>E-mail / matrícula</th><th>Perfil</th><th>Área</th><th>Situação</th><th>Último acesso</th><th /></tr></thead>
            <tbody className="divide-y">
              {list.map((u: any) => (
                <tr key={u.id} className={cx(!u.active && 'text-gray-400')}>
                  <td className="px-3 py-2 font-medium">{u.name}</td>
                  <td>{u.email}{u.registration && <div className="text-xs text-gray-500">Mat. {u.registration}</div>}</td>
                  <td>{ROLE_LABELS[u.role as keyof typeof ROLE_LABELS]}</td>
                  <td>{u.area_name ?? '—'}</td>
                  <td>{!u.active ? 'Inativo' : u.locked ? <span className="text-red-700">Bloqueado (tentativas)</span> : u.must_change_password ? 'Senha provisória' : 'Ativo'}</td>
                  <td className="text-xs">{fmtDateTime(u.last_login_at)}</td>
                  <td className="whitespace-nowrap px-2 text-right">
                    <Button size="sm" kind="ghost" onClick={() => setEdit(u)} aria-label="Editar"><Pencil size={14} /></Button>
                    <Button size="sm" kind="ghost" onClick={() => setReset(u)} aria-label="Redefinir senha"><KeyRound size={14} /></Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && <UserModal user={edit} areas={meta?.areas ?? []} onClose={() => setEdit(null)} />}
      {reset && <ResetModal user={reset} onClose={() => setReset(null)} />}
    </div>
  );
}

function UserModal({ user, areas, onClose }: { user: any; areas: any[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const isNew = !user.id;
  const [f, setF] = useState({
    name: user.name ?? '', email: user.email ?? '', registration: user.registration ?? '', role: user.role ?? 'colaborador',
    areaId: user.area_id ? String(user.area_id) : '', active: user.active ?? true, password: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);
  const set = (k: string, v: unknown) => setF((s) => ({ ...s, [k]: v }));
  const submit = async () => {
    setBusy(true);
    setError(null);
    const body: any = { name: f.name, email: f.email, registration: f.registration || null, role: f.role, areaId: f.areaId ? Number(f.areaId) : null, active: f.active };
    try {
      if (isNew) await post('/api/admin/users', { ...body, password: f.password });
      else await put(`/api/admin/users/${user.id}`, body);
      toast('ok', isNew ? 'Usuário criado' : 'Usuário atualizado');
      qc.invalidateQueries();
      onClose();
    } catch (e) {
      setError({ msg: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={isNew ? 'Novo usuário' : `Editar ${user.name}`} footer={<><Button onClick={onClose}>Cancelar</Button><Button kind="primary" loading={busy} onClick={submit}>Salvar</Button></>}>
      <FormError error={error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nome completo" required className="sm:col-span-2"><Input value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="E-mail" required hint="Usado no login e nas notificações."><Input type="email" value={f.email} onChange={(e) => set('email', e.target.value)} /></Field>
        <Field label="Matrícula" hint="Também pode ser usada no login."><Input value={f.registration} onChange={(e) => set('registration', e.target.value)} /></Field>
        <Field label="Perfil" required>
          <Select value={f.role} onChange={(e) => set('role', e.target.value)}>{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</Select>
        </Field>
        <Field label="Área" required={['lider', 'colaborador'].includes(f.role)}>
          <Select value={f.areaId} onChange={(e) => set('areaId', e.target.value)}><option value="">—</option>{areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>
        </Field>
        {isNew && <Field label="Senha provisória" required hint="O usuário deverá trocá-la no primeiro acesso." className="sm:col-span-2"><Input value={f.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" /></Field>}
        <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" className="h-4 w-4 accent-brand-600" checked={f.active} onChange={(e) => set('active', e.target.checked)} />Ativo</label>
      </div>
      <RoleHelp />
    </Modal>
  );
}

function RoleHelp() {
  return (
    <details className="mt-4 text-xs text-gray-600">
      <summary className="cursor-pointer font-medium">O que cada perfil pode fazer</summary>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li><strong>Colaborador</strong>: abre pendências, assume pendências sem responsável, executa e conclui as suas, gerencia etapas das suas, solicita alteração de prazo, valida pendências que abriu, comenta e anexa.</li>
        <li><strong>Líder de área</strong>: tudo do colaborador + atribui, transfere, cancela, altera e aprova prazos, valida e reabre pendências da sua área; conduz a reunião; vê relatórios.</li>
        <li><strong>Gestor</strong>: as ações do líder em todas as áreas + auditoria, cadastros e fechamento do ranking.</li>
        <li><strong>Administrador</strong>: tudo + usuários e configurações do sistema.</li>
        <li>Ninguém apaga pendências ou altera o histórico de auditoria.</li>
      </ul>
    </details>
  );
}

function ResetModal({ user, onClose }: { user: any; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [pw, setPw] = useState('');
  const [error, setError] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onClose={onClose} title={`Redefinir senha — ${user.name}`} footer={<><Button onClick={onClose}>Cancelar</Button><Button kind="primary" loading={busy} onClick={async () => {
      setBusy(true);
      try {
        await post(`/api/admin/users/${user.id}/reset-password`, { password: pw });
        toast('ok', 'Senha redefinida; o usuário deverá trocá-la no próximo acesso');
        qc.invalidateQueries({ queryKey: ['admin-users'] });
        onClose();
      } catch (e) { setError({ msg: errorMessage(e) }); } finally { setBusy(false); }
    }}>Redefinir</Button></>}>
      <FormError error={error} />
      <Field label="Nova senha provisória" hint="Mínimo de 8 caracteres com letras e números. As sessões ativas do usuário são encerradas."><Input value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></Field>
    </Modal>
  );
}

// ---------------------------------------------------------------- settings

export function SettingsPage() {
  const me = useMe();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => get('/api/admin/settings') });
  const [cfg, setCfg] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);
  useEffect(() => { if (q.data) setCfg(structuredClone(q.data.config)); }, [q.data]);
  if (q.isLoading || !cfg) return q.error ? <ErrorBox error={q.error} /> : <Spinner />;
  const editable = can.manageSettings(me);
  const set = (path: string, value: unknown) => setCfg((c: any) => {
    const next = structuredClone(c);
    const keys = path.split('.');
    let o = next;
    for (const k of keys.slice(0, -1)) o = o[k];
    o[keys.at(-1)!] = value;
    return next;
  });
  const n = (path: string, label: string, hint?: string, step = 1) => {
    const v = path.split('.').reduce((o: any, k) => o[k], cfg);
    return <Field label={label} hint={hint}><Input type="number" step={step} value={v} disabled={!editable} onChange={(e) => set(path, Number(e.target.value))} /></Field>;
  };
  const b = (path: string, label: string) => {
    const v = path.split('.').reduce((o: any, k) => o[k], cfg);
    return <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-brand-600" disabled={!editable} checked={v} onChange={(e) => set(path, e.target.checked)} />{label}</label>;
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await put('/api/admin/settings', { config: cfg });
      toast('ok', 'Configurações salvas');
      qc.invalidateQueries();
    } catch (e) { setError({ msg: errorMessage(e) }); } finally { setBusy(false); }
  };
  return (
    <div className="max-w-4xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Configurações</h1>
        {editable && <Button kind="primary" loading={busy} onClick={save}><Save size={16} />Salvar</Button>}
      </div>
      {!editable && <p className="text-sm text-gray-500">Somente leitura: apenas administradores alteram configurações.</p>}
      <FormError error={error} />
      <Section title="Prazos">
        <Field label="Fuso horário da fábrica" hint="Ex.: America/Sao_Paulo"><Input value={cfg.timezone} disabled={!editable} onChange={(e) => set('timezone', e.target.value)} /></Field>
        {n('deadline.days', 'Prazo padrão (dias após a abertura)', 'D+1 = vence no dia seguinte')}
        <Field label="Horário de vencimento"><Input type="time" value={cfg.deadline.time} disabled={!editable} onChange={(e) => set('deadline.time', e.target.value)} /></Field>
        {n('deadline.criticalSafetyHours', 'Prazo de segurança crítica (horas)')}
        {n('deadline.dueSoonHours', 'Aviso de prazo próximo (horas antes)')}
        <div className="space-y-2">{b('deadline.skipWeekends', 'Contar apenas dias úteis (pula sábado, domingo e feriados)')}</div>
        <Field label="Feriados (AAAA-MM-DD, um por linha)" className="sm:col-span-2">
          <Textarea value={cfg.deadline.holidays.join('\n')} disabled={!editable} onChange={(e) => set('deadline.holidays', e.target.value.split(/\s+/).filter(Boolean))} />
        </Field>
      </Section>
      <Section title="Fluxo e encerramento">
        <div className="space-y-2 sm:col-span-2">
          {b('workflow.requireValidation', 'Exigir validação da solução (quem abriu ou líder da área)')}
          {b('workflow.allowSelfValidation', 'Permitir que quem concluiu valide a própria solução')}
        </div>
        <Field label="Evidência obrigatória para prioridades">
          <div className="flex flex-wrap gap-3">{PRIORITIES.map((p) => (
            <label key={p} className="flex items-center gap-1 text-sm"><input type="checkbox" className="accent-brand-600" disabled={!editable} checked={cfg.workflow.evidenceRequiredForPriorities.includes(p)}
              onChange={(e) => set('workflow.evidenceRequiredForPriorities', e.target.checked ? [...cfg.workflow.evidenceRequiredForPriorities, p] : cfg.workflow.evidenceRequiredForPriorities.filter((x: string) => x !== p))} />{PRIORITY_LABELS[p]}</label>
          ))}</div>
        </Field>
        <Field label="Alteração de prazo precisa de aprovação para">
          <div className="flex flex-wrap gap-3">{ROLES.filter((r) => r !== 'admin').map((r) => (
            <label key={r} className="flex items-center gap-1 text-sm"><input type="checkbox" className="accent-brand-600" disabled={!editable} checked={cfg.workflow.deadlineChangeRequiresApprovalFor.includes(r)}
              onChange={(e) => set('workflow.deadlineChangeRequiresApprovalFor', e.target.checked ? [...cfg.workflow.deadlineChangeRequiresApprovalFor, r] : cfg.workflow.deadlineChangeRequiresApprovalFor.filter((x: string) => x !== r))} />{ROLE_LABELS[r]}</label>
          ))}</div>
        </Field>
        {n('complexity.moderateMinSteps', 'Etapas obrigatórias para "moderada"')}
        {n('complexity.complexMinSteps', 'Etapas obrigatórias para "complexa"')}
        {n('recurrence.windowDays', 'Janela de reincidência (dias)', 'Mesmo ativo + mesma categoria concluída dentro da janela')}
      </Section>
      <Section title="Escalonamento e alertas">
        <div className="space-y-2 sm:col-span-2">
          {b('escalation.notifyLeadersOnOverdue', 'Avisar líderes da área quando uma pendência atrasar')}
          {b('escalation.notifyManagersOnCriticalSafety', 'Avisar gestores imediatamente em segurança crítica')}
        </div>
        {n('escalation.managerAfterOverdueHours', 'Escalonar para gestores após (horas de atraso)')}
        <div className="text-sm text-gray-600 sm:col-span-2">E-mail: {q.data.emailEnabled ? <span className="font-medium text-emerald-700">SMTP configurado — notificações também vão por e-mail.</span> : <span className="font-medium text-amber-700">SMTP não configurado — apenas notificações no sistema. Veja a documentação de implantação.</span>}</div>
        <div className="text-sm text-gray-600 sm:col-span-2">Anexos armazenados em: <span className="font-medium text-gray-800">{q.data.storage}</span></div>
      </Section>
      <Section title="Pontuação do ranking">
        {n('scoring.base.simples', 'Pontos base — simples')}
        {n('scoring.base.moderada', 'Pontos base — moderada')}
        {n('scoring.base.complexa', 'Pontos base — complexa')}
        {n('scoring.onTimeBonusPct', 'Bônus no prazo (%)')}
        {n('scoring.latePenaltyPct', 'Penalidade por atraso (%)')}
        {n('scoring.reopenPenalty', 'Penalidade por reabertura (pontos)')}
        {n('scoring.recurrencePenalty', 'Penalidade por reincidência (pontos)')}
        {n('scoring.stepPoints', 'Pontos por etapa em pendência de outro')}
        {n('scoring.quickSelfCloseMinutes', 'Encerramento prematuro (minutos)')}
        {n('scoring.maxSimplePerMonth', 'Máximo de simples pontuadas por mês')}
        {n('scoring.minIssuesForChampion', 'Mínimo de validadas para campeão')}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <Card title={title}><div className="grid gap-3 sm:grid-cols-2">{children}</div></Card>;
}

// ---------------------------------------------------------------- catalogs

export function CatalogsPage() {
  const meta = useMeta();
  const qc = useQueryClient();
  const toast = useToast();
  const assets = useQuery({ queryKey: ['assets-all'], queryFn: () => get('/api/assets?all=true') });
  const [cat, setCat] = useState<any>(null);
  const [asset, setAsset] = useState<any>(null);
  const [templates, setTemplates] = useState<string>('');
  useEffect(() => {
    if (meta) setTemplates(meta.stepTemplates.map((t) => `# ${t.name}\n${t.steps.join('\n')}`).join('\n\n'));
  }, [meta]);
  const saveTemplates = async () => {
    const parsed = templates.split(/\n(?=# )/).map((block) => {
      const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
      return { name: lines[0]?.replace(/^#\s*/, '') ?? '', steps: lines.slice(1) };
    }).filter((t) => t.name && t.steps.length);
    try {
      await put('/api/admin/step-templates', { templates: parsed });
      toast('ok', 'Modelos de etapas salvos');
      qc.invalidateQueries({ queryKey: ['meta'] });
    } catch (e) { toast('error', errorMessage(e)); }
  };
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">Cadastros</h1>
      <Card title="Categorias de problema" actions={<Button size="sm" onClick={() => setCat({})}><Plus size={14} />Categoria</Button>}>
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-gray-500"><tr><th className="py-1">Nome</th><th>Área</th><th>Segurança</th><th>Exige evidência</th><th>Ativa</th><th /></tr></thead>
          <tbody className="divide-y">{meta?.categories.map((c) => (
            <tr key={c.id} className={cx(!c.active && 'text-gray-400')}><td className="py-1.5">{c.name}</td><td>{meta.areas.find((a) => a.id === c.area_id)?.name ?? 'Todas'}</td>
              <td>{c.is_safety ? 'Sim' : '—'}</td><td>{c.requires_evidence ? 'Sim' : '—'}</td><td>{c.active ? 'Sim' : 'Não'}</td>
              <td className="text-right"><Button size="sm" kind="ghost" onClick={() => setCat(c)}><Pencil size={14} /></Button></td></tr>
          ))}</tbody>
        </table>
      </Card>
      <Card title="Máquinas, equipamentos e moldes" actions={<Button size="sm" onClick={() => setAsset({})}><Plus size={14} />Cadastrar</Button>}>
        <p className="mb-2 text-xs text-gray-500">Usado como sugestão no cadastro de pendências e para detectar reincidências. Referências digitadas livremente também são aceitas.</p>
        {assets.data?.length === 0 ? <Empty>Nenhum item cadastrado.</Empty> : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-gray-500"><tr><th className="py-1">Tipo</th><th>Código</th><th>Descrição</th><th>Área</th><th /></tr></thead>
            <tbody className="divide-y">{assets.data?.map((a: any) => (
              <tr key={a.id} className={cx(!a.active && 'text-gray-400')}><td className="py-1.5">{ASSET_TYPE_LABELS[a.type as keyof typeof ASSET_TYPE_LABELS]}</td><td className="font-mono">{a.code}</td><td>{a.description}</td><td>{a.area_name ?? '—'}</td>
                <td className="text-right"><Button size="sm" kind="ghost" onClick={() => setAsset(a)}><Pencil size={14} /></Button></td></tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      <Card title="Modelos de etapas" actions={<Button size="sm" kind="primary" onClick={saveTemplates}><Save size={14} />Salvar modelos</Button>}>
        <p className="mb-2 text-xs text-gray-500">Uma linha "# Nome do modelo" seguida de uma etapa por linha.</p>
        <Textarea rows={14} className="font-mono text-xs" value={templates} onChange={(e) => setTemplates(e.target.value)} />
      </Card>
      {cat && <CatalogModal title="Categoria" initial={cat} onClose={() => setCat(null)}
        fields={(f, set) => <>
          <Field label="Nome" required><Input value={f.name ?? ''} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label="Área"><Select value={f.area_id ?? ''} onChange={(e) => set('area_id', e.target.value ? Number(e.target.value) : null)}><option value="">Todas</option>{meta?.areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(f.is_safety)} onChange={(e) => set('is_safety', e.target.checked)} />Relacionada à segurança (crítica = tratamento imediato)</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(f.requires_evidence)} onChange={(e) => set('requires_evidence', e.target.checked)} />Exige evidência para concluir</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.active ?? true} onChange={(e) => set('active', e.target.checked)} />Ativa</label>
        </>}
        save={(f) => {
          const body = { name: f.name, areaId: f.area_id ?? null, isSafety: Boolean(f.is_safety), requiresEvidence: Boolean(f.requires_evidence), active: f.active ?? true };
          return f.id ? put(`/api/admin/categories/${f.id}`, body) : post('/api/admin/categories', body);
        }} />}
      {asset && <CatalogModal title="Máquina / equipamento / molde" initial={asset} onClose={() => setAsset(null)}
        fields={(f, set) => <>
          <Field label="Tipo" required><Select value={f.type ?? 'maquina'} onChange={(e) => set('type', e.target.value)}>{ASSET_TYPES.map((t) => <option key={t} value={t}>{ASSET_TYPE_LABELS[t]}</option>)}</Select></Field>
          <Field label="Código" required><Input value={f.code ?? ''} onChange={(e) => set('code', e.target.value)} /></Field>
          <Field label="Descrição"><Input value={f.description ?? ''} onChange={(e) => set('description', e.target.value)} /></Field>
          <Field label="Área"><Select value={f.area_id ?? ''} onChange={(e) => set('area_id', e.target.value ? Number(e.target.value) : null)}><option value="">—</option>{meta?.areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.active ?? true} onChange={(e) => set('active', e.target.checked)} />Ativo</label>
        </>}
        save={(f) => {
          const body = { type: f.type ?? 'maquina', code: f.code, description: f.description || null, areaId: f.area_id ?? null, active: f.active ?? true };
          return f.id ? put(`/api/admin/assets/${f.id}`, body) : post('/api/admin/assets', body);
        }} />}
    </div>
  );
}

function CatalogModal({ title, initial, fields, save, onClose }: { title: string; initial: any; fields: (f: any, set: (k: string, v: unknown) => void) => ReactNode; save: (f: any) => Promise<unknown>; onClose: () => void }) {
  const [f, setF] = useState<any>(initial);
  const [error, setError] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const set = (k: string, v: unknown) => setF((s: any) => ({ ...s, [k]: v }));
  return (
    <Modal open onClose={onClose} title={title} footer={<><Button onClick={onClose}>Cancelar</Button><Button kind="primary" loading={busy} onClick={async () => {
      setBusy(true);
      try { await save(f); qc.invalidateQueries(); onClose(); } catch (e) { setError({ msg: errorMessage(e) }); } finally { setBusy(false); }
    }}>Salvar</Button></>}>
      <FormError error={error} />
      <div className="space-y-3">{fields(f, set)}</div>
    </Modal>
  );
}

// ---------------------------------------------------------------- audit

export function AuditPage() {
  const meta = useMeta();
  const [f, setF] = useState({ action: '', actorId: '', issue: '', from: '', to: '' });
  const [page, setPage] = useState(0);
  const q = useQuery({ queryKey: ['audit', f, page], queryFn: () => get(`/api/admin/audit${qs({ ...f, limit: 100, offset: page * 100 })}`) });
  const set = (k: string, v: string) => { setPage(0); setF((s) => ({ ...s, [k]: v })); };
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Auditoria</h1>
      <p className="text-sm text-gray-500">Registro permanente e imutável das operações. Nenhum perfil pode alterar ou apagar estes eventos.</p>
      <div className="grid gap-2 rounded-xl border border-gray-200 bg-white p-3 sm:grid-cols-5">
        <Select value={f.action} onChange={(e) => set('action', e.target.value)} aria-label="Tipo">
          <option value="">Todas as operações</option>
          <option value="issue.">Pendências</option><option value="step.">Etapas</option><option value="deadline.">Prazos</option>
          <option value="impediment.">Impedimentos</option><option value="auth.">Login/acesso</option><option value="user.">Usuários</option>
          <option value="settings.">Configurações</option><option value="meeting.">Reuniões</option><option value="report.">Exportações</option><option value="ranking.">Ranking</option>
        </Select>
        <Select value={f.actorId} onChange={(e) => set('actorId', e.target.value)} aria-label="Usuário"><option value="">Todos os usuários</option>{meta?.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>
        <Input placeholder="Código da pendência" value={f.issue} onChange={(e) => set('issue', e.target.value)} />
        <Input type="date" value={f.from} onChange={(e) => set('from', e.target.value)} aria-label="De" />
        <Input type="date" value={f.to} onChange={(e) => set('to', e.target.value)} aria-label="Até" />
      </div>
      {q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} /> : (
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500"><tr><th className="px-3 py-2">Data/hora</th><th>Usuário</th><th>Operação</th><th>Pendência</th><th>Detalhes</th><th>IP</th></tr></thead>
            <tbody className="divide-y">{q.data.map((e: any) => (
              <tr key={e.id} className="align-top"><td className="whitespace-nowrap px-3 py-1.5 text-xs">{fmtDateTime(e.at)}</td><td>{e.actor_name ?? 'Sistema'}</td><td className="font-mono text-xs">{e.action}</td>
                <td className="font-mono text-xs">{e.issue_code ?? '—'}</td><td className="max-w-md break-words font-mono text-xs text-gray-600">{JSON.stringify(e.data)}</td><td className="text-xs text-gray-500">{e.ip ?? ''}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <div className="flex gap-2">
        <Button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Anterior</Button>
        <Button disabled={(q.data?.length ?? 0) < 100} onClick={() => setPage((p) => p + 1)}>Próxima</Button>
      </div>
    </div>
  );
}
