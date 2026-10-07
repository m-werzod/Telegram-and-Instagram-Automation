import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Users,
  Search,
  ChevronLeft,
  ChevronRight,
  Send,
  Phone,
  Mail,
  Target,
  Clock,
} from 'lucide-react';
import { api, type Lead } from '../api';
import IconChip from '../components/IconChip';
import InstagramIcon from '../components/InstagramIcon';
import QueryError from '../components/QueryError';

/**
 * CRM — the leads the agents build out of real conversations.
 *
 * Phone-first by construction: one card per person, never a seven-column table
 * squeezed into a horizontal scroller. The two channels get their own sections
 * because an Instagram DM and a Telegram chat are different conversations with
 * different people, and a single blended list hides which channel is actually
 * producing customers.
 */

const STATUSES = ['', 'NEW', 'OPEN', 'QUALIFIED', 'CONVERTED', 'LOST', 'SPAM'] as const;
const STATUS_LABEL: Record<string, string> = {
  '': 'Har qanday holat',
  NEW: 'YANGI',
  OPEN: 'OCHIQ',
  QUALIFIED: 'MALAKALI',
  CONVERTED: 'MIJOZGA AYLANDI',
  LOST: "YO'QOTILDI",
  SPAM: 'SPAM',
};

/** Fields the agent fills in from the conversation, in the order they matter. */
const QUALIFICATION_LABEL: Record<string, string> = {
  purpose: 'Maqsad',
  category: 'Toifa',
  requestedService: 'Xizmat',
  location: 'Hudud',
  timeline: 'Muddat',
  budget: 'Byudjet',
};

export function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'QUALIFIED' || status === 'CONVERTED'
      ? 'ok'
      : status === 'LOST' || status === 'SPAM'
        ? 'bad'
        : status === 'OPEN'
          ? 'accent'
          : '';
  return <span className={`badge ${cls}`}>{STATUS_LABEL[status] ?? status}</span>;
}

interface Summary {
  total: number;
  bySource: { INSTAGRAM: number; TELEGRAM: number };
  byStatus: Record<string, number>;
}

export default function Leads() {
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);

  const query = useQuery({
    queryKey: ['leads', status, source, q, page],
    queryFn: () =>
      api.get<{ leads: Lead[]; total: number; pageSize: number }>(
        `/api/leads?status=${status}&source=${source}&q=${encodeURIComponent(q)}&page=${page}`,
      ),
  });
  // Real per-channel totals. Counting the current page instead would report
  // "Instagram: 4" whenever a page merely happens to hold four of them.
  const summary = useQuery({
    queryKey: ['leads-summary'],
    queryFn: () => api.get<{ summary: Summary }>('/api/leads/summary'),
  });

  const total = query.data?.total ?? 0;
  const pageSize = query.data?.pageSize ?? 25;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const leads = query.data?.leads ?? [];
  const s = summary.data?.summary;

  const instagram = leads.filter((l) => l.source === 'INSTAGRAM');
  const telegram = leads.filter((l) => l.source === 'TELEGRAM');
  const filtering = Boolean(status || q);
  const reset = () => {
    setPage(1);
  };

  return (
    <>
      <div className="page-head">
        <IconChip icon={Users} tone="amber" size={42} />
        <div>
          <h1 className="page-title">Mijozlar (CRM)</h1>
          <p className="page-sub">
            AI suhbatdan ismni, telefonni va maqsadni o'zi ajratib oladi va shu yerga yozadi.
          </p>
        </div>
      </div>

      <QueryError error={query.error} onRetry={() => query.refetch()} />

      {/* Channel tabs double as the source filter — a thumb-sized target
          instead of a <select> nobody notices on a phone. */}
      <div className="seg" role="tablist" aria-label="Kanal">
        {[
          { value: '', label: 'Barchasi', count: s?.total },
          { value: 'INSTAGRAM', label: 'Instagram', count: s?.bySource.INSTAGRAM },
          { value: 'TELEGRAM', label: 'Telegram', count: s?.bySource.TELEGRAM },
        ].map((t) => (
          <button
            key={t.value}
            role="tab"
            aria-selected={source === t.value}
            className={source === t.value ? 'active' : ''}
            onClick={() => {
              setSource(t.value);
              reset();
            }}
          >
            {t.label}
            {typeof t.count === 'number' && <span className="seg-count">{t.count}</span>}
          </button>
        ))}
      </div>

      <div className="card filters">
        <div className="login-input search">
          <Search size={15} strokeWidth={1.8} />
          <input
            placeholder="Ism, @username, telefon yoki email…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              reset();
            }}
          />
        </div>
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            reset();
          }}
          aria-label="Holat"
        >
          {STATUSES.map((st) => (
            <option key={st} value={st}>
              {STATUS_LABEL[st]}
              {st && s?.byStatus[st] !== undefined ? ` (${s.byStatus[st]})` : ''}
            </option>
          ))}
        </select>
      </div>

      {query.isLoading ? (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            Yuklanmoqda…
          </p>
        </div>
      ) : leads.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <IconChip icon={Users} tone="amber" size={52} />
            <p style={{ margin: 0 }}>
              {filtering ? 'Bu filtrga mos mijoz topilmadi.' : 'Hali mijozlar yo‘q.'}
            </p>
            {!filtering && (
              <p className="muted" style={{ fontSize: 13, margin: '6px 0 0' }}>
                Birinchi suhbat kelganda agent mijozni o‘zi yaratadi.
              </p>
            )}
          </div>
        </div>
      ) : (
        <>
          {source !== 'TELEGRAM' && (
            <ChannelSection
              title="Instagram"
              icon={InstagramIcon}
              tone="pink"
              total={s?.bySource.INSTAGRAM}
              leads={instagram}
            />
          )}
          {source !== 'INSTAGRAM' && (
            <ChannelSection
              title="Telegram"
              icon={Send}
              tone="cyan"
              total={s?.bySource.TELEGRAM}
              leads={telegram}
            />
          )}
        </>
      )}

      {pages > 1 && (
        <div className="card pager">
          <button className="small" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            <ChevronLeft size={14} /> Oldingi
          </button>
          <span className="muted">
            {page} / {pages} sahifa
          </span>
          <button className="small" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            Keyingi <ChevronRight size={14} />
          </button>
        </div>
      )}
    </>
  );
}

function ChannelSection({
  title,
  icon,
  tone,
  total,
  leads,
}: {
  title: string;
  icon: React.ComponentType<{ size?: number }>;
  tone: 'pink' | 'cyan';
  total?: number;
  leads: Lead[];
}) {
  return (
    <div className="card">
      <div className="row between" style={{ marginBottom: leads.length ? 12 : 0 }}>
        <h3 style={{ margin: 0 }}>
          <IconChip icon={icon} tone={tone} size={26} /> {title}
        </h3>
        <span className="badge">
          {leads.length}
          {typeof total === 'number' && total !== leads.length ? ` / ${total}` : ''}
        </span>
      </div>
      {leads.length === 0 ? (
        <p className="muted" style={{ margin: '8px 0 0', fontSize: 13 }}>
          Bu sahifada {title} mijozi yo‘q.
        </p>
      ) : (
        <div className="lead-list">
          {leads.map((l) => (
            <LeadCard key={l.id} lead={l} />
          ))}
        </div>
      )}
    </div>
  );
}

function LeadCard({ lead }: { lead: Lead }) {
  const name = lead.name || (lead.username ? `@${lead.username}` : "Noma'lum");
  const facts = Object.entries(QUALIFICATION_LABEL)
    .map(([key, label]) => [label, lead.qualification?.[key]] as const)
    .filter(([, value]) => typeof value === 'string' && value.trim())
    .slice(0, 4);

  return (
    <Link to={`/leads/${lead.id}`} className="lead-card">
      <div className="lead-top">
        <span className="lead-avatar">{(name.replace(/^@/, '')[0] ?? '?').toUpperCase()}</span>
        <div className="lead-id">
          <div className="lead-name">{name}</div>
          {lead.username && lead.name && <div className="lead-handle">@{lead.username}</div>}
        </div>
        <div className="lead-right">
          <StatusBadge status={lead.status} />
          <span className="lead-score" title="Qiziqish bali">
            {lead.score}
          </span>
        </div>
      </div>

      <div className="lead-facts">
        {lead.phone && (
          <span className="fact">
            <Phone size={12} /> {lead.phone}
          </span>
        )}
        {lead.email && (
          <span className="fact">
            <Mail size={12} /> {lead.email}
          </span>
        )}
        {lead.intent && (
          <span className="fact">
            <Target size={12} /> {lead.intent}
          </span>
        )}
        {lead.lastInteractionAt && (
          <span className="fact muted">
            <Clock size={12} /> {new Date(lead.lastInteractionAt).toLocaleString('uz-UZ')}
          </span>
        )}
      </div>

      {facts.length > 0 && (
        <dl className="lead-collected">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{String(value)}</dd>
            </div>
          ))}
        </dl>
      )}

      {lead.tags.length > 0 && (
        <div className="lead-tags">
          {lead.tags.slice(0, 4).map((t) => (
            <span className="badge" key={t}>
              {t}
            </span>
          ))}
          {lead.tags.length > 4 && <span className="muted">+{lead.tags.length - 4}</span>}
        </div>
      )}
    </Link>
  );
}
