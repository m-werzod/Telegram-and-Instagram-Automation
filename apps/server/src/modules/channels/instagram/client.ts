import { ExternalApiError, RateLimitedError } from '../../../lib/errors.js';

/**
 * Instagram API with Instagram Login (Business Login) client.
 * Host: graph.instagram.com, pinned to v25.0 (see docs/integration-notes.md).
 *
 * Verified endpoints:
 *  - GET  /me                      — token validation + account identity
 *  - POST /{comment-id}/replies    — public comment reply
 *  - POST /me/messages             — DMs (recipient.id) and private replies (recipient.comment_id)
 *  - POST /me/subscribed_apps      — per-account webhook enablement
 *  - GET  /refresh_access_token    — 60-day token refresh
 *  - GET  /{IGSID}                 — user profile (requires user consent via messaging)
 */

export const IG_API_VERSION = 'v25.0';
const BASE = 'https://graph.instagram.com';

/** Instagram DM texts are limited to 1000 bytes of UTF-8. */
export const IG_DM_MAX_BYTES = 1000;

export interface IgAccount {
  user_id?: string;
  id?: string;
  username?: string;
  name?: string;
  account_type?: string;
}

export interface IgUserProfile {
  username?: string;
  name?: string;
  follower_count?: number;
  is_verified_user?: boolean;
  is_user_follow_business?: boolean;
}

interface IgError {
  message: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  fbtrace_id?: string;
}

export class InstagramClient {
  constructor(
    private readonly accessToken: string,
    private readonly baseUrl = BASE,
  ) {}

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    opts: { query?: Record<string, string>; json?: unknown } = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}/${IG_API_VERSION}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          ...(opts.json !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new ExternalApiError('instagram', `network failure on ${method} ${path}: ${String(err)}`, {
        retryable: true,
      });
    }

    let data: any;
    try {
      data = await res.json();
    } catch {
      if (res.ok) return undefined as T;
      throw new ExternalApiError('instagram', `non-JSON error response (${res.status})`, {
        statusCode: res.status,
        retryable: res.status >= 500,
      });
    }

    if (!res.ok || data?.error) {
      throw mapIgError(res.status, (data?.error ?? {}) as IgError, `${method} ${path}`);
    }
    return data as T;
  }

  /** Validate the token and identify the professional account. */
  getMe(): Promise<IgAccount> {
    return this.request<IgAccount>('GET', '/me', {
      query: { fields: 'user_id,username,name,account_type' },
    });
  }

  /** Public reply to a top-level comment. */
  replyToComment(commentId: string, message: string): Promise<{ id: string }> {
    return this.request<{ id: string }>('POST', `/${commentId}/replies`, {
      query: { message: clampChars(message, 950) },
    });
  }

  /** The single allowed private reply (DM) to a comment — 7-day window. */
  sendPrivateReply(commentId: string, text: string): Promise<{ recipient_id?: string; message_id?: string }> {
    return this.request('POST', `/me/messages`, {
      json: { recipient: { comment_id: commentId }, message: { text: clampBytes(text, IG_DM_MAX_BYTES) } },
    });
  }

  /** DM to a user who has messaged the account (24-hour window). */
  sendMessage(igsid: string, text: string): Promise<{ recipient_id?: string; message_id?: string }> {
    return this.request('POST', `/me/messages`, {
      json: { recipient: { id: igsid }, message: { text: clampBytes(text, IG_DM_MAX_BYTES) } },
    });
  }

  /**
   * DM an image to a user (24-hour window). Meta fetches the image from the
   * given public HTTPS URL (JPEG/PNG/WebP/GIF, ≤8MB).
   */
  sendImageMessage(
    igsid: string,
    imageUrl: string,
  ): Promise<{ recipient_id?: string; message_id?: string }> {
    return this.request('POST', `/me/messages`, {
      json: {
        recipient: { id: igsid },
        message: { attachment: { type: 'image', payload: { url: imageUrl } } },
      },
    });
  }

  /** Enable webhook delivery for this account (required in addition to app-level config). */
  subscribeApps(fields: string[]): Promise<{ success?: boolean }> {
    return this.request('POST', `/me/subscribed_apps`, {
      query: { subscribed_fields: fields.join(',') },
    });
  }

  /** Profile of a messaging user (consent exists only after they message). */
  getUserProfile(igsid: string): Promise<IgUserProfile> {
    return this.request<IgUserProfile>('GET', `/${igsid}`, {
      query: { fields: 'username,name,follower_count,is_verified_user,is_user_follow_business' },
    });
  }

  hideComment(commentId: string, hide: boolean): Promise<{ success?: boolean }> {
    return this.request('POST', `/${commentId}`, { query: { hide: String(hide) } });
  }

  /** Refresh a long-lived token (must be ≥24h old, not expired). Unversioned endpoint. */
  async refreshAccessToken(): Promise<{ access_token: string; expires_in: number }> {
    const url = new URL(`${this.baseUrl}/refresh_access_token`);
    url.searchParams.set('grant_type', 'ig_refresh_token');
    url.searchParams.set('access_token', this.accessToken);
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || data?.error) {
      throw mapIgError(res.status, (data?.error ?? {}) as IgError, 'GET /refresh_access_token');
    }
    return data as { access_token: string; expires_in: number };
  }
}

function mapIgError(status: number, err: IgError, context: string): Error {
  const code = err.code ?? 0;
  const sub = err.error_subcode ?? 0;
  const msg = `${context}: ${err.message ?? `HTTP ${status}`} (code ${code}${sub ? `/${sub}` : ''})`;

  // OAuth/token problems — operator must reconnect; retrying is pointless.
  if (code === 190 || status === 401) {
    return new ExternalApiError('instagram', msg, { statusCode: 401, retryable: false });
  }
  // Rate limits / temporarily blocked.
  if (code === 4 || code === 17 || code === 32 || code === 613 || status === 429) {
    return new RateLimitedError(msg, 60_000);
  }
  // Permission / policy violations (incl. outside-window sends) — non-retryable.
  if (code === 10 || code === 200 || code === 3 || status === 403) {
    return new ExternalApiError('instagram', msg, { statusCode: 403, retryable: false });
  }
  if (status >= 500 || code === 1 || code === 2) {
    return new ExternalApiError('instagram', msg, { statusCode: status || 502, retryable: true });
  }
  return new ExternalApiError('instagram', msg, { statusCode: status || 400, retryable: false });
}

export function clampChars(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Clamp to a UTF-8 byte budget without splitting a code point. */
export function clampBytes(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;
  let result = '';
  let bytes = 0;
  for (const ch of text) {
    const len = encoder.encode(ch).length;
    if (bytes + len > maxBytes - 3) break; // room for the ellipsis
    result += ch;
    bytes += len;
  }
  return `${result.trimEnd()}…`;
}
