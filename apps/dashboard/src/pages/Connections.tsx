import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type Connection } from '../api';

export function HealthBadge({ status }: { status: string }) {
  const cls =
    status === 'CONNECTED' ? 'ok' : status === 'DEGRADED' || status === 'UNKNOWN' ? 'warn' : 'bad';
  return <span className={`badge ${cls}`}>{status.replaceAll('_', ' ')}</span>;
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
      <h1 className="page-title">Connections</h1>
      <p className="page-sub">
        Health is verified against the live APIs — a stored token alone is never shown as
        "connected". Steps that cannot be automated appear under Manual actions.
      </p>
      <ChannelCard
        title="Instagram"
        channel="instagram"
        connection={instagram}
        isAdmin={isAdmin}
        onChanged={refresh}
        tokenLabel="Instagram access token"
        tokenHint={
          'Paste a long-lived Instagram User access token. Fastest path: Meta App Dashboard → Instagram → "API setup with Instagram business login" → Generate token (valid 60 days; the platform refreshes it automatically). Requires scopes: instagram_business_basic, instagram_business_manage_comments, instagram_business_manage_messages.'
        }
      />
      <ChannelCard
        title="Telegram"
        channel="telegram"
        connection={telegram}
        isAdmin={isAdmin}
        onChanged={refresh}
        tokenLabel="Bot token"
        tokenHint="Create a bot with @BotFather in Telegram (/newbot) and paste the token. The platform validates it, configures the webhook, and registers commands automatically."
        extraActions={
          telegram && isAdmin ? (
            <ReconfigureWebhookButton onChanged={refresh} />
          ) : null
        }
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
      {m.isPending ? 'Configuring…' : 'Reconfigure webhook'}
    </button>
  );
}

function ChannelCard(props: {
  title: string;
  channel: 'instagram' | 'telegram';
  connection?: Connection;
  isAdmin: boolean;
  onChanged: () => void;
  tokenLabel: string;
  tokenHint: string;
  extraActions?: React.ReactNode;
}) {
  const { title, channel, connection, isAdmin, onChanged } = props;
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
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Connection failed'),
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
        <h3 style={{ margin: 0 }}>{title}</h3>
        {connection && connection.status === 'connected' ? (
          <HealthBadge status={connection.healthStatus} />
        ) : (
          <span className="badge bad">DISCONNECTED</span>
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
            Last checked:{' '}
            {connection.lastHealthCheckAt
              ? new Date(connection.lastHealthCheckAt).toLocaleString()
              : 'never'}
          </p>
          <div className="row">
            <button className="small" onClick={() => health.mutate()} disabled={health.isPending}>
              {health.isPending ? 'Checking…' : 'Check health now'}
            </button>
            {props.extraActions}
            {isAdmin && (
              <button
                className="small danger"
                onClick={() => {
                  if (confirm(`Disconnect ${title}? The stored token will be deleted.`)) {
                    disconnect.mutate();
                  }
                }}
              >
                Disconnect
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
              placeholder="Paste token — it is encrypted at rest and never displayed again"
            />
            <span className="hint">{props.tokenHint}</span>
          </label>
          {error && <div className="error-text">{error}</div>}
          <button
            className="primary"
            onClick={() => connect.mutate()}
            disabled={connect.isPending || token.length < 10}
          >
            {connect.isPending ? 'Connecting…' : `Connect ${title}`}
          </button>
        </>
      ) : (
        <p className="muted">An administrator can connect this channel.</p>
      )}
    </div>
  );
}
