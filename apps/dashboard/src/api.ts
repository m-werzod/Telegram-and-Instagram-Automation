/** Typed API client for the platform backend (cookies carry the session). */

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers:
      init?.body && !(init.body instanceof FormData)
        ? { 'content-type': 'application/json' }
        : undefined,
    ...init,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (data as any)?.error ?? {};
    throw new ApiError(res.status, err.code ?? 'error', err.message ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  postForm: <T>(path: string, form: FormData) => request<T>(path, { method: 'POST', body: form }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

// ── Shared shapes (mirrors the server API) ──────────────────────────────────

export interface SessionUser {
  id: string;
  username: string;
  name: string;
  role: 'ADMIN' | 'OPERATOR';
}

export interface Agent {
  id: string;
  type: 'INSTAGRAM_COMMENT' | 'INSTAGRAM_DM' | 'TELEGRAM' | 'TELEGRAM_PERSONAL';
  name: string;
  enabled: boolean;
  systemInstructions: string;
  businessObjective: string;
  tone: string;
  language: string;
  provider: string;
  model: string;
  knowledgeBaseId: string | null;
  knowledgeBase?: { id: string; name: string } | null;
  settings: Record<string, unknown>;
  updatedAt: string;
}

export interface Connection {
  id: string;
  channel: 'INSTAGRAM' | 'TELEGRAM';
  status: string;
  displayName: string;
  externalAccountId: string;
  healthStatus: string;
  healthDetail: string;
  lastHealthCheckAt: string | null;
  metadata: Record<string, unknown>;
}

export interface Lead {
  id: string;
  source: string;
  name: string | null;
  username: string | null;
  phone: string | null;
  email: string | null;
  language: string | null;
  intent: string | null;
  status: string;
  score: number;
  tags: string[];
  qualification: Record<string, unknown>;
  lastInteractionAt: string | null;
  createdAt: string;
  identities?: Array<{ id: string; channel: string; externalId: string; username: string | null }>;
  conversations?: Array<{
    id: string;
    kind: string;
    channel: string;
    status: string;
    lastMessageAt: string | null;
  }>;
  notes?: Array<{ id: string; authorType: string; content: string; createdAt: string }>;
  handoffs?: Array<{ id: string; reason: string; status: string; createdAt: string }>;
}

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string;
  _count?: { documents: number; chunks: number };
}

export interface KnowledgeDocument {
  id: string;
  title: string;
  sourceType: string;
  sourceRef: string;
  status: string;
  error: string | null;
  createdAt: string;
  _count?: { chunks: number };
}

export interface ManualAction {
  id: string;
  platform: string;
  title: string;
  officialUrl: string;
  steps: string[];
  expectedResult: string;
  whatToReturn: string;
  status: 'PENDING' | 'DONE' | 'DISMISSED';
}

export interface Handoff {
  id: string;
  reason: string;
  status: 'OPEN' | 'RESOLVED';
  createdAt: string;
  lead: { id: string; name: string | null; username: string | null; status: string } | null;
  conversation: { id: string; kind: string; channel: string; status: string };
}

export interface MediaAsset {
  id: string;
  name: string;
  description: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface SettingStatus {
  key: string;
  source: 'platform' | 'env' | 'unset';
  maskedValue: string;
}

export interface SettingsResponse {
  settings: SettingStatus[];
  urls: {
    appUrl: string | null;
    instagramWebhook: string | null;
    mediaBase: string | null;
  };
}

export interface TelegramPersonalAccount {
  id: string;
  businessConnectionId: string;
  ownerUserId: string;
  ownerName: string;
  ownerUsername: string | null;
  isEnabled: boolean;
  canReply: boolean;
  canReadMessages: boolean;
  connectedAt: string;
  enabled: boolean;
  displayName: string;
  instructions: string | null;
  knowledgeBaseId: string | null;
  knowledgeBase?: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
}
