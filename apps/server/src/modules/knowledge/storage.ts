import { getPrisma } from '../../db/client.js';
import { NotFoundError } from '../../lib/errors.js';

/**
 * Storage for uploaded knowledge documents — raw bytes live in Postgres
 * (KnowledgeFile), NOT on local disk, so the application holds no production
 * state on the filesystem and deploys as a stateless container. Documents are
 * capped at 20MB by the upload route, well within bytea territory.
 */

export async function storeFile(tenantId: string, documentId: string, data: Buffer): Promise<void> {
  const prisma = getPrisma();
  // Prisma's Bytes type wants a plain ArrayBuffer-backed Uint8Array.
  const bytes = new Uint8Array(data);
  await prisma.knowledgeFile.upsert({
    where: { documentId },
    create: { documentId, tenantId, data: bytes },
    update: { data: bytes },
  });
}

export async function readStoredFile(tenantId: string, documentId: string): Promise<Buffer> {
  const prisma = getPrisma();
  const file = await prisma.knowledgeFile.findFirst({ where: { documentId, tenantId } });
  if (!file) throw new NotFoundError(`Stored file for document ${documentId} not found`);
  return Buffer.from(file.data);
}

export async function deleteStoredFile(tenantId: string, documentId: string): Promise<void> {
  // Cascade on KnowledgeDocument covers most paths; this keeps explicit
  // callers working and is a no-op when the row is already gone.
  await getPrisma().knowledgeFile.deleteMany({ where: { documentId, tenantId } });
}
