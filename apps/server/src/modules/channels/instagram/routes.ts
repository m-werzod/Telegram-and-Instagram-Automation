import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getEnv } from '../../../config/env.js';
import { getPrisma } from '../../../db/client.js';
import { hmacSha256Hex, safeEqual } from '../../../lib/crypto.js';
import { recordAndEnqueueEvent } from '../../webhooks/service.js';
import { markInstagramWebhookVerified } from './service.js';

/**
 * Meta webhook endpoint for Instagram (object: "instagram").
 *  - GET  /api/webhooks/instagram  — verification handshake (hub.challenge echo)
 *  - POST /api/webhooks/instagram  — signed event notifications
 *
 * Signature: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(raw body, app secret),
 * verified constant-time over the RAW body. Payloads are batched: each atomic
 * item (comment change / messaging event) is persisted as its own deduplicated
 * WebhookEvent, then the request is ACKed immediately (5-second budget).
 */
export async function instagramWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/webhooks/instagram', { config: { rateLimit: false } }, async (req, reply) => {
    const env = getEnv();
    const q = req.query as Record<string, string | undefined>;
    const mode = q['hub.mode'];
    const token = q['hub.verify_token'];
    const challenge = q['hub.challenge'];

    if (mode === 'subscribe' && env.META_VERIFY_TOKEN && token === env.META_VERIFY_TOKEN && challenge) {
      req.log.info('instagram webhook verification succeeded');
      return reply.code(200).type('text/plain').send(challenge);
    }
    req.log.warn('instagram webhook verification failed (mode/token mismatch)');
    return reply.code(403).send();
  });

  app.post('/api/webhooks/instagram', { config: { rateLimit: false } }, async (req, reply) => {
    const env = getEnv();
    if (!env.META_APP_SECRET) {
      req.log.error('META_APP_SECRET not configured — rejecting webhook');
      return reply.code(503).send();
    }

    const signature = req.headers['x-hub-signature-256'];
    const rawBody = (req as FastifyRequest & { rawBody?: Buffer }).rawBody;
    if (typeof signature !== 'string' || !rawBody) {
      return reply.code(401).send();
    }
    const expected = `sha256=${hmacSha256Hex(env.META_APP_SECRET, rawBody)}`;
    if (!safeEqual(signature, expected)) {
      req.log.warn('instagram webhook signature mismatch');
      return reply.code(401).send();
    }

    const body = req.body as {
      object?: string;
      entry?: Array<{
        id: string;
        time?: number;
        changes?: Array<{ field: string; value: Record<string, unknown> }>;
        messaging?: Array<Record<string, unknown>>;
      }>;
    };

    if (body?.object !== 'instagram' || !Array.isArray(body.entry)) {
      return reply.code(200).send(); // not for us; ack to stop retries
    }

    const prisma = getPrisma();
    for (const entry of body.entry) {
      const connection = await prisma.channelConnection.findFirst({
        where: { channel: 'INSTAGRAM', externalAccountId: String(entry.id) },
      });
      const tenantId = connection?.tenantId ?? null;
      if (tenantId) {
        // First verified delivery proves the Meta dashboard config works.
        await markInstagramWebhookVerified(tenantId).catch(() => undefined);
      }

      for (const change of entry.changes ?? []) {
        if (change.field !== 'comments' && change.field !== 'live_comments') continue;
        const commentId = String((change.value as { id?: unknown }).id ?? '');
        if (!commentId) continue;
        await recordAndEnqueueEvent({
          channel: 'INSTAGRAM',
          eventKey: `comment:${commentId}`,
          tenantId,
          payload: { kind: 'comment', accountId: String(entry.id), field: change.field, value: change.value },
        });
      }

      for (const messaging of entry.messaging ?? []) {
        const msg = messaging as {
          sender?: { id?: string };
          message?: { mid?: string; is_echo?: boolean };
          read?: unknown;
          reaction?: unknown;
        };
        // Only inbound user messages; echoes/read receipts/reactions are ignored.
        if (!msg.message?.mid || msg.message.is_echo) continue;
        await recordAndEnqueueEvent({
          channel: 'INSTAGRAM',
          eventKey: `message:${msg.message.mid}`,
          tenantId,
          payload: { kind: 'dm', accountId: String(entry.id), messaging },
        });
      }
    }

    return reply.code(200).send();
  });
}
