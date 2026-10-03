import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ScrollText, Webhook, Cpu, Wrench } from 'lucide-react';
import { api } from '../api';
import IconChip from '../components/IconChip';

type Tab = 'events' | 'ai' | 'tools';

const STATUS_LABEL: Record<string, string> = {
  PROCESSED: 'QAYTA ISHLANDI',
  SUCCEEDED: 'MUVAFFAQIYATLI',
  SKIPPED: "O'TKAZIB YUBORILDI",
  FAILED: 'XATOLIK',
  DEAD_LETTER: 'BUTUNLAY MUVAFFAQIYATSIZ',
  RECEIVED: 'QABUL QILINDI',
  ENQUEUED: 'NAVBATDA',
  PROCESSING: 'QAYTA ISHLANMOQDA',
  RUNNING: 'ISHLAMOQDA',
};

export default function Logs() {
  const [tab, setTab] = useState<Tab>('events');
  return (
    <>
      <div className="page-head">
        <IconChip icon={ScrollText} tone="slate" size={42} />
        <div>
          <h1 className="page-title">Jurnal</h1>
          <p className="page-sub">Webhook hodisalari, AI ishga tushishlari va boshqariluvchi funksiya chaqiruvlari.</p>
        </div>
      </div>
      <div className="tabs">
        <button className={tab === 'events' ? 'active' : ''} onClick={() => setTab('events')}>
          <Webhook size={14} /> Webhook hodisalari
        </button>
        <button className={tab === 'ai' ? 'active' : ''} onClick={() => setTab('ai')}>
          <Cpu size={14} /> AI ishga tushishlari
        </button>
        <button className={tab === 'tools' ? 'active' : ''} onClick={() => setTab('tools')}>
          <Wrench size={14} /> Funksiya chaqiruvlari
        </button>
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
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr><th>Qabul qilindi</th><th>Kanal</th><th>Hodisa kaliti</th><th>Holat</th><th>Urinishlar</th><th>Xatolik</th></tr>
          </thead>
          <tbody>
            {q.data?.events.map((e) => (
              <tr key={e.id}>
                <td className="muted">{new Date(e.receivedAt).toLocaleString('uz-UZ')}</td>
                <td>{e.channel === 'INSTAGRAM' ? 'Instagram' : 'Telegram'}</td>
                <td className="mono">{e.eventKey}</td>
                <td><span className={`badge ${statusClass(e.status)}`}>{STATUS_LABEL[e.status] ?? e.status}</span></td>
                <td>{e.attempts}</td>
                <td className="muted" style={{ maxWidth: 320 }}>{e.error ?? ''}</td>
              </tr>
            ))}
            {q.data?.events.length === 0 && <tr><td colSpan={6} className="muted">Hali hodisalar yo'q.</td></tr>}
          </tbody>
        </table>
      </div>
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
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr><th>Vaqt</th><th>Agent</th><th>Model</th><th>Holat</th><th>Tokenlar (kirish/chiqish)</th><th>Tezlik</th><th>Qaror</th></tr>
          </thead>
          <tbody>
            {q.data?.executions.map((e) => (
              <tr key={e.id}>
                <td className="muted">{new Date(e.createdAt).toLocaleString('uz-UZ')}</td>
                <td>{e.agent?.name ?? '—'}</td>
                <td className="mono">{e.model}</td>
                <td>
                  <span className={`badge ${statusClass(e.status)}`}>{STATUS_LABEL[e.status] ?? e.status}</span>
                  {e.error && <div className="error-text" style={{ fontSize: 12 }}>{e.error}</div>}
                </td>
                <td>{e.inputTokens} / {e.outputTokens}</td>
                <td>{e.latencyMs} ms</td>
                <td>
                  {e.decision && (
                    <details className="json">
                      <summary className="muted" style={{ cursor: 'pointer' }}>ko'rish</summary>
                      <pre>{JSON.stringify(e.decision, null, 2)}</pre>
                    </details>
                  )}
                </td>
              </tr>
            ))}
            {q.data?.executions.length === 0 && <tr><td colSpan={7} className="muted">Hali ishga tushishlar yo'q.</td></tr>}
          </tbody>
        </table>
      </div>
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
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr><th>Vaqt</th><th>Funksiya</th><th>Holat</th><th>Tezlik</th><th>Kirish</th><th>Xatolik</th></tr>
          </thead>
          <tbody>
            {q.data?.executions.map((e) => (
              <tr key={e.id}>
                <td className="muted">{new Date(e.createdAt).toLocaleString('uz-UZ')}</td>
                <td className="mono">{e.name}</td>
                <td><span className={`badge ${statusClass(e.status)}`}>{STATUS_LABEL[e.status] ?? e.status}</span></td>
                <td>{e.latencyMs} ms</td>
                <td>
                  <details className="json">
                    <summary className="muted" style={{ cursor: 'pointer' }}>ko'rish</summary>
                    <pre>{JSON.stringify(e.input, null, 2)}</pre>
                  </details>
                </td>
                <td className="muted">{e.error ?? ''}</td>
              </tr>
            ))}
            {q.data?.executions.length === 0 && <tr><td colSpan={6} className="muted">Hali chaqiruvlar yo'q.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
