import { Prisma } from '@prisma/client';
import { getPrisma } from '../../db/client.js';
import { NotFoundError, errorMessage } from '../../lib/errors.js';
import { childLogger } from '../../lib/logger.js';
import { getEmbeddings } from '../ai/index.js';
import { chunkText } from './chunker.js';
import { cleanText, parseBuffer, parseUrl } from './parser.js';

/**
 * Knowledge pipeline (spec §8): upload → parse → clean → chunk → embed → store
 * → retrieve. Retrieval is semantic (pgvector cosine) when an embedding
 * provider is configured, otherwise Postgres full-text search. Results carry
 * source metadata for internal citation tracking.
 */

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  content: string;
  score: number;
}

const RETRIEVAL_LIMIT = 6;
const VECTOR_MIN_SCORE = 0.35; // cosine similarity threshold
const FTS_MIN_SCORE = 0.01;

export async function ingestDocument(documentId: string, tenantId: string): Promise<void> {
  const prisma = getPrisma();
  const log = childLogger({ module: 'knowledge', documentId, tenantId });

  const doc = await prisma.knowledgeDocument.findFirst({
    where: { id: documentId, tenantId },
  });
  if (!doc) throw new NotFoundError(`Document ${documentId} not found`);

  await prisma.knowledgeDocument.update({
    where: { id: doc.id },
    data: { status: 'PROCESSING', error: null },
  });

  try {
    let rawText: string;
    let title = doc.title;

    if (doc.sourceType === 'URL') {
      const parsed = await parseUrl(doc.sourceRef);
      rawText = parsed.text;
      if (!title && parsed.title) title = parsed.title;
    } else if (doc.sourceType === 'FILE') {
      const { readStoredFile } = await import('./storage.js');
      const buffer = await readStoredFile(tenantId, doc.id);
      const parsed = await parseBuffer(buffer, doc.mimeType, doc.sourceRef);
      rawText = parsed.text;
    } else {
      // TEXT / FAQ: content was stored directly as the sourceRef payload file or inline.
      const { readStoredFile } = await import('./storage.js');
      const buffer = await readStoredFile(tenantId, doc.id);
      rawText = buffer.toString('utf8');
    }

    const text = cleanText(rawText);
    const chunks = chunkText(text);
    log.info({ chunks: chunks.length, chars: text.length }, 'document parsed and chunked');

    // Replace previous chunks atomically-ish: delete then insert.
    await prisma.knowledgeChunk.deleteMany({ where: { documentId: doc.id } });

    const embedder = getEmbeddings();
    for (let i = 0; i < chunks.length; i += 50) {
      const batch = chunks.slice(i, i + 50);
      const created = await prisma.$transaction(
        batch.map((c) =>
          prisma.knowledgeChunk.create({
            data: {
              documentId: doc.id,
              knowledgeBaseId: doc.knowledgeBaseId,
              tenantId,
              ord: c.ord,
              content: c.content,
              tokenCount: c.tokenCount,
              metadata: { documentTitle: title, sourceType: doc.sourceType, version: doc.version },
            },
            select: { id: true },
          }),
        ),
      );
      if (embedder) {
        const vectors = await embedder.embed(
          batch.map((c) => c.content),
          'document',
        );
        for (let j = 0; j < created.length; j++) {
          const vec = vectors[j];
          if (!vec) continue;
          await prisma.$executeRaw`UPDATE "KnowledgeChunk" SET embedding = ${JSON.stringify(vec)}::vector WHERE id = ${created[j]!.id}`;
        }
      }
    }

    await prisma.knowledgeDocument.update({
      where: { id: doc.id },
      data: { status: 'READY', title, updatedAt: new Date() },
    });
    log.info('document ingested');
  } catch (err) {
    await prisma.knowledgeDocument.update({
      where: { id: doc.id },
      data: { status: 'FAILED', error: errorMessage(err).slice(0, 1000) },
    });
    throw err;
  }
}

/**
 * Retrieve the most relevant chunks for a query. Semantic when embeddings are
 * available; FTS fallback otherwise. Never returns the whole knowledge base.
 */
export async function searchKnowledge(
  tenantId: string,
  knowledgeBaseId: string,
  query: string,
  limit = RETRIEVAL_LIMIT,
): Promise<RetrievedChunk[]> {
  const prisma = getPrisma();
  const trimmed = query.trim();
  if (!trimmed) return [];

  const embedder = getEmbeddings();
  if (embedder) {
    try {
      const [vector] = await embedder.embed([trimmed.slice(0, 4000)], 'query');
      if (vector) {
        const rows = await prisma.$queryRaw<
          Array<{ id: string; documentId: string; content: string; metadata: unknown; score: number }>
        >`
          SELECT c.id, c."documentId", c.content, c.metadata,
                 1 - (c.embedding <=> ${JSON.stringify(vector)}::vector) AS score
          FROM "KnowledgeChunk" c
          WHERE c."knowledgeBaseId" = ${knowledgeBaseId}
            AND c."tenantId" = ${tenantId}
            AND c.embedding IS NOT NULL
          ORDER BY c.embedding <=> ${JSON.stringify(vector)}::vector
          LIMIT ${limit}
        `;
        // If embedded chunks exist, the vector result is authoritative (even when
        // everything scores below threshold → "no relevant knowledge"). Only fall
        // through to FTS when no chunks have embeddings at all.
        if (rows.length > 0) {
          return mapRows(rows.filter((r) => Number(r.score) >= VECTOR_MIN_SCORE));
        }
      }
    } catch (err) {
      childLogger({ module: 'knowledge' }).warn(
        { err: errorMessage(err) },
        'vector retrieval failed; falling back to full-text search',
      );
    }
  }

  // Full-text fallback ('simple' config — language-agnostic for uz/ru/en content).
  const rows = await prisma.$queryRaw<
    Array<{ id: string; documentId: string; content: string; metadata: unknown; score: number }>
  >`
    SELECT c.id, c."documentId", c.content, c.metadata,
           ts_rank(c.tsv, plainto_tsquery('simple', ${trimmed})) AS score
    FROM "KnowledgeChunk" c
    WHERE c."knowledgeBaseId" = ${knowledgeBaseId}
      AND c."tenantId" = ${tenantId}
      AND c.tsv @@ plainto_tsquery('simple', ${trimmed})
    ORDER BY score DESC
    LIMIT ${limit}
  `;
  return mapRows(rows.filter((r) => Number(r.score) >= FTS_MIN_SCORE));
}

function mapRows(
  rows: Array<{ id: string; documentId: string; content: string; metadata: unknown; score: number }>,
): RetrievedChunk[] {
  return rows.map((r) => {
    const meta = (r.metadata ?? {}) as { documentTitle?: string };
    return {
      chunkId: r.id,
      documentId: r.documentId,
      documentTitle: meta.documentTitle ?? 'Untitled',
      content: r.content,
      score: Number(r.score),
    };
  });
}

// Re-export Prisma namespace usage guard (kept minimal; raw queries above are tenant-scoped).
export type { Prisma };
