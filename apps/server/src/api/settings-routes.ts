import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getEnv } from '../config/env.js';
import { getPrisma } from '../db/client.js';
import { ValidationError } from '../lib/errors.js';
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
      await setSetting(tenantOf(req), key, value.data);
      await audit(req, 'settings.set', key);
      return { settings: await settingsStatus(tenantOf(req)) };
    },
  );

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
