import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type SettingsResponse, type SettingStatus } from '../api';

const SETTING_META: Record<string, { label: string; hint: string; placeholder: string }> = {
  ANTHROPIC_API_KEY: {
    label: 'Anthropic API key (Claude)',
    hint: 'Powers every agent. Get it at https://platform.claude.com → API keys. Paste it here and the agents start answering immediately — no redeploy.',
    placeholder: 'sk-ant-…',
  },
  META_APP_ID: {
    label: 'Meta App ID',
    hint: 'From https://developers.facebook.com/apps → your app → App settings → Basic.',
    placeholder: '1234567890…',
  },
  META_APP_SECRET: {
    label: 'Meta App secret',
    hint: 'Same page as the App ID. Used to verify Instagram webhook signatures.',
    placeholder: 'abc123…',
  },
  META_VERIFY_TOKEN: {
    label: 'Meta webhook verify token',
    hint: 'Any random string YOU choose. Enter the exact same value in the Meta App Dashboard webhook configuration.',
    placeholder: 'my-verify-token-…',
  },
};

function SourceBadge({ source }: { source: SettingStatus['source'] }) {
  if (source === 'platform') return <span className="badge ok">SET (dashboard)</span>;
  if (source === 'env') return <span className="badge accent">SET (server env)</span>;
  return <span className="badge bad">NOT SET</span>;
}

export default function Settings() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<SettingsResponse>('/api/settings'),
  });

  const urls = query.data?.urls;

  return (
    <>
      <h1 className="page-title">Settings</h1>
      <p className="page-sub">
        Keys are encrypted at rest, never displayed again, and take effect immediately.
        Dashboard values override the server environment variables.
      </p>

      {query.data?.settings.map((s) => (
        <SettingCard key={s.key} setting={s} onChanged={() => qc.invalidateQueries({ queryKey: ['settings'] })} />
      ))}

      <div className="card">
        <h3>Webhook & platform URLs</h3>
        {urls?.appUrl ? (
          <table className="table">
            <tbody>
              <tr>
                <td className="muted">Platform URL</td>
                <td className="mono">{urls.appUrl}</td>
              </tr>
              <tr>
                <td className="muted">Instagram webhook callback URL</td>
                <td className="mono">{urls.instagramWebhook}</td>
              </tr>
            </tbody>
          </table>
        ) : (
          <p className="muted">
            APP_URL is not configured on the server — webhook URLs cannot be shown. Set APP_URL in
            the deployment environment.
          </p>
        )}
        <p className="muted" style={{ fontSize: 12 }}>
          Use the callback URL + verify token in the Meta App Dashboard (Instagram → Configure
          webhooks → subscribe to <span className="mono">comments</span> and{' '}
          <span className="mono">messages</span>). The exact steps are listed under Manual actions.
        </p>
      </div>
    </>
  );
}

function SettingCard({ setting, onChanged }: { setting: SettingStatus; onChanged: () => void }) {
  const meta = SETTING_META[setting.key] ?? { label: setting.key, hint: '', placeholder: '' };
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  const save = useMutation({
    mutationFn: () => api.put(`/api/settings/${setting.key}`, { value }),
    onSuccess: () => {
      setValue('');
      setError('');
      onChanged();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Save failed'),
  });
  const clear = useMutation({
    mutationFn: () => api.delete(`/api/settings/${setting.key}`),
    onSuccess: onChanged,
  });

  return (
    <div className="card">
      <div className="row between">
        <h3 style={{ margin: 0 }}>{meta.label}</h3>
        <SourceBadge source={setting.source} />
      </div>
      {setting.maskedValue && (
        <p className="muted mono" style={{ margin: '8px 0 0' }}>Current: {setting.maskedValue}</p>
      )}
      <label className="field" style={{ marginTop: 10 }}>
        <div className="row">
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={meta.placeholder}
            autoComplete="off"
          />
          {setting.key === 'META_VERIFY_TOKEN' && (
            <button
              type="button"
              className="small"
              onClick={() =>
                setValue(
                  Array.from(crypto.getRandomValues(new Uint8Array(18)))
                    .map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36])
                    .join(''),
                )
              }
            >
              Generate
            </button>
          )}
        </div>
        <span className="hint">{meta.hint}</span>
      </label>
      {error && <div className="error-text">{error}</div>}
      <div className="row">
        <button
          className="primary"
          disabled={!value.trim() || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        {setting.source === 'platform' && (
          <button
            className="small danger"
            disabled={clear.isPending}
            onClick={() => {
              if (confirm('Remove the dashboard value? The server env value (if any) applies again.')) {
                clear.mutate();
              }
            }}
          >
            Remove
          </button>
        )}
      </div>
    </div>
  );
}
