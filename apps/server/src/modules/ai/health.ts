import { getPrisma } from '../../db/client.js';
import { getLogger } from '../../lib/logger.js';
import { upsertManualAction, resolveManualAction } from '../manual-actions/service.js';
import { clearSetting, getStoredSetting, resolveSetting, setSetting } from '../settings/service.js';
import { verifyAnthropicKey, type KeyVerification } from './anthropic-provider.js';
import {
  keyNameForProvider,
  providerForKey,
  providerForModel,
  type ProviderName,
} from './models.js';
import { verifyOpenAIKey } from './openai-provider.js';

/**
 * Health of the credential the agents depend on. A wrong API key is invisible
 * from the outside — agents stay "enabled", events keep arriving, and every
 * run dies at a 401 deep in the AI execution log. This turns that into a
 * first-class, surfaced state (spec §28: anything the platform cannot fix
 * itself becomes an explicit operator task).
 */
export const AI_KEY_ACTION_KEY = 'ai-api-key';

export type AIKeyHealth =
  | { status: 'missing'; provider: ProviderName }
  | ({ provider: ProviderName; source: 'platform' | 'env' } & KeyVerification);

const PROVIDER_LABEL: Record<ProviderName, string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI (ChatGPT)',
};

const PROVIDER_CONSOLE: Record<ProviderName, string> = {
  anthropic: 'https://platform.claude.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
};

const PROVIDER_KEY_PREFIX: Record<ProviderName, string> = {
  anthropic: 'sk-ant-',
  openai: 'sk-',
};

function verifyFor(provider: ProviderName, key: string): Promise<KeyVerification> {
  return provider === 'openai' ? verifyOpenAIKey(key) : verifyAnthropicKey(key);
}

/** Verify the key for one provider on one tenant. Costs no tokens. */
export async function checkTenantAIKey(
  tenantId: string,
  provider: ProviderName = 'anthropic',
): Promise<AIKeyHealth> {
  const keyName = keyNameForProvider(provider);
  const stored = await getStoredSetting(tenantId, keyName);
  const effective = stored ?? (await resolveSetting(tenantId, keyName));
  if (!effective) return { status: 'missing', provider };
  const source = stored ? 'platform' : 'env';
  return { provider, source, ...(await verifyFor(provider, effective)) };
}

/**
 * Move an API key that was saved into the wrong provider's slot.
 *
 * Operators buy one key and paste it into whichever field they opened first —
 * an OpenAI `sk-proj-…` key in the Anthropic box authenticates against nothing,
 * so every agent run 401s and the platform looks switched off. New saves are
 * routed by issuer (see settings-routes), but a key stored before that still
 * has to be rescued; this runs on boot and makes the running deployment heal
 * itself with no operator action.
 *
 * Conservative by construction: it only moves a key whose prefix unambiguously
 * identifies the other provider, and never overwrites a key already sitting in
 * the destination slot.
 */
export async function repairMisfiledAIKeys(): Promise<void> {
  const tenants = await getPrisma().tenant.findMany({ select: { id: true } });
  for (const tenant of tenants) {
    for (const provider of ['anthropic', 'openai'] as const) {
      const slot = keyNameForProvider(provider);
      try {
        const stored = await getStoredSetting(tenant.id, slot);
        if (!stored) continue;
        const issuer = providerForKey(stored);
        if (!issuer || issuer === provider) continue;

        const target = keyNameForProvider(issuer);
        if (await getStoredSetting(tenant.id, target)) {
          getLogger().warn(
            { tenantId: tenant.id, slot, issuer },
            'a key filed under the wrong provider was left alone — the correct slot already holds a key',
          );
          continue;
        }
        await setSetting(tenant.id, target, stored);
        await clearSetting(tenant.id, slot);
        getLogger().warn(
          { tenantId: tenant.id, from: slot, to: target },
          'moved an API key to the provider that issued it — agents can now authenticate',
        );
      } catch (err) {
        getLogger().warn(
          { err: err instanceof Error ? err.message : String(err), tenantId: tenant.id, slot },
          'could not repair a misfiled AI key',
        );
      }
    }
  }
}

/** The providers this tenant's enabled agents actually need right now. */
async function providersInUse(tenantId: string): Promise<ProviderName[]> {
  const agents = await getPrisma().agent.findMany({
    where: { tenantId, enabled: true },
    select: { model: true },
  });
  const names = new Set<ProviderName>(agents.map((a) => providerForModel(a.model)));
  return [...names];
}

/**
 * Periodic check (housekeeping loop): raise an operator task when a key the
 * agents need is missing or rejected, and clear it as soon as every provider
 * in use has a working key. Only `rejected`/`missing` raise the task — an
 * `unknown` result (network blip, 429, provider 5xx) says nothing about the
 * key and must not cry wolf.
 *
 * A *missing* key is no longer automatically an outage: when the other
 * provider has a valid key the pipeline runs the agents on its equivalent
 * model (see `resolveProviderForModel`), so the task raised in that case says
 * what is actually happening — replies ARE going out, on a substitute model —
 * instead of claiming the platform is down.
 */
export async function runAIKeyHealthCheck(): Promise<void> {
  const tenants = await getPrisma().tenant.findMany({ select: { id: true } });
  for (const tenant of tenants) {
    try {
      const needed = await providersInUse(tenant.id);
      if (needed.length === 0) continue;

      // Check both providers: the one the agents want, and the one that could
      // stand in for it.
      const health: Partial<Record<ProviderName, AIKeyHealth>> = {};
      for (const provider of ['anthropic', 'openai'] as const) {
        health[provider] = await checkTenantAIKey(tenant.id, provider);
      }

      const rejected = needed
        .map((p) => health[p]!)
        .find((h): h is Extract<AIKeyHealth, { status: 'rejected' }> => h.status === 'rejected');
      const missing = needed
        .map((p) => health[p]!)
        .find((h): h is Extract<AIKeyHealth, { status: 'missing' }> => h.status === 'missing');
      const standIn = (['anthropic', 'openai'] as const).find(
        (p) => !needed.includes(p) && health[p]?.status === 'valid',
      );

      if (rejected) {
        // A key that exists but is refused is never substituted — the operator
        // must fix that credential.
        await upsertManualAction(tenant.id, aiKeyManualAction(rejected));
      } else if (missing && standIn) {
        await upsertManualAction(tenant.id, substitutedProviderAction(missing.provider, standIn));
      } else if (missing) {
        await upsertManualAction(tenant.id, aiKeyManualAction(missing));
      } else if (needed.every((p) => health[p]?.status === 'valid')) {
        // Only a clean bill of health clears the task — an 'unknown' result
        // leaves it exactly as it was.
        await resolveManualAction(tenant.id, AI_KEY_ACTION_KEY);
      }
    } catch (err) {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err), tenantId: tenant.id },
        'AI key health check failed',
      );
    }
  }
}

/**
 * The agents are configured for one provider and the key belongs to the other.
 * They keep answering on the substitute model — this task exists so the
 * operator knows, and can make the configuration say what it does.
 */
function substitutedProviderAction(
  wanted: ProviderName,
  using: ProviderName,
): Parameters<typeof upsertManualAction>[1] {
  const wantedLabel = PROVIDER_LABEL[wanted];
  const usingLabel = PROVIDER_LABEL[using];
  return {
    dedupKey: AI_KEY_ACTION_KEY,
    platform: using === 'openai' ? 'OpenAI' : 'Anthropic',
    title: `Agents are running on ${usingLabel}, not the configured ${wantedLabel}`,
    officialUrl: PROVIDER_CONSOLE[wanted],
    steps: [
      `Your agents' model belongs to ${wantedLabel}, but the only API key configured is for ${usingLabel}. Replies are still going out — the platform automatically runs each agent on the closest ${usingLabel} model so customers are never left unanswered.`,
      `To keep it this way and make the dashboard match reality: open Agents → each agent → "Model" and pick a ${usingLabel} model. The cost shown next to each model is per million tokens.`,
      `To go back to ${wantedLabel} instead: open ${PROVIDER_CONSOLE[wanted]}, create a key (it starts with "${PROVIDER_KEY_PREFIX[wanted]}"), make sure that account has billing set up, and paste it into Settings.`,
    ],
    expectedResult: `Either every agent's model is a ${usingLabel} one, or a working ${wantedLabel} key is saved in Settings. This task then disappears.`,
    whatToReturn: 'Nothing — the dashboard clears this task automatically.',
  };
}

function aiKeyManualAction(
  health: Extract<AIKeyHealth, { status: 'missing' | 'rejected' }>,
): Parameters<typeof upsertManualAction>[1] {
  const rejected = health.status === 'rejected';
  const label = PROVIDER_LABEL[health.provider];
  const console_ = PROVIDER_CONSOLE[health.provider];
  const prefix = PROVIDER_KEY_PREFIX[health.provider];
  return {
    dedupKey: AI_KEY_ACTION_KEY,
    platform: health.provider === 'openai' ? 'OpenAI' : 'Anthropic',
    title: rejected
      ? `Replace the ${label} API key — it is being rejected`
      : `Add a ${label} API key — no agent can reply without it`,
    officialUrl: console_,
    steps: [
      rejected
        ? `${label} refused the stored key (${health.source === 'platform' ? 'pasted in the dashboard' : 'set as an environment variable'}): "${health.detail}". Until it is replaced, every agent run fails and no message gets a reply.`
        : `Your agents are configured to use ${label}, but no API key for it is configured.`,
      `Open ${console_} → create an API key and copy it. A valid key starts with "${prefix}".`,
      'Billing must be set up on that account — a key on an account with no credit authenticates but cannot generate.',
      `Paste the key into the dashboard: Settings → "${label}" → Save. The platform verifies it against ${label} on save and refuses an invalid one, so a successful save means it works. No redeploy needed.`,
      'Then send one test message to the bot and open Logs → "AI bajarilishlari": the newest row must read SUCCEEDED.',
    ],
    expectedResult:
      'Settings shows the key as set, this task disappears, and a test message gets an agent reply (AI execution log: SUCCEEDED).',
    whatToReturn: 'Nothing — the dashboard clears this task automatically once the key works.',
  };
}
