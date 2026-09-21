import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPrisma } from '../db/client.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { getQueue } from '../queue/index.js';
import { searchKnowledge } from '../modules/knowledge/service.js';
import { deleteStoredFile, storeFile } from '../modules/knowledge/storage.js';
import { requireAuth, tenantOf } from './middleware.js';

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Knowledge base management + ingestion (spec §8). */
export async function knowledgeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/api/knowledge-bases', async (req) => {
    const bases = await getPrisma().knowledgeBase.findMany({
      where: { tenantId: tenantOf(req) },
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { documents: true, chunks: true } } },
    });
    return { knowledgeBases: bases };
  });

  app.post<{ Body: { name?: string; description?: string } }>('/api/knowledge-bases', async (req) => {
    const name = z.string().min(1).max(200).safeParse(req.body?.name);
    if (!name.success) throw new ValidationError('name is required');
    const kb = await getPrisma().knowledgeBase.create({
      data: { tenantId: tenantOf(req), name: name.data, description: req.body?.description ?? '' },
    });
    return { knowledgeBase: kb };
  });

  app.delete<{ Params: { id: string } }>('/api/knowledge-bases/:id', async (req) => {
    const tenantId = tenantOf(req);
    const prisma = getPrisma();
    const kb = await prisma.knowledgeBase.findFirst({ where: { id: req.params.id, tenantId } });
    if (!kb) throw new NotFoundError('Knowledge base not found');
    const docs = await prisma.knowledgeDocument.findMany({
      where: { knowledgeBaseId: kb.id },
      select: { id: true },
    });
    await prisma.knowledgeBase.delete({ where: { id: kb.id } });
    for (const d of docs) await deleteStoredFile(tenantId, d.id).catch(() => undefined);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/knowledge-bases/:id/documents', async (req) => {
    const tenantId = tenantOf(req);
    const kb = await getPrisma().knowledgeBase.findFirst({
      where: { id: req.params.id, tenantId },
    });
    if (!kb) throw new NotFoundError('Knowledge base not found');
    const documents = await getPrisma().knowledgeDocument.findMany({
      where: { knowledgeBaseId: kb.id },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { chunks: true } } },
    });
    return { documents };
  });

  /**
   * Add a document. Accepts either:
   *  - multipart/form-data with a file (PDF/DOCX/TXT/MD), or
   *  - JSON: { url } | { text, title } | { faq: [{q,a}...], title }
   */
  app.post<{ Params: { id: string } }>('/api/knowledge-bases/:id/documents', async (req) => {
    const tenantId = tenantOf(req);
    const prisma = getPrisma();
    const kb = await prisma.knowledgeBase.findFirst({ where: { id: req.params.id, tenantId } });
    if (!kb) throw new NotFoundError('Knowledge base not found');

    let doc;
    if (req.isMultipart()) {
      const file = await req.file({ limits: { fileSize: MAX_UPLOAD_BYTES } });
      if (!file) throw new ValidationError('No file uploaded');
      const buffer = await file.toBuffer();
      doc = await prisma.knowledgeDocument.create({
        data: {
          knowledgeBaseId: kb.id,
          tenantId,
          title: file.filename,
          sourceType: 'FILE',
          sourceRef: file.filename,
          mimeType: file.mimetype,
        },
      });
      await storeFile(tenantId, doc.id, buffer);
    } else {
      const body = z
        .object({
          url: z.string().url().optional(),
          text: z.string().max(2_000_000).optional(),
          title: z.string().max(300).optional(),
          faq: z.array(z.object({ q: z.string().max(2000), a: z.string().max(10_000) })).max(500).optional(),
        })
        .safeParse(req.body ?? {});
      if (!body.success) throw new ValidationError('Invalid document payload', body.error.issues);
      const { url, text, title, faq } = body.data;

      if (url) {
        doc = await prisma.knowledgeDocument.create({
          data: {
            knowledgeBaseId: kb.id,
            tenantId,
            title: title ?? url,
            sourceType: 'URL',
            sourceRef: url,
          },
        });
      } else if (faq?.length) {
        const content = faq.map((f) => `Q: ${f.q}\nA: ${f.a}`).join('\n\n');
        doc = await prisma.knowledgeDocument.create({
          data: {
            knowledgeBaseId: kb.id,
            tenantId,
            title: title ?? 'FAQ',
            sourceType: 'FAQ',
          },
        });
        await storeFile(tenantId, doc.id, Buffer.from(content, 'utf8'));
      } else if (text) {
        doc = await prisma.knowledgeDocument.create({
          data: {
            knowledgeBaseId: kb.id,
            tenantId,
            title: title ?? 'Manual text',
            sourceType: 'TEXT',
          },
        });
        await storeFile(tenantId, doc.id, Buffer.from(text, 'utf8'));
      } else {
        throw new ValidationError('Provide a file, url, text, or faq');
      }
    }

    await getQueue().enqueue('knowledge:ingest', { documentId: doc.id, tenantId });
    return { document: doc };
  });

  app.post<{ Params: { id: string } }>('/api/documents/:id/reingest', async (req) => {
    const tenantId = tenantOf(req);
    const doc = await getPrisma().knowledgeDocument.findFirst({
      where: { id: req.params.id, tenantId },
    });
    if (!doc) throw new NotFoundError('Document not found');
    await getPrisma().knowledgeDocument.update({
      where: { id: doc.id },
      data: { status: 'PENDING', version: { increment: 1 } },
    });
    await getQueue().enqueue('knowledge:ingest', { documentId: doc.id, tenantId });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/documents/:id', async (req) => {
    const tenantId = tenantOf(req);
    const doc = await getPrisma().knowledgeDocument.findFirst({
      where: { id: req.params.id, tenantId },
    });
    if (!doc) throw new NotFoundError('Document not found');
    await getPrisma().knowledgeDocument.delete({ where: { id: doc.id } });
    await deleteStoredFile(tenantId, doc.id).catch(() => undefined);
    return { ok: true };
  });

  /** Retrieval test bench for operators. */
  app.post<{ Params: { id: string }; Body: { query?: string } }>(
    '/api/knowledge-bases/:id/search',
    async (req) => {
      const tenantId = tenantOf(req);
      const query = z.string().min(1).max(2000).safeParse(req.body?.query);
      if (!query.success) throw new ValidationError('query is required');
      const kb = await getPrisma().knowledgeBase.findFirst({
        where: { id: req.params.id, tenantId },
      });
      if (!kb) throw new NotFoundError('Knowledge base not found');
      const results = await searchKnowledge(tenantId, kb.id, query.data);
      return { results };
    },
  );
}
