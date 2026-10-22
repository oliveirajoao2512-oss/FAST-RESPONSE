import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout, MaintainerLayout } from './components/Layout';
import { Spinner } from './components/ui';
import { useQualityAccess } from './lib/quality';
import { can, useSession } from './lib/session';
import { AuditPage, CatalogsPage, SettingsPage, UsersPage } from './pages/Admin';
import { ApprovalsPage } from './pages/Approvals';
import { AreaPage } from './pages/Area';
import { ChangePasswordPage, LoginPage } from './pages/Auth';
import { DashboardPage } from './pages/Dashboard';
import { FastResponsePage } from './pages/FastResponse';
import { IssuesPage } from './pages/Issues';
import { MinePage } from './pages/Mine';
import { NotificationsPage } from './pages/Notifications';
import { RankingPage } from './pages/Ranking';
import { ReportsPage } from './pages/Reports';

// Quality module loads on demand (only its leaders/managers open it).
const QualityPage = lazy(() => import('./pages/Quality').then((m) => ({ default: m.QualityPage })));
const WorkOrdersPage = lazy(() => import('./pages/WorkOrders').then((m) => ({ default: m.WorkOrdersPage })));
const osPage = <Suspense fallback={<Spinner />}><WorkOrdersPage /></Suspense>;

export function App() {
  const { me, loading } = useSession();
  const quality = useQualityAccess(me);
  if (loading) return <Spinner label="Carregando Fast Response…" />;
  if (!me) {
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }
  if (me.mustChangePassword) return <ChangePasswordPage forced />;
  // maintainers only see the work orders (the server refuses everything else too)
  if (me.role === 'manutentor') {
    return (
      <Routes>
        <Route element={<MaintainerLayout />}>
          <Route path="os" element={osPage} />
          <Route path="notificacoes" element={<NotificationsPage />} />
          <Route path="trocar-senha" element={<ChangePasswordPage />} />
          <Route path="*" element={<Navigate to="/os" replace />} />
        </Route>
      </Routes>
    );
  }
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<DashboardPage />} />
        <Route path="fast-response" element={<FastResponsePage />} />
        <Route path="minhas" element={<MinePage />} />
        <Route path="pendencias" element={<IssuesPage />} />
        <Route path="pendencias/:id" element={<IssueRedirect />} />
        <Route path="areas/:slug" element={<AreaPage />} />
        <Route path="aprovacoes" element={<ApprovalsPage />} />
        <Route path="os" element={osPage} />
        <Route path="ranking" element={<RankingPage />} />
        {can.viewReports(me) && <Route path="relatorios" element={<ReportsPage />} />}
        <Route path="notificacoes" element={<NotificationsPage />} />
        <Route path="trocar-senha" element={<ChangePasswordPage />} />
        {can.manageUsers(me) && <Route path="admin/usuarios" element={<UsersPage />} />}
        {(can.manageSettings(me) || can.viewAudit(me)) && <Route path="admin/configuracoes" element={<SettingsPage />} />}
        {can.manageCatalog(me) && <Route path="admin/cadastros" element={<CatalogsPage />} />}
        {can.viewAudit(me) && <Route path="admin/auditoria" element={<AuditPage />} />}
        {quality && <Route path="qualidade" element={<Suspense fallback={<Spinner />}><QualityPage /></Suspense>} />}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

/** Links from e-mails (/pendencias/:id) open the issue overlay on the list page. */
function IssueRedirect() {
  const id = location.pathname.split('/').pop();
  return <Navigate to={`/minhas?p=${id}`} replace />;
}
