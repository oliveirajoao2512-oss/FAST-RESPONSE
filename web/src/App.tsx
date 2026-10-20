import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
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

export function App() {
  const { me, loading } = useSession();
  if (loading) return <Spinner label="Carregando Fast Response…" />;
  if (!me) {
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }
  if (me.mustChangePassword) return <ChangePasswordPage forced />;
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
        <Route path="ranking" element={<RankingPage />} />
        {can.viewReports(me) && <Route path="relatorios" element={<ReportsPage />} />}
        <Route path="notificacoes" element={<NotificationsPage />} />
        <Route path="trocar-senha" element={<ChangePasswordPage />} />
        {can.manageUsers(me) && <Route path="admin/usuarios" element={<UsersPage />} />}
        {(can.manageSettings(me) || can.viewAudit(me)) && <Route path="admin/configuracoes" element={<SettingsPage />} />}
        {can.manageCatalog(me) && <Route path="admin/cadastros" element={<CatalogsPage />} />}
        {can.viewAudit(me) && <Route path="admin/auditoria" element={<AuditPage />} />}
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
