import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type MediaAsset } from '../api';

/**
 * Image library the agents can send to customers (price list, branch map,
 * course banners…). The AI chooses an image by its name + description, so
 * clear Uzbek descriptions directly improve when the right image is sent.
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
      <h1 className="page-title">Media · Images</h1>
      <p className="page-sub">
        Images the AI can send in Instagram DMs and Telegram chats (public comments cannot carry
        images — the agent invites the person to DM instead). The AI picks an image by its name and
        description, so describe each one clearly — in Uzbek, e.g. “Narxlar jadvali — barcha
        toifalar uchun 2026”.
      </p>

      {isAdmin && <UploadCard onUploaded={refresh} />}

      <div className="grid cols-2">
        {assets.data?.assets.map((a) => (
          <AssetCard key={a.id} asset={a} isAdmin={isAdmin} onChanged={refresh} />
        ))}
      </div>
      {assets.data?.assets.length === 0 && (
        <div className="card">
          <p className="muted">
            No images yet. Upload the price list, branch locations, and course banners so the
            agents can share them when customers ask.
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
      if (!file) throw new ApiError(400, 'no_file', 'Choose an image file first');
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
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Upload failed'),
  });

  return (
    <div className="card">
      <h3>Upload an image</h3>
      <div className="grid cols-2">
        <label className="field">
          <span className="name">Image file (JPEG/PNG/WebP/GIF, ≤8 MB)</span>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" />
        </label>
        <label className="field">
          <span className="name">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Narxlar jadvali 2026"
          />
        </label>
      </div>
      <label className="field">
        <span className="name">Description — tells the AI when to send this image</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. Barcha toifalar (A, B, BC, C, CE, BE, D) narxlari va muddatlari jadvali. Mijoz narx yoki kurslar jadvalini so'raganda yuborilsin."
        />
      </label>
      {error && <div className="error-text">{error}</div>}
      <button className="primary" onClick={() => upload.mutate()} disabled={upload.isPending}>
        {upload.isPending ? 'Uploading…' : 'Upload'}
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
        style={{ maxWidth: '100%', maxHeight: 220, borderRadius: 8, display: 'block' }}
      />
      <p className="muted" style={{ fontSize: 11, margin: '6px 0' }}>
        {asset.mimeType} · {(asset.sizeBytes / 1024).toFixed(0)} KB ·{' '}
        {new Date(asset.createdAt).toLocaleDateString()}
      </p>
      {isAdmin ? (
        <>
          <label className="field">
            <span className="name">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span className="name">Description (when should the AI send it?)</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <div className="row">
            <button className="small" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
            <button
              className="small danger"
              onClick={() => {
                if (confirm(`Delete "${asset.name}"? Agents will no longer be able to send it.`)) {
                  remove.mutate();
                }
              }}
            >
              Delete
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
