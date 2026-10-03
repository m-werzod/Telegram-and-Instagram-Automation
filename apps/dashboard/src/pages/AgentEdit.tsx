import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, type Agent, type KnowledgeBase, type MediaAsset } from '../api';

interface Settings {
  bannedPhrases: string[];
  maxRepliesPerHour: number;
  pauseOnEscalation: boolean;
  publicReplyOnPrivate: boolean;
  skipTrivialComments: boolean;
  welcomeImageMediaId: string | null;
}

const DEFAULT_SETTINGS: Settings = {
  bannedPhrases: [],
  maxRepliesPerHour: 20,
  pauseOnEscalation: true,
  publicReplyOnPrivate: true,
  skipTrivialComments: true,
  welcomeImageMediaId: null,
};

export default function AgentEdit() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const agentQuery = useQuery({
    queryKey: ['agent', id],
    queryFn: () => api.get<{ agent: Agent }>(`/api/agents/${id}`),
    enabled: !!id,
  });
  const kbQuery = useQuery({
    queryKey: ['knowledge-bases'],
    queryFn: () => api.get<{ knowledgeBases: KnowledgeBase[] }>('/api/knowledge-bases'),
  });
  const mediaQuery = useQuery({
    queryKey: ['media'],
    queryFn: () => api.get<{ assets: MediaAsset[] }>('/api/media'),
  });

  const [form, setForm] = useState<Partial<Agent> | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const a = agentQuery.data?.agent;
    if (a && !form) {
      setForm(a);
      setSettings({ ...DEFAULT_SETTINGS, ...(a.settings as Partial<Settings>) });
    }
  }, [agentQuery.data, form]);

  const save = useMutation({
    mutationFn: () =>
      api.patch<{ agent: Agent }>(`/api/agents/${id}`, {
        name: form?.name,
        systemInstructions: form?.systemInstructions,
        businessObjective: form?.businessObjective,
        tone: form?.tone,
        language: form?.language,
        model: form?.model,
        knowledgeBaseId: form?.knowledgeBaseId ?? null,
        settings,
      }),
    onSuccess: () => {
      setSaved(true);
      setError('');
      setTimeout(() => setSaved(false), 2500);
      qc.invalidateQueries({ queryKey: ['agents'] });
      qc.invalidateQueries({ queryKey: ['agent', id] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Save failed'),
  });

  if (!form) return <p className="muted">Loading…</p>;
  const set = (patch: Partial<Agent>) => setForm({ ...form, ...patch });

  return (
    <>
      <p><Link to="/agents">← Agents</Link></p>
      <h1 className="page-title">{form.name}</h1>
      <p className="page-sub">
        Instructions and objectives are stored in the database and applied on the next message —
        no code changes or restarts required.
      </p>

      <div className="card">
        <div className="grid cols-2">
          <label className="field">
            <span className="name">Agent name</span>
            <input value={form.name ?? ''} onChange={(e) => set({ name: e.target.value })} />
          </label>
          <label className="field">
            <span className="name">AI model</span>
            <select value={form.model} onChange={(e) => set({ model: e.target.value })}>
              <option value="claude-opus-5">claude-opus-5 (recommended)</option>
              <option value="claude-sonnet-5">claude-sonnet-5</option>
              <option value="claude-haiku-4-5">claude-haiku-4-5</option>
            </select>
          </label>
          <label className="field">
            <span className="name">Tone</span>
            <input value={form.tone ?? ''} onChange={(e) => set({ tone: e.target.value })} />
            <span className="hint">e.g. "friendly, professional", "casual and playful"</span>
          </label>
          <label className="field">
            <span className="name">Language</span>
            <select value={form.language} onChange={(e) => set({ language: e.target.value })}>
              <option value="auto">Auto-detect (respond in the user's language)</option>
              <option value="uz">Uzbek</option>
              <option value="ru">Russian</option>
              <option value="en">English</option>
            </select>
          </label>
          <label className="field">
            <span className="name">Knowledge base</span>
            <select
              value={form.knowledgeBaseId ?? ''}
              onChange={(e) => set({ knowledgeBaseId: e.target.value || null })}
            >
              <option value="">None</option>
              {kbQuery.data?.knowledgeBases.map((kb) => (
                <option key={kb.id} value={kb.id}>{kb.name}</option>
              ))}
            </select>
          </label>
        </div>

        <label className="field">
          <span className="name">Business objective</span>
          <input
            value={form.businessObjective ?? ''}
            onChange={(e) => set({ businessObjective: e.target.value })}
          />
          <span className="hint">What this agent is trying to achieve (qualify leads, book appointments, support…)</span>
        </label>

        <label className="field">
          <span className="name">System instructions</span>
          <textarea
            style={{ minHeight: 220 }}
            value={form.systemInstructions ?? ''}
            onChange={(e) => set({ systemInstructions: e.target.value })}
          />
          <span className="hint">
            Brand identity, allowed/prohibited responses, qualification questions, escalation rules.
            Platform security rules are always applied on top of these.
          </span>
        </label>
      </div>

      <div className="card">
        <h3>Guardrails & escalation</h3>
        <div className="grid cols-2">
          <label className="field">
            <span className="name">Max autonomous replies per conversation per hour</span>
            <input
              type="number" min={1} max={200}
              value={settings.maxRepliesPerHour}
              onChange={(e) => setSettings({ ...settings, maxRepliesPerHour: Number(e.target.value) || 20 })}
            />
          </label>
          <label className="field">
            <span className="name">Banned phrases (one per line — replies containing them are blocked & escalated)</span>
            <textarea
              value={settings.bannedPhrases.join('\n')}
              onChange={(e) =>
                setSettings({ ...settings, bannedPhrases: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })
              }
            />
          </label>
        </div>
        <div className="row" style={{ gap: 24 }}>
          <label className="row" style={{ gap: 6 }}>
            <input
              type="checkbox" style={{ width: 'auto' }}
              checked={settings.pauseOnEscalation}
              onChange={(e) => setSettings({ ...settings, pauseOnEscalation: e.target.checked })}
            />
            Pause agent in a conversation after escalation
          </label>
          {form.type === 'INSTAGRAM_COMMENT' && (
            <label className="row" style={{ gap: 6 }}>
              <input
                type="checkbox" style={{ width: 'auto' }}
                checked={settings.publicReplyOnPrivate}
                onChange={(e) => setSettings({ ...settings, publicReplyOnPrivate: e.target.checked })}
              />
              Also reply publicly when a DM (private reply) is sent
            </label>
          )}
        </div>
      </div>

      {form.type === 'TELEGRAM' && (
        <div className="card">
          <h3>Welcome image (/start)</h3>
          <p className="muted" style={{ fontSize: 13 }}>
            Sent as a photo when someone opens the bot with /start — e.g. the school's banner or
            price list. Upload images on the Media page.
          </p>
          <div className="grid cols-2">
            <label className="field">
              <span className="name">Image</span>
              <select
                value={settings.welcomeImageMediaId ?? ''}
                onChange={(e) =>
                  setSettings({ ...settings, welcomeImageMediaId: e.target.value || null })
                }
              >
                <option value="">None</option>
                {mediaQuery.data?.assets.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </label>
            {settings.welcomeImageMediaId && (
              <img
                src={`/files/media/${settings.welcomeImageMediaId}`}
                alt="Welcome"
                style={{ maxHeight: 120, borderRadius: 8, alignSelf: 'end' }}
              />
            )}
          </div>
        </div>
      )}

      {error && <div className="error-text">{error}</div>}
      {saved && <div className="success-text">Saved ✓</div>}
      <button className="primary" onClick={() => save.mutate()} disabled={save.isPending}>
        {save.isPending ? 'Saving…' : 'Save changes'}
      </button>
    </>
  );
}
