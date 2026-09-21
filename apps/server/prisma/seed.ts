import { PrismaClient } from '@prisma/client';
import {
  randomBytes,
  scrypt as scryptCb,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const prisma = new PrismaClient();

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt.toString('base64')}:${derived.toString('base64')}`;
}

/**
 * Idempotent seed: default tenant, admin user, one knowledge base, and the
 * three agents (disabled by default — enable them from the dashboard).
 * Default instructions are editable data, not code (spec §6–7).
 */
async function main(): Promise<void> {
  const tenantName = process.env.TENANT_NAME ?? 'Default Business';
  const adminEmail = (process.env.ADMIN_EMAIL ?? 'admin@example.com').toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD ?? 'change-me-now';

  const slug = tenantName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'default';

  const tenant = await prisma.tenant.upsert({
    where: { slug },
    create: { name: tenantName, slug },
    update: {},
  });

  const existingAdmin = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (!existingAdmin) {
    await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: adminEmail,
        passwordHash: await hashPassword(adminPassword),
        name: 'Administrator',
        role: 'ADMIN',
      },
    });
    console.error(`Created admin user ${adminEmail}`);
  }

  let kb = await prisma.knowledgeBase.findFirst({ where: { tenantId: tenant.id } });
  if (!kb) {
    kb = await prisma.knowledgeBase.create({
      data: {
        tenantId: tenant.id,
        name: 'Business knowledge',
        description: 'Products, services, prices, FAQs',
      },
    });
  }

  const agents: Array<{
    type: 'INSTAGRAM_COMMENT' | 'INSTAGRAM_DM' | 'TELEGRAM';
    name: string;
    systemInstructions: string;
    businessObjective: string;
  }> = [
    {
      type: 'INSTAGRAM_COMMENT',
      name: 'Instagram Comment Agent',
      businessObjective:
        'Answer public questions briefly, identify interested buyers, and move them into DMs.',
      systemInstructions: [
        'You represent our brand in public Instagram comments.',
        '- Reply briefly and warmly to genuine questions about our products/services.',
        '- If someone asks about price or availability, give the general answer if it is in the knowledge base; for details, send them a private reply (DM).',
        '- Thank people for compliments in one short sentence. Do not reply to plain emoji-only or tag-only comments.',
        '- Never argue with negative comments: apologize once, offer to resolve it in DMs, and escalate to a human.',
        '- Never mention discounts or promises that are not in the knowledge base.',
      ].join('\n'),
    },
    {
      type: 'INSTAGRAM_DM',
      name: 'Instagram DM Agent',
      businessObjective:
        'Qualify leads: understand what they need, share accurate details, and collect name + phone number for follow-up.',
      systemInstructions: [
        'You are our Instagram direct-message assistant.',
        '- Answer questions using the knowledge base; keep messages short (1-3 sentences).',
        '- When interest is clear, ask for the missing qualification detail (what they need, then name, then phone) — exactly one question per message.',
        '- If asked something outside the knowledge base, say you will check with the team and escalate.',
        '- If the customer is upset or asks for a human, escalate immediately.',
      ].join('\n'),
    },
    {
      type: 'TELEGRAM',
      name: 'Telegram Agent',
      businessObjective:
        'Provide help and qualify leads; collect name, phone, and requested service for the sales team.',
      systemInstructions: [
        'You are our Telegram assistant.',
        '- On /start, greet the user briefly and say what you can help with.',
        '- Answer questions from the knowledge base; keep messages conversational and short.',
        '- Guide interested users toward leaving their name and phone number so the team can call them back.',
        '- Escalate to a human on complaints, complex custom requests, or when the user asks for a person.',
      ].join('\n'),
    },
  ];

  for (const a of agents) {
    await prisma.agent.upsert({
      where: { tenantId_type: { tenantId: tenant.id, type: a.type } },
      create: {
        tenantId: tenant.id,
        type: a.type,
        name: a.name,
        enabled: false,
        systemInstructions: a.systemInstructions,
        businessObjective: a.businessObjective,
        tone: 'friendly, professional',
        language: 'auto',
        provider: 'anthropic',
        model: 'claude-opus-5',
        knowledgeBaseId: kb.id,
      },
      update: {},
    });
  }

  console.error(`Seed complete. Tenant "${tenant.name}", 3 agents (disabled), knowledge base ready.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
