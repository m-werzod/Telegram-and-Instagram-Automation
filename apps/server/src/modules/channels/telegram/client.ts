import { ExternalApiError, RateLimitedError } from '../../../lib/errors.js';

/**
 * Telegram Bot API client (Bot API 10.x, https://core.telegram.org/bots/api).
 * Plain-text messages, webhook management, health introspection.
 */

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TgWebhookInfo {
  url: string;
  has_custom_certificate: boolean;
  pending_update_count: number;
  last_error_date?: number;
  last_error_message?: string;
  max_connections?: number;
  allowed_updates?: string[];
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel'; username?: string; title?: string };
  date: number;
  text?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: { id: string; from: TgUser; data?: string; message?: TgMessage };
}

/** Telegram sendMessage hard limit: 4096 characters after entity parsing. */
export const TELEGRAM_MAX_MESSAGE = 4096;

export class TelegramClient {
  constructor(
    private readonly token: string,
    private readonly baseUrl = 'https://api.telegram.org',
  ) {}

  private async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: params ? JSON.stringify(params) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new ExternalApiError('telegram', `network failure calling ${method}: ${String(err)}`, {
        retryable: true,
      });
    }

    let data: {
      ok: boolean;
      result?: T;
      description?: string;
      error_code?: number;
      parameters?: { retry_after?: number };
    };
    try {
      data = (await res.json()) as typeof data;
    } catch {
      throw new ExternalApiError('telegram', `non-JSON response from ${method} (${res.status})`, {
        retryable: res.status >= 500,
      });
    }

    if (!data.ok) {
      const code = data.error_code ?? res.status;
      const retryAfter = data.parameters?.retry_after;
      if (code === 429 || retryAfter !== undefined) {
        throw new RateLimitedError(
          `telegram flood control on ${method}: ${data.description ?? ''}`,
          (retryAfter ?? 5) * 1000,
        );
      }
      const retryable = code >= 500;
      throw new ExternalApiError('telegram', data.description ?? `error ${code} on ${method}`, {
        statusCode: code,
        retryable,
      });
    }
    return data.result as T;
  }

  /** Validates the token and returns the bot's identity. */
  getMe(): Promise<TgUser> {
    return this.call<TgUser>('getMe');
  }

  setWebhook(params: {
    url: string;
    secretToken: string;
    allowedUpdates?: string[];
    dropPendingUpdates?: boolean;
    maxConnections?: number;
  }): Promise<boolean> {
    return this.call<boolean>('setWebhook', {
      url: params.url,
      secret_token: params.secretToken,
      allowed_updates: params.allowedUpdates ?? ['message', 'edited_message', 'callback_query'],
      drop_pending_updates: params.dropPendingUpdates ?? false,
      ...(params.maxConnections ? { max_connections: params.maxConnections } : {}),
    });
  }

  deleteWebhook(dropPendingUpdates = false): Promise<boolean> {
    return this.call<boolean>('deleteWebhook', { drop_pending_updates: dropPendingUpdates });
  }

  getWebhookInfo(): Promise<TgWebhookInfo> {
    return this.call<TgWebhookInfo>('getWebhookInfo');
  }

  /** Sends plain text, splitting on the 4096-char limit at line/space boundaries. */
  async sendMessage(chatId: number | string, text: string): Promise<TgMessage[]> {
    const parts = splitMessage(text, TELEGRAM_MAX_MESSAGE);
    const sent: TgMessage[] = [];
    for (const part of parts) {
      sent.push(await this.call<TgMessage>('sendMessage', { chat_id: chatId, text: part }));
    }
    return sent;
  }

  sendChatAction(chatId: number | string, action = 'typing'): Promise<boolean> {
    return this.call<boolean>('sendChatAction', { chat_id: chatId, action });
  }

  setMyCommands(commands: Array<{ command: string; description: string }>): Promise<boolean> {
    return this.call<boolean>('setMyCommands', { commands });
  }
}

export function splitMessage(text: string, max: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= max) return [trimmed];
  const parts: string[] = [];
  let rest = trimmed;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}
