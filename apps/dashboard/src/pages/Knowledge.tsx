import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type KnowledgeBase, type KnowledgeDocument } from '../api';

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
      <h1 className="page-title">Knowledge</h1>
      <p className="page-sub">
        Documents are parsed, chunked, embedded, and retrieved semantically per agent. Agents never
        receive the whole knowledge base — only the most relevant excerpts.
      </p>

      <div className="card row">
        <select value={kbId ?? ''} onChange={(e) => setSelected(e.target.value)} style={{ width: 280 }}>
          {bases.data?.knowledgeBases.map((kb) => (
            <option key={kb.id} value={kb.id}>
              {kb.name} ({kb._count?.documents ?? 0} docs, {kb._count?.chunks ?? 0} chunks)
            </option>
          ))}
        </select>
        <input
          placeholder="New knowledge base name…"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          style={{ width: 240 }}
        />
        <button className="small" disabled={!newName.trim() || createKb.isPending} onClick={() => createKb.mutate()}>
          Create
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
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Upload failed'),
  });
  const uploadFile = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return api.postForm(`/api/knowledge-bases/${kbId}/documents`, form);
    },
    onSuccess: () => { setError(''); refresh(); },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Upload failed'),
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
        <h3>Add document</h3>
        <div className="tabs">
          <button className={tab === 'file' ? 'active' : ''} onClick={() => setTab('file')}>File (PDF, DOCX, TXT, MD)</button>
          <button className={tab === 'url' ? 'active' : ''} onClick={() => setTab('url')}>URL</button>
          <button className={tab === 'text' ? 'active' : ''} onClick={() => setTab('text')}>Text / FAQ</button>
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
            <input placeholder="https://example.com/pricing" value={url} onChange={(e) => setUrl(e.target.value)} />
            <button className="small primary" disabled={!url || uploadJson.isPending} onClick={() => uploadJson.mutate({ url })}>
              Fetch & ingest
            </button>
          </div>
        )}
        {tab === 'text' && (
          <>
            <label className="field">
              <span className="name">Title</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Price list, FAQ" />
            </label>
            <textarea
              placeholder={'Paste business information, FAQs (Q:/A: pairs), product details…'}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <button
              className="primary" style={{ marginTop: 8 }}
              disabled={!text.trim() || uploadJson.isPending}
              onClick={() => uploadJson.mutate({ text, title: title || undefined })}
            >
              Ingest text
            </button>
          </>
        )}
        {error && <div className="error-text">{error}</div>}
      </div>

      <div className="card">
        <h3>Documents</h3>
        <table className="table">
          <thead>
            <tr><th>Title</th><th>Type</th><th>Status</th><th>Chunks</th><th></th></tr>
          </thead>
          <tbody>
            {docs.data?.documents.map((d) => (
              <tr key={d.id}>
                <td>{d.title}</td>
                <td className="muted">{d.sourceType}</td>
                <td>
                  <span className={`badge ${d.status === 'READY' ? 'ok' : d.status === 'FAILED' ? 'bad' : 'warn'}`}>
                    {d.status}
                  </span>
                  {d.error && <div className="error-text" style={{ fontSize: 12 }}>{d.error}</div>}
                </td>
                <td>{d._count?.chunks ?? 0}</td>
                <td className="row">
                  <button className="small" onClick={() => reingest.mutate(d.id)}>Re-ingest</button>
                  <button className="small danger" onClick={() => { if (confirm('Delete this document?')) del.mutate(d.id); }}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {docs.data?.documents.length === 0 && (
              <tr><td colSpan={5} className="muted">No documents yet.</td></tr>
            )}
          </tbody>
        </table>
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
      <h3>Retrieval test</h3>
      <p className="muted" style={{ fontSize: 12 }}>
        Test what the agent would retrieve for a customer question.
      </p>
      <div className="row">
        <input placeholder="e.g. How much does delivery cost?" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="small primary" disabled={!query.trim() || search.isPending} onClick={() => search.mutate()}>
          {search.isPending ? 'Searching…' : 'Search'}
        </button>
      </div>
      {results && (
        <div style={{ marginTop: 12 }}>
          {results.length === 0 && <p className="muted">No relevant chunks found.</p>}
          {results.map((r, i) => (
            <div key={i} style={{ marginBottom: 10 }}>
              <div className="muted" style={{ fontSize: 12 }}>
                {r.documentTitle} · score {r.score.toFixed(3)}
              </div>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{r.content.slice(0, 400)}{r.content.length > 400 ? '…' : ''}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
