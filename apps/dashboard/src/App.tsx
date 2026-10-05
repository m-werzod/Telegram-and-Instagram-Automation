import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { LogOut, Menu, X, MoreHorizontal } from 'lucide-react';
import { api, ApiError, type SessionUser } from './api';
import { NAV_ITEMS, type NavItem } from './nav';
import IconChip from './components/IconChip';
import BrandLogo from './components/BrandLogo';
import SplashScreen from './components/SplashScreen';
import ErrorBoundary from './components/ErrorBoundary';
import Login from './pages/Login';
import Overview from './pages/Overview';
import Agents from './pages/Agents';
import AgentEdit from './pages/AgentEdit';
import Connections from './pages/Connections';
import TelegramPage from './pages/TelegramPage';
import Media from './pages/Media';
import Settings from './pages/Settings';
import Leads from './pages/Leads';
import LeadDetail from './pages/LeadDetail';
import Knowledge from './pages/Knowledge';
import Logs from './pages/Logs';
import Handoffs from './pages/Handoffs';
import ManualActions from './pages/ManualActions';

function initials(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .map((p) => p[0])
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?'
  );
}

/**
 * Signed-in user + sign-out. One definition for the desktop sidebar and the
 * mobile drawer so the two can never drift apart again.
 */
function UserCard({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  const roleLabel = user.role === 'ADMIN' ? 'Administrator' : 'Operator';
  const name = user.name?.trim() || user.username;
  // Two lines, two different facts. The seeded admin is named "Administrator"
  // and signs in as "Admin", so naively printing name-over-role (or
  // login-over-name) stacks near-identical words and reads as a glitch — show
  // the login underneath only when it adds something the name does not.
  const subtitle = name === user.username ? roleLabel : `@${user.username}`;
  return (
    <div className="user">
      <span className="avatar">{initials(name)}</span>
      <span className="who">
        <div className="name">{name}</div>
        <div className="role">{subtitle}</div>
      </span>
      <button className="logout-btn" onClick={onLogout} title="Chiqish" aria-label="Chiqish">
        <LogOut size={17} />
        <span className="label">Chiqish</span>
      </button>
    </div>
  );
}

export default function App() {
  const qc = useQueryClient();
  const [splash, setSplash] = useState(false);
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

  if (me.isLoading) {
    return (
      <div className="login-page">
        <p style={{ color: '#aeb8c4' }}>Yuklanmoqda…</p>
      </div>
    );
  }
  if (me.isError) {
    return (
      <div className="login-page">
        <div className="card" style={{ maxWidth: 420, textAlign: 'center' }}>
          <p>Server bilan bog'lanib bo'lmadi.</p>
          <p className="muted" style={{ fontSize: 13 }}>
            {me.error instanceof Error ? me.error.message : "Noma'lum xatolik"}
          </p>
          <button className="primary" onClick={() => me.refetch()}>
            Qayta urinish
          </button>
        </div>
      </div>
    );
  }
  if (!me.data?.user) {
    return (
      <Login
        onLoggedIn={() => {
          setSplash(true);
          qc.invalidateQueries({ queryKey: ['me'] });
        }}
      />
    );
  }
  const user = me.data.user;
  const isAdmin = user.role === 'ADMIN';

  const logout = async () => {
    try {
      await api.post('/api/auth/logout');
    } finally {
      // Clearing the cache drops every page's data, but leaves this observer
      // holding the old session — refetch it so the login screen comes back.
      qc.clear();
      await me.refetch();
    }
  };

  const items = NAV_ITEMS.filter((n) => !n.adminOnly || isAdmin);
  const bottomItems = items.filter((n) => n.inBottomBar);

  return (
    <>
      {splash && <SplashScreen onDone={() => setSplash(false)} />}
      <Shell user={user} items={items} bottomItems={bottomItems} onLogout={logout} />
    </>
  );
}

function Shell({
  user,
  items,
  bottomItems,
  onLogout,
}: {
  user: SessionUser;
  items: NavItem[];
  bottomItems: NavItem[];
  onLogout: () => void;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();
  const closeDrawer = () => setDrawerOpen(false);

  return (
    <div className="layout">
      {/* ── Desktop sidebar ──────────────────────────────────────────── */}
      <nav className="sidebar">
        <div className="brand">
          <BrandLogo size={34} />
          Turon AI Platforma
        </div>
        <div className="nav-list">
          {items.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
              <IconChip icon={n.icon} tone={n.tone} size={26} className="icon-chip" />
              {n.label}
            </NavLink>
          ))}
        </div>
        <UserCard user={user} onLogout={onLogout} />
      </nav>

      {/* ── Mobile top bar ───────────────────────────────────────────── */}
      <div className="topbar">
        <button className="menu-btn" onClick={() => setDrawerOpen(true)} aria-label="Menyu">
          <Menu size={21} />
        </button>
        <div className="brand">
          <BrandLogo size={28} />
          Turon AI
        </div>
        <span className="avatar">{initials(user.name || user.username)}</span>
      </div>

      {/* ── Mobile nav drawer ────────────────────────────────────────── */}
      <div className={`drawer-backdrop${drawerOpen ? ' open' : ''}`} onClick={closeDrawer} />
      <nav className={`nav-drawer${drawerOpen ? ' open' : ''}`}>
        <div className="drawer-head">
          <div className="brand">
            <BrandLogo size={34} />
            Turon AI
          </div>
          <button className="close-btn" onClick={closeDrawer} aria-label="Yopish">
            <X size={20} />
          </button>
        </div>
        <div className="nav-list" onClick={closeDrawer}>
          {items.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
              <IconChip icon={n.icon} tone={n.tone} size={26} />
              {n.label}
            </NavLink>
          ))}
        </div>
        <UserCard user={user} onLogout={onLogout} />
      </nav>

      <main className="main">
        {/* Keyed by path so a crashing page is isolated to that page and
            navigating away clears it — the shell and nav stay usable. */}
        <ErrorBoundary key={location.pathname}>
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/agents/:id" element={<AgentEdit />} />
          <Route path="/connections" element={<Connections isAdmin={user.role === 'ADMIN'} />} />
          <Route path="/telegram" element={<TelegramPage isAdmin={user.role === 'ADMIN'} />} />
          <Route path="/media" element={<Media isAdmin={user.role === 'ADMIN'} />} />
          {user.role === 'ADMIN' && <Route path="/settings" element={<Settings />} />}
          <Route path="/leads" element={<Leads />} />
          <Route path="/leads/:id" element={<LeadDetail />} />
          <Route path="/knowledge" element={<Knowledge />} />
          <Route path="/logs" element={<Logs />} />
          <Route path="/handoffs" element={<Handoffs />} />
          <Route path="/manual-actions" element={<ManualActions />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </ErrorBoundary>
      </main>

      {/* ── Mobile bottom tab bar ────────────────────────────────────── */}
      <nav className="bottombar">
        {bottomItems.map((n) => {
          const active = n.end ? location.pathname === n.to : location.pathname.startsWith(n.to);
          return (
            <NavLink key={n.to} to={n.to} end={n.end} className={active ? 'active' : ''}>
              <span className="tab-icon"><n.icon size={21} strokeWidth={2.25} /></span>
              {n.label.split(' ')[0]}
            </NavLink>
          );
        })}
        <button className={drawerOpen ? 'active' : ''} onClick={() => setDrawerOpen(true)}>
          <span className="tab-icon"><MoreHorizontal size={21} strokeWidth={2.25} /></span>
          Ko'proq
        </button>
      </nav>
    </div>
  );
}
