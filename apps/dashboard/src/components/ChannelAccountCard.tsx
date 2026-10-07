import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HelpCircle,
  Repeat,
  Unplug,
  ShieldAlert,
} from 'lucide-react';
import { api, ApiError, type Connection } from '../api';
import IconChip, { type IconComponent } from './IconChip';

/**
 * The account a channel is automating, and the control that moves the
 * automation to a different one.
 *
 * Replacing the account is not the same action as connecting one, and the UI
 * says so: pasting a new token here stops the account that is running now.
 * Everything else — agents, prompts, knowledge base, CRM history — is attached
 * to the business, not to the account, and stays exactly where it is.
 *
 * One definition, used by both the Connections page and the handover page, so
 * the two can never offer different versions of the same operation.
 */

const STATUS_LABEL: Record<string, string> = {
  CONNECTED: 'ULANGAN',
  DEGRADED: 'BUZILGAN',
  AUTH_REQUIRED: 'QAYTA ULANISH KERAK',
  PERMISSION_REQUIRED: 'RUXSAT KERAK',
  WEBHOOK_ERROR: 'WEBHOOK XATOSI',
  DISCONNECTED: 'ULANMAGAN',
  UNKNOWN: "NOMA'LUM",
};

export function HealthBadge({ status }: { status: string }) {
  const cls =
    status === 'CONNECTED' ? 'ok' : status === 'DEGRADED' || status === 'UNKNOWN' ? 'warn' : 'bad';
  const Icon =
    status === 'CONNECTED' ? CheckCircle2 : status === 'DEGRADED' || status === 'UNKNOWN' ? AlertTriangle : XCircle;
  return (
    <span className={`badge ${cls}`}>
      <Icon size={12} /> {STATUS_LABEL[status] ?? status.replaceAll('_', ' ')}
    </span>
  );
}

/** What the server recorded about the account this one replaced. */
interface PreviousAccount {
  displayName?: string;
  externalAccountId?: string;
  releasedAt?: string;
  released?: boolean;
  error?: string | null;
}

export interface ChannelAccountCardProps {
  title: string;
  icon: IconComponent;
  iconTone: 'pink' | 'cyan';
  channel: 'instagram' | 'telegram';
  connection?: Connection;
  isAdmin: boolean;
  onChanged: () => void;
  tokenLabel: string;
  tokenHint: string;
  /** What the owner does on their side once the new account is in place. */
  switchHint: string;
  extraActions?: React.ReactNode;
  /** Hide health/disconnect controls — the handover page only switches accounts. */
  compact?: boolean;
}

export default function ChannelAccountCard(props: ChannelAccountCardProps) {
  const { title, icon: Icon, iconTone, channel, connection, isAdmin, onChanged, compact } = props;
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [switching, setSwitching] = useState(false);

  const live = connection?.status === 'connected';
  const previous = (connection?.metadata as { previousAccount?: PreviousAccount } | undefined)
    ?.previousAccount;

  const connect = useMutation({
    mutationFn: () =>
      api.post(
        `/api/connections/${channel}`,
        channel === 'telegram' ? { botToken: token } : { accessToken: token },
      ),
    onSuccess: () => {
      setToken('');
      setError('');
      setSwitching(false);
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

  const tokenForm = (confirmLabel: string) => (
    <>
      <label className="field" style={{ marginTop: 12 }}>
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
      <div className="row">
        <button
          className="primary"
          onClick={() => connect.mutate()}
          disabled={connect.isPending || token.length < 10}
        >
          {connect.isPending ? 'Bajarilmoqda…' : confirmLabel}
        </button>
        {switching && (
          <button
            className="small"
            onClick={() => {
              setSwitching(false);
              setToken('');
              setError('');
            }}
          >
            Bekor qilish
          </button>
        )}
      </div>
    </>
  );

  return (
    <div className="card">
      <div className="row between">
        <h3 style={{ margin: 0 }}>
          <IconChip icon={Icon} tone={iconTone} size={26} /> {title}
        </h3>
        {live ? (
          <HealthBadge status={connection.healthStatus} />
        ) : (
          <span className="badge bad">
            <XCircle size={12} /> ULANMAGAN
          </span>
        )}
      </div>

      {live ? (
        <>
          <div className="account-line">
            <span className="account-name">{connection.displayName}</span>
            <span className="muted mono">id: {connection.externalAccountId}</span>
          </div>
          {!compact && connection.healthDetail && (
            <p className="muted" style={{ marginTop: 4 }}>
              {connection.healthDetail}
            </p>
          )}
          {!compact && (
            <p className="muted" style={{ fontSize: 12 }}>
              Oxirgi tekshiruv:{' '}
              {connection.lastHealthCheckAt
                ? new Date(connection.lastHealthCheckAt).toLocaleString('uz-UZ')
                : 'hali tekshirilmagan'}
            </p>
          )}

          {previous?.displayName && (
            <p className={previous.released ? 'muted' : 'error-text'} style={{ fontSize: 12.5 }}>
              {previous.released ? (
                <>
                  Oldingi akkaunt <strong>{previous.displayName}</strong> avtomatlashtirishdan uzildi
                  {previous.releasedAt
                    ? ` (${new Date(previous.releasedAt).toLocaleString('uz-UZ')})`
                    : ''}
                  .
                </>
              ) : (
                <>
                  <ShieldAlert size={14} />
                  <span>
                    Oldingi akkaunt <strong>{previous.displayName}</strong> bu yerda almashtirildi,
                    lekin uni to‘liq uzib bo‘lmadi: {previous.error}.{' '}
                    {channel === 'instagram'
                      ? 'Instagram → Sozlamalar → Ilovalar va veb-saytlar bo‘limidan platformani olib tashlang.'
                      : '@BotFather orqali eski botning webhook sozlamasini tekshiring.'}
                  </span>
                </>
              )}
            </p>
          )}

          {isAdmin && !switching && (
            <div className="row" style={{ marginTop: 12 }}>
              {!compact && (
                <button className="small" onClick={() => health.mutate()} disabled={health.isPending}>
                  <HelpCircle size={13} />
                  {health.isPending ? 'Tekshirilmoqda…' : 'Hozir tekshirish'}
                </button>
              )}
              {props.extraActions}
              <button className="small" onClick={() => setSwitching(true)}>
                <Repeat size={13} /> Akkauntni almashtirish
              </button>
              {!compact && (
                <button
                  className="small danger"
                  onClick={() => {
                    if (
                      confirm(
                        `${title} ulanishini uzasizmi? Saqlangan token o'chiriladi va bu akkaunt avtomatlashtirishdan chiqadi.`,
                      )
                    ) {
                      disconnect.mutate();
                    }
                  }}
                  disabled={disconnect.isPending}
                >
                  <Unplug size={13} /> Uzish
                </button>
              )}
            </div>
          )}
          {!isAdmin && (
            <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>
              Akkauntni faqat administrator almashtira oladi.
            </p>
          )}

          {switching && (
            <>
              <div className="switch-warning">
                <ShieldAlert size={16} />
                <div>
                  <strong>{connection.displayName}</strong> avtomatlashtirishdan chiqadi va uning
                  o‘rniga yangi akkaunt ishlay boshlaydi. Agentlar, ko‘rsatmalar, bilimlar bazasi va
                  mijozlar tarixi joyida qoladi.
                  <div className="muted" style={{ marginTop: 6 }}>
                    {props.switchHint}
                  </div>
                </div>
              </div>
              {tokenForm('Almashtirish')}
            </>
          )}
        </>
      ) : isAdmin ? (
        tokenForm(`${title}ni ulash`)
      ) : (
        <p className="muted" style={{ marginBottom: 0 }}>
          Bu kanalni faqat administrator ulashi mumkin.
        </p>
      )}
    </div>
  );
}
