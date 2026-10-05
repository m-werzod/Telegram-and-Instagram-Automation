import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getEnv } from '../config/env.js';
import { getPrisma } from '../db/client.js';
import { ValidationError } from '../lib/errors.js';
import {
  checkTenantAIKey,
  keyNameForProvider,
  providerForKey,
  verifyAnthropicKey,
  verifyOpenAIKey,
} from '../modules/ai/index.js';
import {
  clearSetting,
  isSettingKey,
  setSetting,
  settingsStatus,
} from '../modules/settings/service.js';
import { requireAdmin, requireAuth, tenantOf } from './middleware.js';

/**
 * Platform settings (ADMIN): paste/rotate the Anthropic API key and the Meta
 * app credentials from the dashboard with no redeploy. Values are stored
 * encrypted; the API returns only masked previews and source info.
 */
export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/api/settings', async (req) => {
    requireAdmin(req);
    const env = getEnv();
    const settings = await settingsStatus(tenantOf(req));
    const appUrl = env.APP_URL?.replace(/\/$/, '') ?? null;
    return {
      settings,
      urls: {
        appUrl,
        instagramWebhook: appUrl ? `${appUrl}/api/webhooks/instagram` : null,
        mediaBase: appUrl ? `${appUrl}/files/media/` : null,
      },
    };
  });

  app.put<{ Params: { key: string }; Body: { value?: string } }>(
    '/api/settings/:key',
    async (req) => {
      requireAdmin(req);
      const key = req.params.key.toUpperCase();
      if (!isSettingKey(key)) throw new ValidationError('Unknown setting key');
      const value = z.string().min(1).max(4000).safeParse(req.body?.value);
      if (!value.success) throw new ValidationError('value is required');

      // An AI key is the one credential every agent depends on, and a wrong
      // one fails silently: the save succeeds, agents stay "enabled", and every
      // inbound message then dies at a 401 inside the AI execution log. So:
      //
      //  1. Read which provider ISSUED the key from its prefix and file it
      //     under that provider, whichever box it was pasted into. Operators
      //     buy one key and paste it wherever they happened to open — storing
      //     an OpenAI key in the Anthropic slot guarantees a dead platform.
      //  2. Verify it against that provider BEFORE storing (free, zero-token
      //     metadata call) and refuse an invalid key with an actionable message.
      //
      // A check that cannot complete (network/429/5xx) must not block a
      // legitimate key, so only an explicit rejection rejects.
      let storedKey = key;
      let warning: string | undefined;
      let notice: string | undefined;
      if (key === 'ANTHROPIC_API_KEY' || key === 'OPENAI_API_KEY') {
        const chosen = key === 'OPENAI_API_KEY' ? 'openai' : 'anthropic';
        // An unrecognisable prefix proves nothing — trust the operator's choice.
        const issuer = providerForKey(value.data) ?? chosen;
        storedKey = keyNameForProvider(issuer);

        const openai = issuer === 'openai';
        const label = openai ? 'OpenAI' : 'Anthropic';
        const hint = openai
          ? '"sk-" bilan boshlanadi — uni https://platform.openai.com/api-keys sahifasidan oling'
          : '"sk-ant-" bilan boshlanadi — uni https://platform.claude.com → Settings → API keys sahifasidan oling';
        const check = openai
          ? await verifyOpenAIKey(value.data.trim())
          : await verifyAnthropicKey(value.data.trim());
        if (check.status === 'rejected') {
          throw new ValidationError(
            `${label} bu kalitni qabul qilmadi (${check.detail}). To'g'ri kalit ${hint}. Kalit saqlanmadi.`,
          );
        }
        if (check.status === 'unknown') {
          warning = `Kalit saqlandi, lekin ${label}'da tekshirib bo'lmadi (${check.detail}). "Tekshirish" tugmasi bilan keyinroq tasdiqlang.`;
        }
        if (issuer !== chosen) {
          notice = `Bu ${label} kaliti ekan — shuning uchun u ${label} maydoniga saqlandi. Agentlar avtomatik ${label} modeliga o'tadi.`;
        }
      }

      await setSetting(tenantOf(req), storedKey, value.data);
      await audit(req, 'settings.set', storedKey);
      return {
        settings: await settingsStatus(tenantOf(req)),
        ...(warning ? { warning } : {}),
        ...(notice ? { notice } : {}),
      };
    },
  );

  /**
   * On-demand check of a stored AI key ("is my AI key still usable?"). Costs
   * no tokens, and reports the key's real state rather than merely whether a
   * value is present.
   */
  app.post<{ Params: { key: string } }>('/api/settings/:key/verify', async (req) => {
    requireAdmin(req);
    const key = req.params.key.toUpperCase();
    if (key !== 'ANTHROPIC_API_KEY' && key !== 'OPENAI_API_KEY') {
      throw new ValidationError('That setting cannot be verified');
    }
    const health = await checkTenantAIKey(
      tenantOf(req),
      key === 'OPENAI_API_KEY' ? 'openai' : 'anthropic',
    );
    return { verification: health };
  });

  app.delete<{ Params: { key: string } }>('/api/settings/:key', async (req) => {
    requireAdmin(req);
    const key = req.params.key.toUpperCase();
    if (!isSettingKey(key)) throw new ValidationError('Unknown setting key');
    await clearSetting(tenantOf(req), key);
    await audit(req, 'settings.clear', key);
    return { settings: await settingsStatus(tenantOf(req)) };
  });
}

async function audit(req: { tenantId?: string; user?: { id: string } }, action: string, key: string): Promise<void> {
  await getPrisma()
    .auditLog.create({
      data: {
        tenantId: req.tenantId!,
        userId: req.user?.id ?? null,
        action,
        resource: 'setting',
        resourceId: key,
      },
    })
    .catch(() => undefined);
}
