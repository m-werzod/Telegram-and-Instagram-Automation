import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Send,
  Users,
  Settings2,
  Trash2,
  ChevronDown,
  Info,
  Palette,
  ImageIcon,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import {
  api,
  ApiError,
  type Agent,
  type Connection,
  type KnowledgeBase,
  type MediaAsset,
  type TelegramBotProfile,
  type TelegramPersonalAccount,
} from '../api';
import { AgentToggle } from './Agents';
import { HealthBadge } from './Connections';
import IconChip from '../components/IconChip';
import QueryError from '../components/QueryError';

/**
 * Telegram boshqaruv markazi: bot (o'z agenti + sozlamalari) va bot orqali
 * ulangan har bir SHAXSIY Telegram akkaunt — har biri o'z yoqish/o'chirish
 * tugmasi, ko'rsatmalari va bilimlar bazasi bilan.
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

  const telegram = connections.data?.connections?.find((c) => c.channel === 'TELEGRAM');
  const botAgent = agents.data?.agents?.find((a) => a.type === 'TELEGRAM');
  const personalAgent = agents.data?.agents?.find((a) => a.type === 'TELEGRAM_PERSONAL');
  const botUsername = (telegram?.metadata as { botUsername?: string } | undefined)?.botUsername;
  const refreshAccounts = () => qc.invalidateQueries({ queryKey: ['tg-personal'] });

  return (
    <>
      <div className="page-head">
        <IconChip icon={Send} tone="cyan" size={42} />
        <div>
          <h1 className="page-title">Telegram</h1>
          <p className="page-sub">
            Bot o'z suhbatlariga 24/7 javob beradi; Telegram Business orqali ulangan shaxsiy akkauntlar
            alohida-alohida, o'z ko'rsatmalari va bilimlar bazasi bilan boshqariladi.
          </p>
        </div>
      </div>

      <QueryError
        error={connections.error ?? agents.error ?? accounts.error}
        onRetry={() => {
          connections.refetch();
          agents.refetch();
          accounts.refetch();
        }}
      />

      {/* ── Bot kartasi ──────────────────────────────────────────────────── */}
      <div className="card">
        <div className="row between">
          <h3 style={{ margin: 0 }}>
            <IconChip icon={Send} tone="cyan" size={26} />
            Telegram bot {botUsername ? `· @${botUsername}` : ''}
          </h3>
          {telegram && telegram.status === 'connected' ? (
            <HealthBadge status={telegram.healthStatus} />
          ) : (
            <span className="badge bad">ULANMAGAN</span>
          )}
        </div>
        {telegram?.healthDetail && <p className="muted">{telegram.healthDetail}</p>}
        {!telegram || telegram.status !== 'connected' ? (
          <p className="muted">
            Botni <Link to="/connections">Ulanishlar</Link> sahifasida ulang (@BotFather'dan olingan tokenni joylashtiring).
          </p>
        ) : botAgent ? (
          <div className="row between" style={{ marginTop: 8 }}>
            <div>
              <strong>{botAgent.name}</strong>{' '}
              <span className={`badge ${botAgent.enabled ? 'ok' : ''}`}>
                {botAgent.enabled ? 'YOQILGAN' : "O'CHIRILGAN"}
              </span>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                Model: {botAgent.model} · Til: {botAgent.language} · Bilim bazasi: {botAgent.knowledgeBase?.name ?? "yo'q"}
              </div>
            </div>
            <div className="row">
              <Link className="btn" to={`/agents/${botAgent.id}`}>
                <Settings2 size={15} /> Bot sozlamalari
              </Link>
              <AgentToggle agent={botAgent} />
            </div>
          </div>
        ) : null}
      </div>

      {telegram?.status === 'connected' && (
        <BotBrandingCard isAdmin={isAdmin} botAgent={botAgent} botUsername={botUsername} />
      )}

      {/* ── Shaxsiy akkauntlar ───────────────────────────────────────────── */}
      <div className="card">
        <div className="row between">
          <h3 style={{ margin: 0 }}><IconChip icon={Users} tone="violet" size={26} /> Shaxsiy akkauntlar (Telegram Business)</h3>
          {personalAgent && (
            <div className="row">
              <span className="muted" style={{ fontSize: 12 }}>
                Asosiy agent: {personalAgent.enabled ? 'YOQILGAN' : "O'CHIRILGAN"}
              </span>
              <Link className="btn" to={`/agents/${personalAgent.id}`}>Sozlamalar</Link>
              <AgentToggle agent={personalAgent} />
            </div>
          )}
        </div>
        <p className="muted" style={{ fontSize: 13 }}>
          Ulangan shaxsning o'z Telegram suhbatlariga uning nomidan javob beriladi. Bot ularga ulangan
          zahoti yangi akkaunt shu yerda avtomatik paydo bo'ladi — pastda yoqilmaguncha avtomatlashtirish{' '}
          <strong>O'CHIRILGAN</strong> bo'lib turadi. Yuqoridagi asosiy agent tugmasi ham YOQILGAN bo'lishi shart.
        </p>

        <details style={{ margin: '10px 0' }}>
          <summary className="row" style={{ cursor: 'pointer', gap: 6 }}>
            <Info size={15} /> Foydalanuvchi qanday qo'shiladi (shaxsiy akkauntni ulash)
          </summary>
          <ol className="steps">
            <li>
              Bot uchun bir martalik sozlash: Telegramda <span className="mono">@BotFather</span> →{' '}
              <span className="mono">/mybots</span> → {botUsername ? `@${botUsername}` : 'bot'} →
              Bot Settings → <strong>Business Mode → Turn on</strong>.
            </li>
            <li>
              Foydalanuvchining telefonida (o'z Telegram akkaunti): <strong>Sozlamalar → Chat avtomatlashtirish</strong>{' '}
              (Premium/Business akkauntlarda: Sozlamalar → Telegram Business → Chatbotlar) →{' '}
              {botUsername ? `@${botUsername}` : 'bot'}ni tanlang.
            </li>
            <li>Qaysi suhbatlarni ulashishni tanlaydi va <strong>"Xabarlarga javob berish"</strong> ruxsatini beradi.</li>
            <li>Akkaunt quyidagi ro'yxatda paydo bo'ladi — sozlang va avtomatlashtirishni yoqing.</li>
          </ol>
        </details>

        {accounts.data?.accounts?.length === 0 && (
          <p className="muted">Hali hech qanday shaxsiy akkaunt ulanmagan.</p>
        )}
        {accounts.data?.accounts?.map((acc) => (
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

/** `start - Tavsif` lines → the Bot API command list. */
function parseCommands(text: string): Array<{ command: string; description: string }> {
  const out: Array<{ command: string; description: string }> = [];
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^\/?([A-Za-z0-9_]{1,32})\s*[-—:]\s*(.+)$/);
    if (m?.[1] && m[2]) out.push({ command: m[1].toLowerCase(), description: m[2].trim() });
  }
  return out;
}

const FIELD_LABEL: Record<string, string> = {
  name: 'Bot nomi',
  shortDescription: 'Qisqa tavsif',
  description: 'Tavsif',
  commands: 'Buyruqlar',
};

/**
 * Bot branding. Name, both description texts and the command menu are pushed
 * to Telegram from here, so the bot's presentation is owned by the platform
 * instead of being typed into @BotFather. The avatar is the one thing the Bot
 * API cannot set — that stays a @BotFather step.
 */
function BotBrandingCard({
  isAdmin,
  botAgent,
  botUsername,
}: {
  isAdmin: boolean;
  botAgent?: Agent;
  botUsername?: string;
}) {
  const qc = useQueryClient();
  const profileQuery = useQuery({
    queryKey: ['tg-bot-profile'],
    queryFn: () =>
      api.get<{ profile: TelegramBotProfile; defaults: TelegramBotProfile }>(
        '/api/connections/telegram/profile',
      ),
  });
  const media = useQuery({
    queryKey: ['media'],
    queryFn: () => api.get<{ assets: MediaAsset[] }>('/api/media'),
  });

  const [form, setForm] = useState<TelegramBotProfile | null>(null);
  const [commandsText, setCommandsText] = useState('');
  const [error, setError] = useState('');
  const [results, setResults] = useState<Array<{ field: string; ok: boolean; error?: string }>>([]);

  useEffect(() => {
    const p = profileQuery.data?.profile;
    if (p && !form) {
      setForm(p);
      setCommandsText(p.commands.map((c) => `${c.command} - ${c.description}`).join('\n'));
    }
  }, [profileQuery.data, form]);

  const save = useMutation({
    mutationFn: () =>
      api.put<{ profile: TelegramBotProfile; results: Array<{ field: string; ok: boolean; error?: string }> }>(
        '/api/connections/telegram/profile',
        { ...form, commands: parseCommands(commandsText) },
      ),
    onSuccess: (data) => {
      setError('');
      setResults(data.results);
      qc.invalidateQueries({ queryKey: ['tg-bot-profile'] });
      qc.invalidateQueries({ queryKey: ['connections'] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Saqlab bo'lmadi"),
  });

  const agentSettings = (botAgent?.settings ?? {}) as Record<string, unknown>;
  const welcomeImageId = (agentSettings.welcomeImageMediaId as string | null) ?? '';
  const setWelcomeImage = useMutation({
    mutationFn: (mediaId: string) =>
      api.patch(`/api/agents/${botAgent?.id}`, {
        settings: { ...agentSettings, welcomeImageMediaId: mediaId || null },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agents'] }),
  });

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>
        <IconChip icon={Palette} tone="pink" size={26} /> Bot brendingi
      </h3>
      <p className="muted" style={{ fontSize: 13 }}>
        Bu yerdagi matnlar to'g'ridan-to'g'ri Telegram'ga yoziladi — bot nomi, tavsiflari va buyruqlar
        menyusi platformadan boshqariladi, @BotFather'ga kirish shart emas.
      </p>

      <QueryError error={profileQuery.error} onRetry={() => profileQuery.refetch()} />

      {form && (
        <>
          <div className="grid cols-2">
            <label className="field">
              <span className="name">Bot nomi (≤64 belgi)</span>
              <input
                value={form.name}
                maxLength={64}
                disabled={!isAdmin}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
              <span className="hint">Suhbat tepasida ko'rinadigan nom. Telegram nomni soatiga 2 martadan ko'p o'zgartirishga ruxsat bermaydi.</span>
            </label>
            <label className="field">
              <span className="name">Qisqa tavsif (≤120 belgi)</span>
              <input
                value={form.shortDescription}
                maxLength={120}
                disabled={!isAdmin}
                onChange={(e) => setForm({ ...form, shortDescription: e.target.value })}
              />
              <span className="hint">Bot profilida, nom ostida ko'rinadi.</span>
            </label>
          </div>

          <label className="field">
            <span className="name">Tavsif (≤512 belgi) — bo'sh suhbat ekranida ko'rinadi</span>
            <textarea
              rows={3}
              value={form.description}
              maxLength={512}
              disabled={!isAdmin}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </label>

          <label className="field">
            <span className="name">Buyruqlar menyusi — har bir qatorda bitta: <span className="mono">start - Tavsif</span></span>
            <textarea
              rows={3}
              value={commandsText}
              disabled={!isAdmin}
              onChange={(e) => setCommandsText(e.target.value)}
            />
            <span className="hint">Telegram'dagi "/" tugmasi ostidagi ro'yxat. Faqat kichik harflar, raqamlar va pastki chiziq.</span>
          </label>

          {error && <div className="error-text">{error}</div>}
          {results.length > 0 && (
            <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              {results.map((r) => (
                <span key={r.field} className={`badge ${r.ok ? 'ok' : 'bad'}`} title={r.error ?? ''}>
                  {r.ok ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}{' '}
                  {FIELD_LABEL[r.field] ?? r.field}
                  {r.ok ? '' : ` — ${r.error ?? 'xatolik'}`}
                </span>
              ))}
            </div>
          )}

          {isAdmin && (
            <button className="primary" onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? 'Yuborilmoqda…' : "Telegram'ga saqlash"}
            </button>
          )}
        </>
      )}

      <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '18px 0 14px' }} />

      <label className="field">
        <span className="name">Salomlashuv rasmi — mijoz /start bosganda yuboriladi</span>
        <select
          value={welcomeImageId}
          disabled={!isAdmin || !botAgent || setWelcomeImage.isPending}
          onChange={(e) => setWelcomeImage.mutate(e.target.value)}
        >
          <option value="">Rasm yuborilmasin</option>
          {media.data?.assets?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <span className="hint">
          Logotipni <Link to="/media">Media · Rasmlar</Link> bo'limiga yuklang, so'ng shu yerda tanlang.
          {!botAgent && " Avval Telegram agenti yaratilishi kerak."}
        </span>
      </label>

      <details>
        <summary className="row" style={{ cursor: 'pointer', gap: 6 }}>
          <ImageIcon size={15} /> Bot avatarini (profil rasmini) qo'yish
        </summary>
        <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
          Telegram Bot API botga o'z avatarini o'zgartirishga ruxsat bermaydi — buni faqat @BotFather
          qiladi. Bir marta bajariladi:
        </p>
        <ol className="steps">
          <li>Telegramda <span className="mono">@BotFather</span> → <span className="mono">/mybots</span> → {botUsername ? `@${botUsername}` : 'botingiz'}.</li>
          <li><strong>Edit Bot → Edit Botpic</strong>.</li>
          <li>Logotipni <strong>rasm (photo)</strong> sifatida yuboring — kvadrat, kamida 512×512 px.</li>
        </ol>
        <p className="muted" style={{ fontSize: 13 }}>
          Logotipning platformadagi nusxasi (1024×1024 PNG):{' '}
          <a href="/logo.png" target="_blank" rel="noreferrer">/logo.png</a>
        </p>
      </details>
    </div>
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
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Yangilashda xatolik'),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/api/telegram-personal-accounts/${account.id}`),
    onSuccess: onChanged,
  });

  const owner = account.ownerUsername ? `@${account.ownerUsername}` : account.ownerName;
  const telegramSide = !account.isEnabled
    ? { cls: 'bad', text: 'EGASI TOMONIDAN UZILGAN' }
    : !account.canReply
      ? { cls: 'warn', text: "FAQAT O'QISH (javob ruxsati yo'q)" }
      : { cls: 'ok', text: 'ULANGAN' };

  return (
    <div className="card" style={{ background: 'rgba(79,107,237,0.025)' }}>
      <div className="row between">
        <div>
          <strong>{account.displayName || owner}</strong>{' '}
          <span className="muted mono" style={{ fontSize: 12 }}>{owner}</span>{' '}
          <span className={`badge ${telegramSide.cls}`}>{telegramSide.text}</span>{' '}
          <span className={`badge ${account.enabled ? 'ok' : ''}`}>
            {account.enabled ? 'AVTOMATLASHTIRISH YOQILGAN' : "AVTOMATLASHTIRISH O'CHIRILGAN"}
          </span>
        </div>
        <div className="row">
          {isAdmin && (
            <button
              className={`toggle ${account.enabled ? 'on' : ''}`}
              title={account.enabled ? "O'chirish" : 'Yoqish'}
              onClick={() => patch.mutate({ enabled: !account.enabled })}
              disabled={patch.isPending}
              aria-label={`${owner} avtomatlashtirish ${account.enabled ? 'yoqilgan' : "o'chirilgan"}`}
            >
              <span className="knob" />
            </button>
          )}
          <button className="small" onClick={() => setExpanded((v) => !v)}>
            <ChevronDown size={14} style={{ transform: expanded ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s' }} />
            {expanded ? 'Yopish' : 'Sozlamalar'}
          </button>
        </div>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        Ulangan: {new Date(account.connectedAt).toLocaleString('uz-UZ')} · Bilim bazasi:{' '}
        {account.knowledgeBase?.name ?? "asosiy agentniki"} · Ko'rsatmalar:{' '}
        {account.instructions?.trim() ? 'maxsus' : 'asosiy agentniki'}
      </div>

      {expanded && isAdmin && (
        <div style={{ marginTop: 12 }}>
          <div className="grid cols-2">
            <label className="field">
              <span className="name">Ko'rinadigan nom (CRM va ro'yxat uchun)</span>
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </label>
            <label className="field">
              <span className="name">Bilimlar bazasi</span>
              <select value={kbId} onChange={(e) => setKbId(e.target.value)}>
                <option value="">Asosiy agentning bilim bazasidan foydalanish</option>
                {knowledgeBases.map((kb) => (
                  <option key={kb.id} value={kb.id}>{kb.name}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="field">
            <span className="name">
              Shu akkaunt uchun ko'rsatmalar (bo'sh = asosiy agent ko'rsatmalari ishlatiladi)
            </span>
            <textarea
              style={{ minHeight: 160 }}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="masalan: Siz Alisher akaning yordamchisisiz. Faqat avtomaktab mavzusidagi xabarlarga javob bering…"
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
              {patch.isPending ? 'Saqlanmoqda…' : 'Akkaunt sozlamalarini saqlash'}
            </button>
            <button
              className="small danger"
              onClick={() => {
                if (
                  confirm(
                    `${owner}ni platformadan olib tashlaysizmi? Ular Telegramda botni ham uzishlari kerak (Sozlamalar → Chat avtomatlashtirish).`,
                  )
                ) {
                  remove.mutate();
                }
              }}
            >
              <Trash2 size={14} /> Olib tashlash
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
