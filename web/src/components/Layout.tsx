import { useQuery } from '@tanstack/react-query';
import {
  Award, Bell, Download, CheckSquare, ClipboardList, Factory, Gauge, KeyRound, LayoutList, LogOut, Menu, Plus, ScrollText, Search, Settings,
  ShieldCheck, Siren, Users, WifiOff, X, BarChart3, Database, ClipboardCheck, ChevronDown, Wrench, Eye, SlidersHorizontal,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ORDER_ONLY_ROLES, ROLE_LABELS, type Role } from '@shared/constants';
import { WO_DOMAIN, type WoDomain } from '@shared/maintenance';
import { get, post, qs } from '../lib/api';
import { fmtShort } from '../lib/format';
import { useMeta } from '../lib/meta';
import { isIos, useInstall } from '../lib/install';
import { startPreview, stopPreview } from '../lib/preview';
import { useQualityAccess } from '../lib/quality';
import { useRealtime } from '../lib/realtime';
import { useWoList } from '../lib/workOrders';
import { can, useMe, useSession } from '../lib/session';
import { IssueOverlay } from './IssueDetail';
import { useOpenIssue } from './issues';
import { NewIssueModal } from './NewIssueModal';
import { AreaDot, Button, cx, Field, Modal, Select } from './ui';

export function Layout() {
  const me = useMe();
  const meta = useMeta();
  const conn = useRealtime(true);
  const [menu, setMenu] = useState(false);
  const [creating, setCreating] = useState(false);
  const [params, setParams] = useSearchParams();
  // "Nova pendência" shortcut of the installed app opens /?nova=1
  useEffect(() => {
    if (params.get('nova') === '1') {
      setCreating(true);
      params.delete('nova');
      setParams(params, { replace: true });
    }
  }, [params, setParams]);
  const quality = useQualityAccess(me);
  const counts = useQuery({ queryKey: ['area-counts'], queryFn: () => get('/api/dashboard'), staleTime: 30_000 });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.key === 'n' && !e.ctrlKey && !e.metaKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) {
        e.preventDefault();
        setCreating(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const link = ({ isActive }: { isActive: boolean }) =>
    cx('flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm', isActive ? 'bg-brand-600 text-white' : 'text-gray-300 hover:bg-white/10 hover:text-white');
  const overdueBy = (id: number) => counts.data?.byArea.find((a: any) => a.id === id)?.overdue ?? 0;
  const workOrders = useWoList('abertas', {}, true, 'manutencao');
  const waitingOs = workOrders.data?.filter((o) => o.status === 'aberta').length ?? 0;
  const adjustments = useWoList('abertas', {}, true, 'ajuste');
  const waitingOa = adjustments.data?.filter((o) => o.status === 'aberta').length ?? 0;
  const { pathname } = useLocation();
  const inGestao = ['/ranking', '/relatorios', '/admin', '/qualidade'].some((p) => pathname.startsWith(p));
  const [gestao, setGestao] = useState(() => {
    try { return localStorage.getItem('fr-nav-gestao') === '1'; } catch { return false; }
  });
  const toggleGestao = () => {
    setGestao(!gestao);
    try { localStorage.setItem('fr-nav-gestao', gestao ? '0' : '1'); } catch {}
  };
  const gestaoOpen = gestao || inGestao;

  const nav = (
    <nav className="flex flex-col gap-0.5 p-3" onClick={() => setMenu(false)}>
      <NavLink to="/" end className={link}><Gauge size={18} />Painel geral</NavLink>
      <NavLink to="/fast-response" className={link}><Siren size={18} />Fast Response</NavLink>
      <NavLink to="/minhas" className={link}><CheckSquare size={18} />Minhas pendências</NavLink>
      <NavLink to="/pendencias" className={link}><LayoutList size={18} />Todas as pendências</NavLink>
      <NavLink to="/aprovacoes" className={link}><ShieldCheck size={18} />Aprovações</NavLink>
      <NavLink to="/os" className={link}>
        <Wrench size={18} /><span className="flex-1">Ordens de Manutenção</span>
        {waitingOs > 0 && <span className="rounded-full bg-red-600 px-1.5 text-xs font-bold text-white" title="Aguardando aceite">{waitingOs}</span>}
      </NavLink>
      <NavLink to="/ajustes" className={link}>
        <SlidersHorizontal size={18} /><span className="flex-1">Ordens de Ajuste</span>
        {waitingOa > 0 && <span className="rounded-full bg-red-600 px-1.5 text-xs font-bold text-white" title="Aguardando aceite">{waitingOa}</span>}
      </NavLink>
      <div className="mt-4 mb-1 px-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Áreas</div>
      {meta?.areas.map((a) => (
        <NavLink key={a.id} to={`/areas/${a.slug}`} className={link}>
          <AreaDot color={a.color} /><span className="flex-1">{a.name}</span>
          {overdueBy(a.id) > 0 && <span className="rounded-full bg-red-600 px-1.5 text-xs font-bold text-white" title="Atrasadas">{overdueBy(a.id)}</span>}
        </NavLink>
      ))}
      <button type="button" onClick={(e) => { e.stopPropagation(); toggleGestao(); }} aria-expanded={gestaoOpen}
        className="mt-4 mb-1 flex items-center justify-between rounded-lg px-3 py-1 text-xs font-semibold uppercase tracking-wider text-gray-400 hover:bg-white/10 hover:text-white">
        Gestão<ChevronDown size={16} className={cx('transition-transform', gestaoOpen && 'rotate-180')} />
      </button>
      {gestaoOpen && (
        <>
          <NavLink to="/ranking" className={link}><Award size={18} />Ranking mensal</NavLink>
          {can.viewReports(me) && <NavLink to="/relatorios" className={link}><BarChart3 size={18} />Relatórios</NavLink>}
          {quality && <NavLink to="/qualidade" className={link}><ClipboardCheck size={18} />Resposta Rápida</NavLink>}
          {can.manageUsers(me) && <NavLink to="/admin/usuarios" className={link}><Users size={18} />Usuários</NavLink>}
          {can.manageCatalog(me) && <NavLink to="/admin/cadastros" className={link}><Database size={18} />Cadastros</NavLink>}
          {(can.manageSettings(me) || can.viewAudit(me)) && <NavLink to="/admin/configuracoes" className={link}><Settings size={18} />Configurações</NavLink>}
          {can.viewAudit(me) && <NavLink to="/admin/auditoria" className={link}><ScrollText size={18} />Auditoria</NavLink>}
        </>
      )}
    </nav>
  );

  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 flex-col overflow-y-auto bg-gray-900 lg:flex">
        <Brand />
        {nav}
      </aside>
      {menu && (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div className="w-72 overflow-y-auto bg-gray-900">
            <div className="flex items-center justify-between pr-3"><Brand /><button aria-label="Fechar menu" className="text-gray-300" onClick={() => setMenu(false)}><X /></button></div>
            {nav}
          </div>
          <div className="flex-1 bg-black/40" onClick={() => setMenu(false)} />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <PreviewBanner />
        <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-gray-200 bg-white px-3 py-2 sm:px-4">
          <button className="rounded p-2 text-gray-700 hover:bg-gray-100 lg:hidden" aria-label="Abrir menu" onClick={() => setMenu(true)}><Menu size={20} /></button>
          <GlobalSearch />
          <Button kind="primary" onClick={() => setCreating(true)} title="Nova pendência (atalho: N)"><Plus size={18} /><span className="hidden sm:inline">Nova pendência</span></Button>
          <NotificationsBell />
          <UserMenu />
        </header>
        {conn !== 'online' && (
          <div className="flex items-center gap-2 bg-amber-100 px-4 py-1.5 text-sm text-amber-900" role="status">
            <WifiOff size={16} />
            {conn === 'offline' ? 'Sem conexão. As informações podem estar desatualizadas; ações não serão enviadas até a conexão voltar.' : 'Reconectando ao servidor… a tela será atualizada automaticamente.'}
          </div>
        )}
        <main className="min-w-0 flex-1 overflow-y-auto p-3 sm:p-5">
          <Outlet />
        </main>
      </div>
      {creating && <NewIssueModal onClose={() => setCreating(false)} />}
      <IssueOverlay />
    </div>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2 px-4 py-4 text-white">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600"><Factory size={18} /></span>
      <div className="leading-tight">
        <div className="font-bold">Fast Response</div>
        <div className="text-xs text-gray-400">Gestão de pendências</div>
      </div>
    </div>
  );
}

function GlobalSearch() {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [debounced, setDebounced] = useState('');
  const navigate = useNavigate();
  const openIssue = useOpenIssue();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const r = useQuery({ queryKey: ['search', debounced], queryFn: () => get(`/api/issues${qs({ q: debounced, limit: 8, sort: 'updated' })}`), enabled: debounced.length >= 2 });
  return (
    <div className="relative flex-1 max-w-xl">
      <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
      <input ref={ref} value={text} onChange={(e) => { setText(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 200)}
        onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) { setOpen(false); navigate(`/pendencias?q=${encodeURIComponent(text.trim())}`); } }}
        placeholder="Buscar código, título, máquina, molde, OP… (Ctrl+K)" aria-label="Pesquisa global"
        className="w-full rounded-lg border border-gray-300 bg-gray-50 py-2 pl-9 pr-3 text-sm focus:border-brand-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-200" />
      {open && debounced.length >= 2 && (
        <div className="absolute left-0 right-0 top-full z-40 mt-1 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg">
          {r.isLoading && <div className="px-3 py-2 text-sm text-gray-500">Buscando…</div>}
          {r.data?.items.length === 0 && <div className="px-3 py-2 text-sm text-gray-500">Nada encontrado.</div>}
          {r.data?.items.map((i: any) => (
            <button key={i.id} onMouseDown={() => { openIssue(i.id); setOpen(false); }} className="block w-full px-3 py-2 text-left text-sm hover:bg-brand-50">
              <span className="font-mono text-xs text-gray-500">{i.code}</span> <span className="font-medium">{i.title}</span>
              <span className="block text-xs text-gray-500">{i.area_name} · {i.assignee_name ?? 'sem responsável'}</span>
            </button>
          ))}
          {r.data?.total > 8 && <button onMouseDown={() => navigate(`/pendencias?q=${encodeURIComponent(debounced)}`)} className="block w-full border-t px-3 py-2 text-left text-sm text-brand-700">Ver todos os {r.data.total} resultados</button>}
        </div>
      )}
    </div>
  );
}

export function NotificationsBell() {
  const { unread } = useSession();
  const [open, setOpen] = useState(false);
  const list = useQuery({ queryKey: ['notifications'], queryFn: () => get('/api/notifications?limit=30'), enabled: open });
  const openIssue = useOpenIssue();
  const navigate = useNavigate();
  return (
    <div className="relative">
      <button className="relative rounded-lg p-2 text-gray-700 hover:bg-gray-100" aria-label={`Notificações (${unread} não lidas)`} onClick={() => setOpen((v) => !v)}>
        <Bell size={20} />
        {unread > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-5 rounded-full bg-red-600 px-1 text-center text-xs font-bold text-white">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-40 mt-1 w-[min(24rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b px-3 py-2">
              <span className="text-sm font-semibold">Notificações</span>
              <Button size="sm" kind="ghost" onClick={() => post('/api/notifications/read', { all: true }).then(() => list.refetch())}>Marcar todas como lidas</Button>
            </div>
            <div className="max-h-[60vh] overflow-y-auto">
              {list.data?.length === 0 && <div className="px-3 py-6 text-center text-sm text-gray-500">Nenhuma notificação.</div>}
              {list.data?.map((n: any) => (
                <button key={n.id} onClick={() => { post('/api/notifications/read', { ids: [n.id] }); setOpen(false); if (n.work_order_id) navigate(`${n.work_order_domain === 'ajuste' ? '/ajustes' : '/os'}?id=${n.work_order_id}`); else if (n.issue_id) openIssue(n.issue_id); }}
                  className={cx('block w-full border-b px-3 py-2 text-left text-sm hover:bg-gray-50', !n.read_at && 'bg-brand-50')}>
                  <div className={cx('font-medium', ['atrasada', 'seguranca_critica', 'escalonamento', 'os_aberta'].includes(n.type) && 'text-red-700')}>{n.title}</div>
                  {n.body && <div className="line-clamp-2 text-gray-600">{n.body}</div>}
                  <div className="text-xs text-gray-400">{fmtShort(n.created_at)}</div>
                </button>
              ))}
            </div>
            <button className="block w-full px-3 py-2 text-center text-sm text-brand-700 hover:bg-gray-50" onClick={() => { setOpen(false); navigate('/notificacoes'); }}>Ver todas</button>
          </div>
        </>
      )}
    </div>
  );
}

export function UserMenu() {
  const { me, logout } = useSession();
  const [open, setOpen] = useState(false);
  const [howTo, setHowTo] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const install = useInstall();
  const navigate = useNavigate();
  if (!me) return null;
  const installApp = async () => {
    setOpen(false);
    if (!(install.canPrompt && (await install.prompt()))) setHowTo(true);
  };
  const initials = me.name.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-2 rounded-lg p-1 hover:bg-gray-100" aria-label="Menu do usuário">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-800 text-xs font-bold text-white">{initials}</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-40 mt-1 w-64 rounded-xl border border-gray-200 bg-white p-2 shadow-xl">
            <div className="px-2 py-1.5">
              <div className="font-medium">{me.name}</div>
              <div className="text-xs text-gray-500">{ROLE_LABELS[me.role]}{me.area ? ` · ${me.area.name}` : ''}</div>
            </div>
            {me.role === 'admin' && <MenuItem onClick={() => { setOpen(false); setPreviewing(true); }}><Eye size={16} />Visualizar como…</MenuItem>}
            {me.preview && <MenuItem onClick={() => stopPreview()}><Eye size={16} />Sair da visualização</MenuItem>}
            <MenuItem onClick={() => { setOpen(false); navigate('/trocar-senha'); }}><KeyRound size={16} />Alterar senha</MenuItem>
            <MenuItem onClick={() => { setOpen(false); navigate('/notificacoes'); }}><ClipboardList size={16} />Notificações</MenuItem>
            {!install.installed && <MenuItem onClick={installApp}><Download size={16} />Instalar aplicativo</MenuItem>}
            <MenuItem onClick={() => logout().then(() => navigate('/login'))}><LogOut size={16} />Sair</MenuItem>
          </div>
        </>
      )}
      {howTo && <InstallHelp onClose={() => setHowTo(false)} />}
      {previewing && <PreviewModal onClose={() => setPreviewing(false)} />}
    </div>
  );
}

function InstallHelp({ onClose }: { onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title="Instalar o Fast Response" footer={<Button kind="primary" onClick={onClose}>Entendi</Button>}>
      <p className="mb-3 text-sm text-gray-600">Instalado, o sistema abre direto por um ícone na tela inicial ou na área de trabalho, em janela própria, sem barra de endereço.</p>
      {isIos() ? (
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>Abra este endereço no <strong>Safari</strong>.</li>
          <li>Toque em <strong>Compartilhar</strong> (quadrado com seta para cima).</li>
          <li>Escolha <strong>Adicionar à Tela de Início</strong> e confirme.</li>
        </ol>
      ) : (
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li><strong>Android (Chrome):</strong> menu ⋮ → <strong>Instalar app</strong> ou <strong>Adicionar à tela inicial</strong>.</li>
          <li><strong>Computador (Chrome ou Edge):</strong> clique no ícone de instalar no fim da barra de endereço, ou menu ⋮ → <strong>Transmitir, salvar e compartilhar → Instalar página como app</strong>.</li>
        </ol>
      )}
    </Modal>
  );
}

const MenuItem = ({ onClick, children }: { onClick: () => void; children: ReactNode }) => (
  <button onClick={onClick} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-gray-100">{children}</button>
);

/** Shell for maintainers and process technicians: only their order module, notifications and their own account. */
export function MaintainerLayout({ domain }: { domain: WoDomain }) {
  const conn = useRealtime(true);
  return (
    <div className="flex h-full flex-col">
      <PreviewBanner />
      <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-gray-200 bg-white px-3 py-2 sm:px-4">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 text-white">{domain === 'ajuste' ? <SlidersHorizontal size={18} /> : <Wrench size={18} />}</span>
        <div className="flex-1 leading-tight">
          <div className="font-bold">Fast Response</div>
          <div className="text-xs text-gray-500">{WO_DOMAIN[domain].title}</div>
        </div>
        <NotificationsBell />
        <UserMenu />
      </header>
      {conn !== 'online' && (
        <div className="flex items-center gap-2 bg-amber-100 px-4 py-1.5 text-sm text-amber-900" role="status">
          <WifiOff size={16} />
          {conn === 'offline' ? 'Sem conexão. A fila pode estar desatualizada.' : 'Reconectando… a fila será atualizada automaticamente.'}
        </div>
      )}
      <main className="min-w-0 flex-1 overflow-y-auto p-3 sm:p-5">
        <Outlet />
      </main>
    </div>
  );
}

const PREVIEW_ROLES: Role[] = ['gestor', 'lider', 'colaborador', 'manutentor', 'tecnico_processo'];
const PREVIEW_HINT: Partial<Record<Role, string>> = {
  gestor: 'Gestor de Manutenção comanda a fila de OS e vê o dashboard dela; o de Processos, o das Ordens de Ajuste; o de Qualidade, a Resposta Rápida.',
  lider: 'O líder enxerga e age nas pendências da própria área.',
  colaborador: 'O colaborador vê as pendências e age nas que são dele.',
  manutentor: 'O manutentor vê só as Ordens de Manutenção.',
  tecnico_processo: 'O técnico de processo vê só as Ordens de Ajuste.',
};

/** Administrator chooses a profile (and area) to see the system as it does. */
function PreviewModal({ onClose }: { onClose: () => void }) {
  const meta = useMeta();
  const [role, setRole] = useState<Role>('colaborador');
  const [areaId, setAreaId] = useState('');
  const needsArea = role === 'lider' || role === 'colaborador';
  const ok = !needsArea || !!areaId;
  return (
    <Modal open onClose={onClose} title="Visualizar como outro perfil"
      footer={<><Button onClick={onClose}>Cancelar</Button><Button kind="primary" disabled={!ok} onClick={() => startPreview(role, ORDER_ONLY_ROLES.includes(role) || !areaId ? null : Number(areaId))}><Eye size={16} />Visualizar</Button></>}>
      <div className="space-y-4">
        <p className="text-sm text-gray-600">Você vê o sistema com as permissões do perfil escolhido, inclusive o que fica escondido. É só para olhar: nenhuma alteração é gravada enquanto a visualização estiver ligada.</p>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Perfil">
          {PREVIEW_ROLES.map((r) => (
            <button key={r} type="button" role="radio" aria-checked={role === r} onClick={() => setRole(r)}
              className={cx('rounded-lg border px-3 py-2.5 text-sm font-medium', role === r ? 'border-brand-600 bg-brand-600 text-white' : 'border-gray-300 bg-white text-gray-800 hover:bg-gray-50')}>
              {ROLE_LABELS[r]}
            </button>
          ))}
        </div>
        <p className="text-xs text-gray-500">{PREVIEW_HINT[role]}</p>
        {!ORDER_ONLY_ROLES.includes(role) && (
          <Field label="Área" required={needsArea}>
            <Select value={areaId} onChange={(e) => setAreaId(e.target.value)}>
              <option value="">{needsArea ? 'Selecione…' : 'Sem área'}</option>
              {meta?.areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          </Field>
        )}
      </div>
    </Modal>
  );
}

function PreviewBanner() {
  const { me } = useSession();
  if (!me?.preview) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 bg-indigo-700 px-3 py-2 text-sm text-white sm:px-4" role="status">
      <Eye size={16} />
      <span className="flex-1">Visualizando como <b>{ROLE_LABELS[me.role]}</b>{me.area ? ` · ${me.area.name}` : ''}. Somente leitura.</span>
      <button onClick={() => stopPreview()} className="rounded-lg bg-white px-3 py-1 font-medium text-indigo-800 hover:bg-indigo-50">Sair da visualização</button>
    </div>
  );
}
