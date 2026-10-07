import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserPlus, Users as UsersIcon, Building2, Trash2, KeyRound, Save } from 'lucide-react';
import { api, ApiError } from '../api';
import IconChip from '../components/IconChip';
import QueryError from '../components/QueryError';

/**
 * Team and business identity — the handover screen.
 *
 * Everything else in this dashboard assumes the business already owns the
 * platform. This is where that becomes true: create the owner's account, put
 * the business's real name on the agents and the public legal pages, and then
 * remove the installer.
 */

interface TeamUser {
  id: string;
  username: string;
  name: string;
  email: string | null;
  role: 'ADMIN' | 'OPERATOR';
  createdAt: string;
}

interface Business {
  id: string;
  name: string;
  slug: string;
}

export default function Team({ me }: { me: { id: string; role: string } }) {
  const qc = useQueryClient();
  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<{ users: TeamUser[] }>('/api/users'),
  });
  const business = useQuery({
    queryKey: ['business'],
    queryFn: () => api.get<{ business: Business }>('/api/business'),
  });

  const list = users.data?.users ?? [];
  const admins = list.filter((u) => u.role === 'ADMIN').length;

  return (
    <div>
      <div className="page-head">
        <IconChip icon={UsersIcon} tone="blue" />
        <div>
          <h2 className="page-title">Jamoa va biznes</h2>
          <p className="page-sub">
            Platformani biznes egasiga topshirish: unga administrator hisobi oching, biznes nomini
            to‘g‘rilang, so‘ng o‘z hisobingizni olib tashlang.
          </p>
        </div>
      </div>

      <BusinessCard business={business.data?.business} error={business.error} />

      <div className="card">
        <h3>
          <IconChip icon={UsersIcon} tone="violet" size={26} /> Foydalanuvchilar
        </h3>
        {users.isError ? (
          <QueryError error={users.error} onRetry={() => users.refetch()} />
        ) : users.isLoading ? (
          <p className="muted">Yuklanmoqda…</p>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Login</th>
                  <th>Ism</th>
                  <th>Rol</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((u) => (
                  <UserRow
                    key={u.id}
                    user={u}
                    isMe={u.id === me.id}
                    lastAdmin={u.role === 'ADMIN' && admins <= 1}
                    onChanged={() => qc.invalidateQueries({ queryKey: ['users'] })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <CreateUserCard onCreated={() => qc.invalidateQueries({ queryKey: ['users'] })} />

      <div className="card">
        <h3>
          <IconChip icon={UserPlus} tone="green" size={26} /> Topshirish tartibi
        </h3>
        <ol style={{ paddingLeft: 20, margin: 0, lineHeight: 1.9 }}>
          <li>Yuqorida biznes nomini egasining nomiga o‘zgartiring.</li>
          <li>Egasiga <strong>Administrator</strong> rolida hisob oching.</li>
          <li>U o‘z hisobi bilan kirib ko‘rsin — ishlayotganiga ishonch hosil qiling.</li>
          <li>
            U <strong>Ulanishlar</strong> sahifasida o‘z Telegram botini va Instagram akkauntini
            ulasin, <strong>Bilimlar bazasi</strong>ga o‘z ma’lumotlarini kiritsin.
          </li>
          <li>Oxirida — egasi o‘z hisobidan turib sizning hisobingizni o‘chiradi.</li>
        </ol>
        <p className="muted" style={{ marginTop: 12, marginBottom: 0 }}>
          O‘z hisobingizni o‘zingiz o‘chira olmaysiz va oxirgi administrator ham o‘chirilmaydi —
          bu platformadan butunlay chiqib qolishning oldini oladi.
        </p>
      </div>
    </div>
  );
}

function BusinessCard({ business, error }: { business?: Business; error: unknown }) {
  const qc = useQueryClient();
  const [name, setName] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const value = name ?? business?.name ?? '';

  const save = useMutation({
    mutationFn: () => api.patch<{ business: Business }>('/api/business', { name: value.trim() }),
    onSuccess: () => {
      setSaved(true);
      setName(null);
      qc.invalidateQueries({ queryKey: ['business'] });
    },
  });

  return (
    <div className="card">
      <h3>
        <IconChip icon={Building2} tone="amber" size={26} /> Biznes nomi
      </h3>
      {error ? <QueryError error={error} /> : null}
      <label className="field">
        <input value={value} onChange={(e) => { setName(e.target.value); setSaved(false); }} />
        <span className="hint">
          Bu nom shunchaki ko‘rinish uchun emas: har bir agentning ko‘rsatmasiga qo‘shiladi
          (“siz … nomidan javob berasiz”) va ommaviy <span className="mono">/privacy</span> hamda{' '}
          <span className="mono">/data-deletion</span> sahifalarida chiqadi.
        </span>
      </label>
      {save.isError && (
        <div className="error-text">
          {save.error instanceof ApiError ? save.error.message : 'Saqlab bo‘lmadi'}
        </div>
      )}
      {saved && <p className="success-text">Saqlandi.</p>}
      <button
        className="primary"
        disabled={save.isPending || !value.trim() || value.trim() === business?.name}
        onClick={() => save.mutate()}
      >
        <Save size={15} />
        {save.isPending ? 'Saqlanmoqda…' : 'Saqlash'}
      </button>
    </div>
  );
}

function CreateUserCard({ onCreated }: { onCreated: () => void }) {
  const empty = { username: '', name: '', password: '', role: 'ADMIN' as const };
  const [form, setForm] = useState<{ username: string; name: string; password: string; role: 'ADMIN' | 'OPERATOR' }>(empty);
  const [done, setDone] = useState('');

  const create = useMutation({
    mutationFn: () => api.post<{ user: TeamUser }>('/api/users', form),
    onSuccess: (res) => {
      setDone(`"${res.user.username}" yaratildi.`);
      setForm(empty);
      onCreated();
    },
  });

  return (
    <div className="card">
      <h3>
        <IconChip icon={UserPlus} tone="green" size={26} /> Yangi foydalanuvchi
      </h3>
      <div className="grid cols-2">
        <label className="field">
          <span className="name">Login</span>
          <input
            value={form.username}
            placeholder="masalan: turon"
            onChange={(e) => { setForm({ ...form, username: e.target.value }); setDone(''); }}
          />
          <span className="hint">Faqat harf, raqam, nuqta, pastki chiziq va defis.</span>
        </label>
        <label className="field">
          <span className="name">Ism familiya</span>
          <input
            value={form.name}
            placeholder="masalan: Turon Avtomaktab egasi"
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label className="field">
          <span className="name">Parol</span>
          <input
            type="text"
            value={form.password}
            placeholder="kamida 8 ta belgi"
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
          <span className="hint">
            Ochiq ko‘rinadi — egasiga yetkazib bering va birinchi kirishdan keyin o‘zgartirishini
            ayting.
          </span>
        </label>
        <label className="field">
          <span className="name">Rol</span>
          <select
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value as 'ADMIN' | 'OPERATOR' })}
          >
            <option value="ADMIN">Administrator — hamma narsani boshqaradi</option>
            <option value="OPERATOR">Operator — faqat suhbat va mijozlar</option>
          </select>
        </label>
      </div>
      {create.isError && (
        <div className="error-text">
          {create.error instanceof ApiError ? create.error.message : 'Yaratib bo‘lmadi'}
        </div>
      )}
      {done && <p className="success-text">{done}</p>}
      <button
        className="primary"
        disabled={create.isPending || !form.username.trim() || !form.name.trim() || form.password.length < 8}
        onClick={() => create.mutate()}
      >
        <UserPlus size={15} />
        {create.isPending ? 'Yaratilmoqda…' : 'Yaratish'}
      </button>
    </div>
  );
}

function UserRow({
  user,
  isMe,
  lastAdmin,
  onChanged,
}: {
  user: TeamUser;
  isMe: boolean;
  lastAdmin: boolean;
  onChanged: () => void;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/api/users/${user.id}`, body),
    onSuccess: () => {
      setPassword('');
      setError('');
      setNote('Yangilandi.');
      onChanged();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Xatolik'),
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/api/users/${user.id}`),
    onSuccess: () => { setError(''); onChanged(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Xatolik'),
  });

  return (
    <tr>
      <td>
        <strong>{user.username}</strong>
        {isMe && <span className="badge accent" style={{ marginLeft: 8 }}>SIZ</span>}
      </td>
      <td>{user.name}</td>
      <td>
        <span className={`badge ${user.role === 'ADMIN' ? 'ok' : ''}`}>
          {user.role === 'ADMIN' ? 'ADMINISTRATOR' : 'OPERATOR'}
        </span>
      </td>
      <td>
        <div className="row" style={{ gap: 6 }}>
          <input
            type="text"
            value={password}
            placeholder="yangi parol"
            style={{ width: 150 }}
            onChange={(e) => { setPassword(e.target.value); setNote(''); }}
          />
          <button
            className="small"
            disabled={password.length < 8 || update.isPending}
            onClick={() => update.mutate({ password })}
          >
            <KeyRound size={13} />
            O‘zgartirish
          </button>
          <button
            className="small danger"
            disabled={isMe || lastAdmin || remove.isPending}
            title={
              isMe
                ? 'O‘z hisobingizni o‘chira olmaysiz'
                : lastAdmin
                  ? 'Oxirgi administratorni o‘chirib bo‘lmaydi'
                  : 'O‘chirish'
            }
            onClick={() => {
              if (confirm(`"${user.username}" hisobini o‘chirilsinmi?`)) remove.mutate();
            }}
          >
            <Trash2 size={13} />
          </button>
        </div>
        {error && <div className="error-text" style={{ fontSize: 12 }}>{error}</div>}
        {note && <p className="success-text" style={{ fontSize: 12, margin: '4px 0 0' }}>{note}</p>}
      </td>
    </tr>
  );
}
