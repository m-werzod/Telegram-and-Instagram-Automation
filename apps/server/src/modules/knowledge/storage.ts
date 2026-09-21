import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Local file storage for uploaded knowledge documents. Files are stored under
 * data/uploads/<tenantId>/<documentId> — outside the web root, never served
 * directly. Swap for S3-compatible storage by replacing this module.
 */

const ROOT = process.env.UPLOADS_DIR ?? path.resolve(process.cwd(), 'data', 'uploads');

function fileFor(tenantId: string, documentId: string): string {
  // documentId is a cuid we generated; tenantId likewise. No user-controlled path parts.
  return path.join(ROOT, tenantId, documentId);
}

export async function storeFile(tenantId: string, documentId: string, data: Buffer): Promise<void> {
  const target = fileFor(tenantId, documentId);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, data);
}

export async function readStoredFile(tenantId: string, documentId: string): Promise<Buffer> {
  return readFile(fileFor(tenantId, documentId));
}

export async function deleteStoredFile(tenantId: string, documentId: string): Promise<void> {
  try {
    await unlink(fileFor(tenantId, documentId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
