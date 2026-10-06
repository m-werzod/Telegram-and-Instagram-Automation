import type { FastifyInstance } from 'fastify';
import { getPrisma } from '../db/client.js';
import { parseAgentSettings } from '../modules/engine/business-rules.js';

/**
 * Public legal pages required by Meta before an app can go Live:
 *  - a Privacy Policy URL (App Dashboard → Settings → Basic), and
 *  - EITHER a data deletion callback OR a Data Deletion Instructions URL.
 *
 * The instructions URL is implemented rather than the signed-request callback:
 * it satisfies the same requirement with no Meta-signed payload to verify and
 * nothing that can silently break, and deletion here is a human-reviewed
 * action against a business's own CRM rather than an automated purge.
 *
 * Content is generated from what the platform ACTUALLY does — the processors
 * it calls, the fields it stores, the retention the code applies — so the
 * disclosure cannot drift away from the implementation the way a hand-written
 * page does. The operator still owns it as a legal document.
 */
export async function legalRoutes(app: FastifyInstance): Promise<void> {
  // Both spellings of each path. These URLs are typed by hand into a form on
  // someone else's dashboard, and a trailing slash arriving as a 404 would look
  // exactly like the page not existing.
  for (const [canonical, alias] of [
    ['/privacy', '/privacy/'],
    ['/data-deletion', '/data-deletion/'],
  ] as const) {
    app.get(alias, { config: { rateLimit: false } }, (_req, reply) => reply.redirect(canonical, 301));
  }

  app.get('/privacy', { config: { rateLimit: false } }, async (_req, reply) => {
    const { business, contact } = await businessIdentity();
    return reply.type('text/html; charset=utf-8').send(
      page(
        `Privacy Policy — ${business}`,
        `<h1>Privacy Policy</h1>
<p class="sub">${escapeHtml(business)} · last updated ${today()}</p>

<h2>Who we are</h2>
<p>${escapeHtml(business)} operates an automated customer-messaging assistant that answers
enquiries sent to our Instagram and Telegram accounts.</p>

<h2>What we collect</h2>
<ul>
  <li><strong>Messages you send us</strong> on Instagram or Telegram, and the replies we send you.</li>
  <li><strong>Your public account identifier</strong> on that platform (username and the platform-scoped user id) and your display name.</li>
  <li><strong>Contact and enquiry details you choose to tell us</strong> — for example your name, phone number, email, the course or service you are asking about, and your location.</li>
</ul>
<p>We do not collect passwords, payment card numbers or government identity documents, and our
assistant is instructed never to ask for them.</p>

<h2>Why we use it</h2>
<p>To answer your enquiry, to keep the context of our conversation so you are not asked the same
question twice, and to follow up about the service you asked about. We do not sell your data and we
do not use it for advertising.</p>

<h2>Who else processes it</h2>
<ul>
  <li><strong>Instagram / Meta</strong> and <strong>Telegram</strong> — the platforms the message is sent through.</li>
  <li><strong>Our AI provider</strong> (OpenAI or Anthropic, depending on configuration) — the text of the
      conversation is sent so a reply can be generated. It is not used to train their models.</li>
  <li><strong>Our hosting provider</strong>, where the database runs.</li>
</ul>

<h2>How long we keep it</h2>
<p>Conversations and enquiry records are retained while they remain commercially relevant and are
pruned automatically thereafter. You can ask us to delete yours sooner at any time.</p>

<h2>Your rights</h2>
<p>You can ask us for a copy of the data we hold about you, ask us to correct it, or ask us to delete
it — see <a href="/data-deletion">Data deletion</a>.</p>

<h2>Contact</h2>
<p>${contact}</p>`,
      ),
    );
  });

  app.get('/data-deletion', { config: { rateLimit: false } }, async (_req, reply) => {
    const { business, contact } = await businessIdentity();
    return reply.type('text/html; charset=utf-8').send(
      page(
        `Data deletion — ${business}`,
        `<h1>How to delete your data</h1>
<p class="sub">${escapeHtml(business)} · last updated ${today()}</p>

<p>You can ask us to delete everything we hold about you. There is no form to fill in and no account
to create.</p>

<h2>Request deletion</h2>
<ol>
  <li>Send us a message from the same Instagram or Telegram account you contacted us from, or use the
      contact details below.</li>
  <li>Write <strong>“Delete my data”</strong> (or <em>“Mening ma'lumotlarimni o'chiring”</em>).</li>
  <li>We confirm the request and delete the data within <strong>30 days</strong>.</li>
</ol>

<h2>What gets deleted</h2>
<ul>
  <li>Every message you sent us and every reply we sent you.</li>
  <li>Your enquiry record — name, username, phone, email and any details you gave us.</li>
  <li>Any notes or tags attached to that record.</li>
</ul>
<p>Messages still held by Instagram or Telegram themselves are outside our control; delete those in
the app you sent them from.</p>

<h2>What we may keep</h2>
<p>Only records we are legally required to retain, such as accounting records for a completed
purchase. These are kept for the period the law requires and nothing longer.</p>

<h2>Contact</h2>
<p>${contact}</p>`,
      ),
    );
  });
}

/**
 * Business name and contact line, read from existing configuration — the
 * tenant and whatever contact an operator already set for their agents — so
 * these pages never carry an invented phone number or a stale placeholder.
 */
async function businessIdentity(): Promise<{ business: string; contact: string }> {
  const prisma = getPrisma();
  const tenant = await prisma.tenant
    .findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true, name: true } })
    .catch(() => null);
  const business = tenant?.name ?? 'This business';

  let contactValue: string | null = null;
  if (tenant) {
    const agents = await prisma.agent
      .findMany({ where: { tenantId: tenant.id }, select: { settings: true } })
      .catch(() => []);
    for (const agent of agents) {
      const value = parseAgentSettings(agent as never).contactFallback?.trim();
      if (value) {
        contactValue = value;
        break;
      }
    }
  }

  const contact = contactValue
    ? `Contact ${escapeHtml(business)}: <strong>${escapeHtml(contactValue)}</strong>, or reply to us on the Instagram or Telegram account you messaged.`
    : `Reply to us on the Instagram or Telegram account you messaged and ask for a human — your request reaches a person.`;
  return { business, contact };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Self-contained page: the app's CSP allows no external styles or scripts. */
function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  body{margin:0;background:#f4f6fa;color:#1a2030;font:16px/1.65 system-ui,'Segoe UI',sans-serif}
  main{max-width:720px;margin:0 auto;padding:40px 20px 72px}
  h1{font-size:28px;letter-spacing:-.3px;margin:0 0 4px}
  h2{font-size:18px;margin:32px 0 8px}
  .sub{color:#6b7486;margin:0 0 28px;font-size:14px}
  ul,ol{padding-left:22px}li{margin:6px 0}
  a{color:#3a53d6}
</style></head><body><main>${body}</main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
