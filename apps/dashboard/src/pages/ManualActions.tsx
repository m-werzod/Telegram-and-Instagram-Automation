import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ManualAction } from '../api';

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
      <h1 className="page-title">Manual actions</h1>
      <p className="page-sub">
        Steps the platform cannot perform automatically (Meta dashboard settings, app review,
        infrastructure). Each one lists the exact official page and steps.
      </p>

      {pending.length === 0 && <div className="card"><p className="muted">Nothing pending. 🎉</p></div>}
      {pending.map((a) => (
        <div className="card" key={a.id}>
          <div className="row between">
            <h3 style={{ margin: 0 }}>{a.title}</h3>
            <span className="badge warn">{a.platform}</span>
          </div>
          <p>
            Official page:{' '}
            <a href={a.officialUrl} target="_blank" rel="noreferrer">{a.officialUrl}</a>
          </p>
          <ol className="steps">
            {a.steps.map((s, i) => <li key={i}>{s}</li>)}
          </ol>
          {a.expectedResult && (
            <p><strong>Expected result:</strong> {a.expectedResult}</p>
          )}
          {a.whatToReturn && (
            <p className="muted"><strong>What to report back:</strong> {a.whatToReturn}</p>
          )}
          <div className="row">
            <button className="small primary" onClick={() => setStatus.mutate({ id: a.id, status: 'DONE' })}>
              Mark done
            </button>
            <button className="small" onClick={() => setStatus.mutate({ id: a.id, status: 'DISMISSED' })}>
              Dismiss
            </button>
          </div>
        </div>
      ))}

      {done.length > 0 && (
        <div className="card">
          <h3>Completed / dismissed</h3>
          {done.map((a) => (
            <div className="row between" key={a.id} style={{ padding: '6px 0' }}>
              <span>{a.title}</span>
              <span className="row">
                <span className={`badge ${a.status === 'DONE' ? 'ok' : ''}`}>{a.status}</span>
                <button className="small" onClick={() => setStatus.mutate({ id: a.id, status: 'PENDING' })}>
                  Reopen
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
