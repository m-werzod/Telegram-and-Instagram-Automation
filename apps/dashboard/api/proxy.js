// Vercel Serverless Function: transparent reverse proxy for /api/* to the
// backend VPS. A plain `rewrites` entry (the usual, simpler approach) cannot
// be used here because the backend currently answers HTTPS with a
// self-issued certificate (the hosting provider's shared-IP gateway blocks
// public Let's Encrypt validation — see deploy/Caddyfile) — a standard proxy
// would refuse that certificate as untrusted. This function proxies the
// request itself using a dispatcher that trusts the backend explicitly,
// since we know exactly which server that certificate belongs to. Remove
// this file (and restore a plain `rewrites` entry in vercel.json) once the
// backend has a publicly-trusted certificate.
//
// Fixed (non-dynamic) function path on purpose: Vercel's generic/"Other"
// framework function routing does not reliably match a `[...path]`
// filesystem catch-all beyond one path segment. vercel.json instead rewrites
// every /api/:path* request to /api/proxy?path=:path*, carrying the full
// sub-path as a query parameter that this function reassembles.
import { Agent, fetch as undiciFetch } from 'undici';

export const config = {
  api: {
    bodyParser: false, // raw passthrough — must not mangle JSON/multipart/binary bodies
  },
};

const BACKEND = 'https://77-93-152-116.sslip.io:10044';

// A dedicated dispatcher that only skips certificate *trust-chain* validation
// for this one known backend — it still negotiates real TLS encryption, just
// without requiring a publicly-trusted issuer for this specific, known origin.
const insecureDispatcher = new Agent({ connect: { rejectUnauthorized: false } });

export default async function handler(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;

  // req.url here is the REWRITTEN url: /api/proxy?path=auth%2Flogin&foo=bar.
  // Rebuild the real backend path from the `path` param and pass every other
  // query param straight through unchanged.
  const incoming = new URL(req.url, 'http://internal');
  const subPath = incoming.searchParams.get('path') ?? '';
  incoming.searchParams.delete('path');
  const qs = incoming.searchParams.toString();
  const targetUrl = `${BACKEND}/api/${subPath}${qs ? `?${qs}` : ''}`;

  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  delete headers['content-length']; // fetch recomputes this from body

  let upstream;
  try {
    upstream = await undiciFetch(targetUrl, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      dispatcher: insecureDispatcher,
      redirect: 'manual',
    });
  } catch (err) {
    res.statusCode = 502;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: { code: 'upstream_unreachable', message: String(err) } }));
    return;
  }

  res.statusCode = upstream.status;
  for (const [key, value] of upstream.headers) {
    const k = key.toLowerCase();
    if (k === 'content-encoding' || k === 'transfer-encoding' || k === 'set-cookie') continue;
    res.setHeader(key, value);
  }
  const setCookie = upstream.headers.getSetCookie?.() ?? [];
  if (setCookie.length) res.setHeader('set-cookie', setCookie);

  const buf = Buffer.from(await upstream.arrayBuffer());
  res.end(buf);
}
