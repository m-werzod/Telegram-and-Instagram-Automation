import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { LayoutDashboard, Users, Activity, Cpu, LifeBuoy, Bot, Plug, Timer } from 'lucide-react';
import { api, type Agent, type Connection } from '../api';
import { AgentToggle } from './Agents';
import { HealthBadge } from './Connections';
import IconChip from '../components/IconChip';

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
      <div className="page-head">
        <IconChip icon={LayoutDashboard} tone="blue" size={42} />
        <div>
          <h1 className="page-title">Bosh sahifa</h1>
          <p className="page-sub">So'nggi 24 soatdagi agentlar, kanallar va faollikning jonli ko'rinishi.</p>
        </div>
      </div>

      <div className="grid cols-4">
        <div className="card stat">
          <IconChip icon={Users} tone="amber" size={42} />
          <div><div className="num">{s?.leads ?? '—'}</div><div className="label">Mijozlar</div></div>
        </div>
        <div className="card stat">
          <IconChip icon={Activity} tone="green" size={42} />
          <div><div className="num">{s?.events24h ?? '—'}</div><div className="label">Hodisalar (24 soat)</div></div>
        </div>
        <div className="card stat">
          <IconChip icon={Cpu} tone="violet" size={42} />
          <div>
            <div className="num">{s ? `${s.executions24h} / ${s.failures24h}` : '—'}</div>
            <div className="label">AI ishga tushishlari / xatolar</div>
          </div>
        </div>
        <div className="card stat">
          <IconChip icon={LifeBuoy} tone="red" size={42} />
          <div><div className="num">{s?.openHandoffs ?? '—'}</div><div className="label">Ochiq murojaatlar</div></div>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3><IconChip icon={Bot} tone="violet" size={26} /> AI Agentlar</h3>
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
          <h3><IconChip icon={Plug} tone="green" size={26} /> Ulanishlar</h3>
          {connections.data?.connections.length === 0 && (
            <p className="muted">Hali hech qanday kanal ulanmagan — <Link to="/connections">Ulanishlar</Link> bo'limiga o'ting.</p>
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
            <p className="muted row" style={{ marginTop: 10, gap: 6 }}>
              <Timer size={14} /> O'rtacha AI javob tezligi (24 soat): {s.avgLatencyMs} ms
            </p>
          )}
        </div>
      </div>
    </>
  );
}
