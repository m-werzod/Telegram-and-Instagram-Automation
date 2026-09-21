import type { FastifyInstance } from 'fastify';
import { getPrisma } from '../../../db/client.js';
import { safeEqual } from '../../../lib/crypto.js';
import { recordAndEnqueueEvent } from '../../webhooks/service.js';
import type { TgUpdate } from './client.js';

/**
 * Telegram webhook endpoint. Authenticated via the per-connection secret token
 * Telegram echoes in X-Telegram-Bot-Api-Secret-Token (verified constant-time).
 * The event is persisted + deduplicated by update_id, then ACKed immediately;
 * processing happens on the queue (spec §24).
 */
export async function telegramWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { connectionId: string }; Body: TgUpdate }>(
    '/api/webhooks/telegram/:connectionId',
    { config: { rateLimit: false } },
    async (req, reply) => {
      const { connectionId } = req.params;
      const connection = await getPrisma().channelConnection.findUnique({
        where: { id: connectionId },
      });
      if (!connection || connection.channel !== 'TELEGRAM' || !connection.webhookSecret) {
        return reply.code(404).send();
      }

      const secret = req.headers['x-telegram-bot-api-secret-token'];
      if (typeof secret !== 'string' || !safeEqual(secret, connection.webhookSecret)) {
        req.log.warn({ connectionId }, 'telegram webhook with bad secret token');
        return reply.code(401).send();
      }

      const update = req.body;
      if (!update || typeof update.update_id !== 'number') {
        return reply.code(200).send({ ok: true }); // malformed — ack so Telegram stops retrying
      }

      // Dedup key includes the bot id: update_id sequences are per bot, so a
      // bot swap on the same connection must start a fresh dedup namespace.
      await recordAndEnqueueEvent({
        channel: 'TELEGRAM',
        eventKey: `${connection.id}:${connection.externalAccountId}:${update.update_id}`,
        tenantId: connection.tenantId,
        payload: { connectionId: connection.id, update },
      });

      return reply.code(200).send({ ok: true });
    },
  );
}
