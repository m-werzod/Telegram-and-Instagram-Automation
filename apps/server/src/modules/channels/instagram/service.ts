import type { ChannelConnection } from '@prisma/client';
import { getPrisma } from '../../../db/client.js';
import { getEnv } from '../../../config/env.js';
import { decryptSecret, encryptSecret } from '../../../lib/crypto.js';
import { ValidationError, errorMessage } from '../../../lib/errors.js';
import { childLogger } from '../../../lib/logger.js';
import { upsertManualAction, resolveManualAction } from '../../manual-actions/service.js';
import { InstagramClient } from './client.js';

/**
 * Instagram connection lifecycle (spec §16, §39). Everything the API permits is
 * automated (token validation, account discovery, per-account webhook
 * subscription, token refresh, health checks). Meta App Dashboard steps that
 * have no API are emitted as exact manual actions.
 */

interface InstagramCredentials {
  accessToken: string;
  /** epoch ms when the token was stored/refreshed (drives refresh scheduling). */
  obtainedAt: number;
}

const SUBSCRIBED_FIELDS = ['comments', 'messages'];

export function getInstagramClient(connection: ChannelConnection): InstagramClient {
  const env = getEnv();
  const creds = JSON.parse(
    decryptSecret(connection.credentialsEncrypted, env.ENCRYPTION_KEY),
  ) as InstagramCredentials;
  return new InstagramClient(creds.accessToken);
}

export async function connectInstagram(
  tenantId: string,
  accessToken: string,
): Promise<ChannelConnection> {
  const env = getEnv();
  const prisma = getPrisma();
  const log = childLogger({ module: 'instagram', tenantId });
  const token = accessToken.trim();
  if (token.length < 20) throw new ValidationError('Access token looks too short');

  // 1. Validate against the live API and discover the account.
  const client = new InstagramClient(token);
  const me = await client.getMe();
  const accountId = me.user_id ?? me.id;
  if (!accountId) throw new ValidationError('Could not resolve the Instagram account id from this token');

  // 2. Persist encrypted.
  const credentialsEncrypted = encryptSecret(
    JSON.stringify({ accessToken: token, obtainedAt: Date.now() } satisfies InstagramCredentials),
    env.ENCRYPTION_KEY,
  );
  const connection = await prisma.channelConnection.upsert({
    where: { tenantId_channel: { tenantId, channel: 'INSTAGRAM' } },
    create: {
      tenantId,
      channel: 'INSTAGRAM',
      status: 'connected',
      displayName: me.username ? `@${me.username}` : (me.name ?? 'Instagram account'),
      externalAccountId: String(accountId),
      credentialsEncrypted,
      metadata: { username: me.username ?? null, accountType: me.account_type ?? null },
    },
    update: {
      status: 'connected',
      displayName: me.username ? `@${me.username}` : (me.name ?? 'Instagram account'),
      externalAccountId: String(accountId),
      credentialsEncrypted,
      metadata: { username: me.username ?? null, accountType: me.account_type ?? null },
    },
  });

  // 3. Automate per-account webhook subscription (the part the API allows).
  let subscribed = false;
  try {
    await client.subscribeApps(SUBSCRIBED_FIELDS);
    subscribed = true;
    log.info({ fields: SUBSCRIBED_FIELDS }, 'subscribed_apps configured');
  } catch (err) {
    log.warn({ err: errorMessage(err) }, 'subscribed_apps failed — check permissions');
  }

  await prisma.channelConnection.update({
    where: { id: connection.id },
    data: {
      healthStatus: subscribed ? 'CONNECTED' : 'PERMISSION_REQUIRED',
      healthDetail: subscribed
        ? 'Token valid; account webhook subscription active. App-level webhook config must be completed in the Meta App Dashboard (see Manual Actions).'
        : 'Token valid but POST /me/subscribed_apps failed — the token likely lacks instagram_business_manage_comments / instagram_business_manage_messages.',
      lastHealthCheckAt: new Date(),
    },
  });

  // 4. Emit the exact Meta dashboard steps that cannot be automated (spec §16, §28).
  await createMetaManualActions(tenantId);
  return (await prisma.channelConnection.findUnique({ where: { id: connection.id } }))!;
}

export async function createMetaManualActions(tenantId: string): Promise<void> {
  const env = getEnv();
  const callbackUrl = env.APP_URL
    ? `${env.APP_URL.replace(/\/$/, '')}/api/webhooks/instagram`
    : '<your public HTTPS URL>/api/webhooks/instagram';

  await upsertManualAction(tenantId, {
    dedupKey: 'meta-webhook-config',
    platform: 'Meta',
    title: 'Configure Instagram webhooks in the Meta App Dashboard',
    officialUrl: 'https://developers.facebook.com/apps/',
    steps: [
      'Open https://developers.facebook.com/apps/ and select your app (must be a Business type app with the Instagram product added).',
      'In the left menu choose "Instagram" → "API setup with Instagram business login" → section "3. Configure webhooks" (or Products → Webhooks → subscribe to the "Instagram" object).',
      `Callback URL: enter exactly ${callbackUrl}`,
      'Verify token: enter exactly the META_VERIFY_TOKEN value shown on the dashboard Settings page (set one there first if it is empty — any random string you choose).',
      'Click "Verify and save" — the platform answers the verification challenge automatically.',
      'Subscribe to the webhook fields: "comments" and "messages".',
      'Set the app to Live mode (toggle at the top of the App Dashboard). Meta does not deliver webhooks for apps in Development mode.',
    ],
    expectedResult:
      'The dashboard shows the webhook as verified, and the Connections page here shows "webhook verified" after Meta\'s first delivery.',
    whatToReturn: 'A screenshot or confirmation that the webhook is verified and the app is Live.',
  });

  await upsertManualAction(tenantId, {
    dedupKey: 'ig-connected-tools',
    platform: 'Meta',
    title: 'Allow message access for connected tools on the Instagram account',
    officialUrl:
      'https://developers.facebook.com/documentation/business-messaging/instagram-messaging/get-started',
    steps: [
      'On the phone with the Instagram professional account, open the Instagram app.',
      'Go to Settings → Messages and story replies → Message controls → Connected tools.',
      'Toggle "Allow Access to Messages" ON.',
    ],
    expectedResult:
      'Instagram DM webhooks start arriving. Without this toggle, message events are silently never delivered.',
    whatToReturn: 'Confirmation that the toggle is ON.',
  });

  await upsertManualAction(tenantId, {
    dedupKey: 'meta-advanced-access',
    platform: 'Meta',
    title: 'App Review: Advanced Access for comment webhooks (and messaging beyond app-role users)',
    officialUrl: 'https://developers.facebook.com/docs/instagram-platform/app-review',
    steps: [
      'Note: with Standard Access, comment webhooks (comments/live_comments) are NOT delivered, and DMs only work with users who hold a role on your app. If this platform serves only your own account AND your testers hold app roles, you can develop first and do review later.',
      'Open your app in https://developers.facebook.com/apps/ → App Review → Permissions and Features.',
      'Request Advanced Access for: instagram_business_basic, instagram_business_manage_comments, instagram_business_manage_messages.',
      'Provide the requested screencast showing how your app uses each permission (connect account → agent replies to a comment → agent answers a DM).',
      'Complete Business Verification if prompted (required for tech providers).',
    ],
    expectedResult: 'Advanced Access granted for the three permissions; comment webhooks start arriving.',
    whatToReturn: 'The App Review approval status for each permission.',
  });
}

export async function disconnectInstagram(tenantId: string): Promise<void> {
  const prisma = getPrisma();
  const connection = await prisma.channelConnection.findUnique({
    where: { tenantId_channel: { tenantId, channel: 'INSTAGRAM' } },
  });
  if (!connection) return;
  await prisma.channelConnection.update({
    where: { id: connection.id },
    data: {
      status: 'disconnected',
      healthStatus: 'DISCONNECTED',
      healthDetail: '',
      credentialsEncrypted: '',
    },
  });
}

/** Called when a verified Instagram webhook arrives — proof the Meta config works. */
export async function markInstagramWebhookVerified(tenantId: string): Promise<void> {
  await resolveManualAction(tenantId, 'meta-webhook-config');
}

/** Refresh the 60-day token when it is older than 7 days (token must be ≥24h old). */
export async function refreshInstagramTokenIfDue(connection: ChannelConnection): Promise<void> {
  const env = getEnv();
  const prisma = getPrisma();
  if (!connection.credentialsEncrypted) return;
  const creds = JSON.parse(
    decryptSecret(connection.credentialsEncrypted, env.ENCRYPTION_KEY),
  ) as InstagramCredentials;
  const ageDays = (Date.now() - (creds.obtainedAt ?? 0)) / 86_400_000;
  if (ageDays < 7) return;

  const client = new InstagramClient(creds.accessToken);
  const refreshed = await client.refreshAccessToken();
  await prisma.channelConnection.update({
    where: { id: connection.id },
    data: {
      credentialsEncrypted: encryptSecret(
        JSON.stringify({ accessToken: refreshed.access_token, obtainedAt: Date.now() }),
        env.ENCRYPTION_KEY,
      ),
    },
  });
  childLogger({ module: 'instagram', tenantId: connection.tenantId }).info(
    { expiresInDays: Math.round(refreshed.expires_in / 86_400) },
    'instagram token refreshed',
  );
}

/** Live health check (spec §27). */
export async function checkInstagramHealth(connection: ChannelConnection): Promise<{
  status: 'CONNECTED' | 'DEGRADED' | 'AUTH_REQUIRED' | 'PERMISSION_REQUIRED' | 'DISCONNECTED';
  detail: string;
}> {
  if (connection.status !== 'connected' || !connection.credentialsEncrypted) {
    return { status: 'DISCONNECTED', detail: 'Not connected' };
  }
  const client = getInstagramClient(connection);
  try {
    const me = await client.getMe();
    // Opportunistic token refresh keeps the 60-day token alive indefinitely.
    try {
      await refreshInstagramTokenIfDue(connection);
    } catch (err) {
      return {
        status: 'DEGRADED',
        detail: `Token valid but refresh failed: ${errorMessage(err)}`,
      };
    }
    return {
      status: 'CONNECTED',
      detail: `Token valid for @${me.username ?? connection.externalAccountId}`,
    };
  } catch (err) {
    const msg = errorMessage(err);
    if (msg.includes('401') || msg.includes('code 190')) {
      return { status: 'AUTH_REQUIRED', detail: 'Access token expired or revoked — reconnect the account' };
    }
    if (msg.includes('403') || msg.includes('code 10') || msg.includes('code 200')) {
      return { status: 'PERMISSION_REQUIRED', detail: msg };
    }
    return { status: 'DEGRADED', detail: msg };
  }
}
