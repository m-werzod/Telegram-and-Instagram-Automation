import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  User2,
  Copy,
  MessageSquare,
  StickyNote,
  Send,
  Sparkles,
  Phone,
  Mail,
} from 'lucide-react';
import { api, type Lead } from '../api';
import { StatusBadge } from './Leads';
import IconChip from '../components/IconChip';
import InstagramIcon from '../components/InstagramIcon';

interface Message {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  role: string;
  content: string;
  createdAt: string;
}

const STATUS_OPTIONS = ['NEW', 'OPEN', 'QUALIFIED', 'CONVERTED', 'LOST', 'SPAM'];
const STATUS_LABEL: Record<string, string> = {
  NEW: 'Yangi',
  OPEN: 'Ochiq',
  QUALIFIED: 'Malakali',
  CONVERTED: 'Mijozga aylandi',
  LOST: "Yo'qotildi",
  SPAM: 'Spam',
};

/** Everything the agent can extract from a conversation, in reading order. */
const QUALIFICATION_LABEL: Record<string, string> = {
  purpose: 'Maqsad',
  category: 'Toifa',
  requestedService: "So'ralgan xizmat",
  location: 'Hudud',
  timeline: 'Muddat',
  budget: 'Byudjet',
};

const CONVERSATION_KIND: Record<string, string> = {
  INSTAGRAM_COMMENT_THREAD: 'Instagram izoh',
  INSTAGRAM_DM: 'Instagram DM',
  TELEGRAM_CHAT: 'Telegram bot',
  TELEGRAM_PERSONAL_CHAT: 'Telegram shaxsiy',
};

function channelLabel(channel: string): string {
  return channel === 'INSTAGRAM' ? 'Instagram' : 'Telegram';
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
    onSuccess: () => {
      setNote('');
      refresh();
    },
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
        <Link to="/leads" className="back-link">
          <ArrowLeft size={15} /> Mijozlar
        </Link>
        <p>Mijoz ma'lumotini yuklab bo'lmadi.</p>
        <p className="muted" style={{ fontSize: 13 }}>
          {leadQuery.error instanceof Error ? leadQuery.error.message : 'Mijoz topilmadi'}
        </p>
        <button className="small" onClick={() => leadQuery.refetch()}>
          Qayta urinish
        </button>
      </div>
    );
  }
  if (!lead) return <p className="muted">Yuklanmoqda…</p>;

  const name = lead.name || (lead.username ? `@${lead.username}` : "Noma'lum mijoz");
  const collected = Object.entries(QUALIFICATION_LABEL)
    .map(([key, label]) => [label, lead.qualification?.[key]] as const)
    .filter(([, value]) => typeof value === 'string' && value.trim());

  return (
    <>
      <Link to="/leads" className="back-link">
        <ArrowLeft size={15} /> Mijozlar
      </Link>

      <div className="page-head">
        <IconChip
          icon={lead.source === 'INSTAGRAM' ? InstagramIcon : Send}
          tone={lead.source === 'INSTAGRAM' ? 'pink' : 'cyan'}
          size={42}
        />
        <div style={{ minWidth: 0, flex: 1 }}>
          <h1 className="page-title">{name}</h1>
          <div className="row" style={{ gap: 7 }}>
            <StatusBadge status={lead.status} />
            <span className="badge">{channelLabel(lead.source)}</span>
            <span className="muted" style={{ fontSize: 12.5 }}>
              Ball: <strong>{lead.score}</strong>
            </span>
          </div>
        </div>
      </div>

      {/* Status is the one field an operator changes constantly — full width on
          a phone, not a 190px control wedged beside the title. */}
      <div className="card">
        <label className="field" style={{ marginBottom: 0 }}>
          <span className="name">Holat</span>
          <select value={lead.status} onChange={(e) => patchLead.mutate({ status: e.target.value })}>
            {STATUS_OPTIONS.map((st) => (
              <option key={st} value={st}>
                {STATUS_LABEL[st] ?? st}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid cols-2">
        <div>
          <div className="card">
            <h3>
              <IconChip icon={User2} tone="blue" size={26} /> Aloqa ma'lumotlari
            </h3>
            <div className="kv">
              <div>
                <div className="k">Telefon</div>
                <div className={`v${lead.phone ? '' : ' empty'}`}>
                  {lead.phone ? (
                    <a href={`tel:${lead.phone.replace(/\s/g, '')}`}>
                      <Phone size={12} style={{ display: 'inline', verticalAlign: -1 }} /> {lead.phone}
                    </a>
                  ) : (
                    'berilmagan'
                  )}
                </div>
              </div>
              <div>
                <div className="k">Email</div>
                <div className={`v${lead.email ? '' : ' empty'}`}>
                  {lead.email ? (
                    <a href={`mailto:${lead.email}`}>
                      <Mail size={12} style={{ display: 'inline', verticalAlign: -1 }} /> {lead.email}
                    </a>
                  ) : (
                    'berilmagan'
                  )}
                </div>
              </div>
              <div>
                <div className="k">Username</div>
                <div className={`v${lead.username ? '' : ' empty'}`}>
                  {lead.username ? `@${lead.username}` : '—'}
                </div>
              </div>
              <div>
                <div className="k">Til</div>
                <div className={`v${lead.language ? '' : ' empty'}`}>{lead.language ?? '—'}</div>
              </div>
              <div className="wide">
                <div className="k">Kanal identifikatorlari</div>
                <div className="v">
                  {lead.identities?.length
                    ? lead.identities.map((i) => (
                        <div key={i.id} style={{ fontSize: 12.5 }}>
                          {channelLabel(i.channel)}: {i.username ? `@${i.username} ` : ''}
                          <span className="mono muted">{i.externalId}</span>
                        </div>
                      ))
                    : '—'}
                </div>
              </div>
            </div>
          </div>

          {/* The whole point of the automation: what the agent worked out on its
              own. Kept in its own card so it is never mistaken for something an
              operator typed. */}
          <div className="card">
            <h3>
              <IconChip icon={Sparkles} tone="violet" size={26} /> AI suhbatdan aniqlagan
            </h3>
            {!lead.intent && collected.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                Hali hech narsa aniqlanmadi — suhbat davom etsa agent o'zi to'ldiradi.
              </p>
            ) : (
              <div className="kv">
                {lead.intent && (
                  <div className="wide">
                    <div className="k">Niyat</div>
                    <div className="v">{lead.intent}</div>
                  </div>
                )}
                {collected.map(([label, value]) => (
                  <div key={label}>
                    <div className="k">{label}</div>
                    <div className="v">{String(value)}</div>
                  </div>
                ))}
              </div>
            )}
            {lead.tags.length > 0 && (
              <div className="lead-tags">
                {lead.tags.map((t) => (
                  <span key={t} className="badge">
                    {t}
                  </span>
                ))}
              </div>
            )}
          </div>

          {candidates.data?.candidates && candidates.data.candidates.length > 0 && (
            <div className="card">
              <h3>
                <IconChip icon={Copy} tone="violet" size={26} /> Ehtimoliy takrorlanishlar
              </h3>
              <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
                Telefon/email/username bir xil. Birlashtirish barcha suhbat va eslatmalarni shu
                mijozga ko'chiradi.
              </p>
              <div className="stack">
                {candidates.data.candidates.map((c) => (
                  <div className="mini-row" key={c.id}>
                    <span>
                      <Link to={`/leads/${c.id}`}>{c.name || c.username || c.id}</Link>{' '}
                      <span className="muted">({channelLabel(c.source)})</span>
                    </span>
                    <button
                      className="small"
                      onClick={() => {
                        if (confirm('Bu takrorlanishni joriy mijozga birlashtirasizmi?')) {
                          merge.mutate(c.id);
                        }
                      }}
                    >
                      Birlashtirish
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div>
          <div className="card">
            <h3>
              <IconChip icon={MessageSquare} tone="cyan" size={26} /> Suhbatlar
            </h3>
            {lead.conversations?.length ? (
              lead.conversations.map((c) => (
                <button
                  key={c.id}
                  className={`conv-item${conversationId === c.id ? ' active' : ''}`}
                  onClick={() => setConversationId(conversationId === c.id ? null : c.id)}
                >
                  <span className="conv-who">
                    <strong>{CONVERSATION_KIND[c.kind] ?? channelLabel(c.channel)}</strong>
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      {c.lastMessageAt
                        ? new Date(c.lastMessageAt).toLocaleString('uz-UZ')
                        : 'xabar yo‘q'}
                    </div>
                  </span>
                  <span className={`badge ${c.status === 'HANDED_OFF' ? 'warn' : ''}`}>
                    {c.status === 'ACTIVE'
                      ? 'FAOL'
                      : c.status === 'HANDED_OFF'
                        ? 'OPERATORDA'
                        : 'YOPILGAN'}
                  </span>
                </button>
              ))
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                Hali suhbat yo'q.
              </p>
            )}
          </div>

          {conversationId && (
            <div className="card">
              <h3>
                <IconChip icon={MessageSquare} tone="blue" size={26} /> Xabarlar
              </h3>
              {messages.isLoading ? (
                <p className="muted" style={{ margin: 0 }}>
                  Yuklanmoqda…
                </p>
              ) : (
                <div className="chat">
                  {messages.data?.messages?.map((m) => (
                    <div key={m.id} className={`msg ${m.direction === 'INBOUND' ? 'in' : 'out'}`}>
                      {m.content}
                      <div className="meta">
                        {m.role === 'USER'
                          ? 'Mijoz'
                          : m.role === 'AGENT'
                            ? 'AI'
                            : m.role === 'OPERATOR'
                              ? 'Operator'
                              : 'Tizim'}{' '}
                        · {new Date(m.createdAt).toLocaleString('uz-UZ')}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="card">
            <h3>
              <IconChip icon={StickyNote} tone="amber" size={26} /> Eslatmalar
            </h3>
            {lead.notes?.map((n) => (
              <div key={n.id} style={{ marginBottom: 10 }}>
                <div className="muted" style={{ fontSize: 11 }}>
                  {n.authorType === 'AGENT' ? 'AI' : n.authorType === 'OPERATOR' ? 'Operator' : 'Tizim'}{' '}
                  · {new Date(n.createdAt).toLocaleString('uz-UZ')}
                </div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{n.content}</div>
              </div>
            ))}
            <div className="row">
              <input
                value={note}
                placeholder="Eslatma qo'shish…"
                style={{ flex: 1, minWidth: 160 }}
                onChange={(e) => setNote(e.target.value)}
              />
              <button
                className="small"
                disabled={!note.trim() || addNote.isPending}
                onClick={() => addNote.mutate()}
              >
                <Send size={13} /> Qo'shish
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
