import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Users, Search, ChevronLeft, ChevronRight } from 'lucide-react';
import { api, type Lead } from '../api';
import IconChip from '../components/IconChip';

const STATUSES = ['', 'NEW', 'OPEN', 'QUALIFIED', 'CONVERTED', 'LOST', 'SPAM'];
const STATUS_LABEL: Record<string, string> = {
  '': 'Har qanday holat',
  NEW: 'YANGI',
  OPEN: 'OCHIQ',
  QUALIFIED: "MALAKALI",
  CONVERTED: 'MIJOZGA AYLANDI',
  LOST: 'YO\'QOTILDI',
  SPAM: 'SPAM',
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

  const total = query.data?.total ?? 0;
  const pageSize = query.data?.pageSize ?? 25;
  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
      <div className="page-head">
        <IconChip icon={Users} tone="amber" size={42} />
        <div>
          <h1 className="page-title">Mijozlar (CRM)</h1>
          <p className="page-sub">Barcha kanallar bo'yicha jami {total} ta mijoz.</p>
        </div>
      </div>

      <div className="card row">
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} style={{ width: 170 }}>
          {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <select value={source} onChange={(e) => { setSource(e.target.value); setPage(1); }} style={{ width: 170 }}>
          <option value="">Har qanday manba</option>
          <option value="INSTAGRAM">Instagram</option>
          <option value="TELEGRAM">Telegram</option>
        </select>
        <div className="login-input" style={{ flex: 1, minWidth: 220, background: '#fff' }}>
          <Search size={15} strokeWidth={1.8} />
          <input
            placeholder="Ism, @username, telefon, email bo'yicha qidirish…"
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1); }}
            style={{ border: 'none', padding: '9px 0' }}
          />
        </div>
      </div>

      <div className="card">
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Mijoz</th><th>Manba</th><th>Holat</th><th>Ball</th><th>Maqsad</th>
                <th>Teglar</th><th>Oxirgi aloqa</th>
              </tr>
            </thead>
            <tbody>
              {query.data?.leads?.map((l) => (
                <tr key={l.id}>
                  <td>
                    <Link to={`/leads/${l.id}`}>
                      {l.name || (l.username ? `@${l.username}` : "Noma'lum")}
                    </Link>
                    <div className="muted" style={{ fontSize: 12 }}>{l.phone ?? l.email ?? ''}</div>
                  </td>
                  <td>{l.source === 'INSTAGRAM' ? 'Instagram' : 'Telegram'}</td>
                  <td><StatusBadge status={l.status} /></td>
                  <td>{l.score}</td>
                  <td className="muted">{l.intent ?? ''}</td>
                  <td>{l.tags.slice(0, 3).map((t) => <span className="badge" key={t} style={{ marginRight: 4 }}>{t}</span>)}</td>
                  <td className="muted">
                    {l.lastInteractionAt ? new Date(l.lastInteractionAt).toLocaleString('uz-UZ') : '—'}
                  </td>
                </tr>
              ))}
              {query.data?.leads?.length === 0 && (
                <tr><td colSpan={7} className="muted">Hali mijozlar yo'q.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {pages > 1 && (
          <div className="row" style={{ marginTop: 10 }}>
            <button className="small" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              <ChevronLeft size={14} /> Oldingi
            </button>
            <span className="muted">{page} / {pages} sahifa</span>
            <button className="small" disabled={page >= pages} onClick={() => setPage(page + 1)}>
              Keyingi <ChevronRight size={14} />
            </button>
          </div>
        )}
      </div>
    </>
  );
}
