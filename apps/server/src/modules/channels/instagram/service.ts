import type { ChannelConnection } from '@prisma/client';
import { getPrisma } from '../../../db/client.js';
import { getEnv } from '../../../config/env.js';
import { decryptSecret, encryptSecret } from '../../../lib/crypto.js';
import { ValidationError, errorMessage } from '../../../lib/errors.js';
import { childLogger } from '../../../lib/logger.js';
import { isPubliclyReachable } from '../shared/reachability.js';
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

  // 2. If this token belongs to a DIFFERENT account than the one currently
  //    automated, release the old one FIRST. Overwriting the row alone leaves
  //    the previous account subscribed at Meta: its comments and DMs keep
  //    arriving here forever, matching no connection and silently discarded.
  //    That is what a handover to a real business owner must not leave behind.
  const previous = await prisma.channelConnection.findUnique({
    where: { tenantId_channel: { tenantId, channel: 'INSTAGRAM' } },
  });
  const switchedAccount =
    previous?.status === 'connected' &&
    Boolean(previous.credentialsEncrypted) &&
    previous.externalAccountId !== String(accountId);
  const release = switchedAccount
    ? await releaseInstagramAccount(previous!, 'replaced by a different Instagram account')
    : null;

  // 3. Persist encrypted.
  const credentialsEncrypted = encryptSecret(
    JSON.stringify({ accessToken: token, obtainedAt: Date.now() } satisfies InstagramCredentials),
    env.ENCRYPTION_KEY,
  );
  const metadata = {
    username: me.username ?? null,
    accountType: me.account_type ?? null,
    // What happened to the account that was automated until now, so the
    // dashboard can state it instead of implying a clean handover.
    ...(switchedAccount
      ? {
          previousAccount: {
            displayName: previous!.displayName,
            externalAccountId: previous!.externalAccountId,
            releasedAt: new Date().toISOString(),
            released: release?.released ?? false,
            error: release?.error ?? null,
          },
        }
      : {}),
  };
  const connection = await prisma.channelConnection.upsert({
    where: { tenantId_channel: { tenantId, channel: 'INSTAGRAM' } },
    create: {
      tenantId,
      channel: 'INSTAGRAM',
      status: 'connected',
      displayName: me.username ? `@${me.username}` : (me.name ?? 'Instagram account'),
      externalAccountId: String(accountId),
      credentialsEncrypted,
      metadata,
    },
    update: {
      status: 'connected',
      displayName: me.username ? `@${me.username}` : (me.name ?? 'Instagram account'),
      externalAccountId: String(accountId),
      credentialsEncrypted,
      metadata,
    },
  });

  // 4. Automate per-account webhook subscription (the part the API allows).
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

  // 5. Emit the exact Meta dashboard steps that cannot be automated (spec §16, §28).
  await createMetaManualActions(tenantId);

  if (switchedAccount) {
    log.info(
      { from: previous!.displayName, to: connection.displayName, released: release?.released },
      'instagram account switched',
    );
    await prisma.auditLog
      .create({
        data: {
          tenantId,
          action: 'connection.instagram.switched',
          resource: 'channel_connection',
          resourceId: connection.id,
          detail: {
            from: { account: previous!.displayName, externalAccountId: previous!.externalAccountId },
            to: { account: connection.displayName, externalAccountId: connection.externalAccountId },
            previousAccountReleased: release?.released ?? false,
            releaseError: release?.error ?? null,
          },
        },
      })
      .catch(() => undefined);
  }
  return (await prisma.channelConnection.findUnique({ where: { id: connection.id } }))!;
}

/**
 * Cut an Instagram account off from this platform: delete its webhook
 * subscription so Meta stops delivering its events here.
 *
 * Best effort by design — the stored token may already be expired or revoked,
 * and a handover must not be blocked by an account that cannot be reached. The
 * outcome is returned so the caller can report honestly rather than claim a
 * clean release that did not happen.
 */
export async function releaseInstagramAccount(
  connection: ChannelConnection,
  reason: string,
): Promise<{ released: boolean; error: string | null }> {
  const log = childLogger({ module: 'instagram', tenantId: connection.tenantId });
  if (!connection.credentialsEncrypted) return { released: false, error: 'no stored credentials' };

  let released = false;
  let error: string | null = null;
  try {
    await getInstagramClient(connection).unsubscribeApps();
    released = true;
    log.info({ account: connection.displayName, reason }, 'instagram account released');
  } catch (err) {
    error = errorMessage(err);
    log.warn({ account: connection.displayName, reason, err: error }, 'could not release instagram account');
  }

  // Raised whether or not the unsubscribe worked, because it is a different
  // thing: unsubscribing stops webhook DELIVERY, it does not revoke the access
  // token this platform still holds for that account. Only the account's owner
  // can do that, in Instagram's own settings — there is no API for an app to
  // revoke an Instagram-Login grant on a user's behalf. A handover that skips
  // it leaves the previous owner's account still reachable by this app until
  // the 60-day token lapses.
  await upsertManualAction(connection.tenantId, {
    dedupKey: `ig-revoke-${connection.externalAccountId}`,
    platform: 'Instagram',
    title: `Revoke this platform's access on the previous account ${connection.displayName}`,
    officialUrl: 'https://www.instagram.com/accounts/manage_access_tools/',
    steps: [
      released
        ? `Webhook delivery for ${connection.displayName} has been switched off from here, so no new comments or DMs from it reach this platform.`
        : `Webhook delivery for ${connection.displayName} could NOT be switched off from here (${error}). Until the step below is done, Meta may keep delivering that account's events to this server — they are discarded, but the subscription is still live.`,
      'The stored access token has been discarded, but only the account owner can revoke the app grant itself.',
      `On the phone signed in as ${connection.displayName}: Instagram app → Settings and privacy → Apps and websites (or Website permissions) → Active.`,
      'Find this platform in the list and press Remove.',
      'If the account is also managed in Meta Business Suite, check Business settings → Integrations → Connected apps as well.',
    ],
    expectedResult: `This platform no longer appears under Apps and websites for ${connection.displayName}, and that account is fully detached from the automation.`,
    whatToReturn: 'Nothing — mark this done once the app no longer appears in that list.',
  }).catch(() => undefined);

  return { released, error };
}

export async function createMetaManualActions(tenantId: string): Promise<void> {
  const env = getEnv();
  const appUrl = env.APP_URL?.replace(/\/$/, '');
  const callbackUrl = appUrl
    ? `${appUrl}/api/webhooks/instagram`
    : '<your public HTTPS URL>/api/webhooks/instagram';

  // Unlike Telegram — which quietly degrades to long-polling — Instagram has no
  // pull mode at all: if Meta cannot POST to this URL, not one comment or DM
  // ever arrives and nothing anywhere reports an error. So probe the address we
  // are about to tell the operator to paste into Meta, and lead with the truth
  // when it does not actually reach this server.
  const reachable = appUrl ? await isPubliclyReachable(appUrl) : false;
  const unreachableWarning = appUrl
    ? `BLOCKER — ${appUrl} does not currently reach this server: a request to ${appUrl}/api/health was answered by something else (or not at all). Meta delivers Instagram events by POST only, so until this address routes here, no comment and no DM can ever arrive, however correctly the rest is configured. This is a hosting/network setting (ports 80/443 routed to this machine, a real domain, or a tunnel), not something the app can fix. Note Meta requires port 443 — a URL with a custom port will not be accepted.`
    : 'BLOCKER — APP_URL is not set, so there is no address to give Meta. Set APP_URL in .env to the public HTTPS base URL of this server and restart.';

  await upsertManualAction(tenantId, {
    dedupKey: 'meta-webhook-config',
    platform: 'Meta',
    title: 'Configure Instagram webhooks in the Meta App Dashboard',
    officialUrl: 'https://developers.facebook.com/apps/',
    steps: [
      ...(reachable ? [] : [unreachableWarning]),
      'Open https://developers.facebook.com/apps/ and select your app (must be a Business type app with the Instagram product added).',
      'In the left menu choose "Instagram" → "API setup with Instagram business login" → section "3. Configure webhooks" (or Products → Webhooks → subscribe to the "Instagram" object).',
      `Callback URL: ${callbackUrl}`,
      'IMPORTANT — the callback URL must present a publicly-trusted TLS certificate. Meta refuses self-issued ones, so if this server answers on a self-signed certificate (the Connections page says "long-polling" for Telegram for the same reason), use the public HTTPS address the dashboard itself is served from, keeping the /api/webhooks/instagram path.',
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
  // Unsubscribe BEFORE the token is discarded — afterwards there is no way to
  // tell Meta to stop, and it keeps delivering this account's events here.
  const release = await releaseInstagramAccount(connection, 'disconnected by an administrator');
  await prisma.channelConnection.update({
    where: { id: connection.id },
    data: {
      status: 'disconnected',
      healthStatus: 'DISCONNECTED',
      healthDetail: release.released
        ? ''
        : `Disconnected here, but Meta was not told to stop sending events: ${release.error}. Remove this platform under Instagram → Settings → Apps and websites if it keeps delivering.`,
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
