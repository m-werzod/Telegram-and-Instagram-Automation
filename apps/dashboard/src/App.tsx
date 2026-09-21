import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api, ApiError, type SessionUser } from './api';
import Login from './pages/Login';
import Overview from './pages/Overview';
import Agents from './pages/Agents';
import AgentEdit from './pages/AgentEdit';
import Connections from './pages/Connections';
import Leads from './pages/Leads';
import LeadDetail from './pages/LeadDetail';
import Knowledge from './pages/Knowledge';
import Logs from './pages/Logs';
import Handoffs from './pages/Handoffs';
import ManualActions from './pages/ManualActions';

export default function App() {
  const qc = useQueryClient();
  const me = useQuery<{ user: SessionUser } | null>({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api.get<{ user: SessionUser }>('/api/auth/me');
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
  });

  if (me.isLoading) return <div className="login-wrap muted">Loading…</div>;
  if (!me.data) return <Login onLoggedIn={() => qc.invalidateQueries({ queryKey: ['me'] })} />;
  const user = me.data.user;

  const logout = async () => {
    await api.post('/api/auth/logout');
    qc.clear();
    qc.invalidateQueries({ queryKey: ['me'] });
  };

  return (
    <div className="layout">
      <nav className="sidebar">
        <div className="brand">AI Automation</div>
        <NavLink to="/" end>Overview</NavLink>
        <NavLink to="/agents">Agents</NavLink>
        <NavLink to="/connections">Connections</NavLink>
        <NavLink to="/leads">CRM · Leads</NavLink>
        <NavLink to="/handoffs">Handoffs</NavLink>
        <NavLink to="/knowledge">Knowledge</NavLink>
        <NavLink to="/logs">Logs</NavLink>
        <NavLink to="/manual-actions">Manual actions</NavLink>
        <div className="spacer" />
        <div className="user">
          {user.name} · {user.role}
          <br />
          <button className="small" onClick={logout}>Sign out</button>
        </div>
      </nav>
      <main className="main">
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/agents/:id" element={<AgentEdit />} />
          <Route path="/connections" element={<Connections isAdmin={user.role === 'ADMIN'} />} />
          <Route path="/leads" element={<Leads />} />
          <Route path="/leads/:id" element={<LeadDetail />} />
          <Route path="/knowledge" element={<Knowledge />} />
          <Route path="/logs" element={<Logs />} />
          <Route path="/handoffs" element={<Handoffs />} />
          <Route path="/manual-actions" element={<ManualActions />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
