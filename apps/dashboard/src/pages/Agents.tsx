import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Bot, Settings2, Send } from 'lucide-react';
import { api, type Agent } from '../api';
import IconChip, { type IconComponent } from '../components/IconChip';
import InstagramIcon from '../components/InstagramIcon';

const CHANNEL_LABEL: Record<Agent['type'], string> = {
  INSTAGRAM_COMMENT: 'Instagram · Izohlar',
  INSTAGRAM_DM: 'Instagram · Direct xabarlar',
  TELEGRAM: 'Telegram · Bot',
  TELEGRAM_PERSONAL: 'Telegram · Shaxsiy akkaunt',
};

const CHANNEL_ICON: Record<Agent['type'], IconComponent> = {
  INSTAGRAM_COMMENT: InstagramIcon,
  INSTAGRAM_DM: InstagramIcon,
  TELEGRAM: Send,
  TELEGRAM_PERSONAL: Send,
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
      title={agent.enabled ? "O'chirish" : 'Yoqish'}
      onClick={() => toggle.mutate(!agent.enabled)}
      disabled={toggle.isPending}
      aria-label={`${agent.name} ${agent.enabled ? 'yoqilgan' : "o'chirilgan"}`}
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
      <div className="page-head">
        <IconChip icon={Bot} tone="violet" size={42} />
        <div>
          <h1 className="page-title">AI Agentlar</h1>
          <p className="page-sub">
            Har bir agent o'z ko'rsatmalari, bilimlar bazasi va YOQILGAN/O'CHIRILGAN holati bilan mustaqil ishlaydi.
            Holat backend tomonidan nazorat qilinadi: o'chirilgan agent javob bermaydi, lekin kiruvchi xabarlar baribir qayd etiladi.
          </p>
        </div>
      </div>
      {agents.data?.agents?.map((a) => {
        const ChannelIcon = CHANNEL_ICON[a.type];
        return (
          <div className="card" key={a.id}>
            <div className="row between">
              <div className="row" style={{ gap: 14, alignItems: 'flex-start' }}>
                <IconChip icon={ChannelIcon} tone={a.type.startsWith('INSTAGRAM') ? 'pink' : 'cyan'} size={38} />
                <div>
                  <div className="row">
                    <strong>{a.name}</strong>
                    <span className="badge accent">{CHANNEL_LABEL[a.type]}</span>
                    <span className={`badge ${a.enabled ? 'ok' : ''}`}>{a.enabled ? 'YOQILGAN' : "O'CHIRILGAN"}</span>
                  </div>
                  <div className="muted" style={{ marginTop: 6 }}>
                    {a.businessObjective || 'Maqsad sozlanmagan'}
                  </div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    Model: {a.model} · Til: {a.language} · Bilim bazasi: {a.knowledgeBase?.name ?? "yo'q"}
                  </div>
                </div>
              </div>
              <div className="row">
                <Link className="btn" to={`/agents/${a.id}`}>
                  <Settings2 size={15} /> Sozlash
                </Link>
                <AgentToggle agent={a} />
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}
