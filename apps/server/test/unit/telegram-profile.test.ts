import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelConnection } from '@prisma/client';
import { encryptSecret } from '../../src/lib/crypto.js';
import { initLogger } from '../../src/lib/logger.js';
import {
  DEFAULT_BOT_PROFILE,
  applyTelegramProfile,
  readTelegramProfile,
} from '../../src/modules/channels/telegram/service.js';
import { makeTestEnv, TEST_ENCRYPTION_KEY } from '../helpers/test-env.js';
import { mockPrisma } from '../helpers/mock-prisma.js';

function connection(metadata: unknown): ChannelConnection {
  return {
    id: 'conn-1',
    tenantId: 'tenant-1',
    channel: 'TELEGRAM',
    status: 'connected',
    displayName: '@bot',
    externalAccountId: '1',
    credentialsEncrypted: encryptSecret(JSON.stringify({ botToken: '1:abc' }), TEST_ENCRYPTION_KEY),
    webhookSecret: 's',
    metadata,
  } as unknown as ChannelConnection;
}

describe('readTelegramProfile', () => {
  beforeEach(() => {
    initLogger('silent', false);
    makeTestEnv();
  });

  it('returns the Uzbek-first defaults when nothing is stored', () => {
    expect(readTelegramProfile(connection({}))).toEqual(DEFAULT_BOT_PROFILE);
    expect(readTelegramProfile(connection(null))).toEqual(DEFAULT_BOT_PROFILE);
  });

  it('returns stored values over the defaults', () => {
    const stored = {
      name: 'Turon Bot',
      shortDescription: 'qisqa',
      description: 'uzun',
      commands: [{ command: 'start', description: 'boshlash' }],
    };
    expect(readTelegramProfile(connection({ profile: stored }))).toEqual(stored);
  });

  it('fills each missing field from the defaults', () => {
    const p = readTelegramProfile(connection({ profile: { name: 'Faqat nom' } }));
    expect(p.name).toBe('Faqat nom');
    expect(p.description).toBe(DEFAULT_BOT_PROFILE.description);
    expect(p.commands).toEqual(DEFAULT_BOT_PROFILE.commands);
  });

  it('ignores an empty stored command list', () => {
    const p = readTelegramProfile(connection({ profile: { commands: [] } }));
    expect(p.commands).toEqual(DEFAULT_BOT_PROFILE.commands);
  });

  it('keeps unrelated connection metadata reachable', () => {
    const meta = { botUsername: 'turon_bot', channelMode: 'polling', profile: { name: 'X' } };
    expect(readTelegramProfile(connection(meta)).name).toBe('X');
  });
});

describe('applyTelegramProfile', () => {
  const fetchMock = vi.fn();
  let prisma: ReturnType<typeof mockPrisma>;

  const profile = {
    name: 'Turon Avtomaktab',
    shortDescription: 'qisqa tavsif',
    description: 'uzun tavsif',
    commands: [{ command: 'start', description: 'boshlash' }],
  };

  beforeEach(() => {
    initLogger('silent', false);
    makeTestEnv();
    prisma = mockPrisma();
    prisma.install();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const ok = () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: true }) }) as unknown as Response;

  it('pushes every field to the Bot API and reports each as applied', async () => {
    fetchMock.mockResolvedValue(ok());
    const res = await applyTelegramProfile(connection({}), profile);

    const methods = fetchMock.mock.calls.map((c) => String(c[0]).split('/').pop());
    expect(methods).toEqual(['setMyName', 'setMyShortDescription', 'setMyDescription', 'setMyCommands']);
    expect(res.results.every((r) => r.ok)).toBe(true);
    expect(res.profile).toEqual(profile);
  });

  it('persists the profile onto the connection without dropping other metadata', async () => {
    fetchMock.mockResolvedValue(ok());
    await applyTelegramProfile(connection({ botUsername: 'turon_bot' }), profile);

    expect(prisma.channelConnection.update).toHaveBeenCalledWith({
      where: { id: 'conn-1' },
      data: { metadata: { botUsername: 'turon_bot', profile } },
    });
  });

  it('keeps applying the remaining fields when Telegram rejects one', async () => {
    // Telegram rate-limits name changes to twice an hour; that must not stop
    // the descriptions or the command menu from being updated.
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith('setMyName')
        ? ({ ok: false, status: 429, json: async () => ({ ok: false, description: 'Too Many Requests' }) } as unknown as Response)
        : ok(),
    );

    const res = await applyTelegramProfile(connection({}), profile);

    expect(res.results.find((r) => r.field === 'name')?.ok).toBe(false);
    expect(res.results.find((r) => r.field === 'name')?.error).toMatch(/Too Many Requests|429/);
    expect(res.results.filter((r) => r.ok).map((r) => r.field)).toEqual([
      'shortDescription',
      'description',
      'commands',
    ]);
    // the write still happens, so the dashboard keeps showing what was asked for
    expect(prisma.channelConnection.update).toHaveBeenCalled();
  });
});
