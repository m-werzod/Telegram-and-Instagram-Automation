import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Settings as SettingsIcon, KeyRound, Globe2, Wand2, Trash2, Save, ShieldCheck } from 'lucide-react';
import {
  api,
  ApiError,
  type AIKeyVerification,
  type SettingsResponse,
  type SettingStatus,
} from '../api';
import IconChip from '../components/IconChip';

const SETTING_META: Record<string, { label: string; hint: string; placeholder: string }> = {
  ANTHROPIC_API_KEY: {
    label: 'Anthropic API kaliti (Claude)',
    hint: "Claude modellaridagi agentlar uchun. Uni https://platform.claude.com → API keys sahifasidan oling. Shu yerga joylashtiring — agentlar darhol javob bera boshlaydi, qayta ishga tushirish shart emas.",
    placeholder: 'sk-ant-…',
  },
  OPENAI_API_KEY: {
    label: 'OpenAI API kaliti (ChatGPT)',
    hint: "GPT modellaridagi agentlar uchun. Uni https://platform.openai.com/api-keys sahifasidan oling. Agent sahifasida gpt-5 modelini tanlasangiz, shu kalit ishlatiladi. Bilimlar bazasining semantik qidiruvini ham yoqadi.",
    placeholder: 'sk-…',
  },
  META_APP_ID: {
    label: 'Meta App ID',
    hint: 'https://developers.facebook.com/apps → ilovangiz → App settings → Basic sahifasidan.',
    placeholder: '1234567890…',
  },
  META_APP_SECRET: {
    label: 'Meta App secret',
    hint: 'App ID bilan bir xil sahifada. Instagram webhook imzosini tekshirish uchun ishlatiladi.',
    placeholder: 'abc123…',
  },
  META_IG_APP_SECRET: {
    label: 'Instagram App secret (Instagram Login)',
    hint: "Meta ilovangizda Instagram Login ishlatilsa, u ALOHIDA sirga ega. Uni https://developers.facebook.com/apps → Use cases → \"Manage messaging & content on Instagram\" → Customize → \"API setup with Instagram login\" → \"Instagram app secret\" → Show orqali oling. Instagram webhook imzolari shu sir bilan imzolanishi mumkin — ikkalasi ham tekshiriladi, shuning uchun uni kiritish xavfsiz.",
    placeholder: '••••••••',
  },
  META_VERIFY_TOKEN: {
    label: 'Meta webhook verify token',
    hint: "O'zingiz tanlagan istalgan tasodifiy matn. Xuddi shu qiymatni Meta App Dashboard webhook sozlamalariga kiriting.",
    placeholder: 'my-verify-token-…',
  },
};

function SourceBadge({ source }: { source: SettingStatus['source'] }) {
  if (source === 'platform') return <span className="badge ok">O'RNATILGAN (dashboard)</span>;
  if (source === 'env') return <span className="badge accent">O'RNATILGAN (server)</span>;
  return <span className="badge bad">O'RNATILMAGAN</span>;
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
      <div className="page-head">
        <IconChip icon={SettingsIcon} tone="slate" size={42} />
        <div>
          <h1 className="page-title">Sozlamalar</h1>
          <p className="page-sub">
            Kalitlar shifrlangan holda saqlanadi, qayta ko'rsatilmaydi va darhol kuchga kiradi.
            Dashboard'dagi qiymat server muhit o'zgaruvchilaridan ustun turadi.
          </p>
        </div>
      </div>

      {query.data?.settings?.map((s) => (
        <SettingCard key={s.key} setting={s} onChanged={() => qc.invalidateQueries({ queryKey: ['settings'] })} />
      ))}

      <div className="card">
        <h3><IconChip icon={Globe2} tone="blue" size={26} /> Webhook va platforma manzillari</h3>
        {urls?.appUrl ? (
          <div className="table-scroll">
            <table className="table">
              <tbody>
                <tr>
                  <td className="muted">Platforma manzili</td>
                  <td className="mono">{urls.appUrl}</td>
                </tr>
                <tr>
                  <td className="muted">Instagram webhook manzili</td>
                  <td className="mono">{urls.instagramWebhook}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">
            Server tomonida APP_URL sozlanmagan — webhook manzillarini ko'rsatib bo'lmaydi.
          </p>
        )}
        <p className="muted" style={{ fontSize: 12 }}>
          Callback manzili va verify token'ni Meta App Dashboard'da ishlating (Instagram → Configure
          webhooks → <span className="mono">comments</span> va <span className="mono">messages</span>ga obuna bo'ling).
          Aniq qadamlar "Qo'lda bajariladigan ishlar" bo'limida.
        </p>
      </div>
    </>
  );
}

function SettingCard({ setting, onChanged }: { setting: SettingStatus; onChanged: () => void }) {
  const meta = SETTING_META[setting.key] ?? { label: setting.key, hint: '', placeholder: '' };
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const isAIKey = setting.key === 'ANTHROPIC_API_KEY' || setting.key === 'OPENAI_API_KEY';
  const [verification, setVerification] = useState<AIKeyVerification | null>(null);

  const verify = useMutation({
    mutationFn: () =>
      api.post<{ verification: AIKeyVerification }>(`/api/settings/${setting.key}/verify`),
    onSuccess: (res) => {
      setError('');
      setNotice('');
      setVerification(res.verification);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Tekshirib bolmadi'),
  });

  const save = useMutation({
    mutationFn: () =>
      api.put<{ warning?: string; notice?: string }>(`/api/settings/${setting.key}`, { value }),
    onSuccess: (res) => {
      setValue('');
      setError('');
      // `notice` means the key belonged to the OTHER provider and was filed
      // there instead — the operator has to be told, or the Settings page will
      // seem to have swallowed what they just pasted. Otherwise: no warning
      // means the server round-tripped the key to the provider and it was
      // accepted, so say that rather than a bare "saved".
      setNotice(
        [res?.notice, res?.warning].filter(Boolean).join(' ') ||
          (isAIKey ? 'Kalit tekshirildi va saqlandi — agentlar ishlashga tayyor.' : ''),
      );
      setVerification(null);
      onChanged();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Saqlab bo\'lmadi'),
  });
  const clear = useMutation({
    mutationFn: () => api.delete(`/api/settings/${setting.key}`),
    onSuccess: onChanged,
  });

  return (
    <div className="card">
      <div className="row between">
        <h3 style={{ margin: 0 }}><IconChip icon={KeyRound} tone="amber" size={26} /> {meta.label}</h3>
        <SourceBadge source={setting.source} />
      </div>
      {setting.maskedValue && (
        <p className="muted mono" style={{ margin: '8px 0 0' }}>Hozirgi: {setting.maskedValue}</p>
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
              <Wand2 size={13} /> Yaratish
            </button>
          )}
        </div>
        <span className="hint">{meta.hint}</span>
      </label>
      {error && <div className="error-text">{error}</div>}
      {notice && <p className="muted" style={{ margin: '6px 0 0' }}>{notice}</p>}
      {verification && <VerificationResult verification={verification} />}
      <div className="row">
        <button
          className="primary"
          disabled={!value.trim() || save.isPending}
          onClick={() => save.mutate()}
        >
          <Save size={15} />
          {save.isPending ? 'Saqlanmoqda…' : 'Saqlash'}
        </button>
        {isAIKey && setting.source !== 'unset' && (
          <button className="small" disabled={verify.isPending} onClick={() => verify.mutate()}>
            <ShieldCheck size={13} />
            {verify.isPending ? 'Tekshirilmoqda…' : 'Tekshirish'}
          </button>
        )}
        {setting.source === 'platform' && (
          <button
            className="small danger"
            disabled={clear.isPending}
            onClick={() => {
              if (confirm("Dashboard qiymatini o'chirasizmi? Server muhit qiymati (agar bo'lsa) qo'llaniladi.")) {
                clear.mutate();
              }
            }}
          >
            <Trash2 size={13} /> O'chirish
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The AI key's real state as Anthropic reports it. "O'RNATILGAN" alone was the
 * trap this answers: a key can be stored and still be refused on every single
 * agent run, which looks identical to "the agents are broken".
 */
function VerificationResult({ verification }: { verification: AIKeyVerification }) {
  const label = verification.provider === 'openai' ? 'OpenAI' : 'Anthropic';
  const console_ =
    verification.provider === 'openai'
      ? 'platform.openai.com/api-keys'
      : 'platform.claude.com → Settings → API keys';
  const prefix = verification.provider === 'openai' ? 'sk-…' : 'sk-ant-…';
  if (verification.status === 'valid') {
    return (
      <p className="muted" style={{ margin: '6px 0 0' }}>
        <span className="badge ok">ISHLAYDI</span> {label} kalitni qabul qildi — agentlar javob
        bera oladi.
      </p>
    );
  }
  if (verification.status === 'missing') {
    return (
      <p className="muted" style={{ margin: '6px 0 0' }}>
        <span className="badge bad">YO'Q</span> Kalit o'rnatilmagan — hech bir agent javob bera
        olmaydi.
      </p>
    );
  }
  if (verification.status === 'rejected') {
    return (
      <div className="error-text">
        {label} kalitni rad etdi ({verification.detail}). Shu sababli bu provayderdagi agentlar
        javob bermaydi. {console_} sahifasida yangi kalit (
        <span className="mono">{prefix}</span>) yarating va shu yerga joylashtiring.
      </div>
    );
  }
  return (
    <p className="muted" style={{ margin: '6px 0 0' }}>
      Hozir tekshirib bo'lmadi ({verification.detail}) — bu kalit yaroqsiz degani emas, keyinroq
      qayta urinib ko'ring.
    </p>
  );
}
