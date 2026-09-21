/**
 * Text chunking for retrieval. Splits on paragraph boundaries first, then
 * sentences, targeting ~800 estimated tokens per chunk with overlap so
 * answers spanning a boundary stay retrievable.
 */

export interface Chunk {
  content: string;
  ord: number;
  tokenCount: number;
}

const TARGET_TOKENS = 800;
const OVERLAP_CHARS = 300;
const CHARS_PER_TOKEN = 4;
const TARGET_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function chunkText(text: string): Chunk[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= TARGET_CHARS) {
    return [{ content: trimmed, ord: 0, tokenCount: estimateTokens(trimmed) }];
  }

  const paragraphs = trimmed.split(/\n\s*\n/);
  const chunks: string[] = [];
  let current = '';

  const flush = () => {
    const c = current.trim();
    if (c) chunks.push(c);
    current = '';
  };

  for (const para of paragraphs) {
    const p = para.trim();
    if (!p) continue;
    if (current.length + p.length + 2 <= TARGET_CHARS) {
      current = current ? `${current}\n\n${p}` : p;
      continue;
    }
    flush();
    if (p.length <= TARGET_CHARS) {
      current = p;
      continue;
    }
    // Paragraph longer than a chunk: split on sentence boundaries, hard-wrap as last resort.
    const sentences = p.match(/[^.!?\n]+[.!?\n]*/g) ?? [p];
    for (const sentence of sentences) {
      if (current.length + sentence.length <= TARGET_CHARS) {
        current += sentence;
      } else {
        flush();
        if (sentence.length > TARGET_CHARS) {
          for (let i = 0; i < sentence.length; i += TARGET_CHARS) {
            const piece = sentence.slice(i, i + TARGET_CHARS);
            if (i + TARGET_CHARS >= sentence.length) current = piece;
            else chunks.push(piece.trim());
          }
        } else {
          current = sentence;
        }
      }
    }
  }
  flush();

  // Add trailing overlap from the previous chunk so boundary-spanning facts survive.
  const withOverlap = chunks.map((c, i) => {
    if (i === 0) return c;
    const prev = chunks[i - 1]!;
    const overlap = prev.slice(-OVERLAP_CHARS);
    const boundary = overlap.indexOf(' ');
    const cleanOverlap = boundary >= 0 ? overlap.slice(boundary + 1) : overlap;
    return `…${cleanOverlap}\n${c}`;
  });

  return withOverlap.map((content, ord) => ({
    content,
    ord,
    tokenCount: estimateTokens(content),
  }));
}
