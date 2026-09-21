import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type Handoff } from '../api';

export default function Handoffs() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['handoffs'],
    queryFn: () => api.get<{ handoffs: Handoff[] }>('/api/handoffs'),
    refetchInterval: 20_000,
  });
  const resolve = useMutation({
    mutationFn: (vars: { id: string; resumeAgent: boolean }) =>
      api.post(`/api/handoffs/${vars.id}/resolve`, { resumeAgent: vars.resumeAgent }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['handoffs'] }),
  });

  return (
    <>
      <h1 className="page-title">Human handoffs</h1>
      <p className="page-sub">
        Conversations escalated by agents. While a conversation is handed off, the agent stays
        silent until you resolve it.
      </p>
      <div className="card">
        <table className="table">
          <thead>
            <tr><th>When</th><th>Lead</th><th>Channel</th><th>Reason</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {q.data?.handoffs.map((h) => (
              <tr key={h.id}>
                <td className="muted">{new Date(h.createdAt).toLocaleString()}</td>
                <td>
                  {h.lead ? (
                    <Link to={`/leads/${h.lead.id}`}>{h.lead.name || h.lead.username || 'Lead'}</Link>
                  ) : '—'}
                </td>
                <td>{h.conversation.channel} · {h.conversation.kind.replaceAll('_', ' ').toLowerCase()}</td>
                <td style={{ maxWidth: 360 }}>{h.reason}</td>
                <td><span className={`badge ${h.status === 'OPEN' ? 'warn' : 'ok'}`}>{h.status}</span></td>
                <td>
                  {h.status === 'OPEN' && (
                    <div className="row">
                      <button className="small primary" onClick={() => resolve.mutate({ id: h.id, resumeAgent: true })}>
                        Resolve & resume agent
                      </button>
                      <button className="small" onClick={() => resolve.mutate({ id: h.id, resumeAgent: false })}>
                        Resolve, keep paused
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {q.data?.handoffs.length === 0 && (
              <tr><td colSpan={6} className="muted">No handoffs.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
