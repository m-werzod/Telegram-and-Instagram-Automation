import { ValidationError } from '../../lib/errors.js';

/**
 * Document parsing: PDF, DOCX, TXT, Markdown, HTML pages by URL, raw text.
 * Output is normalized plain text ready for chunking.
 */

export interface ParsedDocument {
  text: string;
  title?: string;
}

export async function parseBuffer(
  buffer: Buffer,
  mimeType: string,
  filename: string,
): Promise<ParsedDocument> {
  const lower = filename.toLowerCase();
  if (mimeType === 'application/pdf' || lower.endsWith('.pdf')) {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: true });
    return { text: String(text) };
  }
  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    lower.endsWith('.docx')
  ) {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return { text: result.value };
  }
  if (
    mimeType.startsWith('text/') ||
    lower.endsWith('.txt') ||
    lower.endsWith('.md') ||
    lower.endsWith('.markdown') ||
    mimeType === 'application/octet-stream'
  ) {
    return { text: buffer.toString('utf8') };
  }
  throw new ValidationError(`Unsupported document type: ${mimeType || filename}`);
}

export async function parseUrl(url: string): Promise<ParsedDocument> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError('Only http(s) URLs are supported');
  }
  // SSRF guard: refuse obviously-internal hosts. (Operators add their own KB URLs,
  // but defense in depth costs nothing.)
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.endsWith('.internal') ||
    host === '169.254.169.254'
  ) {
    throw new ValidationError('URL points to a private/internal address');
  }

  const res = await fetch(url, {
    signal: AbortSignal.timeout(20_000),
    headers: { 'user-agent': 'KnowledgeBot/1.0 (+knowledge ingestion)' },
    redirect: 'follow',
  });
  if (!res.ok) throw new ValidationError(`URL fetch failed with status ${res.status}`);
  const contentType = res.headers.get('content-type') ?? '';
  const body = Buffer.from(await res.arrayBuffer());

  if (contentType.includes('application/pdf')) {
    return parseBuffer(body, 'application/pdf', 'remote.pdf');
  }
  if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
    const { load } = await import('cheerio');
    const $ = load(body.toString('utf8'));
    $('script, style, nav, footer, header, noscript, iframe, svg').remove();
    const title = $('title').first().text().trim() || undefined;
    const main = $('main, article').first();
    const text = (main.length ? main.text() : $('body').text()) ?? '';
    return { text, title };
  }
  if (contentType.includes('text/') || contentType.includes('json')) {
    return { text: body.toString('utf8') };
  }
  throw new ValidationError(`Unsupported content type from URL: ${contentType}`);
}

/** Normalize whitespace and strip control characters. */
export function cleanText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
