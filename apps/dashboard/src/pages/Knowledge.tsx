import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Plus, FileText, Link2, Type, RefreshCw, Trash2, Search, FilePlus } from 'lucide-react';
import { api, ApiError, type KnowledgeBase, type KnowledgeDocument } from '../api';
import IconChip from '../components/IconChip';

const STATUS_LABEL: Record<string, string> = {
  PENDING: 'KUTILMOQDA',
  PROCESSING: 'QAYTA ISHLANMOQDA',
  READY: 'TAYYOR',
  FAILED: 'XATOLIK',
};

export default function Knowledge() {
  const qc = useQueryClient();
  const bases = useQuery({
    queryKey: ['knowledge-bases'],
    queryFn: () => api.get<{ knowledgeBases: KnowledgeBase[] }>('/api/knowledge-bases'),
  });
  const [selected, setSelected] = useState<string | null>(null);
  const kbId = selected ?? bases.data?.knowledgeBases[0]?.id ?? null;

  const [newName, setNewName] = useState('');
  const createKb = useMutation({
    mutationFn: () => api.post('/api/knowledge-bases', { name: newName }),
    onSuccess: () => {
      setNewName('');
      qc.invalidateQueries({ queryKey: ['knowledge-bases'] });
    },
  });

  return (
    <>
      <div className="page-head">
        <IconChip icon={BookOpen} tone="green" size={42} />
        <div>
          <h1 className="page-title">Bilimlar bazasi</h1>
          <p className="page-sub">
            Hujjatlar tahlil qilinadi, bo'laklarga bo'linadi va har bir agent uchun eng mos qismlari
            qidirib topiladi. Agentlar hech qachon butun bazani ko'rmaydi — faqat eng tegishli qismlarni.
          </p>
        </div>
      </div>

      <div className="card row">
        <select value={kbId ?? ''} onChange={(e) => setSelected(e.target.value)} style={{ width: 280 }}>
          {bases.data?.knowledgeBases.map((kb) => (
            <option key={kb.id} value={kb.id}>
              {kb.name} ({kb._count?.documents ?? 0} hujjat, {kb._count?.chunks ?? 0} bo'lak)
            </option>
          ))}
        </select>
        <input
          placeholder="Yangi bilimlar bazasi nomi…"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          style={{ width: 240 }}
        />
        <button className="small" disabled={!newName.trim() || createKb.isPending} onClick={() => createKb.mutate()}>
          <Plus size={14} /> Yaratish
        </button>
      </div>

      {kbId && <Documents kbId={kbId} />}
      {kbId && <SearchTest kbId={kbId} />}
    </>
  );
}

function Documents({ kbId }: { kbId: string }) {
  const qc = useQueryClient();
  const docs = useQuery({
    queryKey: ['documents', kbId],
    queryFn: () => api.get<{ documents: KnowledgeDocument[] }>(`/api/knowledge-bases/${kbId}/documents`),
    refetchInterval: (q) =>
      q.state.data?.documents.some((d) => d.status === 'PENDING' || d.status === 'PROCESSING') ? 3000 : false,
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['documents', kbId] });
    qc.invalidateQueries({ queryKey: ['knowledge-bases'] });
  };

  const [tab, setTab] = useState<'file' | 'url' | 'text'>('file');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');

  const uploadJson = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post(`/api/knowledge-bases/${kbId}/documents`, body),
    onSuccess: () => { setUrl(''); setText(''); setTitle(''); setError(''); refresh(); },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Yuklashda xatolik'),
  });
  const uploadFile = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return api.postForm(`/api/knowledge-bases/${kbId}/documents`, form);
    },
    onSuccess: () => { setError(''); refresh(); },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Yuklashda xatolik'),
  });
  const del = useMutation({
    mutationFn: (docId: string) => api.delete(`/api/documents/${docId}`),
    onSuccess: refresh,
  });
  const reingest = useMutation({
    mutationFn: (docId: string) => api.post(`/api/documents/${docId}/reingest`),
    onSuccess: refresh,
  });

  return (
    <>
      <div className="card">
        <h3><IconChip icon={FilePlus} tone="green" size={26} /> Hujjat qo'shish</h3>
        <div className="tabs">
          <button className={tab === 'file' ? 'active' : ''} onClick={() => setTab('file')}>
            <FileText size={14} /> Fayl (PDF, DOCX, TXT, MD)
          </button>
          <button className={tab === 'url' ? 'active' : ''} onClick={() => setTab('url')}>
            <Link2 size={14} /> Havola (URL)
          </button>
          <button className={tab === 'text' ? 'active' : ''} onClick={() => setTab('text')}>
            <Type size={14} /> Matn / FAQ
          </button>
        </div>
        {tab === 'file' && (
          <input
            type="file"
            accept=".pdf,.docx,.txt,.md,.markdown"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) uploadFile.mutate(f);
              e.target.value = '';
            }}
          />
        )}
        {tab === 'url' && (
          <div className="row">
            <input placeholder="https://masalan.uz/narxlar" value={url} onChange={(e) => setUrl(e.target.value)} />
            <button className="small primary" disabled={!url || uploadJson.isPending} onClick={() => uploadJson.mutate({ url })}>
              Yuklab olish va qo'shish
            </button>
          </div>
        )}
        {tab === 'text' && (
          <>
            <label className="field">
              <span className="name">Sarlavha</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="masalan: Narxlar ro'yxati, FAQ" />
            </label>
            <textarea
              placeholder={"Biznes ma'lumotlari, FAQ (Savol:/Javob: juftliklari), mahsulot tafsilotlarini joylashtiring…"}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <button
              className="primary" style={{ marginTop: 8 }}
              disabled={!text.trim() || uploadJson.isPending}
              onClick={() => uploadJson.mutate({ text, title: title || undefined })}
            >
              Matnni qo'shish
            </button>
          </>
        )}
        {error && <div className="error-text">{error}</div>}
      </div>

      <div className="card">
        <h3><IconChip icon={FileText} tone="slate" size={26} /> Hujjatlar</h3>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr><th>Sarlavha</th><th>Turi</th><th>Holat</th><th>Bo'laklar</th><th></th></tr>
            </thead>
            <tbody>
              {docs.data?.documents.map((d) => (
                <tr key={d.id}>
                  <td>{d.title}</td>
                  <td className="muted">{d.sourceType}</td>
                  <td>
                    <span className={`badge ${d.status === 'READY' ? 'ok' : d.status === 'FAILED' ? 'bad' : 'warn'}`}>
                      {STATUS_LABEL[d.status] ?? d.status}
                    </span>
                    {d.error && <div className="error-text" style={{ fontSize: 12 }}>{d.error}</div>}
                  </td>
                  <td>{d._count?.chunks ?? 0}</td>
                  <td className="row">
                    <button className="small" onClick={() => reingest.mutate(d.id)}>
                      <RefreshCw size={13} /> Qayta ishlash
                    </button>
                    <button className="small danger" onClick={() => { if (confirm("Bu hujjatni o'chirasizmi?")) del.mutate(d.id); }}>
                      <Trash2 size={13} /> O'chirish
                    </button>
                  </td>
                </tr>
              ))}
              {docs.data?.documents.length === 0 && (
                <tr><td colSpan={5} className="muted">Hali hujjat yo'q.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function SearchTest({ kbId }: { kbId: string }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Array<{ documentTitle: string; content: string; score: number }> | null>(null);
  const search = useMutation({
    mutationFn: () =>
      api.post<{ results: Array<{ documentTitle: string; content: string; score: number }> }>(
        `/api/knowledge-bases/${kbId}/search`,
        { query },
      ),
    onSuccess: (data) => setResults(data.results),
  });

  return (
    <div className="card">
      <h3><IconChip icon={Search} tone="violet" size={26} /> Qidiruvni sinash</h3>
      <p className="muted" style={{ fontSize: 12 }}>
        Mijoz savol bersa, agent qaysi ma'lumotlarni topishini shu yerda sinab ko'ring.
      </p>
      <div className="row">
        <input placeholder="masalan: Yetkazib berish qancha turadi?" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="small primary" disabled={!query.trim() || search.isPending} onClick={() => search.mutate()}>
          {search.isPending ? 'Qidirilmoqda…' : 'Qidirish'}
        </button>
      </div>
      {results && (
        <div style={{ marginTop: 12 }}>
          {results.length === 0 && <p className="muted">Mos bo'lak topilmadi.</p>}
          {results.map((r, i) => (
            <div key={i} style={{ marginBottom: 10 }}>
              <div className="muted" style={{ fontSize: 12 }}>
                {r.documentTitle} · aniqlik {r.score.toFixed(3)}
              </div>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{r.content.slice(0, 400)}{r.content.length > 400 ? '…' : ''}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
