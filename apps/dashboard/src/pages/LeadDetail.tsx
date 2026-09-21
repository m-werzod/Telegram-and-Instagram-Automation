import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, type Lead } from '../api';
import { StatusBadge } from './Leads';

interface Message {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  role: string;
  content: string;
  createdAt: string;
}

export default function LeadDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const leadQuery = useQuery({
    queryKey: ['lead', id],
    queryFn: () => api.get<{ lead: Lead }>(`/api/leads/${id}`),
    enabled: !!id,
  });
  const candidates = useQuery({
    queryKey: ['merge-candidates', id],
    queryFn: () => api.get<{ candidates: Lead[] }>(`/api/leads/${id}/merge-candidates`),
    enabled: !!id,
  });
  const [conversationId, setConversationId] = useState<string | null>(null);
  const messages = useQuery({
    queryKey: ['messages', conversationId],
    queryFn: () => api.get<{ messages: Message[] }>(`/api/conversations/${conversationId}/messages`),
    enabled: !!conversationId,
  });
  const [note, setNote] = useState('');
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['lead', id] });
    qc.invalidateQueries({ queryKey: ['merge-candidates', id] });
  };

  const addNote = useMutation({
    mutationFn: () => api.post(`/api/leads/${id}/notes`, { content: note }),
    onSuccess: () => { setNote(''); refresh(); },
  });
  const patchLead = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.patch(`/api/leads/${id}`, patch),
    onSuccess: refresh,
  });
  const merge = useMutation({
    mutationFn: (sourceLeadId: string) => api.post(`/api/leads/${id}/merge`, { sourceLeadId }),
    onSuccess: refresh,
  });

  const lead = leadQuery.data?.lead;
  if (!lead) return <p className="muted">Loading…</p>;

  return (
    <>
      <p><Link to="/leads">← Leads</Link></p>
      <div className="row between">
        <h1 className="page-title">
          {lead.name || (lead.username ? `@${lead.username}` : 'Unknown lead')}{' '}
          <StatusBadge status={lead.status} />
        </h1>
        <select
          value={lead.status}
          onChange={(e) => patchLead.mutate({ status: e.target.value })}
          style={{ width: 170 }}
        >
          {['NEW', 'OPEN', 'QUALIFIED', 'CONVERTED', 'LOST', 'SPAM'].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      <div className="grid cols-2">
        <div>
          <div className="card">
            <h3>Profile</h3>
            <table className="table">
              <tbody>
                <tr><td className="muted">Source</td><td>{lead.source}</td></tr>
                <tr><td className="muted">Phone</td><td>{lead.phone ?? '—'}</td></tr>
                <tr><td className="muted">Email</td><td>{lead.email ?? '—'}</td></tr>
                <tr><td className="muted">Language</td><td>{lead.language ?? '—'}</td></tr>
                <tr><td className="muted">Intent</td><td>{lead.intent ?? '—'}</td></tr>
                <tr><td className="muted">Score</td><td>{lead.score}</td></tr>
                <tr>
                  <td className="muted">Tags</td>
                  <td>{lead.tags.map((t) => <span key={t} className="badge" style={{ marginRight: 4 }}>{t}</span>)}</td>
                </tr>
                <tr>
                  <td className="muted">Identities</td>
                  <td>
                    {lead.identities?.map((i) => (
                      <div key={i.id} className="mono" style={{ fontSize: 12 }}>
                        {i.channel}: {i.username ? `@${i.username} ` : ''}({i.externalId})
                      </div>
                    ))}
                  </td>
                </tr>
                <tr>
                  <td className="muted">Qualification</td>
                  <td>
                    {Object.entries(lead.qualification ?? {}).length === 0
                      ? '—'
                      : Object.entries(lead.qualification).map(([k, v]) => (
                          <div key={k}><span className="muted">{k}:</span> {String(v)}</div>
                        ))}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {candidates.data && candidates.data.candidates.length > 0 && (
            <div className="card">
              <h3>Possible duplicates</h3>
              <p className="muted" style={{ fontSize: 12 }}>
                Same phone/email/username. Merging moves all conversations and notes into this lead.
              </p>
              {candidates.data.candidates.map((c) => (
                <div className="row between" key={c.id} style={{ padding: '6px 0' }}>
                  <span>
                    <Link to={`/leads/${c.id}`}>{c.name || c.username || c.id}</Link>{' '}
                    <span className="muted">({c.source})</span>
                  </span>
                  <button
                    className="small"
                    onClick={() => {
                      if (confirm('Merge this duplicate into the current lead?')) merge.mutate(c.id);
                    }}
                  >
                    Merge into this lead
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="card">
            <h3>Notes</h3>
            {lead.notes?.map((n) => (
              <div key={n.id} style={{ marginBottom: 10 }}>
                <div className="muted" style={{ fontSize: 11 }}>
                  {n.authorType} · {new Date(n.createdAt).toLocaleString()}
                </div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{n.content}</div>
              </div>
            ))}
            <div className="row">
              <input value={note} placeholder="Add a note…" onChange={(e) => setNote(e.target.value)} />
              <button className="small" disabled={!note.trim() || addNote.isPending} onClick={() => addNote.mutate()}>
                Add
              </button>
            </div>
          </div>
        </div>

        <div>
          <div className="card">
            <h3>Conversations</h3>
            {lead.conversations?.map((c) => (
              <div className="row between" key={c.id} style={{ padding: '6px 0' }}>
                <span>
                  {c.channel} · {c.kind.replaceAll('_', ' ').toLowerCase()}{' '}
                  <span className={`badge ${c.status === 'HANDED_OFF' ? 'warn' : ''}`}>{c.status}</span>
                </span>
                <button className="small" onClick={() => setConversationId(c.id)}>View</button>
              </div>
            ))}
            {lead.conversations?.length === 0 && <p className="muted">No conversations yet.</p>}
          </div>

          {conversationId && (
            <div className="card">
              <h3>Messages</h3>
              <div className="chat">
                {messages.data?.messages.map((m) => (
                  <div key={m.id} className={`msg ${m.direction === 'INBOUND' ? 'in' : 'out'}`}>
                    {m.content}
                    <div className="meta">
                      {m.role} · {new Date(m.createdAt).toLocaleString()}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
