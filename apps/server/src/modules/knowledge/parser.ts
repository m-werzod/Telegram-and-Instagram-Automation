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

/**
 * SSRF guard: validates protocol, hostname AND every DNS-resolved address
 * against private/link-local/loopback ranges, re-validates each redirect hop,
 * and caps the response size. Residual risk: a DNS-rebinding attacker could
 * still race resolve-then-fetch (TOCTOU) — acceptable given only authenticated
 * operators can submit URLs; full mitigation would require IP-pinned dialing.
 */
const MAX_FETCH_BYTES = 15 * 1024 * 1024;
const MAX_REDIRECTS = 3;

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true; // be safe
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64.0.0/10
    (a === 169 && b === 254) || // link-local incl. metadata service
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast/reserved
  );
}

function isPrivateAddress(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower.includes(':')) {
    // IPv6: loopback, unspecified, link-local fe80::/10, unique-local fc00::/7, IPv4-mapped
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIPv4(mapped[1]!);
    return false;
  }
  return isPrivateIPv4(lower);
}

async function assertPublicUrl(target: URL): Promise<void> {
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new ValidationError('Only http(s) URLs are supported');
  }
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new ValidationError('URL points to a private/internal address');
  }
  // Literal IPs (incl. non-dotted encodings the URL parser normalizes) and DNS names
  // are both checked against the resolved addresses.
  const { lookup } = await import('node:dns/promises');
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new ValidationError(`Could not resolve host: ${host}`);
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new ValidationError('URL resolves to a private/internal address');
  }
}

async function fetchPublicUrl(url: string): Promise<Response> {
  let current = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(current);
    const res = await fetch(current, {
      signal: AbortSignal.timeout(20_000),
      headers: { 'user-agent': 'KnowledgeBot/1.0 (+knowledge ingestion)' },
      redirect: 'manual',
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel().catch(() => undefined);
      if (!location) throw new ValidationError(`Redirect without a Location header (${res.status})`);
      current = new URL(location, current); // re-validated on the next iteration
      continue;
    }
    return res;
  }
  throw new ValidationError(`Too many redirects (limit ${MAX_REDIRECTS})`);
}

export async function parseUrl(url: string): Promise<ParsedDocument> {
  const res = await fetchPublicUrl(url);
  if (!res.ok) throw new ValidationError(`URL fetch failed with status ${res.status}`);
  const declaredLength = Number(res.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_FETCH_BYTES) {
    throw new ValidationError(`Document too large (limit ${MAX_FETCH_BYTES} bytes)`);
  }
  const contentType = res.headers.get('content-type') ?? '';
  const body = await readBodyCapped(res, MAX_FETCH_BYTES);

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

/** Stream the body with a hard byte cap (Content-Length can be absent or lie). */
async function readBodyCapped(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ValidationError(`Document too large (limit ${maxBytes} bytes)`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
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
