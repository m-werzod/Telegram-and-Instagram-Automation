import type { ChannelConnection } from '@prisma/client';
import { getPrisma } from '../../../db/client.js';
import { getEnv } from '../../../config/env.js';
import { decryptSecret, encryptSecret } from '../../../lib/crypto.js';
import { ValidationError, errorMessage } from '../../../lib/errors.js';
import { childLogger } from '../../../lib/logger.js';
import { isPubliclyReachable } from '../shared/reachability.js';
import { resolveGlobalSetting } from '../../settings/service.js';
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

/**
 * Webhook fields this platform needs on every connected account.
 *
 * `comments` and `messages` are not optional extras: Instagram has no pull
 * mode, so an account that is not subscribed to them delivers NOTHING, for
 * ever, while every other check still passes. They are therefore treated as
 * part of being connected, not as a nice-to-have (see
 * `ensureInstagramSubscription`).
 */
const REQUIRED_FIELDS = ['comments', 'messages'] as const;

/**
 * What is asked for first. `live_comments` is wanted — comments during a live
 * broadcast arrive on their own field and the handler already routes them —
 * but it is NOT required, because `POST /me/subscribed_apps` rejects the whole
 * call if any single field is unavailable to the app. Asking for the wider set
 * and falling back to the required one means an app that cannot have
 * live_comments still ends up correctly subscribed instead of unsubscribed.
 */
const PREFERRED_FIELDS = ['comments', 'live_comments', 'messages'] as const;

/**
 * What Meta says this account's webhook subscription actually is, right now.
 *
 * `ok` means every REQUIRED_FIELD is live, which is the only state in which a
 * comment or a DM can reach this server at all.
 */
export interface SubscriptionState {
  ok: boolean;
  /** Fields Meta reports as subscribed (empty when the edge could not be read). */
  fields: string[];
  missing: string[];
  /** Whether GET /me/subscribed_apps could be read at all. */
  readable: boolean;
  /** Set when this call had to (re-)subscribe the account. */
  repaired: boolean;
  error: string | null;
}

function uniqueFields(subs: Array<{ subscribed_fields?: string[] }>): string[] {
  return [...new Set(subs.flatMap((sub) => sub.subscribed_fields ?? []))];
}

/**
 * Subscribe, preferring the wider field set and falling back to the required
 * one. A single unavailable field (typically `live_comments`, which needs
 * Advanced Access) rejects the entire POST, so one request is not enough.
 */
async function subscribeWithFallback(
  client: InstagramClient,
): Promise<{ ok: boolean; fields: string[]; error: string | null }> {
  const attempts: Array<readonly string[]> = [PREFERRED_FIELDS, REQUIRED_FIELDS];
  let lastError: string | null = null;
  for (const fields of attempts) {
    try {
      await client.subscribeApps([...fields]);
      return { ok: true, fields: [...fields], error: lastError };
    } catch (err) {
      lastError = errorMessage(err);
    }
  }
  return { ok: false, fields: [], error: lastError };
}

/**
 * Make sure Meta is actually subscribed to deliver this account's comments and
 * DMs here — and say so honestly when it is not.
 *
 * This is the fix for the failure that makes Instagram automation look
 * completely dead while the dashboard stays green. `POST /me/subscribed_apps`
 * runs once, at connect time, and its failure was only ever a log line plus a
 * `PERMISSION_REQUIRED` health status — which the next health check (token
 * valid ⇒ `CONNECTED`) overwrote 15 minutes later. From then on nothing
 * anywhere knew the account was unsubscribed, nothing retried it, and not one
 * comment or message could ever arrive. Telegram has nothing equivalent: it
 * re-arms its webhook/polling at boot and `getWebhookInfo` reports delivery
 * problems on every check, which is exactly why one channel kept working and
 * the other went silent.
 *
 * So the subscription is now READ BACK from Meta, repaired when it is missing,
 * and re-verified on every health check and every boot.
 *
 * An unreadable edge is deliberately NOT treated as proof of a good one: if
 * the read fails, a subscribe is attempted anyway, because being wrong in that
 * direction costs one idempotent API call, and being wrong in the other
 * direction costs every customer message.
 */
export async function ensureInstagramSubscription(
  connection: ChannelConnection,
  opts: {
    repair?: boolean;
    /**
     * Client to use instead of one built from the stored credentials. The
     * connect flow passes the client for the token being connected: reading
     * the token back out of the row that was just written would make the
     * subscribe depend on the write having landed and been returned, and the
     * subscribe has to be made with the new account's token, never the one it
     * replaced.
     */
    client?: InstagramClient;
  } = {},
): Promise<SubscriptionState> {
  const log = childLogger({ module: 'instagram', tenantId: connection.tenantId });
  if (connection.status !== 'connected' || !connection.credentialsEncrypted) {
    return {
      ok: false,
      fields: [],
      missing: [...REQUIRED_FIELDS],
      readable: false,
      repaired: false,
      error: 'not connected',
    };
  }

  const client = opts.client ?? getInstagramClient(connection);
  let fields: string[] = [];
  let readable = false;
  let error: string | null = null;

  try {
    fields = uniqueFields(await client.getSubscribedApps());
    readable = true;
  } catch (err) {
    error = errorMessage(err);
  }

  let missing = REQUIRED_FIELDS.filter((field) => !fields.includes(field));
  let repaired = false;

  if (opts.repair !== false && (missing.length > 0 || !readable)) {
    const attempt = await subscribeWithFallback(client);
    if (attempt.ok) {
      repaired = true;
      error = null;
      // Re-read so the verdict is Meta's answer, not our optimism.
      try {
        fields = uniqueFields(await client.getSubscribedApps());
        readable = true;
      } catch {
        // The edge is write-only for this app. A successful POST is then the
        // best evidence available, so take it.
        fields = attempt.fields;
      }
      missing = REQUIRED_FIELDS.filter((field) => !fields.includes(field));
      log.info({ fields }, 'instagram webhook subscription repaired');
    } else {
      error = attempt.error;
      log.warn({ err: error, fields }, 'instagram webhook subscription could NOT be established');
    }
  }

  const ok = missing.length === 0 && (readable || repaired);
  if (!ok) {
    await upsertManualAction(connection.tenantId, {
      dedupKey: 'ig-subscription-missing',
      platform: 'Instagram',
      title: 'Instagram is not subscribed to deliver comments or DMs to this server',
      officialUrl: 'https://developers.facebook.com/docs/instagram-platform/webhooks',
      steps: [
        `BLOCKER — Meta is not delivering this account's events here. Instagram has no polling mode, so until this is fixed not one comment and not one direct message can ever arrive, however correct the token, the app secret and the agents are.`,
        readable
          ? `Meta reports these subscribed fields for ${connection.displayName}: ${fields.length ? fields.join(', ') : '(none)'} — missing: ${missing.join(', ')}.`
          : `The subscription could not even be read back from Meta (${error ?? 'unknown error'}), and re-subscribing failed.`,
        'Cause 1 — the access token lacks the permissions. Re-generate it in https://developers.facebook.com/apps/ → your app → Instagram → "API setup with Instagram business login" → Generate token, approving ALL of: instagram_business_basic, instagram_business_manage_comments, instagram_business_manage_messages. Then paste it again on the Connections page.',
        'Cause 2 — the app is still in Development mode. Switch it to Live at the top of the App Dashboard; Meta does not deliver webhooks for a Development-mode app.',
        'Cause 3 — the app-level webhook is not configured. App Dashboard → Instagram → section "3. Configure webhooks": set the callback URL and verify token, press "Verify and save", then tick the "comments" and "messages" fields.',
        'Cause 4 — comment webhooks additionally need Advanced Access for instagram_business_manage_comments (App Review). See the App Review task.',
        'After any of these, press "Health check" on the Connections page — the platform re-subscribes automatically and this task closes itself once Meta confirms the subscription.',
      ],
      expectedResult:
        'The Connections page shows Instagram as connected with "webhook subscription: comments, messages", and a test comment or DM is answered.',
      whatToReturn: 'Nothing — this task resolves itself as soon as the subscription is confirmed.',
    }).catch(() => undefined);
  } else {
    await resolveManualAction(connection.tenantId, 'ig-subscription-missing').catch(() => undefined);
  }

  return { ok, fields, missing, readable, repaired, error };
}

/**
 * Re-verify (and silently repair) every connected Instagram account's webhook
 * subscription at boot.
 *
 * The Telegram channel has always re-armed its transport on startup; Instagram
 * did not re-arm anything, so a subscription that was never established — or
 * that Meta dropped when the token was re-generated — stayed broken until
 * somebody happened to reconnect the account by hand.
 */
export async function ensureInstagramDelivery(): Promise<void> {
  const prisma = getPrisma();
  const connections = await prisma.channelConnection.findMany({
    where: { channel: 'INSTAGRAM', status: 'connected' },
  });
  for (const connection of connections) {
    const state = await ensureInstagramSubscription(connection).catch((err) => {
      childLogger({ module: 'instagram', tenantId: connection.tenantId }).warn(
        { err: errorMessage(err) },
        'instagram subscription check failed at boot',
      );
      return null;
    });
    if (!state) continue;
    if (state.ok) continue;
    // Record the fault so the dashboard and the "automation is down" banner
    // can see it immediately, instead of only at the next health check.
    await prisma.channelConnection
      .update({
        where: { id: connection.id },
        data: {
          healthStatus: 'PERMISSION_REQUIRED',
          healthDetail: subscriptionDetail(state),
          lastHealthCheckAt: new Date(),
        },
      })
      .catch(() => undefined);
  }
}

function subscriptionDetail(state: SubscriptionState): string {
  if (state.ok) {
    return `webhook subscription: ${state.fields.length ? state.fields.join(', ') : 'confirmed'}`;
  }
  return state.readable
    ? `NOT RECEIVING EVENTS — Meta is not subscribed to ${state.missing.join(' + ')} for this account (subscribed: ${state.fields.join(', ') || 'nothing'}). No comment or DM can arrive until this is fixed; see Manual Actions.`
    : `NOT RECEIVING EVENTS — the webhook subscription could not be established (${state.error ?? 'unknown error'}). No comment or DM can arrive until this is fixed; see Manual Actions.`;
}

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
  // Both identifiers Meta hands out for the same professional account are
  // kept, because `entry.id` on an incoming webhook is matched against them.
  // `/me` returns `user_id` (the professional account id, which is what
  // webhooks carry) and `id` (the app-scoped id); which one a given app/API
  // version puts in `entry.id` has moved historically, and a mismatch drops
  // every event on the floor with no error anywhere. Matching either costs
  // nothing and removes the whole failure mode.
  const accountIds = [...new Set([me.user_id, me.id].filter(Boolean).map(String))];
  const metadata = {
    username: me.username ?? null,
    accountType: me.account_type ?? null,
    accountIds,
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

  // 4. Per-account webhook subscription — established AND read back, because
  //    an account that is not subscribed receives nothing and reports nothing.
  const subscription = await ensureInstagramSubscription(connection, { client });
  log.info(
    { fields: subscription.fields, ok: subscription.ok },
    subscription.ok ? 'subscribed_apps confirmed' : 'subscribed_apps NOT established',
  );

  await prisma.channelConnection.update({
    where: { id: connection.id },
    data: {
      healthStatus: subscription.ok ? 'CONNECTED' : 'PERMISSION_REQUIRED',
      healthDetail: subscription.ok
        ? `Token valid; ${subscriptionDetail(subscription)}. App-level webhook config must be completed in the Meta App Dashboard (see Manual Actions).`
        : subscriptionDetail(subscription),
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

/**
 * Which connection an incoming webhook belongs to, given `entry.id`.
 *
 * Meta publishes two ids for the same professional account — `user_id` and the
 * app-scoped `id` from `GET /me` — and which of them lands in `entry.id` has
 * differed between apps and API versions. A single-column equality match on
 * the wrong one drops EVERY event with no error at either end, which is
 * indistinguishable from Meta not sending anything at all. So:
 *
 *  1. exact match on the stored account id (the normal path);
 *  2. match against the other id recorded for the account at connect time;
 *  3. if the whole deployment has exactly ONE connected Instagram account,
 *     accept it and learn the id Meta is really using.
 *
 * Step 3 is safe precisely because it is gated on there being one and only one
 * candidate: with two accounts connected it does nothing, so an event can
 * never be attributed to the wrong tenant.
 */
export async function resolveInstagramConnection(
  accountId: string,
  log?: { info: (obj: unknown, msg: string) => void; warn: (obj: unknown, msg: string) => void },
): Promise<{ id: string; tenantId: string } | null> {
  const prisma = getPrisma();

  const exact = await prisma.channelConnection.findFirst({
    where: { channel: 'INSTAGRAM', externalAccountId: accountId },
    select: { id: true, tenantId: true },
  });
  if (exact) return exact;

  const candidates = await prisma.channelConnection.findMany({
    where: { channel: 'INSTAGRAM', status: 'connected' },
    select: { id: true, tenantId: true, externalAccountId: true, displayName: true, metadata: true },
  });

  const byAlternate = candidates.find((candidate) =>
    (((candidate.metadata as { accountIds?: unknown }).accountIds ?? []) as unknown[])
      .map(String)
      .includes(accountId),
  );
  if (byAlternate) {
    await rememberInstagramAccountId(byAlternate.id, accountId).catch(() => undefined);
    log?.info(
      { accountId, connectionId: byAlternate.id },
      'instagram webhook matched the account\'s alternate id — learned it for future events',
    );
    return { id: byAlternate.id, tenantId: byAlternate.tenantId };
  }

  if (candidates.length === 1) {
    const only = candidates[0]!;
    await rememberInstagramAccountId(only.id, accountId).catch(() => undefined);
    log?.warn(
      { accountId, storedAccountId: only.externalAccountId, connectionId: only.id },
      'instagram webhook entry.id does not match the stored account id; attributing it to the only connected Instagram account and recording the id Meta actually uses',
    );
    return { id: only.id, tenantId: only.tenantId };
  }

  return null;
}

/** Record an id Meta actually used, so the next event matches on the fast path. */
async function rememberInstagramAccountId(connectionId: string, accountId: string): Promise<void> {
  const prisma = getPrisma();
  const connection = await prisma.channelConnection.findUnique({
    where: { id: connectionId },
    select: { metadata: true },
  });
  if (!connection) return;
  const metadata = (connection.metadata ?? {}) as Record<string, unknown>;
  const known = new Set((((metadata.accountIds ?? []) as unknown[]) || []).map(String));
  if (known.has(accountId)) return;
  known.add(accountId);
  await prisma.channelConnection.update({
    where: { id: connectionId },
    data: { metadata: { ...metadata, accountIds: [...known] } },
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

/** How old the stored token is, in days — null when it cannot be read. */
export function instagramTokenAgeDays(connection: ChannelConnection): number | null {
  if (!connection.credentialsEncrypted) return null;
  try {
    const creds = JSON.parse(
      decryptSecret(connection.credentialsEncrypted, getEnv().ENCRYPTION_KEY),
    ) as InstagramCredentials;
    if (!creds.obtainedAt) return null;
    return (Date.now() - creds.obtainedAt) / 86_400_000;
  } catch {
    return null;
  }
}

/**
 * Has Meta EVER delivered anything for this account?
 *
 * Counted across both attributed and unattributed events. An event whose
 * `entry.id` matched no connection is stored with a null tenantId, which is
 * precisely the case an operator most needs to see — so a tenant-scoped count
 * would hide the very evidence it exists to find. One Meta app per deployment
 * makes the wider count unambiguous.
 *
 * Note the counts are a rolling window: processed events are pruned after 7
 * days, so "zero" means "nothing in the last week", which for a live business
 * account is still conclusive.
 */
export interface DeliveryEvidence {
  comments: number;
  messages: number;
  connectionAgeHours: number;
  /** 'none' — nothing at all arrives; 'comments-only' — DMs specifically blocked; 'flowing' — both seen. */
  verdict: 'none' | 'comments-only' | 'flowing';
}

export async function readDeliveryEvidence(
  connection: ChannelConnection,
): Promise<DeliveryEvidence> {
  const prisma = getPrisma();
  const scope = { OR: [{ tenantId: connection.tenantId }, { tenantId: null }] };
  const [comments, messages] = await Promise.all([
    prisma.webhookEvent.count({
      where: { channel: 'INSTAGRAM', eventKey: { startsWith: 'comment:' }, ...scope },
    }),
    prisma.webhookEvent.count({
      where: { channel: 'INSTAGRAM', eventKey: { startsWith: 'message:' }, ...scope },
    }),
  ]);
  const connectionAgeHours = (Date.now() - connection.createdAt.getTime()) / 3600_000;
  const verdict =
    messages > 0 ? 'flowing' : comments > 0 ? 'comments-only' : 'none';
  return { comments, messages, connectionAgeHours, verdict };
}

/**
 * Are Instagram DMs actually being delivered to this server?
 *
 * There is a failure mode here that produces no error anywhere and is
 * invisible in every other check: comments arrive perfectly while message
 * webhooks are never sent at all. The connection verifies, the token is valid,
 * the agent is enabled, replies to comments go out — and every DM a customer
 * sends is simply never seen. On this deployment that state lasted from the
 * first day: 104 comment events and zero message events.
 *
 * Meta stops delivering messages when the account's "Connected tools → Allow
 * Access to Messages" toggle is off, or when the app is not subscribed to the
 * `messages` field — neither of which the API reports as a problem.
 *
 * The asymmetry itself is the evidence, so it is measured rather than
 * inferred: a healthy number of comments with no messages at all means
 * delivery is off, not that nobody has written.
 */
async function describeDmDelivery(
  connection: ChannelConnection,
  evidence: DeliveryEvidence,
): Promise<string> {
  const tenantId = connection.tenantId;
  const { comments, messages } = evidence;

  if (messages > 0) return `; DMs: ${messages} received`;
  // Too few comments to conclude anything — the account may just be quiet.
  if (comments < 10) return '';

  await upsertManualAction(tenantId, {
    dedupKey: 'ig-dm-never-delivered',
    platform: 'Instagram',
    title: 'Instagram is delivering comments but NOT direct messages',
    officialUrl:
      'https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api',
    steps: [
      `This platform has received ${comments} comment events from Instagram and ZERO message events. Comments work, so the webhook address, the app secret and the token are all correct — Meta is simply not sending direct messages.`,
      'Cause 1 (most common): on the phone, open the Instagram app signed in as this account → Settings and privacy → Messages and story replies → Message controls → Connected tools → turn "Allow Access to Messages" ON. With that toggle off, Meta silently never delivers a single message webhook and reports no error anywhere.',
      'Cause 2: the app is not subscribed to the "messages" field. Open https://developers.facebook.com/apps → your app → Instagram → "API setup with Instagram business login" → section 3 "Configure webhooks" → make sure BOTH "comments" and "messages" are ticked, then save.',
      'Cause 3: the account is not reachable for messaging — it must be a Professional (Business or Creator) account, and the app needs Advanced Access for instagram_business_manage_messages to message people who hold no role on the app.',
      'After changing either setting, send a DM to the account from a DIFFERENT Instagram account and re-run this health check.',
    ],
    expectedResult:
      'A DM sent to the account appears in the dashboard and is answered, and this health check reports "DMs: N received".',
    whatToReturn: 'Nothing — this task resolves itself as soon as one message webhook arrives.',
  }).catch(() => undefined);

  return `; DMs: NONE EVER RECEIVED despite ${comments} comments — "Allow Access to Messages" is probably off (see Manual Actions)`;
}

/**
 * Nothing at all has ever arrived from Meta for this account.
 *
 * With the subscription confirmed, the remaining causes are all app-level and
 * all invisible from here, so they are spelled out rather than guessed at. The
 * verdict waits a day before it counts as a fault: a genuinely quiet account
 * must not be reported as broken.
 */
async function raiseNeverDeliveredAction(
  connection: ChannelConnection,
  appUrl: string | undefined,
  reachable: boolean,
): Promise<void> {
  await upsertManualAction(connection.tenantId, {
    dedupKey: 'ig-nothing-ever-delivered',
    platform: 'Meta',
    title: 'Instagram has never delivered a single event to this server',
    officialUrl: 'https://developers.facebook.com/apps/',
    steps: [
      `The token for ${connection.displayName} is valid and the account IS subscribed to comments and messages, yet not one comment and not one direct message has ever reached this server. Instagram has no polling mode, so this is the whole automation being silent, not a partial fault.`,
      appUrl && !reachable
        ? `BLOCKER — ${appUrl} does not reach this server: a request to ${appUrl}/api/health was answered by something else, or not at all. Meta delivers by POST only, so fix the hosting/DNS/TLS first. Meta also requires port 443 and a publicly-trusted certificate.`
        : appUrl
          ? `The callback address ${appUrl}/api/webhooks/instagram does reach this server, so the remaining causes are all in the Meta App Dashboard.`
          : 'BLOCKER — APP_URL is not set, so there is no address to give Meta. Set APP_URL to this server\'s public HTTPS base URL and restart.',
      'Check 1 — the app must be LIVE. App Dashboard → the toggle at the very top. Meta delivers no webhooks at all for an app in Development mode. This is the single most common cause.',
      'Check 2 — the app-level webhook must be verified. App Dashboard → Instagram → "API setup with Instagram business login" → section 3 "Configure webhooks". The callback URL and verify token must be saved there and show as verified; subscribing the account (which this platform does automatically) is NOT enough on its own.',
      'Check 3 — "comments" and "messages" must be ticked in that same section at app level.',
      'Check 4 — comment webhooks require Advanced Access for instagram_business_manage_comments (App Review). Until it is granted, comments are not delivered even when everything else is correct.',
      'Then comment on one of the account\'s posts from a different Instagram account, and press "Health check" here. If the account is simply quiet and nobody has written, this task can be dismissed.',
    ],
    expectedResult:
      'A test comment or DM appears under Logs → webhook events within seconds, and this check reports events received.',
    whatToReturn: 'Nothing — this task resolves itself as soon as the first event arrives.',
  }).catch(() => undefined);
}

/**
 * Live health check (spec §27).
 *
 * Deliberately NOT just "is the token valid". A valid token proves only that
 * this server can call Instagram — it says nothing about Instagram being able
 * to call this server, which is the direction every customer message travels.
 * The old version checked the token and returned CONNECTED, which also meant
 * it OVERWROTE the PERMISSION_REQUIRED that a failed subscription had set at
 * connect time: fifteen minutes after a broken connect, the dashboard went
 * green and stayed green while nothing was being delivered at all. Telegram
 * never had that hole because `getWebhookInfo` reports delivery state on every
 * check; this now does the equivalent.
 *
 * Order of severity: no token beats no subscription beats no deliveries.
 */
export async function checkInstagramHealth(connection: ChannelConnection): Promise<{
  status: 'CONNECTED' | 'DEGRADED' | 'AUTH_REQUIRED' | 'PERMISSION_REQUIRED' | 'DISCONNECTED';
  detail: string;
}> {
  if (connection.status !== 'connected' || !connection.credentialsEncrypted) {
    return { status: 'DISCONNECTED', detail: 'Not connected' };
  }

  const client = getInstagramClient(connection);
  let me;
  try {
    me = await client.getMe();
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

  const parts = [`Token valid for @${me.username ?? connection.externalAccountId}`];
  let status: 'CONNECTED' | 'DEGRADED' | 'PERMISSION_REQUIRED' = 'CONNECTED';

  // Opportunistic token refresh keeps the 60-day token alive indefinitely.
  // A failed refresh is only an outage when the token is genuinely running
  // out: reporting DEGRADED for a transient refresh error would light up the
  // "automation is down" banner for days while every message was in fact being
  // answered, which is the banner crying wolf rather than reporting anything.
  try {
    await refreshInstagramTokenIfDue(connection);
  } catch (err) {
    const ageDays = instagramTokenAgeDays(connection);
    if (ageDays !== null && ageDays > 45) {
      status = 'DEGRADED';
      parts.push(
        `token refresh is failing and the token is ${Math.round(ageDays)} days old — it expires at 60 days, so reconnect the account now (${errorMessage(err)})`,
      );
    } else {
      parts.push(`token refresh failed, will retry (${errorMessage(err)})`);
    }
  }

  // The check that decides whether anything can arrive at all. Also repairs a
  // missing subscription, so a connect that failed this step heals itself.
  const subscription = await ensureInstagramSubscription(connection).catch(() => null);
  if (!subscription || !subscription.ok) {
    return {
      status: 'PERMISSION_REQUIRED',
      detail: `${parts.join('; ')}; ${
        subscription
          ? subscriptionDetail(subscription)
          : 'the webhook subscription could not be verified'
      }`,
    };
  }
  parts.push(subscriptionDetail(subscription));

  // Delivery evidence. The subscription being right does not prove Meta is
  // actually sending — the app also has to be Live with a verified app-level
  // webhook, neither of which is readable from here.
  const evidence = await readDeliveryEvidence(connection).catch(() => null);
  if (evidence) {
    if (evidence.verdict === 'none') {
      const env = getEnv();
      const appUrl = env.APP_URL?.replace(/\/$/, '');
      const reachable = appUrl ? await isPubliclyReachable(appUrl) : false;
      if (evidence.connectionAgeHours > 24) {
        status = 'DEGRADED';
        parts.push(
          'NO EVENTS EVER RECEIVED — Instagram has delivered nothing since this account was connected. Most likely the app is still in Development mode or its app-level webhook is not verified; see Manual Actions',
        );
        await raiseNeverDeliveredAction(connection, appUrl, reachable).catch(() => undefined);
      } else {
        parts.push('no events received yet (connected less than a day ago)');
      }
    } else {
      await resolveManualAction(connection.tenantId, 'ig-nothing-ever-delivered').catch(
        () => undefined,
      );
      parts.push(`comments: ${evidence.comments} received`);
      const dm = await describeDmDelivery(connection, evidence).catch(() => '');
      if (evidence.messages > 0) {
        await resolveManualAction(connection.tenantId, 'ig-dm-never-delivered').catch(
          () => undefined,
        );
      }
      if (dm) parts.push(dm.replace(/^;\s*/, ''));
    }
  }

  return { status, detail: parts.join('; ') };
}

/**
 * Everything that has to be true for an Instagram comment or DM to be
 * answered, each checked and reported with its evidence.
 *
 * This exists because "Instagram is not working" was, in practice,
 * undiagnosable from the dashboard: the connection said CONNECTED, no banner
 * fired, the logs page showed nothing (events that match no account are stored
 * without a tenant and were filtered out of it), and the actual cause — an
 * account Meta was not subscribed to deliver — appeared in no view at all. One
 * call now answers the question instead of a day of guessing.
 */
export interface InstagramDiagnosticCheck {
  id: string;
  title: string;
  state: 'pass' | 'fail' | 'warn' | 'unknown';
  detail: string;
  /** Only set for a failing check: what to do about it. */
  fix?: string;
}

export async function diagnoseInstagram(tenantId: string): Promise<{
  ok: boolean;
  summary: string;
  checks: InstagramDiagnosticCheck[];
}> {
  const prisma = getPrisma();
  const env = getEnv();
  const checks: InstagramDiagnosticCheck[] = [];
  const push = (check: InstagramDiagnosticCheck): void => void checks.push(check);

  // 1. Is an account connected at all?
  const connection = await prisma.channelConnection.findUnique({
    where: { tenantId_channel: { tenantId, channel: 'INSTAGRAM' } },
  });
  if (!connection || connection.status !== 'connected' || !connection.credentialsEncrypted) {
    push({
      id: 'connection',
      title: 'Instagram account connected',
      state: 'fail',
      detail: connection ? `Status is "${connection.status}"` : 'No Instagram connection exists',
      fix: 'Connections page → Instagram → paste a 60-day Instagram access token and press Connect.',
    });
    return { ok: false, summary: 'No Instagram account is connected.', checks };
  }
  push({
    id: 'connection',
    title: 'Instagram account connected',
    state: 'pass',
    detail: `${connection.displayName} (account id ${connection.externalAccountId})`,
  });

  // 2. Public address Meta must be able to POST to.
  const appUrl = env.APP_URL?.replace(/\/$/, '');
  if (!appUrl) {
    push({
      id: 'app-url',
      title: 'Public callback URL',
      state: 'fail',
      detail: 'APP_URL is not set, so there is no address to give Meta',
      fix: "Set APP_URL to this server's public HTTPS base URL and restart.",
    });
  } else {
    const reachable = await isPubliclyReachable(appUrl);
    push({
      id: 'app-url',
      title: 'Public callback URL',
      state: reachable ? 'pass' : 'fail',
      detail: `${appUrl}/api/webhooks/instagram — ${reachable ? 'reaches this server' : 'does NOT reach this server'}`,
      fix: reachable
        ? undefined
        : 'Meta delivers Instagram events by POST only. Route ports 80/443 to this server with a real domain and a publicly-trusted TLS certificate (Meta requires port 443 and rejects self-signed certificates).',
    });
  }

  // 3. Verify token and app secret — without them the handshake and every
  //    delivery are rejected, which looks exactly like Meta sending nothing.
  const [verifyToken, appSecret, igAppSecret] = await Promise.all([
    resolveGlobalSetting('META_VERIFY_TOKEN'),
    resolveGlobalSetting('META_APP_SECRET'),
    resolveGlobalSetting('META_IG_APP_SECRET'),
  ]);
  push({
    id: 'verify-token',
    title: 'Webhook verify token configured',
    state: verifyToken ? 'pass' : 'fail',
    detail: verifyToken
      ? 'META_VERIFY_TOKEN is set'
      : 'META_VERIFY_TOKEN is empty — the Meta "Verify and save" handshake will fail',
    fix: verifyToken ? undefined : 'Settings page → set META_VERIFY_TOKEN, then paste the same value in the Meta App Dashboard.',
  });
  push({
    id: 'app-secret',
    title: 'App secret configured',
    state: appSecret || igAppSecret ? 'pass' : 'fail',
    detail:
      appSecret && igAppSecret
        ? 'both META_APP_SECRET and META_IG_APP_SECRET are set'
        : appSecret
          ? 'META_APP_SECRET is set (also set META_IG_APP_SECRET — an app using Instagram Login may sign with it)'
          : igAppSecret
            ? 'META_IG_APP_SECRET is set'
            : 'no app secret is set — every delivery is rejected with 401',
    fix:
      appSecret || igAppSecret
        ? undefined
        : 'Settings page → set META_IG_APP_SECRET to the "Instagram app secret" shown under "API setup with Instagram business login".',
  });

  // 4. Token validity.
  let tokenOk = false;
  try {
    const me = await getInstagramClient(connection).getMe();
    tokenOk = true;
    push({
      id: 'token',
      title: 'Access token valid',
      state: 'pass',
      detail: `@${me.username ?? connection.externalAccountId}${me.account_type ? ` (${me.account_type})` : ''}`,
    });
  } catch (err) {
    // A network failure says nothing about the token, and telling the operator
    // to re-generate a perfectly good one sends them down the wrong path.
    const message = errorMessage(err);
    const networkFailure = /network failure|fetch failed|ENOTFOUND|ETIMEDOUT|ECONNREFUSED/i.test(
      message,
    );
    push({
      id: 'token',
      title: 'Access token valid',
      state: networkFailure ? 'unknown' : 'fail',
      detail: message,
      fix: networkFailure
        ? 'This server could not reach graph.instagram.com at all — check outbound internet access, DNS and any egress firewall. The token itself has not been shown to be wrong.'
        : 'Re-generate the token in the Meta App Dashboard and paste it again on the Connections page.',
    });
  }

  // 5. THE one that silently kills everything.
  if (tokenOk) {
    const subscription = await ensureInstagramSubscription(connection, { repair: false }).catch(
      () => null,
    );
    push({
      id: 'subscription',
      title: 'Meta subscribed to deliver this account\'s events',
      state: subscription?.ok ? 'pass' : 'fail',
      detail: subscription
        ? subscription.readable
          ? `subscribed fields: ${subscription.fields.join(', ') || '(none)'}`
          : `could not read the subscription: ${subscription.error ?? 'unknown error'}`
        : 'check failed',
      fix: subscription?.ok
        ? undefined
        : 'Press "Health check" — the platform re-subscribes automatically. If it still fails, the token lacks instagram_business_manage_comments / instagram_business_manage_messages: re-generate it approving all three permissions.',
    });
  }

  // 6. Did anything actually arrive?
  const evidence = await readDeliveryEvidence(connection).catch(() => null);
  if (evidence) {
    push({
      id: 'delivery',
      title: 'Events actually delivered by Meta',
      state:
        evidence.verdict === 'flowing'
          ? 'pass'
          : evidence.verdict === 'comments-only'
            ? 'warn'
            : evidence.connectionAgeHours > 24
              ? 'fail'
              : 'unknown',
      detail: `${evidence.comments} comment events, ${evidence.messages} message events (last 7 days)`,
      fix:
        evidence.verdict === 'none'
          ? 'Set the app to LIVE in the Meta App Dashboard and verify the app-level webhook (Instagram → Configure webhooks). Meta delivers nothing for an app in Development mode.'
          : evidence.verdict === 'comments-only'
            ? 'Comments arrive but DMs never do: on the phone, Instagram app → Settings and privacy → Messages and story replies → Message controls → Connected tools → turn "Allow Access to Messages" ON.'
            : undefined,
    });

    // Events that matched no account are the signature of an id mismatch and
    // are invisible everywhere else, so they are called out explicitly.
    const unattributed = await prisma.webhookEvent.count({
      where: { channel: 'INSTAGRAM', tenantId: null },
    });
    if (unattributed > 0) {
      push({
        id: 'account-match',
        title: 'Delivered events match the connected account',
        state: 'fail',
        detail: `${unattributed} Instagram events arrived whose account id matched no connection — they were discarded`,
        fix: 'Reconnect the Instagram account on the Connections page: the token in use belongs to a different account than the one Meta is delivering for.',
      });
    }
  }

  // 7. Are the agents even switched on? A perfect pipeline that replies to
  //    nobody is the other way this looks "broken".
  const agents = await prisma.agent.findMany({
    where: { tenantId, type: { in: ['INSTAGRAM_COMMENT', 'INSTAGRAM_DM'] } },
    select: { type: true, enabled: true, name: true },
  });
  for (const type of ['INSTAGRAM_COMMENT', 'INSTAGRAM_DM'] as const) {
    const agent = agents.find((a) => a.type === type);
    push({
      id: `agent-${type.toLowerCase()}`,
      title: `${type === 'INSTAGRAM_COMMENT' ? 'Comment' : 'Direct message'} agent enabled`,
      state: agent?.enabled ? 'pass' : 'fail',
      detail: agent
        ? agent.enabled
          ? `${agent.name} is enabled`
          : `${agent.name} exists but is switched OFF — events are recorded and never answered`
        : 'no agent of this type exists',
      fix: agent?.enabled ? undefined : 'Agents page → enable it.',
    });
  }

  const failed = checks.filter((c) => c.state === 'fail');
  return {
    ok: failed.length === 0,
    summary:
      failed.length === 0
        ? 'Every requirement for Instagram automation is satisfied.'
        : `${failed.length} blocking problem${failed.length === 1 ? '' : 's'}: ${failed.map((c) => c.title).join('; ')}.`,
    checks,
  };
}
