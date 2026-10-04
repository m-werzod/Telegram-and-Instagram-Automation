import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, User2, Copy, MessageSquare, StickyNote, Send } from 'lucide-react';
import { api, type Lead } from '../api';
import { StatusBadge } from './Leads';
import IconChip from '../components/IconChip';

interface Message {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  role: string;
  content: string;
  createdAt: string;
}

const STATUS_OPTIONS = ['NEW', 'OPEN', 'QUALIFIED', 'CONVERTED', 'LOST', 'SPAM'];
const QUALIFICATION_LABEL: Record<string, string> = {
  requestedService: 'So\'ralgan xizmat',
  category: 'Toifa',
  purpose: 'Maqsad',
  budget: 'Byudjet',
  location: 'Hudud',
  timeline: 'Muddat',
};

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
  if (leadQuery.isError || (!lead && !leadQuery.isLoading)) {
    return (
      <div className="card">
        <p><Link to="/leads"><ArrowLeft size={14} style={{ verticalAlign: -2 }} /> Mijozlar</Link></p>
        <p>Mijoz ma'lumotini yuklab bo'lmadi.</p>
        <p className="muted" style={{ fontSize: 13 }}>
          {leadQuery.error instanceof Error ? leadQuery.error.message : 'Mijoz topilmadi'}
        </p>
        <button className="small" onClick={() => leadQuery.refetch()}>Qayta urinish</button>
      </div>
    );
  }
  if (!lead) return <p className="muted">Yuklanmoqda…</p>;

  return (
    <>
      <p><Link to="/leads"><ArrowLeft size={14} style={{ verticalAlign: -2 }} /> Mijozlar</Link></p>
      <div className="row between" style={{ marginBottom: 18, flexWrap: 'wrap', gap: 12 }}>
        <div className="page-head" style={{ marginBottom: 0 }}>
          <IconChip icon={User2} tone="amber" size={42} />
          <div>
            <h1 className="page-title">
              {lead.name || (lead.username ? `@${lead.username}` : "Noma'lum mijoz")}
            </h1>
            <StatusBadge status={lead.status} />
          </div>
        </div>
        <select
          value={lead.status}
          onChange={(e) => patchLead.mutate({ status: e.target.value })}
          style={{ width: 190 }}
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      <div className="grid cols-2">
        <div>
          <div className="card">
            <h3><IconChip icon={User2} tone="blue" size={26} /> Profil</h3>
            <div className="table-scroll">
              <table className="table">
                <tbody>
                  <tr><td className="muted">Manba</td><td>{lead.source === 'INSTAGRAM' ? 'Instagram' : 'Telegram'}</td></tr>
                  <tr><td className="muted">Telefon</td><td>{lead.phone ?? '—'}</td></tr>
                  <tr><td className="muted">Email</td><td>{lead.email ?? '—'}</td></tr>
                  <tr><td className="muted">Til</td><td>{lead.language ?? '—'}</td></tr>
                  <tr><td className="muted">Maqsad</td><td>{lead.intent ?? '—'}</td></tr>
                  <tr><td className="muted">Ball</td><td>{lead.score}</td></tr>
                  <tr>
                    <td className="muted">Teglar</td>
                    <td>{lead.tags.map((t) => <span key={t} className="badge" style={{ marginRight: 4 }}>{t}</span>)}</td>
                  </tr>
                  <tr>
                    <td className="muted">Identifikatorlar</td>
                    <td>
                      {lead.identities?.map((i) => (
                        <div key={i.id} className="mono" style={{ fontSize: 12 }}>
                          {i.channel === 'INSTAGRAM' ? 'Instagram' : 'Telegram'}: {i.username ? `@${i.username} ` : ''}({i.externalId})
                        </div>
                      ))}
                    </td>
                  </tr>
                  <tr>
                    <td className="muted">Malakalashtirish ma'lumotlari</td>
                    <td>
                      {Object.entries(lead.qualification ?? {}).length === 0
                        ? '—'
                        : Object.entries(lead.qualification).map(([k, v]) => (
                            <div key={k}><span className="muted">{QUALIFICATION_LABEL[k] ?? k}:</span> {String(v)}</div>
                          ))}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {candidates.data?.candidates && candidates.data.candidates.length > 0 && (
            <div className="card">
              <h3><IconChip icon={Copy} tone="violet" size={26} /> Ehtimoliy takrorlanishlar</h3>
              <p className="muted" style={{ fontSize: 12 }}>
                Telefon/email/username bir xil. Birlashtirish barcha suhbat va eslatmalarni shu mijozga ko'chiradi.
              </p>
              {candidates.data.candidates.map((c) => (
                <div className="row between" key={c.id} style={{ padding: '6px 0' }}>
                  <span>
                    <Link to={`/leads/${c.id}`}>{c.name || c.username || c.id}</Link>{' '}
                    <span className="muted">({c.source === 'INSTAGRAM' ? 'Instagram' : 'Telegram'})</span>
                  </span>
                  <button
                    className="small"
                    onClick={() => {
                      if (confirm('Bu takrorlanishni joriy mijozga birlashtirasizmi?')) merge.mutate(c.id);
                    }}
                  >
                    Shu mijozga birlashtirish
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="card">
            <h3><IconChip icon={StickyNote} tone="amber" size={26} /> Eslatmalar</h3>
            {lead.notes?.map((n) => (
              <div key={n.id} style={{ marginBottom: 10 }}>
                <div className="muted" style={{ fontSize: 11 }}>
                  {n.authorType === 'AGENT' ? 'AI' : n.authorType === 'OPERATOR' ? 'Operator' : 'Tizim'} ·{' '}
                  {new Date(n.createdAt).toLocaleString('uz-UZ')}
                </div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{n.content}</div>
              </div>
            ))}
            <div className="row">
              <input value={note} placeholder="Eslatma qo'shish…" onChange={(e) => setNote(e.target.value)} />
              <button className="small" disabled={!note.trim() || addNote.isPending} onClick={() => addNote.mutate()}>
                <Send size={13} /> Qo'shish
              </button>
            </div>
          </div>
        </div>

        <div>
          <div className="card">
            <h3><IconChip icon={MessageSquare} tone="cyan" size={26} /> Suhbatlar</h3>
            {lead.conversations?.map((c) => (
              <div className="row between" key={c.id} style={{ padding: '6px 0' }}>
                <span>
                  {c.channel === 'INSTAGRAM' ? 'Instagram' : 'Telegram'} · {c.kind.replaceAll('_', ' ').toLowerCase()}{' '}
                  <span className={`badge ${c.status === 'HANDED_OFF' ? 'warn' : ''}`}>
                    {c.status === 'ACTIVE' ? 'FAOL' : c.status === 'HANDED_OFF' ? "OPERATORGA O'TKAZILDI" : 'YOPILGAN'}
                  </span>
                </span>
                <button className="small" onClick={() => setConversationId(c.id)}>Ko'rish</button>
              </div>
            ))}
            {lead.conversations?.length === 0 && <p className="muted">Hali suhbat yo'q.</p>}
          </div>

          {conversationId && (
            <div className="card">
              <h3><IconChip icon={MessageSquare} tone="blue" size={26} /> Xabarlar</h3>
              <div className="chat">
                {messages.data?.messages?.map((m) => (
                  <div key={m.id} className={`msg ${m.direction === 'INBOUND' ? 'in' : 'out'}`}>
                    {m.content}
                    <div className="meta">
                      {m.role === 'USER' ? 'Mijoz' : m.role === 'AGENT' ? 'AI' : m.role === 'OPERATOR' ? 'Operator' : 'Tizim'} ·{' '}
                      {new Date(m.createdAt).toLocaleString('uz-UZ')}
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
