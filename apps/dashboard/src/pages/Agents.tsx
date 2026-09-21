import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type Agent } from '../api';

const CHANNEL_LABEL: Record<Agent['type'], string> = {
  INSTAGRAM_COMMENT: 'Instagram · Comments',
  INSTAGRAM_DM: 'Instagram · Direct messages',
  TELEGRAM: 'Telegram · Bot',
  TELEGRAM_PERSONAL: 'Telegram · Personal account',
};

export function AgentToggle({ agent }: { agent: Agent }) {
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      api.post<{ agent: Agent }>(`/api/agents/${agent.id}/toggle`, { enabled }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents'] });
      qc.invalidateQueries({ queryKey: ['agent', agent.id] });
    },
  });
  return (
    <button
      className={`toggle ${agent.enabled ? 'on' : ''}`}
      title={agent.enabled ? 'Turn OFF' : 'Turn ON'}
      onClick={() => toggle.mutate(!agent.enabled)}
      disabled={toggle.isPending}
      aria-label={`${agent.name} ${agent.enabled ? 'on' : 'off'}`}
    >
      <span className="knob" />
    </button>
  );
}

export default function Agents() {
  const agents = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<{ agents: Agent[] }>('/api/agents'),
  });

  return (
    <>
      <h1 className="page-title">Agents</h1>
      <p className="page-sub">
        Each agent runs independently with its own instructions, knowledge base, and ON/OFF state.
        The state is enforced by the backend: an agent that is OFF never responds, but incoming
        events are still recorded.
      </p>
      {agents.data?.agents.map((a) => (
        <div className="card" key={a.id}>
          <div className="row between">
            <div>
              <div className="row">
                <strong>{a.name}</strong>
                <span className="badge accent">{CHANNEL_LABEL[a.type]}</span>
                <span className={`badge ${a.enabled ? 'ok' : ''}`}>{a.enabled ? 'ON' : 'OFF'}</span>
              </div>
              <div className="muted" style={{ marginTop: 6 }}>
                {a.businessObjective || 'No objective configured'}
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                Model: {a.model} · Language: {a.language} · Knowledge:{' '}
                {a.knowledgeBase?.name ?? 'none'}
              </div>
            </div>
            <div className="row">
              <Link className="btn" to={`/agents/${a.id}`}>Configure</Link>
              <AgentToggle agent={a} />
            </div>
          </div>
        </div>
      ))}
    </>
  );
}
