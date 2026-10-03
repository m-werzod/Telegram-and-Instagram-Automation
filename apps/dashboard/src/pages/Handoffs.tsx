import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { LifeBuoy, CheckCircle2, PauseCircle } from 'lucide-react';
import { api, type Handoff } from '../api';
import IconChip from '../components/IconChip';

export default function Handoffs() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['handoffs'],
    queryFn: () => api.get<{ handoffs: Handoff[] }>('/api/handoffs'),
    refetchInterval: 20_000,
  });
  const resolve = useMutation({
    mutationFn: (vars: { id: string; resumeAgent: boolean }) =>
      api.post(`/api/handoffs/${vars.id}/resolve`, { resumeAgent: vars.resumeAgent }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['handoffs'] }),
  });

  return (
    <>
      <div className="page-head">
        <IconChip icon={LifeBuoy} tone="red" size={42} />
        <div>
          <h1 className="page-title">Operatorga o'tkazilgan murojaatlar</h1>
          <p className="page-sub">
            Agentlar tomonidan operatorga yo'naltirilgan suhbatlar. Suhbat o'tkazilgan vaqtda, siz uni
            hal qilmaguningizcha, agent jim turadi.
          </p>
        </div>
      </div>
      <div className="card">
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr><th>Vaqt</th><th>Mijoz</th><th>Kanal</th><th>Sababi</th><th>Holat</th><th></th></tr>
            </thead>
            <tbody>
              {q.data?.handoffs?.map((h) => (
                <tr key={h.id}>
                  <td className="muted">{new Date(h.createdAt).toLocaleString('uz-UZ')}</td>
                  <td>
                    {h.lead ? (
                      <Link to={`/leads/${h.lead.id}`}>{h.lead.name || h.lead.username || 'Mijoz'}</Link>
                    ) : '—'}
                  </td>
                  <td>{h.conversation.channel === 'INSTAGRAM' ? 'Instagram' : 'Telegram'} · {h.conversation.kind.replaceAll('_', ' ').toLowerCase()}</td>
                  <td style={{ maxWidth: 360 }}>{h.reason}</td>
                  <td><span className={`badge ${h.status === 'OPEN' ? 'warn' : 'ok'}`}>{h.status === 'OPEN' ? 'OCHIQ' : 'HAL QILINDI'}</span></td>
                  <td>
                    {h.status === 'OPEN' && (
                      <div className="row">
                        <button className="small primary" onClick={() => resolve.mutate({ id: h.id, resumeAgent: true })}>
                          <CheckCircle2 size={13} /> Hal qilish va agentni davom ettirish
                        </button>
                        <button className="small" onClick={() => resolve.mutate({ id: h.id, resumeAgent: false })}>
                          <PauseCircle size={13} /> Hal qilish, lekin to'xtatib turish
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {q.data?.handoffs?.length === 0 && (
                <tr><td colSpan={6} className="muted">Hozircha murojaatlar yo'q.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
