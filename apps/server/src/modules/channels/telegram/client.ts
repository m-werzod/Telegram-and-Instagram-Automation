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
  /** Present on messages in chats of a connected personal account (Telegram Business). */
  business_connection_id?: string;
}

/** Owner-granted permissions of a connected business bot (subset we use). */
export interface TgBusinessBotRights {
  can_reply?: boolean;
  can_read_messages?: boolean;
}

/**
 * A Telegram Business connection: the owner's PERSONAL account delegated its
 * private chats to this bot (Settings → Chat Automation / Telegram Business).
 */
export interface TgBusinessConnection {
  id: string;
  user: TgUser;
  user_chat_id: number;
  date: number;
  rights?: TgBusinessBotRights;
  is_enabled: boolean;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: { id: string; from: TgUser; data?: string; message?: TgMessage };
  /** Personal account connected/disconnected/edited the business connection. */
  business_connection?: TgBusinessConnection;
  /** New message in a private chat of the connected personal account. */
  business_message?: TgMessage;
  edited_business_message?: TgMessage;
  deleted_business_messages?: { business_connection_id: string; chat: { id: number }; message_ids: number[] };
}

/** Telegram sendMessage hard limit: 4096 characters after entity parsing. */
export const TELEGRAM_MAX_MESSAGE = 4096;

export class TelegramClient {
  constructor(
    private readonly token: string,
    private readonly baseUrl = 'https://api.telegram.org',
  ) {}

  private async call<T>(method: string, params?: Record<string, unknown> | FormData): Promise<T> {
    const isForm = params instanceof FormData;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: isForm ? undefined : { 'content-type': 'application/json' },
        body: isForm ? params : params ? JSON.stringify(params) : undefined,
        signal: AbortSignal.timeout(60_000),
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

  /**
   * Long-poll for updates (the no-webhook alternative — Bot API §getUpdates).
   * Telegram will not deliver updates via getUpdates while a webhook is set;
   * callers must deleteWebhook() first. Passing `offset` acknowledges every
   * update with id < offset as received, so Telegram won't resend it.
   */
  getUpdates(params: {
    offset?: number;
    timeout?: number;
    allowedUpdates?: string[];
  }): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>('getUpdates', {
      offset: params.offset,
      timeout: params.timeout ?? 30,
      allowed_updates: params.allowedUpdates ?? [
        'message',
        'edited_message',
        'callback_query',
        'business_connection',
        'business_message',
        'edited_business_message',
        'deleted_business_messages',
      ],
    });
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
      // An explicit allowed_updates list FILTERS OUT everything unnamed — the
      // Telegram Business update types must be listed or personal-account
      // messages silently never arrive.
      allowed_updates: params.allowedUpdates ?? [
        'message',
        'edited_message',
        'callback_query',
        'business_connection',
        'business_message',
        'edited_business_message',
        'deleted_business_messages',
      ],
      drop_pending_updates: params.dropPendingUpdates ?? false,
      ...(params.maxConnections ? { max_connections: params.maxConnections } : {}),
    });
  }

  /** Re-fetch a business connection's current state/rights (health checks). */
  getBusinessConnection(businessConnectionId: string): Promise<TgBusinessConnection> {
    return this.call<TgBusinessConnection>('getBusinessConnection', {
      business_connection_id: businessConnectionId,
    });
  }

  deleteWebhook(dropPendingUpdates = false): Promise<boolean> {
    return this.call<boolean>('deleteWebhook', { drop_pending_updates: dropPendingUpdates });
  }

  getWebhookInfo(): Promise<TgWebhookInfo> {
    return this.call<TgWebhookInfo>('getWebhookInfo');
  }

  /**
   * Sends plain text, splitting on the 4096-char limit at line/space
   * boundaries. With businessConnectionId set, the message is sent ON BEHALF
   * OF the connected personal account (appears as the account, not the bot).
   */
  async sendMessage(
    chatId: number | string,
    text: string,
    opts: { businessConnectionId?: string } = {},
  ): Promise<TgMessage[]> {
    const parts = splitMessage(text, TELEGRAM_MAX_MESSAGE);
    const sent: TgMessage[] = [];
    for (const part of parts) {
      sent.push(
        await this.call<TgMessage>('sendMessage', {
          chat_id: chatId,
          text: part,
          ...(opts.businessConnectionId
            ? { business_connection_id: opts.businessConnectionId }
            : {}),
        }),
      );
    }
    return sent;
  }

  sendChatAction(
    chatId: number | string,
    action = 'typing',
    opts: { businessConnectionId?: string } = {},
  ): Promise<boolean> {
    return this.call<boolean>('sendChatAction', {
      chat_id: chatId,
      action,
      ...(opts.businessConnectionId ? { business_connection_id: opts.businessConnectionId } : {}),
    });
  }

  setMyCommands(commands: Array<{ command: string; description: string }>): Promise<boolean> {
    return this.call<boolean>('setMyCommands', { commands });
  }

  /** Display name shown at the top of the chat (≤64 chars). */
  setMyName(name: string): Promise<boolean> {
    return this.call<boolean>('setMyName', { name: name.slice(0, 64) });
  }

  /** Bot description shown on the empty chat screen (≤512 chars). */
  setMyDescription(description: string): Promise<boolean> {
    return this.call<boolean>('setMyDescription', { description: description.slice(0, 512) });
  }

  /** Short description shown on the bot's profile page (≤120 chars). */
  setMyShortDescription(shortDescription: string): Promise<boolean> {
    return this.call<boolean>('setMyShortDescription', {
      short_description: shortDescription.slice(0, 120),
    });
  }

  /**
   * Sends a photo. Bytes are uploaded via multipart/form-data (no public URL
   * required). Caption ≤1024 chars. With businessConnectionId the photo is
   * sent on behalf of the connected personal account.
   */
  async sendPhoto(
    chatId: number | string,
    photo: { data: Buffer; filename: string; contentType: string },
    opts: { caption?: string; businessConnectionId?: string } = {},
  ): Promise<TgMessage> {
    const form = new FormData();
    form.set('chat_id', String(chatId));
    form.set(
      'photo',
      new Blob([new Uint8Array(photo.data)], { type: photo.contentType }),
      photo.filename,
    );
    if (opts.caption) form.set('caption', opts.caption.slice(0, 1024));
    if (opts.businessConnectionId) form.set('business_connection_id', opts.businessConnectionId);
    return this.call<TgMessage>('sendPhoto', form);
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
