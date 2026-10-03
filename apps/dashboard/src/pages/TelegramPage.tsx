import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  api,
  ApiError,
  type Agent,
  type Connection,
  type KnowledgeBase,
  type TelegramPersonalAccount,
} from '../api';
import { AgentToggle } from './Agents';
import { HealthBadge } from './Connections';

/**
 * The Telegram control center: the bot (its own agent + settings), and every
 * PERSONAL Telegram account connected through the bot — each with independent
 * automation toggle, instructions, and knowledge base.
 */
export default function TelegramPage({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: () => api.get<{ connections: Connection[] }>('/api/connections'),
  });
  const agents = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<{ agents: Agent[] }>('/api/agents'),
  });
  const accounts = useQuery({
    queryKey: ['tg-personal'],
    queryFn: () => api.get<{ accounts: TelegramPersonalAccount[] }>('/api/telegram-personal-accounts'),
  });
  const kbs = useQuery({
    queryKey: ['knowledge-bases'],
    queryFn: () => api.get<{ knowledgeBases: KnowledgeBase[] }>('/api/knowledge-bases'),
  });

  const telegram = connections.data?.connections.find((c) => c.channel === 'TELEGRAM');
  const botAgent = agents.data?.agents.find((a) => a.type === 'TELEGRAM');
  const personalAgent = agents.data?.agents.find((a) => a.type === 'TELEGRAM_PERSONAL');
  const botUsername = (telegram?.metadata as { botUsername?: string } | undefined)?.botUsername;
  const refreshAccounts = () => qc.invalidateQueries({ queryKey: ['tg-personal'] });

  return (
    <>
      <h1 className="page-title">Telegram</h1>
      <p className="page-sub">
        The bot answers its own chats 24/7; personal accounts connected via Telegram Business are
        automated individually, each with its own instructions and knowledge base.
      </p>

      {/* ── Bot card ─────────────────────────────────────────────────────── */}
      <div className="card">
        <div className="row between">
          <h3 style={{ margin: 0 }}>Telegram bot {botUsername ? `· @${botUsername}` : ''}</h3>
          {telegram && telegram.status === 'connected' ? (
            <HealthBadge status={telegram.healthStatus} />
          ) : (
            <span className="badge bad">NOT CONNECTED</span>
          )}
        </div>
        {telegram?.healthDetail && <p className="muted">{telegram.healthDetail}</p>}
        {!telegram || telegram.status !== 'connected' ? (
          <p className="muted">
            Connect the bot on the <Link to="/connections">Connections</Link> page (paste the token
            from @BotFather).
          </p>
        ) : botAgent ? (
          <div className="row between" style={{ marginTop: 8 }}>
            <div>
              <strong>{botAgent.name}</strong>{' '}
              <span className={`badge ${botAgent.enabled ? 'ok' : ''}`}>
                {botAgent.enabled ? 'ON' : 'OFF'}
              </span>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                Model: {botAgent.model} · Language: {botAgent.language} · Knowledge:{' '}
                {botAgent.knowledgeBase?.name ?? 'none'}
              </div>
            </div>
            <div className="row">
              <Link className="btn" to={`/agents/${botAgent.id}`}>
                Bot settings (instructions, knowledge, image)
              </Link>
              <AgentToggle agent={botAgent} />
            </div>
          </div>
        ) : null}
      </div>

      {/* ── Personal accounts ────────────────────────────────────────────── */}
      <div className="card">
        <div className="row between">
          <h3 style={{ margin: 0 }}>Personal accounts (Telegram Business)</h3>
          {personalAgent && (
            <div className="row">
              <span className="muted" style={{ fontSize: 12 }}>
                Default agent: {personalAgent.enabled ? 'ON' : 'OFF'}
              </span>
              <Link className="btn" to={`/agents/${personalAgent.id}`}>
                Default settings
              </Link>
              <AgentToggle agent={personalAgent} />
            </div>
          )}
        </div>
        <p className="muted" style={{ fontSize: 13 }}>
          Messages arriving in a connected person's own Telegram chats are answered on their
          behalf. A new account appears here automatically the moment its owner connects the bot —
          automation stays <strong>OFF</strong> until you enable it below. The default agent switch
          above must also be ON for any personal account to answer.
        </p>

        <details style={{ margin: '10px 0' }}>
          <summary style={{ cursor: 'pointer' }}>
            ➕ How to add a user (connect their personal account)
          </summary>
          <ol style={{ lineHeight: 1.8, marginTop: 8 }}>
            <li>
              One-time, for the bot: in Telegram open <span className="mono">@BotFather</span> →{' '}
              <span className="mono">/mybots</span> → {botUsername ? `@${botUsername}` : 'your bot'}{' '}
              → Bot Settings → <strong>Business Mode → Turn on</strong>.
            </li>
            <li>
              On the user's phone (their own Telegram account): <strong>Settings → Chat
              Automation</strong> (on Premium/Business accounts: Settings → Telegram Business →
              Chatbots) → select {botUsername ? `@${botUsername}` : 'the bot'}.
            </li>
            <li>
              They choose which chats to share (e.g. exclude contacts) and grant{' '}
              <strong>“Reply to messages”</strong>.
            </li>
            <li>The account appears in the list below — configure it and switch automation ON.</li>
          </ol>
        </details>

        {accounts.data?.accounts.length === 0 && (
          <p className="muted">No personal accounts connected yet.</p>
        )}
        {accounts.data?.accounts.map((acc) => (
          <PersonalAccountCard
            key={acc.id}
            account={acc}
            isAdmin={isAdmin}
            knowledgeBases={kbs.data?.knowledgeBases ?? []}
            onChanged={refreshAccounts}
          />
        ))}
      </div>
    </>
  );
}

function PersonalAccountCard({
  account,
  isAdmin,
  knowledgeBases,
  onChanged,
}: {
  account: TelegramPersonalAccount;
  isAdmin: boolean;
  knowledgeBases: KnowledgeBase[];
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [displayName, setDisplayName] = useState(account.displayName);
  const [instructions, setInstructions] = useState(account.instructions ?? '');
  const [kbId, setKbId] = useState(account.knowledgeBaseId ?? '');
  const [error, setError] = useState('');

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.patch(`/api/telegram-personal-accounts/${account.id}`, body),
    onSuccess: () => {
      setError('');
      onChanged();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Update failed'),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/api/telegram-personal-accounts/${account.id}`),
    onSuccess: onChanged,
  });

  const owner = account.ownerUsername ? `@${account.ownerUsername}` : account.ownerName;
  const telegramSide = !account.isEnabled
    ? { cls: 'bad', text: 'DISCONNECTED BY OWNER' }
    : !account.canReply
      ? { cls: 'warn', text: 'READ-ONLY (no reply permission)' }
      : { cls: 'ok', text: 'CONNECTED' };

  return (
    <div className="card" style={{ background: 'rgba(255,255,255,0.02)' }}>
      <div className="row between">
        <div>
          <strong>{account.displayName || owner}</strong>{' '}
          <span className="muted mono" style={{ fontSize: 12 }}>{owner}</span>{' '}
          <span className={`badge ${telegramSide.cls}`}>{telegramSide.text}</span>{' '}
          <span className={`badge ${account.enabled ? 'ok' : ''}`}>
            {account.enabled ? 'AUTOMATION ON' : 'AUTOMATION OFF'}
          </span>
        </div>
        <div className="row">
          {isAdmin && (
            <button
              className={`toggle ${account.enabled ? 'on' : ''}`}
              title={account.enabled ? 'Turn automation OFF' : 'Turn automation ON'}
              onClick={() => patch.mutate({ enabled: !account.enabled })}
              disabled={patch.isPending}
              aria-label={`${owner} automation ${account.enabled ? 'on' : 'off'}`}
            >
              <span className="knob" />
            </button>
          )}
          <button className="small" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Close' : 'Settings'}
          </button>
        </div>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        Connected {new Date(account.connectedAt).toLocaleString()} · Knowledge:{' '}
        {account.knowledgeBase?.name ?? 'default agent’s'} · Instructions:{' '}
        {account.instructions?.trim() ? 'custom' : 'default agent’s'}
      </div>

      {expanded && isAdmin && (
        <div style={{ marginTop: 12 }}>
          <div className="grid cols-2">
            <label className="field">
              <span className="name">Display name (for the CRM and this list)</span>
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </label>
            <label className="field">
              <span className="name">Knowledge base</span>
              <select value={kbId} onChange={(e) => setKbId(e.target.value)}>
                <option value="">Use the default agent's knowledge base</option>
                {knowledgeBases.map((kb) => (
                  <option key={kb.id} value={kb.id}>{kb.name}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="field">
            <span className="name">
              Instructions for THIS account (empty = use the default agent's instructions)
            </span>
            <textarea
              style={{ minHeight: 160 }}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="e.g. Siz Alisher akaning yordamchisisiz. Faqat avtomaktab mavzusidagi xabarlarga javob bering…"
            />
          </label>
          {error && <div className="error-text">{error}</div>}
          <div className="row">
            <button
              className="primary"
              disabled={patch.isPending}
              onClick={() =>
                patch.mutate({
                  displayName,
                  instructions: instructions.trim() ? instructions : null,
                  knowledgeBaseId: kbId || null,
                })
              }
            >
              {patch.isPending ? 'Saving…' : 'Save account settings'}
            </button>
            <button
              className="small danger"
              onClick={() => {
                if (
                  confirm(
                    `Remove ${owner} from the platform? They should also disconnect the bot in Telegram (Settings → Chat Automation).`,
                  )
                ) {
                  remove.mutate();
                }
              }}
            >
              Remove
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
