import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plug, Send, CheckCircle2, AlertTriangle, XCircle, HelpCircle, RefreshCw } from 'lucide-react';
import { api, ApiError, type Connection } from '../api';
import IconChip, { type IconComponent } from '../components/IconChip';
import InstagramIcon from '../components/InstagramIcon';

const STATUS_LABEL: Record<string, string> = {
  CONNECTED: 'ULANGAN',
  DEGRADED: 'BUZILGAN',
  AUTH_REQUIRED: 'QAYTA ULANISH KERAK',
  PERMISSION_REQUIRED: "RUXSAT KERAK",
  WEBHOOK_ERROR: 'WEBHOOK XATOSI',
  DISCONNECTED: 'ULANMAGAN',
  UNKNOWN: "NOMA'LUM",
};

export function HealthBadge({ status }: { status: string }) {
  const cls = status === 'CONNECTED' ? 'ok' : status === 'DEGRADED' || status === 'UNKNOWN' ? 'warn' : 'bad';
  const Icon = status === 'CONNECTED' ? CheckCircle2 : status === 'DEGRADED' || status === 'UNKNOWN' ? AlertTriangle : XCircle;
  return (
    <span className={`badge ${cls}`}>
      <Icon size={12} /> {STATUS_LABEL[status] ?? status.replaceAll('_', ' ')}
    </span>
  );
}

export default function Connections({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: () => api.get<{ connections: Connection[] }>('/api/connections'),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['connections'] });

  const instagram = connections.data?.connections.find((c) => c.channel === 'INSTAGRAM');
  const telegram = connections.data?.connections.find((c) => c.channel === 'TELEGRAM');

  return (
    <>
      <div className="page-head">
        <IconChip icon={Plug} tone="green" size={42} />
        <div>
          <h1 className="page-title">Ulanishlar</h1>
          <p className="page-sub">
            Holat jonli API orqali tekshiriladi — saqlangan token hali "ulangan" degani emas.
            Avtomatlashtirib bo'lmaydigan qadamlar "Qo'lda bajariladigan ishlar" bo'limida ko'rsatiladi.
          </p>
        </div>
      </div>
      <ChannelCard
        title="Instagram"
        icon={InstagramIcon}
        iconTone="pink"
        channel="instagram"
        connection={instagram}
        isAdmin={isAdmin}
        onChanged={refresh}
        tokenLabel="Instagram access token"
        tokenHint={'Uzun muddatli Instagram token qo\'ying. Eng tez yo\'l: Meta App Dashboard → Instagram → "API setup with Instagram business login" → Generate token (60 kun amal qiladi; platforma avtomatik yangilaydi).'}
      />
      <ChannelCard
        title="Telegram"
        icon={Send}
        iconTone="cyan"
        channel="telegram"
        connection={telegram}
        isAdmin={isAdmin}
        onChanged={refresh}
        tokenLabel="Bot tokeni"
        tokenHint="Telegramda @BotFather orqali bot yarating (/newbot) va tokenni shu yerga qo'ying. Platforma uni tekshiradi va webhook/polling'ni avtomatik sozlaydi."
        extraActions={telegram && isAdmin ? <ReconfigureWebhookButton onChanged={refresh} /> : null}
      />
    </>
  );
}

function ReconfigureWebhookButton({ onChanged }: { onChanged: () => void }) {
  const m = useMutation({
    mutationFn: () => api.post('/api/connections/telegram/reconfigure-webhook'),
    onSuccess: onChanged,
  });
  return (
    <button className="small" onClick={() => m.mutate()} disabled={m.isPending}>
      <RefreshCw size={13} className={m.isPending ? 'spin' : ''} />
      {m.isPending ? 'Sozlanmoqda…' : 'Qayta sozlash'}
    </button>
  );
}

function ChannelCard(props: {
  title: string;
  icon: IconComponent;
  iconTone: 'pink' | 'cyan';
  channel: 'instagram' | 'telegram';
  connection?: Connection;
  isAdmin: boolean;
  onChanged: () => void;
  tokenLabel: string;
  tokenHint: string;
  extraActions?: React.ReactNode;
}) {
  const { title, icon: Icon, iconTone, channel, connection, isAdmin, onChanged } = props;
  const [token, setToken] = useState('');
  const [error, setError] = useState('');

  const connect = useMutation({
    mutationFn: () =>
      api.post(`/api/connections/${channel}`,
        channel === 'telegram' ? { botToken: token } : { accessToken: token }),
    onSuccess: () => {
      setToken('');
      setError('');
      onChanged();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Ulanishda xatolik'),
  });
  const health = useMutation({
    mutationFn: () => api.post(`/api/connections/${channel}/health`),
    onSuccess: onChanged,
  });
  const disconnect = useMutation({
    mutationFn: () => api.delete(`/api/connections/${channel}`),
    onSuccess: onChanged,
  });

  return (
    <div className="card">
      <div className="row between">
        <h3 style={{ margin: 0 }}><IconChip icon={Icon} tone={iconTone} size={26} /> {title}</h3>
        {connection && connection.status === 'connected' ? (
          <HealthBadge status={connection.healthStatus} />
        ) : (
          <span className="badge bad"><XCircle size={12} /> ULANMAGAN</span>
        )}
      </div>

      {connection && connection.status === 'connected' ? (
        <>
          <p style={{ margin: '10px 0 4px' }}>
            <strong>{connection.displayName}</strong>{' '}
            <span className="muted mono">id: {connection.externalAccountId}</span>
          </p>
          {connection.healthDetail && <p className="muted">{connection.healthDetail}</p>}
          <p className="muted" style={{ fontSize: 12 }}>
            Oxirgi tekshiruv:{' '}
            {connection.lastHealthCheckAt
              ? new Date(connection.lastHealthCheckAt).toLocaleString('uz-UZ')
              : 'hali tekshirilmagan'}
          </p>
          <div className="row">
            <button className="small" onClick={() => health.mutate()} disabled={health.isPending}>
              <HelpCircle size={13} />
              {health.isPending ? 'Tekshirilmoqda…' : 'Hozir tekshirish'}
            </button>
            {props.extraActions}
            {isAdmin && (
              <button
                className="small danger"
                onClick={() => {
                  if (confirm(`${title} ulanishini uzasizmi? Saqlangan token o'chiriladi.`)) {
                    disconnect.mutate();
                  }
                }}
              >
                Uzish
              </button>
            )}
          </div>
        </>
      ) : isAdmin ? (
        <>
          <label className="field" style={{ marginTop: 10 }}>
            <span className="name">{props.tokenLabel}</span>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Tokenni joylashtiring — u shifrlangan holda saqlanadi va qayta ko'rsatilmaydi"
            />
            <span className="hint">{props.tokenHint}</span>
          </label>
          {error && <div className="error-text">{error}</div>}
          <button
            className="primary"
            onClick={() => connect.mutate()}
            disabled={connect.isPending || token.length < 10}
          >
            {connect.isPending ? 'Ulanmoqda…' : `${title}ni ulash`}
          </button>
        </>
      ) : (
        <p className="muted">Bu kanalni faqat administrator ulashi mumkin.</p>
      )}
    </div>
  );
}
