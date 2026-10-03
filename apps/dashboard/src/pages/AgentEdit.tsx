import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Settings2, ShieldCheck, ImageIcon, CheckCircle2 } from 'lucide-react';
import { api, ApiError, type Agent, type KnowledgeBase, type MediaAsset } from '../api';
import IconChip from '../components/IconChip';

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
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Saqlab bo\'lmadi'),
  });

  if (!form) return <p className="muted">Yuklanmoqda…</p>;
  const set = (patch: Partial<Agent>) => setForm({ ...form, ...patch });

  return (
    <>
      <p><Link to="/agents"><ArrowLeft size={14} style={{ verticalAlign: -2 }} /> Agentlar</Link></p>
      <div className="page-head">
        <IconChip icon={Settings2} tone="violet" size={42} />
        <div>
          <h1 className="page-title">{form.name}</h1>
          <p className="page-sub">
            Ko'rsatmalar va maqsadlar bazaga saqlanadi va keyingi xabardan boshlab qo'llaniladi —
            kod o'zgartirish yoki qayta ishga tushirish shart emas.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="grid cols-2">
          <label className="field">
            <span className="name">Agent nomi</span>
            <input value={form.name ?? ''} onChange={(e) => set({ name: e.target.value })} />
          </label>
          <label className="field">
            <span className="name">AI modeli</span>
            <select value={form.model} onChange={(e) => set({ model: e.target.value })}>
              <option value="claude-sonnet-5">claude-sonnet-5 (tavsiya etiladi)</option>
              <option value="claude-opus-5">claude-opus-5 (eng kuchli, qimmatroq)</option>
              <option value="claude-haiku-4-5">claude-haiku-4-5 (eng tez va arzon)</option>
            </select>
          </label>
          <label className="field">
            <span className="name">Ohang (uslub)</span>
            <input value={form.tone ?? ''} onChange={(e) => set({ tone: e.target.value })} />
            <span className="hint">masalan: "samimiy, professional", "erkin va quvnoq"</span>
          </label>
          <label className="field">
            <span className="name">Til</span>
            <select value={form.language} onChange={(e) => set({ language: e.target.value })}>
              <option value="auto">Avtomatik aniqlash (foydalanuvchi tilida javob beradi)</option>
              <option value="uz">O'zbek tili</option>
              <option value="ru">Rus tili</option>
              <option value="en">Ingliz tili</option>
            </select>
          </label>
          <label className="field">
            <span className="name">Bilimlar bazasi</span>
            <select
              value={form.knowledgeBaseId ?? ''}
              onChange={(e) => set({ knowledgeBaseId: e.target.value || null })}
            >
              <option value="">Yo'q</option>
              {kbQuery.data?.knowledgeBases?.map((kb) => (
                <option key={kb.id} value={kb.id}>{kb.name}</option>
              ))}
            </select>
          </label>
        </div>

        <label className="field">
          <span className="name">Biznes maqsadi</span>
          <input
            value={form.businessObjective ?? ''}
            onChange={(e) => set({ businessObjective: e.target.value })}
          />
          <span className="hint">Bu agent nimaga erishishga harakat qiladi (mijozlarni jalb qilish, savollarga javob berish…)</span>
        </label>

        <label className="field">
          <span className="name">Tizim ko'rsatmalari</span>
          <textarea
            style={{ minHeight: 220 }}
            value={form.systemInstructions ?? ''}
            onChange={(e) => set({ systemInstructions: e.target.value })}
          />
          <span className="hint">
            Brend ovozi, ruxsat etilgan/taqiqlangan javoblar, malakalashtirish savollari, eskalatsiya qoidalari.
            Platformaning xavfsizlik qoidalari har doim bulardan ustun turadi.
          </span>
        </label>
      </div>

      <div className="card">
        <h3><IconChip icon={ShieldCheck} tone="amber" size={26} /> Himoya va eskalatsiya</h3>
        <div className="grid cols-2">
          <label className="field">
            <span className="name">Soatiga maksimal avtomatik javoblar (har bir suhbat uchun)</span>
            <input
              type="number" min={1} max={200}
              value={settings.maxRepliesPerHour}
              onChange={(e) => setSettings({ ...settings, maxRepliesPerHour: Number(e.target.value) || 20 })}
            />
          </label>
          <label className="field">
            <span className="name">Taqiqlangan so'zlar (har bir qatorda bittadan — bular bo'lsa javob yuborilmaydi)</span>
            <textarea
              value={settings.bannedPhrases.join('\n')}
              onChange={(e) =>
                setSettings({ ...settings, bannedPhrases: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })
              }
            />
          </label>
        </div>
        <div className="row" style={{ gap: 24 }}>
          <label className="row" style={{ gap: 8 }}>
            <input
              type="checkbox" style={{ width: 'auto', minHeight: 'unset' }}
              checked={settings.pauseOnEscalation}
              onChange={(e) => setSettings({ ...settings, pauseOnEscalation: e.target.checked })}
            />
            Eskalatsiyadan keyin agentni shu suhbatda to'xtatish
          </label>
          {form.type === 'INSTAGRAM_COMMENT' && (
            <label className="row" style={{ gap: 8 }}>
              <input
                type="checkbox" style={{ width: 'auto', minHeight: 'unset' }}
                checked={settings.publicReplyOnPrivate}
                onChange={(e) => setSettings({ ...settings, publicReplyOnPrivate: e.target.checked })}
              />
              DM (shaxsiy xabar) yuborilganda ochiq izohda ham javob berish
            </label>
          )}
        </div>
      </div>

      {form.type === 'TELEGRAM' && (
        <div className="card">
          <h3><IconChip icon={ImageIcon} tone="pink" size={26} /> Xush kelibsiz rasmi (/start)</h3>
          <p className="muted" style={{ fontSize: 13 }}>
            Kimdir botni /start bilan ochganda rasm sifatida yuboriladi — masalan maktab bannerini yoki narxlar jadvalini qo'ying.
            Rasmlarni Media sahifasida yuklang.
          </p>
          <div className="grid cols-2">
            <label className="field">
              <span className="name">Rasm</span>
              <select
                value={settings.welcomeImageMediaId ?? ''}
                onChange={(e) =>
                  setSettings({ ...settings, welcomeImageMediaId: e.target.value || null })
                }
              >
                <option value="">Yo'q</option>
                {mediaQuery.data?.assets?.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </label>
            {settings.welcomeImageMediaId && (
              <img
                src={`/files/media/${settings.welcomeImageMediaId}`}
                alt="Xush kelibsiz"
                style={{ maxHeight: 120, borderRadius: 8, alignSelf: 'end' }}
              />
            )}
          </div>
        </div>
      )}

      {error && <div className="error-text">{error}</div>}
      {saved && <div className="success-text"><CheckCircle2 size={15} /> Saqlandi</div>}
      <button className="primary" onClick={() => save.mutate()} disabled={save.isPending}>
        {save.isPending ? 'Saqlanmoqda…' : "O'zgarishlarni saqlash"}
      </button>
    </>
  );
}
