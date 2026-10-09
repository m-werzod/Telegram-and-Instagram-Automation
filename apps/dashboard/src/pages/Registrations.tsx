import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  GraduationCap,
  Search,
  Phone,
  Clock,
  Send,
  MessageSquare,
  ChevronLeft,
  ChevronRight,
  UserCheck,
} from 'lucide-react';
import { api, ApiError } from '../api';
import IconChip from '../components/IconChip';
import InstagramIcon from '../components/InstagramIcon';
import QueryError from '../components/QueryError';

/**
 * Course registrations — the queue a salesperson actually works.
 *
 * Separate from Mijozlar (CRM) on purpose: that list is every person who ever
 * sent a message, while this one is only people who asked to enrol and gave a
 * name, a phone and a course. Operators live here, so it is the one CRM page
 * their role can reach.
 */

export const REGISTRATION_STATUSES = [
  'NEW',
  'CONTACT_NEEDED',
  'CONTACTED',
  'TRIAL_BOOKED',
  'ENROLLED',
  'COMPLETED',
  'CANCELLED',
] as const;

type Status = (typeof REGISTRATION_STATUSES)[number];

const STATUS_LABEL: Record<Status, string> = {
  NEW: 'Yangi ariza',
  CONTACT_NEEDED: "Bog'lanish kerak",
  CONTACTED: "Bog'lanildi",
  TRIAL_BOOKED: 'Sinov darsi',
  ENROLLED: 'Kursga yozildi',
  COMPLETED: 'Yakunlandi',
  CANCELLED: 'Bekor qilindi',
};

const STATUS_TONE: Record<Status, string> = {
  NEW: 'accent',
  CONTACT_NEEDED: 'warn',
  CONTACTED: '',
  TRIAL_BOOKED: '',
  ENROLLED: 'ok',
  COMPLETED: 'ok',
  CANCELLED: 'bad',
};

export interface Registration {
  id: string;
  fullName: string;
  phone: string;
  course: string;
  preferredTime: string | null;
  note: string | null;
  sourceChannel: 'INSTAGRAM' | 'TELEGRAM';
  sourceAccount: string | null;
  status: Status;
  createdAt: string;
  leadId: string;
  conversationId: string | null;
  assignedToUserId: string | null;
  assignedTo: { id: string; name: string; username: string } | null;
}

interface ListResponse {
  registrations: Registration[];
  total: number;
  page: number;
  pageSize: number;
  summary: {
    byStatus: Record<string, number>;
    courses: Array<{ course: string; count: number }>;
  };
}

export function RegistrationStatusBadge({ status }: { status: Status }) {
  return <span className={`badge ${STATUS_TONE[status]}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export default function Registrations() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [course, setCourse] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);

  const query = useQuery({
    queryKey: ['registrations', status, course, q, page],
    queryFn: () =>
      api.get<ListResponse>(
        `/api/registrations?status=${status}&course=${encodeURIComponent(course)}&q=${encodeURIComponent(q)}&page=${page}`,
      ),
  });
  const assignees = useQuery({
    queryKey: ['registration-assignees'],
    queryFn: () =>
      api.get<{ users: Array<{ id: string; name: string; username: string; role: string }> }>(
        '/api/registrations-assignees',
      ),
  });

  const list = query.data?.registrations ?? [];
  const summary = query.data?.summary;
  const total = query.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / (query.data?.pageSize ?? 25)));
  const refresh = () => qc.invalidateQueries({ queryKey: ['registrations'] });

  // "Open" work: everything that still needs somebody to do something.
  const open = summary
    ? (['NEW', 'CONTACT_NEEDED', 'CONTACTED', 'TRIAL_BOOKED'] as const).reduce(
        (n, s) => n + (summary.byStatus[s] ?? 0),
        0,
      )
    : null;

  return (
    <>
      <div className="page-head">
        <IconChip icon={GraduationCap} tone="green" size={42} />
        <div>
          <h1 className="page-title">Kursga yozilishlar</h1>
          <p className="page-sub">
            Faqat haqiqatan kursga yozilmoqchi bo‘lgan mijozlar — ism, telefon va kurs bilan.
          </p>
        </div>
      </div>

      <QueryError error={query.error} onRetry={() => query.refetch()} />

      {summary && (
        <div className="grid cols-4">
          <div className="card stat">
            <IconChip icon={GraduationCap} tone="green" size={42} />
            <div>
              <div className="num">{total}</div>
              <div className="label">Jami arizalar</div>
            </div>
          </div>
          <div className="card stat">
            <IconChip icon={Clock} tone="amber" size={42} />
            <div>
              <div className="num">{open ?? '—'}</div>
              <div className="label">Ish kutmoqda</div>
            </div>
          </div>
          <div className="card stat">
            <IconChip icon={UserCheck} tone="blue" size={42} />
            <div>
              <div className="num">{summary.byStatus.ENROLLED ?? 0}</div>
              <div className="label">Kursga yozildi</div>
            </div>
          </div>
          <div className="card stat">
            <IconChip icon={GraduationCap} tone="violet" size={42} />
            <div>
              <div className="num">{summary.courses.length}</div>
              <div className="label">Kurslar</div>
            </div>
          </div>
        </div>
      )}

      <div className="seg" role="tablist" aria-label="Holat">
        {[{ value: '', label: 'Barchasi', count: total }].concat(
          REGISTRATION_STATUSES.map((s) => ({
            value: s as string,
            label: STATUS_LABEL[s],
            count: summary?.byStatus[s] ?? 0,
          })),
        ).map((t) => (
          <button
            key={t.value}
            role="tab"
            aria-selected={status === t.value}
            className={status === t.value ? 'active' : ''}
            onClick={() => {
              setStatus(t.value);
              setPage(1);
            }}
          >
            {t.label}
            <span className="seg-count">{t.count}</span>
          </button>
        ))}
      </div>

      <div className="card filters">
        <div className="login-input search">
          <Search size={15} strokeWidth={1.8} />
          <input
            placeholder="Ism, telefon yoki kurs…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <select
          value={course}
          onChange={(e) => {
            setCourse(e.target.value);
            setPage(1);
          }}
          aria-label="Kurs"
        >
          <option value="">Har qanday kurs</option>
          {summary?.courses.map((c) => (
            <option key={c.course} value={c.course}>
              {c.course} ({c.count})
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
      ) : list.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <IconChip icon={GraduationCap} tone="green" size={52} />
            <p style={{ margin: 0 }}>
              {status || q || course ? 'Bu filtrga mos ariza yo‘q.' : 'Hali ariza yo‘q.'}
            </p>
            {!status && !q && !course && (
              <p className="muted" style={{ fontSize: 13, margin: '6px 0 0' }}>
                Mijoz suhbatda kursga yozilmoqchiligini aytsa va ism, telefon, kursni bersa — ariza
                shu yerda o‘zi paydo bo‘ladi.
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="lead-list">
            {list.map((r) => (
              <RegistrationCard
                key={r.id}
                registration={r}
                assignees={assignees.data?.users ?? []}
                onChanged={refresh}
              />
            ))}
          </div>
        </div>
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

function RegistrationCard({
  registration: r,
  assignees,
  onChanged,
}: {
  registration: Registration;
  assignees: Array<{ id: string; name: string; username: string; role: string }>;
  onChanged: () => void;
}) {
  const [error, setError] = useState('');
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/api/registrations/${r.id}`, body),
    onSuccess: () => {
      setError('');
      onChanged();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Xatolik'),
  });

  return (
    <div className="lead-card" style={{ cursor: 'default' }}>
      <div className="lead-top">
        <span className="lead-avatar">{(r.fullName[0] ?? '?').toUpperCase()}</span>
        <div className="lead-id">
          <div className="lead-name">{r.fullName}</div>
          <div className="lead-handle">{r.course}</div>
        </div>
        <div className="lead-right">
          <RegistrationStatusBadge status={r.status} />
        </div>
      </div>

      <div className="lead-facts">
        <span className="fact">
          {/* A registration exists so somebody can call it — make that one tap. */}
          <Phone size={12} /> <a href={`tel:${r.phone}`}>{r.phone}</a>
        </span>
        <span className="fact">
          {r.sourceChannel === 'INSTAGRAM' ? <InstagramIcon size={12} /> : <Send size={12} />}
          {r.sourceAccount ?? (r.sourceChannel === 'INSTAGRAM' ? 'Instagram' : 'Telegram')}
        </span>
        {r.preferredTime && (
          <span className="fact">
            <Clock size={12} /> {r.preferredTime}
          </span>
        )}
        <span className="fact muted">{new Date(r.createdAt).toLocaleString('uz-UZ')}</span>
      </div>

      <div className="reg-actions">
        <label className="field" style={{ margin: 0, flex: 1, minWidth: 150 }}>
          <span className="name">Holat</span>
          <select
            value={r.status}
            disabled={patch.isPending}
            onChange={(e) => patch.mutate({ status: e.target.value })}
          >
            {REGISTRATION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="field" style={{ margin: 0, flex: 1, minWidth: 150 }}>
          <span className="name">Mas'ul</span>
          <select
            value={r.assignedToUserId ?? ''}
            disabled={patch.isPending}
            onChange={(e) => patch.mutate({ assignedToUserId: e.target.value || null })}
          >
            <option value="">Tayinlanmagan</option>
            {assignees.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="row" style={{ gap: 8, marginTop: 10 }}>
        <Link to={`/leads/${r.leadId}`} className="btn small">
          <MessageSquare size={13} /> Suhbatni ko‘rish
        </Link>
      </div>

      {error && (
        <div className="error-text" style={{ fontSize: 12 }}>
          {error}
        </div>
      )}
    </div>
  );
}
