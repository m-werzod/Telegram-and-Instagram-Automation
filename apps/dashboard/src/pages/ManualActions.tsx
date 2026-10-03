import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardList, PartyPopper, ExternalLink, CheckCircle2, EyeOff, RotateCcw } from 'lucide-react';
import { api, type ManualAction } from '../api';
import IconChip from '../components/IconChip';

export default function ManualActions() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['manual-actions'],
    queryFn: () => api.get<{ actions: ManualAction[] }>('/api/manual-actions'),
  });
  const setStatus = useMutation({
    mutationFn: (vars: { id: string; status: 'DONE' | 'DISMISSED' | 'PENDING' }) =>
      api.post(`/api/manual-actions/${vars.id}/status`, { status: vars.status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['manual-actions'] }),
  });

  const pending = q.data?.actions.filter((a) => a.status === 'PENDING') ?? [];
  const done = q.data?.actions.filter((a) => a.status !== 'PENDING') ?? [];

  return (
    <>
      <div className="page-head">
        <IconChip icon={ClipboardList} tone="red" size={42} />
        <div>
          <h1 className="page-title">Qo'lda bajariladigan ishlar</h1>
          <p className="page-sub">
            Platforma avtomatik bajara olmaydigan qadamlar (Meta dashboard sozlamalari, App Review,
            infratuzilma). Har birida aniq rasmiy sahifa va qadamlar ko'rsatilgan.
          </p>
        </div>
      </div>

      {pending.length === 0 && (
        <div className="card empty-state">
          <IconChip icon={PartyPopper} tone="green" size={52} />
          <p className="muted">Hech narsa kutilmayapti. Hammasi tayyor!</p>
        </div>
      )}
      {pending.map((a) => (
        <div className="card" key={a.id}>
          <div className="row between">
            <h3 style={{ margin: 0 }}>{a.title}</h3>
            <span className="badge warn">{a.platform}</span>
          </div>
          <p className="row" style={{ gap: 6 }}>
            Rasmiy sahifa:{' '}
            <a href={a.officialUrl} target="_blank" rel="noreferrer" className="row" style={{ gap: 4 }}>
              {a.officialUrl} <ExternalLink size={12} />
            </a>
          </p>
          <ol className="steps">
            {a.steps.map((s, i) => <li key={i}>{s}</li>)}
          </ol>
          {a.expectedResult && (
            <p><strong>Kutilayotgan natija:</strong> {a.expectedResult}</p>
          )}
          {a.whatToReturn && (
            <p className="muted"><strong>Nimani xabar qilish kerak:</strong> {a.whatToReturn}</p>
          )}
          <div className="row">
            <button className="small primary" onClick={() => setStatus.mutate({ id: a.id, status: 'DONE' })}>
              <CheckCircle2 size={13} /> Bajarildi deb belgilash
            </button>
            <button className="small" onClick={() => setStatus.mutate({ id: a.id, status: 'DISMISSED' })}>
              <EyeOff size={13} /> E'tiborsiz qoldirish
            </button>
          </div>
        </div>
      ))}

      {done.length > 0 && (
        <div className="card">
          <h3>Bajarilgan / e'tiborsiz qoldirilgan</h3>
          {done.map((a) => (
            <div className="row between" key={a.id} style={{ padding: '6px 0' }}>
              <span>{a.title}</span>
              <span className="row">
                <span className={`badge ${a.status === 'DONE' ? 'ok' : ''}`}>
                  {a.status === 'DONE' ? 'BAJARILDI' : "E'TIBORSIZ QOLDIRILDI"}
                </span>
                <button className="small" onClick={() => setStatus.mutate({ id: a.id, status: 'PENDING' })}>
                  <RotateCcw size={13} /> Qayta ochish
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
