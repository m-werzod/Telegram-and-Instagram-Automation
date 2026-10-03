import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../lib/errors.js';
import {
  createMediaAsset,
  deleteMediaAsset,
  getPublicMediaAsset,
  listMediaAssets,
  MAX_IMAGE_BYTES,
  updateMediaAsset,
} from '../modules/media/service.js';
import { requireAdmin, requireAuth, tenantOf } from './middleware.js';

/**
 * Media library management (authenticated) + public raw serving.
 * The public route exposes bytes only — names/descriptions stay private — and
 * ids are unguessable cuids; Instagram fetches attachment URLs from here.
 */
export async function mediaRoutes(app: FastifyInstance): Promise<void> {
  // ── Public raw bytes (no auth): /files/media/:id ──────────────────────────
  app.get<{ Params: { id: string } }>('/files/media/:id', async (req, reply) => {
    const asset = await getPublicMediaAsset(req.params.id);
    if (!asset) return reply.code(404).send();
    return reply
      .header('content-type', asset.mimeType)
      .header('content-length', String(asset.data.length))
      .header('cache-control', 'public, max-age=86400, immutable')
      .send(Buffer.from(asset.data));
  });

  // ── Authenticated management API ──────────────────────────────────────────
  app.register(async (authed) => {
    authed.addHook('preHandler', requireAuth);

    authed.get('/api/media', async (req) => {
      const assets = await listMediaAssets(tenantOf(req));
      return { assets };
    });

    authed.post('/api/media', async (req) => {
      requireAdmin(req);
      if (!req.isMultipart()) throw new ValidationError('Expected multipart/form-data with an image file');
      const file = await req.file({ limits: { fileSize: MAX_IMAGE_BYTES } });
      if (!file) throw new ValidationError('No file uploaded');
      const data = await file.toBuffer();
      const fields = file.fields as Record<string, { value?: unknown } | Array<{ value?: unknown }> | undefined>;
      const fieldValue = (name: string): string => {
        const f = fields[name];
        const v = Array.isArray(f) ? f[0]?.value : f?.value;
        return typeof v === 'string' ? v : '';
      };
      const asset = await createMediaAsset(tenantOf(req), {
        name: fieldValue('name') || file.filename,
        description: fieldValue('description'),
        mimeType: file.mimetype,
        data,
      });
      return { asset };
    });

    authed.patch<{ Params: { id: string } }>('/api/media/:id', async (req) => {
      requireAdmin(req);
      const body = z
        .object({ name: z.string().min(1).max(200).optional(), description: z.string().max(1000).optional() })
        .safeParse(req.body ?? {});
      if (!body.success) throw new ValidationError('Invalid media update', body.error.issues);
      const asset = await updateMediaAsset(tenantOf(req), req.params.id, body.data);
      return { asset };
    });

    authed.delete<{ Params: { id: string } }>('/api/media/:id', async (req) => {
      requireAdmin(req);
      await deleteMediaAsset(tenantOf(req), req.params.id);
      return { ok: true };
    });
  });
}
