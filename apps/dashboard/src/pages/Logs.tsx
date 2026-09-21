import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

type Tab = 'events' | 'ai' | 'tools';

export default function Logs() {
  const [tab, setTab] = useState<Tab>('events');
  return (
    <>
      <h1 className="page-title">Logs</h1>
      <p className="page-sub">Webhook events, AI executions, and controlled tool calls.</p>
      <div className="tabs">
        <button className={tab === 'events' ? 'active' : ''} onClick={() => setTab('events')}>Webhook events</button>
        <button className={tab === 'ai' ? 'active' : ''} onClick={() => setTab('ai')}>AI executions</button>
        <button className={tab === 'tools' ? 'active' : ''} onClick={() => setTab('tools')}>Tool calls</button>
      </div>
      {tab === 'events' && <Events />}
      {tab === 'ai' && <AiExecutions />}
      {tab === 'tools' && <ToolExecutions />}
    </>
  );
}

function statusClass(s: string): string {
  if (['PROCESSED', 'SUCCEEDED'].includes(s)) return 'ok';
  if (['FAILED', 'DEAD_LETTER'].includes(s)) return 'bad';
  if (['SKIPPED'].includes(s)) return '';
  return 'warn';
}

function Events() {
  const q = useQuery({
    queryKey: ['log-events'],
    queryFn: () => api.get<{ events: any[] }>('/api/logs/webhook-events'),
    refetchInterval: 15_000,
  });
  return (
    <div className="card">
      <table className="table">
        <thead>
          <tr><th>Received</th><th>Channel</th><th>Event key</th><th>Status</th><th>Attempts</th><th>Error</th></tr>
        </thead>
        <tbody>
          {q.data?.events.map((e) => (
            <tr key={e.id}>
              <td className="muted">{new Date(e.receivedAt).toLocaleString()}</td>
              <td>{e.channel}</td>
              <td className="mono">{e.eventKey}</td>
              <td><span className={`badge ${statusClass(e.status)}`}>{e.status}</span></td>
              <td>{e.attempts}</td>
              <td className="muted" style={{ maxWidth: 320 }}>{e.error ?? ''}</td>
            </tr>
          ))}
          {q.data?.events.length === 0 && <tr><td colSpan={6} className="muted">No events yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function AiExecutions() {
  const q = useQuery({
    queryKey: ['log-ai'],
    queryFn: () => api.get<{ executions: any[] }>('/api/logs/ai-executions'),
    refetchInterval: 15_000,
  });
  return (
    <div className="card">
      <table className="table">
        <thead>
          <tr><th>Time</th><th>Agent</th><th>Model</th><th>Status</th><th>Tokens in/out</th><th>Latency</th><th>Decision</th></tr>
        </thead>
        <tbody>
          {q.data?.executions.map((e) => (
            <tr key={e.id}>
              <td className="muted">{new Date(e.createdAt).toLocaleString()}</td>
              <td>{e.agent?.name ?? '—'}</td>
              <td className="mono">{e.model}</td>
              <td>
                <span className={`badge ${statusClass(e.status)}`}>{e.status}</span>
                {e.error && <div className="error-text" style={{ fontSize: 12 }}>{e.error}</div>}
              </td>
              <td>{e.inputTokens} / {e.outputTokens}</td>
              <td>{e.latencyMs} ms</td>
              <td>
                {e.decision && (
                  <details className="json">
                    <summary className="muted" style={{ cursor: 'pointer' }}>view</summary>
                    <pre>{JSON.stringify(e.decision, null, 2)}</pre>
                  </details>
                )}
              </td>
            </tr>
          ))}
          {q.data?.executions.length === 0 && <tr><td colSpan={7} className="muted">No executions yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function ToolExecutions() {
  const q = useQuery({
    queryKey: ['log-tools'],
    queryFn: () => api.get<{ executions: any[] }>('/api/logs/tool-executions'),
    refetchInterval: 15_000,
  });
  return (
    <div className="card">
      <table className="table">
        <thead>
          <tr><th>Time</th><th>Tool</th><th>Status</th><th>Latency</th><th>Input</th><th>Error</th></tr>
        </thead>
        <tbody>
          {q.data?.executions.map((e) => (
            <tr key={e.id}>
              <td className="muted">{new Date(e.createdAt).toLocaleString()}</td>
              <td className="mono">{e.name}</td>
              <td><span className={`badge ${statusClass(e.status)}`}>{e.status}</span></td>
              <td>{e.latencyMs} ms</td>
              <td>
                <details className="json">
                  <summary className="muted" style={{ cursor: 'pointer' }}>view</summary>
                  <pre>{JSON.stringify(e.input, null, 2)}</pre>
                </details>
              </td>
              <td className="muted">{e.error ?? ''}</td>
            </tr>
          ))}
          {q.data?.executions.length === 0 && <tr><td colSpan={6} className="muted">No tool calls yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
