/**
 * Worker handler for scheduled message job.
 * Processes ScheduledMessage queue items (send to Telegram, update schedule).
 */

import { sendScheduledMessage } from '../modules/telegram-scheduled/service.js';
import type { JobHandler } from '../queue/types.js';

export const scheduledMessageHandler: JobHandler<'scheduled-message:send'> = async (payload) => {
  await sendScheduledMessage(payload.scheduledMessageId);
};
