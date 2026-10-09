import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lightbulb, Plus, Trash2, Save } from 'lucide-react';
import { api, ApiError } from '../api';
import IconChip from './IconChip';
import QueryError from './QueryError';

/**
 * "Qo'shimcha AI ko'rsatmalari" — short rules the owner writes themselves.
 *
 * Distinct from the knowledge base above it: a document answers "what is
 * true", these answer "what to DO when X happens". They are injected into
 * every agent's context verbatim rather than retrieved by relevance, which is
 * why the list is deliberately capped and each rule is short.
 */

type AgentType = 'INSTAGRAM_COMMENT' | 'INSTAGRAM_DM' | 'TELEGRAM' | 'TELEGRAM_PERSONAL';

interface Instruction {
  id: string;
  text: string;
  enabled: boolean;
  appliesTo: AgentType | null;
  position: number;
}

const SCOPE_LABEL: Record<string, string> = {
  '': 'Barcha kanallar',
  INSTAGRAM_COMMENT: 'Instagram izohlar',
  INSTAGRAM_DM: 'Instagram Direct',
  TELEGRAM: 'Telegram bot',
  TELEGRAM_PERSONAL: 'Telegram shaxsiy',
};

const EXAMPLES = [
  "Agar mijoz biznes hamkorlik haqida so'rasa, unga mening aloqa ma'lumotlarimni yubor.",
  "Narx so'ralsa, avval xizmat turini aniqlashtir.",
  "Kursga yozilmoqchi bo'lgan mijozdan ism va telefon raqamini so'ra.",
  "Shikoyat bildirgan mijozni operatorga yo'naltir.",
];

export default function OwnerInstructions() {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [scope, setScope] = useState<'' | AgentType>('');
  const [error, setError] = useState('');

  const query = useQuery({
    queryKey: ['owner-instructions'],
    queryFn: () =>
      api.get<{ instructions: Instruction[]; limits: { maxLength: number; maxInstructions: number } }>(
        '/api/owner-instructions',
      ),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['owner-instructions'] });

  const create = useMutation({
    mutationFn: () =>
      api.post('/api/owner-instructions', { text: text.trim(), appliesTo: scope || null }),
    onSuccess: () => {
      setText('');
      setError('');
      refresh();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Qo'shib bo'lmadi"),
  });

  const list = query.data?.instructions ?? [];
  const maxLength = query.data?.limits.maxLength ?? 500;
  const maxInstructions = query.data?.limits.maxInstructions ?? 50;
  const tooLong = text.trim().length > maxLength;
  const full = list.length >= maxInstructions;

  return (
    <div className="card">
      <h3>
        <IconChip icon={Lightbulb} tone="amber" size={26} /> Qo'shimcha AI ko'rsatmalari
      </h3>
      <p className="muted" style={{ marginTop: 0 }}>
        AI qanday vaziyatda nima qilishi kerakligini qisqa va aniq yozing. Masalan: mijoz hamkorlik
        haqida so'rasa, unga aloqa ma'lumotlarimni yubor.
      </p>

      <QueryError error={query.error} onRetry={() => query.refetch()} />

      {list.length > 0 && (
        <div className="stack">
          {list.map((i) => (
            <InstructionRow key={i.id} instruction={i} onChanged={refresh} maxLength={maxLength} />
          ))}
        </div>
      )}

      <label className="field" style={{ marginBottom: 8 }}>
        <span className="name">Yangi ko'rsatma</span>
        <textarea
          value={text}
          rows={2}
          placeholder="Masalan: Narx so'ralsa, avval xizmat turini aniqlashtir."
          onChange={(e) => {
            setText(e.target.value);
            setError('');
          }}
        />
        <span className="hint">
          {text.trim().length}/{maxLength} belgi · {list.length}/{maxInstructions} ko'rsatma
        </span>
      </label>

      <div className="row" style={{ gap: 8 }}>
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as '' | AgentType)}
          style={{ width: 190 }}
          aria-label="Qaysi kanalga"
        >
          {Object.entries(SCOPE_LABEL).map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        <button
          className="primary"
          disabled={create.isPending || text.trim().length < 3 || tooLong || full}
          onClick={() => create.mutate()}
        >
          <Plus size={15} />
          {create.isPending ? "Qo'shilmoqda…" : "Qo'shish"}
        </button>
      </div>

      {error && <div className="error-text">{error}</div>}
      {full && (
        <div className="error-text">
          Ko'rsatmalar soni to'ldi — keraksizlarini o'chiring yoki birlashtiring.
        </div>
      )}

      {list.length === 0 && (
        <div className="examples">
          <div className="k">Namunalar — bosib qo'shing</div>
          {EXAMPLES.map((e) => (
            <button key={e} className="small" onClick={() => setText(e)}>
              {e}
            </button>
          ))}
        </div>
      )}

      <p className="muted" style={{ fontSize: 12.5, margin: '14px 0 0' }}>
        Ko'rsatmalar har bir javobdan oldin AI'ga beriladi va darhol ishlaydi — saqlagach qayta
        yuklash shart emas. Xavfsizlik qoidalari va bilimlar bazasidagi tasdiqlangan ma'lumot
        ko'rsatmadan ustun turadi, va ko'rsatmalar mijozga hech qachon ko'rsatilmaydi.
      </p>
    </div>
  );
}

function InstructionRow({
  instruction,
  onChanged,
  maxLength,
}: {
  instruction: Instruction;
  onChanged: () => void;
  maxLength: number;
}) {
  const [draft, setDraft] = useState(instruction.text);
  const dirty = draft.trim() !== instruction.text && draft.trim().length >= 3;

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.patch(`/api/owner-instructions/${instruction.id}`, body),
    onSuccess: onChanged,
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/api/owner-instructions/${instruction.id}`),
    onSuccess: onChanged,
  });

  return (
    <div className={`instruction-row${instruction.enabled ? '' : ' off'}`}>
      <button
        className={`toggle${instruction.enabled ? ' on' : ''}`}
        disabled={patch.isPending}
        aria-label={instruction.enabled ? "O'chirish" : 'Yoqish'}
        title={instruction.enabled ? 'Yoqilgan' : "O'chirilgan"}
        onClick={() => patch.mutate({ enabled: !instruction.enabled })}
      >
        <span className="knob" />
      </button>

      <div className="instruction-body">
        <textarea
          value={draft}
          rows={2}
          maxLength={maxLength}
          onChange={(e) => setDraft(e.target.value)}
        />
        <div className="row" style={{ gap: 6, marginTop: 6 }}>
          <span className="badge">{SCOPE_LABEL[instruction.appliesTo ?? '']}</span>
          {dirty && (
            <button className="small" disabled={patch.isPending} onClick={() => patch.mutate({ text: draft.trim() })}>
              <Save size={13} /> Saqlash
            </button>
          )}
        </div>
      </div>

      <button
        className="small danger"
        disabled={remove.isPending}
        title="O'chirish"
        onClick={() => {
          if (confirm("Bu ko'rsatma o'chirilsinmi?")) remove.mutate();
        }}
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}
