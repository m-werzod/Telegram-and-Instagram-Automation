import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Image as ImageIcon, Upload, Trash2, Save } from 'lucide-react';
import { api, ApiError, type MediaAsset } from '../api';
import IconChip from '../components/IconChip';

/**
 * Agentlar mijozlarga yubora oladigan rasmlar kutubxonasi (narxlar jadvali,
 * filial xaritasi, kurs bannerlari…). AI rasmni nomi va tavsifiga qarab
 * tanlaydi — shuning uchun har birini aniq, o'zbek tilida tavsiflang.
 */
export default function Media({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const assets = useQuery({
    queryKey: ['media'],
    queryFn: () => api.get<{ assets: MediaAsset[] }>('/api/media'),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['media'] });

  return (
    <>
      <div className="page-head">
        <IconChip icon={ImageIcon} tone="pink" size={42} />
        <div>
          <h1 className="page-title">Media · Rasmlar</h1>
          <p className="page-sub">
            AI Instagram Direct va Telegram suhbatlarida yubora oladigan rasmlar (ochiq izohlarda rasm
            yuborib bo'lmaydi — agent mijozni Direct'ga taklif qiladi). AI rasmni nomi va tavsifiga qarab
            tanlaydi, shuning uchun har birini aniq tasvirlab bering — masalan "Narxlar jadvali — barcha
            toifalar uchun 2026".
          </p>
        </div>
      </div>

      {isAdmin && <UploadCard onUploaded={refresh} />}

      <div className="grid cols-2">
        {assets.data?.assets?.map((a) => (
          <AssetCard key={a.id} asset={a} isAdmin={isAdmin} onChanged={refresh} />
        ))}
      </div>
      {assets.data?.assets?.length === 0 && (
        <div className="card empty-state">
          <IconChip icon={ImageIcon} tone="pink" size={52} />
          <p className="muted">
            Hali rasm yo'q. Narxlar jadvali, filiallar manzili va kurs bannerlarini yuklang — agentlar
            mijozlar so'raganda ularni yuborishi mumkin bo'ladi.
          </p>
        </div>
      )}
    </>
  );
}

function UploadCard({ onUploaded }: { onUploaded: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');

  const upload = useMutation({
    mutationFn: async () => {
      const file = fileRef.current?.files?.[0];
      if (!file) throw new ApiError(400, 'no_file', 'Avval rasm faylini tanlang');
      const form = new FormData();
      form.append('name', name || file.name);
      form.append('description', description);
      form.append('file', file);
      return api.postForm('/api/media', form);
    },
    onSuccess: () => {
      setName('');
      setDescription('');
      if (fileRef.current) fileRef.current.value = '';
      setError('');
      onUploaded();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Yuklashda xatolik'),
  });

  return (
    <div className="card">
      <h3><IconChip icon={Upload} tone="blue" size={26} /> Rasm yuklash</h3>
      <div className="grid cols-2">
        <label className="field">
          <span className="name">Rasm fayli (JPEG/PNG/WebP/GIF, ≤8 MB)</span>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" />
        </label>
        <label className="field">
          <span className="name">Nomi</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="masalan: Narxlar jadvali 2026"
          />
        </label>
      </div>
      <label className="field">
        <span className="name">Tavsif — AI'ga qachon yuborishni bildiradi</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="masalan: Barcha toifalar (A, B, BC, C, CE, BE, D) narxlari va muddatlari jadvali. Mijoz narx yoki kurslar jadvalini so'raganda yuborilsin."
        />
      </label>
      {error && <div className="error-text">{error}</div>}
      <button className="primary" onClick={() => upload.mutate()} disabled={upload.isPending}>
        <Upload size={15} />
        {upload.isPending ? 'Yuklanmoqda…' : 'Yuklash'}
      </button>
    </div>
  );
}

function AssetCard({
  asset,
  isAdmin,
  onChanged,
}: {
  asset: MediaAsset;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [name, setName] = useState(asset.name);
  const [description, setDescription] = useState(asset.description);
  const dirty = name !== asset.name || description !== asset.description;

  const save = useMutation({
    mutationFn: () => api.patch(`/api/media/${asset.id}`, { name, description }),
    onSuccess: onChanged,
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/api/media/${asset.id}`),
    onSuccess: onChanged,
  });

  return (
    <div className="card">
      <img
        src={`/files/media/${asset.id}`}
        alt={asset.name}
        style={{ maxWidth: '100%', maxHeight: 220, borderRadius: 10, display: 'block' }}
      />
      <p className="muted" style={{ fontSize: 11, margin: '8px 0' }}>
        {asset.mimeType} · {(asset.sizeBytes / 1024).toFixed(0)} KB ·{' '}
        {new Date(asset.createdAt).toLocaleDateString('uz-UZ')}
      </p>
      {isAdmin ? (
        <>
          <label className="field">
            <span className="name">Nomi</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span className="name">Tavsif (AI qachon yuborishi kerak?)</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <div className="row">
            <button className="small" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
              <Save size={13} /> {save.isPending ? 'Saqlanmoqda…' : 'Saqlash'}
            </button>
            <button
              className="small danger"
              onClick={() => {
                if (confirm(`"${asset.name}" o'chirilsinmi? Agentlar endi uni yubora olmaydi.`)) {
                  remove.mutate();
                }
              }}
            >
              <Trash2 size={13} /> O'chirish
            </button>
          </div>
        </>
      ) : (
        <>
          <strong>{asset.name}</strong>
          <p className="muted">{asset.description}</p>
        </>
      )}
    </div>
  );
}
