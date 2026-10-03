import type { MediaAsset } from '@prisma/client';
import { getPrisma } from '../../db/client.js';
import { getEnv } from '../../config/env.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';

/**
 * Media library: images the agents may send to customers (price lists, branch
 * maps, course banners…). Stored in Postgres (stateless app) and served at a
 * public, unguessable URL — Instagram requires a fetchable HTTPS URL for image
 * attachments; Telegram receives the bytes directly via multipart upload.
 */

export const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

/** Instagram caps image attachments at 8 MB — enforce the same everywhere. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export interface MediaAssetSummary {
  id: string;
  name: string;
  description: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
}

export async function listMediaAssets(tenantId: string): Promise<MediaAssetSummary[]> {
  return getPrisma().mediaAsset.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, description: true, mimeType: true, sizeBytes: true, createdAt: true },
  });
}

export async function createMediaAsset(
  tenantId: string,
  input: { name: string; description: string; mimeType: string; data: Buffer },
): Promise<MediaAssetSummary> {
  const name = input.name.trim();
  if (!name) throw new ValidationError('Image name is required');
  if (!ALLOWED_IMAGE_TYPES.has(input.mimeType)) {
    throw new ValidationError('Only JPEG, PNG, WebP, or GIF images are supported');
  }
  if (input.data.length === 0) throw new ValidationError('Empty file');
  if (input.data.length > MAX_IMAGE_BYTES) {
    throw new ValidationError(`Image too large (limit ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB)`);
  }
  const asset = await getPrisma().mediaAsset.create({
    data: {
      tenantId,
      name: name.slice(0, 200),
      description: input.description.trim().slice(0, 1000),
      mimeType: input.mimeType,
      sizeBytes: input.data.length,
      // Prisma's Bytes type wants a plain ArrayBuffer-backed Uint8Array.
      data: new Uint8Array(input.data),
    },
    select: { id: true, name: true, description: true, mimeType: true, sizeBytes: true, createdAt: true },
  });
  return asset;
}

export async function updateMediaAsset(
  tenantId: string,
  id: string,
  patch: { name?: string; description?: string },
): Promise<MediaAssetSummary> {
  const prisma = getPrisma();
  const existing = await prisma.mediaAsset.findFirst({ where: { id, tenantId }, select: { id: true } });
  if (!existing) throw new NotFoundError('Image not found');
  return prisma.mediaAsset.update({
    where: { id },
    data: {
      ...(patch.name !== undefined ? { name: patch.name.trim().slice(0, 200) } : {}),
      ...(patch.description !== undefined ? { description: patch.description.trim().slice(0, 1000) } : {}),
    },
    select: { id: true, name: true, description: true, mimeType: true, sizeBytes: true, createdAt: true },
  });
}

export async function deleteMediaAsset(tenantId: string, id: string): Promise<void> {
  const prisma = getPrisma();
  const existing = await prisma.mediaAsset.findFirst({ where: { id, tenantId }, select: { id: true } });
  if (!existing) throw new NotFoundError('Image not found');
  await prisma.mediaAsset.delete({ where: { id } });
}

/** Full asset (bytes included) scoped to the tenant — for channel senders. */
export async function getMediaAssetWithData(tenantId: string, id: string): Promise<MediaAsset | null> {
  return getPrisma().mediaAsset.findFirst({ where: { id, tenantId } });
}

/** Public fetch by unguessable id — used by GET /files/media/:id. */
export async function getPublicMediaAsset(id: string): Promise<MediaAsset | null> {
  if (!/^[a-z0-9]{10,40}$/i.test(id)) return null;
  return getPrisma().mediaAsset.findUnique({ where: { id } });
}

/** Public HTTPS URL for an asset, or null when APP_URL is not configured. */
export function publicMediaUrl(assetId: string): string | null {
  const appUrl = getEnv().APP_URL;
  if (!appUrl || !appUrl.startsWith('https://')) return null;
  return `${appUrl.replace(/\/$/, '')}/files/media/${assetId}`;
}
