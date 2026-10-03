import { beforeEach, describe, expect, it } from 'vitest';
import { initLogger } from '../../src/lib/logger.js';
import {
  createMediaAsset,
  getPublicMediaAsset,
  MAX_IMAGE_BYTES,
  publicMediaUrl,
} from '../../src/modules/media/service.js';
import { makeTestEnv } from '../helpers/test-env.js';
import { mockPrisma } from '../helpers/mock-prisma.js';

const TENANT = 'tenant-1';

describe('media service', () => {
  let prisma: ReturnType<typeof mockPrisma>;

  beforeEach(() => {
    initLogger('silent', false);
    makeTestEnv();
    prisma = mockPrisma();
    prisma.install();
  });

  it('creates an image asset with trimmed name and byte size', async () => {
    prisma.mediaAsset.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
      id: 'media-1',
      name: args.data.name,
      description: args.data.description,
      mimeType: args.data.mimeType,
      sizeBytes: args.data.sizeBytes,
      createdAt: new Date(),
    }));
    const asset = await createMediaAsset(TENANT, {
      name: '  Narxlar jadvali  ',
      description: ' Barcha toifalar narxi ',
      mimeType: 'image/png',
      data: Buffer.from([1, 2, 3]),
    });
    expect(asset.name).toBe('Narxlar jadvali');
    expect(asset.sizeBytes).toBe(3);
    const arg = prisma.mediaAsset.create.mock.calls[0]![0] as { data: { description: string } };
    expect(arg.data.description).toBe('Barcha toifalar narxi');
  });

  it('rejects non-image mime types', async () => {
    await expect(
      createMediaAsset(TENANT, {
        name: 'doc',
        description: '',
        mimeType: 'application/pdf',
        data: Buffer.from([1]),
      }),
    ).rejects.toThrow(/JPEG, PNG, WebP, or GIF/);
  });

  it('rejects an empty file and an oversized file', async () => {
    await expect(
      createMediaAsset(TENANT, {
        name: 'x',
        description: '',
        mimeType: 'image/jpeg',
        data: Buffer.alloc(0),
      }),
    ).rejects.toThrow(/Empty/i);
    await expect(
      createMediaAsset(TENANT, {
        name: 'x',
        description: '',
        mimeType: 'image/jpeg',
        data: Buffer.alloc(MAX_IMAGE_BYTES + 1),
      }),
    ).rejects.toThrow(/too large/i);
  });

  it('getPublicMediaAsset rejects malformed ids without a DB query', async () => {
    expect(await getPublicMediaAsset('../etc/passwd')).toBeNull();
    expect(await getPublicMediaAsset('')).toBeNull();
    expect(prisma.mediaAsset.findUnique).not.toHaveBeenCalled();
  });

  it('publicMediaUrl builds an APP_URL-based HTTPS URL, or null without APP_URL', () => {
    makeTestEnv({ APP_URL: 'https://bots.example.com/' });
    expect(publicMediaUrl('abc123defg')).toBe('https://bots.example.com/files/media/abc123defg');
    makeTestEnv({ APP_URL: undefined });
    expect(publicMediaUrl('abc123defg')).toBeNull();
  });
});
