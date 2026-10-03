import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getPrisma } from '../../../db/client.js';
import { hmacSha256Hex, safeEqual } from '../../../lib/crypto.js';
import { resolveGlobalSetting } from '../../settings/service.js';
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
    const verifyToken = await resolveGlobalSetting('META_VERIFY_TOKEN');
    const q = req.query as Record<string, string | undefined>;
    const mode = q['hub.mode'];
    const token = q['hub.verify_token'];
    const challenge = q['hub.challenge'];

    if (mode === 'subscribe' && verifyToken && token === verifyToken && challenge) {
      req.log.info('instagram webhook verification succeeded');
      return reply.code(200).type('text/plain').send(challenge);
    }
    req.log.warn('instagram webhook verification failed (mode/token mismatch)');
    return reply.code(403).send();
  });

  app.post('/api/webhooks/instagram', { config: { rateLimit: false } }, async (req, reply) => {
    const appSecret = await resolveGlobalSetting('META_APP_SECRET');
    if (!appSecret) {
      req.log.error('META_APP_SECRET not configured (Settings page or env) — rejecting webhook');
      return reply.code(503).send();
    }

    const signature = req.headers['x-hub-signature-256'];
    const rawBody = (req as FastifyRequest & { rawBody?: Buffer }).rawBody;
    if (typeof signature !== 'string' || !rawBody) {
      return reply.code(401).send();
    }
    const expected = `sha256=${hmacSha256Hex(appSecret, rawBody)}`;
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

    // Meta batches up to 1000 updates per POST and expects a 200 within ~5s.
    // Lookups are memoized per account id and entries persist in parallel, so
    // latency is bounded by the slowest entry, not the sum of all of them.
    const prisma = getPrisma();
    const connectionCache = new Map<string, Promise<{ id: string; tenantId: string } | null>>();
    const verifiedTenants = new Set<string>();

    await Promise.all(
      body.entry.map(async (entry) => {
        const accountId = String(entry.id);
        if (!connectionCache.has(accountId)) {
          connectionCache.set(
            accountId,
            prisma.channelConnection.findFirst({
              where: { channel: 'INSTAGRAM', externalAccountId: accountId },
              select: { id: true, tenantId: true },
            }),
          );
        }
        const connection = await connectionCache.get(accountId)!;
        const tenantId = connection?.tenantId ?? null;
        if (tenantId && !verifiedTenants.has(tenantId)) {
          verifiedTenants.add(tenantId);
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
            payload: { kind: 'comment', accountId, field: change.field, value: change.value },
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
            payload: { kind: 'dm', accountId, messaging },
          });
        }
      }),
    );

    return reply.code(200).send();
  });
}
