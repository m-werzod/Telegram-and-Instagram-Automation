import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type Agent, type Connection } from '../api';
import { AgentToggle } from './Agents';
import { HealthBadge } from './Connections';

interface Stats {
  leads: number;
  openHandoffs: number;
  events24h: number;
  executions24h: number;
  failures24h: number;
  avgLatencyMs: number;
}

export default function Overview() {
  const stats = useQuery({
    queryKey: ['stats'],
    queryFn: () => api.get<{ stats: Stats }>('/api/stats'),
    refetchInterval: 30_000,
  });
  const agents = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<{ agents: Agent[] }>('/api/agents'),
  });
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: () => api.get<{ connections: Connection[] }>('/api/connections'),
  });

  const s = stats.data?.stats;
  return (
    <>
      <h1 className="page-title">Overview</h1>
      <p className="page-sub">Live view of agents, channels, and activity in the last 24 hours.</p>

      <div className="grid cols-4">
        <div className="card stat"><div className="num">{s?.leads ?? '—'}</div><div className="label">Leads</div></div>
        <div className="card stat"><div className="num">{s?.events24h ?? '—'}</div><div className="label">Webhook events (24h)</div></div>
        <div className="card stat"><div className="num">{s ? `${s.executions24h} / ${s.failures24h}` : '—'}</div><div className="label">AI runs / failures (24h)</div></div>
        <div className="card stat"><div className="num">{s?.openHandoffs ?? '—'}</div><div className="label">Open handoffs</div></div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3>Agents</h3>
          {agents.data?.agents.map((a) => (
            <div className="row between" key={a.id} style={{ padding: '7px 0' }}>
              <div>
                <Link to={`/agents/${a.id}`}>{a.name}</Link>
                <div className="muted" style={{ fontSize: 12 }}>{a.type.replaceAll('_', ' ').toLowerCase()}</div>
              </div>
              <AgentToggle agent={a} />
            </div>
          ))}
        </div>
        <div className="card">
          <h3>Connections</h3>
          {connections.data?.connections.length === 0 && (
            <p className="muted">No channels connected yet — go to <Link to="/connections">Connections</Link>.</p>
          )}
          {connections.data?.connections.map((c) => (
            <div className="row between" key={c.id} style={{ padding: '7px 0' }}>
              <div>
                <strong>{c.channel === 'INSTAGRAM' ? 'Instagram' : 'Telegram'}</strong>{' '}
                <span className="muted">{c.displayName}</span>
              </div>
              <HealthBadge status={c.healthStatus} />
            </div>
          ))}
          {s && s.avgLatencyMs > 0 && (
            <p className="muted" style={{ marginTop: 10 }}>Avg AI latency (24h): {s.avgLatencyMs} ms</p>
          )}
        </div>
      </div>
    </>
  );
}
