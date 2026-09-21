import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type Lead } from '../api';

const STATUSES = ['', 'NEW', 'OPEN', 'QUALIFIED', 'CONVERTED', 'LOST', 'SPAM'];

export function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'QUALIFIED' || status === 'CONVERTED'
      ? 'ok'
      : status === 'LOST' || status === 'SPAM'
        ? 'bad'
        : status === 'OPEN'
          ? 'accent'
          : '';
  return <span className={`badge ${cls}`}>{status}</span>;
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
      <h1 className="page-title">Leads</h1>
      <p className="page-sub">{total} leads across all channels.</p>

      <div className="card row">
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} style={{ width: 160 }}>
          {STATUSES.map((s) => <option key={s} value={s}>{s || 'Any status'}</option>)}
        </select>
        <select value={source} onChange={(e) => { setSource(e.target.value); setPage(1); }} style={{ width: 160 }}>
          <option value="">Any source</option>
          <option value="INSTAGRAM">Instagram</option>
          <option value="TELEGRAM">Telegram</option>
        </select>
        <input
          placeholder="Search name, @username, phone, email…"
          value={q}
          onChange={(e) => { setQ(e.target.value); setPage(1); }}
          style={{ flex: 1, minWidth: 220 }}
        />
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Lead</th><th>Source</th><th>Status</th><th>Score</th><th>Intent</th>
              <th>Tags</th><th>Last interaction</th>
            </tr>
          </thead>
          <tbody>
            {query.data?.leads.map((l) => (
              <tr key={l.id}>
                <td>
                  <Link to={`/leads/${l.id}`}>
                    {l.name || (l.username ? `@${l.username}` : 'Unknown')}
                  </Link>
                  <div className="muted" style={{ fontSize: 12 }}>{l.phone ?? l.email ?? ''}</div>
                </td>
                <td>{l.source}</td>
                <td><StatusBadge status={l.status} /></td>
                <td>{l.score}</td>
                <td className="muted">{l.intent ?? ''}</td>
                <td>{l.tags.slice(0, 3).map((t) => <span className="badge" key={t} style={{ marginRight: 4 }}>{t}</span>)}</td>
                <td className="muted">
                  {l.lastInteractionAt ? new Date(l.lastInteractionAt).toLocaleString() : '—'}
                </td>
              </tr>
            ))}
            {query.data?.leads.length === 0 && (
              <tr><td colSpan={7} className="muted">No leads yet.</td></tr>
            )}
          </tbody>
        </table>
        {pages > 1 && (
          <div className="row" style={{ marginTop: 10 }}>
            <button className="small" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Prev</button>
            <span className="muted">Page {page} / {pages}</span>
            <button className="small" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next →</button>
          </div>
        )}
      </div>
    </>
  );
}
