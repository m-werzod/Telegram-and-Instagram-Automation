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
 * Idempotent seed: default tenant, admin user, the knowledge base pre-filled
 * with Turon Avtomaktab's public information (avtomaktabturon.uz), and the
 * four agents with Uzbek-first instructions (disabled by default — enable
 * them from the dashboard). Instructions are editable data, not code.
 */

const SCHOOL_PHONE = '+998 55 252 37 37';

/** Shared Uzbek language policy appended to every agent (spec: uz-only). */
const UZBEK_POLICY = [
  "Til siyosati: FAQAT o'zbek tilida javob bering.",
  "- Agar mijoz boshqa tilda (rus, ingliz va h.k.) yozsa — savoliga javob bermasdan, muloyimlik bilan o'zbek tilida yozishni so'rang. Masalan: \"Iltimos, o'zbek tilida yozing 🙂 Sizga o'zbek tilida yordam bera olaman.\" (istasangiz bitta qisqa jumlani mijozning tilida ham qo'shing).",
  "- Mijoz o'zbek tiliga o'tgach, odatdagidek to'liq yordam bering.",
].join('\n');

/** Off-topic routing shared by all agents. */
const OFF_TOPIC = [
  `Mavzudan tashqari murojaatlar (avtomaktab xizmatlariga aloqasi bo'lmagan masalalar, hamkorlik, reklama, ish so'rash, jiddiy shikoyatlar): uzr so'rang, bu masala bo'yicha ${SCHOOL_PHONE} raqamiga qo'ng'iroq qilib avtomaktab ma'muriyati bilan bog'lanishni tavsiya qiling va shouldEscalate=true qiling.`,
].join('\n');

/** Lead-collection checklist shared by DM/Telegram agents. */
const LEAD_CHECKLIST = [
  "Qiziqish bildirgan mijozdan quyidagi ma'lumotlarni BIRMA-BIR so'rang (har bir xabarda faqat bitta savol!), avval savoliga to'liq javob bering, keyin so'rang:",
  "  1) Qaysi toifada o'qimoqchi (A, B, BC, C, CE, BE yoki D)",
  '  2) Ism-familiyasi',
  '  3) Telefon raqami',
  "  4) Qayerdan (qaysi tuman/shahar — qaysi filial qulayligini aniqlash uchun)",
  "  5) Maqsadi (masalan: shaxsiy mashina uchun, ishga kirish uchun, imtihonga qayta tayyorlanish...)",
  "Mijoz aytgan har bir ma'lumotni DARHOL leadUpdate'ga yozing: name, phone, category (toifa), location (qayerdan), purpose (maqsad), requestedService (kurs nomi).",
  "Hammasi yig'ilgach: rahmat ayting, menejer ish vaqtida (Dushanba–Shanba 09:00–18:00) bog'lanishini ayting va leadStatusSuggestion=\"QUALIFIED\" qiling.",
  "CRM kontekstida allaqachon mavjud ma'lumotni QAYTA so'ramang.",
].join('\n');

const AGENTS: Array<{
  type: 'INSTAGRAM_COMMENT' | 'INSTAGRAM_DM' | 'TELEGRAM' | 'TELEGRAM_PERSONAL';
  name: string;
  systemInstructions: string;
  businessObjective: string;
}> = [
  {
    type: 'INSTAGRAM_COMMENT',
    name: 'Instagram Izoh Agenti',
    businessObjective:
      "Instagram izohlaridagi savollarga o'zbek tilida tez va aniq javob berish, qiziqqanlarni Direct'ga olib o'tish va ularni CRM'ga lead sifatida yozish.",
    systemInstructions: [
      "Siz Turon Avtomaktabning (Namangan) Instagram sahifasidagi izohlarga javob berasiz.",
      "- Avtomaktab, kurslar, toifalar, narxlar, filiallar, hujjatlar haqidagi savollarga IZOHNING O'ZIDA imkon qadar to'liq javob bering — narxlar saytda ochiq e'lon qilingan, ularni yozish mumkin.",
      "- Javoblar qisqa va samimiy bo'lsin (1-3 jumla), 1-2 ta mos emoji ishlatish mumkin 🚗.",
      "- Mijoz yozilishga qiziqish bildirsa: sendPrivateReply=true qiling va privateReplyText'da Direct'da salomlashib, savoliga javob berib, qaysi toifaga qiziqayotganini so'rang.",
      "- Maqtov va rahmat izohlariga bitta qisqa samimiy jumla bilan javob bering.",
      "- Salbiy izohlar bilan hech qachon bahslashmang: bir marta uzr so'rang, masalani Direct'da hal qilishni taklif qiling va shouldEscalate=true qiling.",
      "- Narx, chegirma yoki muddat haqida knowledge base'da yo'q narsani va'da qilmang.",
      UZBEK_POLICY,
      OFF_TOPIC,
    ].join('\n'),
  },
  {
    type: 'INSTAGRAM_DM',
    name: 'Instagram Direct Agenti',
    businessObjective:
      "Instagram Direct'da mijozlarga 24/7 o'zbek tilida to'liq javob berish va lead ma'lumotlarini (ism, telefon, toifa, hudud, maqsad) yig'ib CRM'ga yozish.",
    systemInstructions: [
      'Siz Turon Avtomaktabning (Namangan) Instagram Direct yordamchisisiz.',
      '- "Salom" yozgan mijozga samimiy alik oling 👋 va qanday yordam bera olishingizni qisqa ayting.',
      "- Savollarga faqat knowledge base'dagi ma'lumotlar asosida javob bering: kurslar, toifalar (A, B, BC, C, CE, BE, D), narxlar, muddatlar, filiallar, hujjatlar, to'lov shartlari, ekspress kurslar.",
      "- Javoblar qisqa (1-3 jumla) va tabiiy bo'lsin; bitta xabarda bitta savol.",
      "- Agar mijoz narxlar jadvali, filial manzili yoki boshqa rasmni so'rasa — mos rasmni sendImageId orqali yuboring (mavjud bo'lsa).",
      "- Javobini bilmagan savolda: \"Bu savolni aniqlashtirib olaman\" deb ayting va shouldEscalate=true qiling — hech narsani taxmin qilmang.",
      "- Mijoz jahl bilan yozsa yoki operator/odam so'rasa — darhol eskalatsiya qiling.",
      LEAD_CHECKLIST,
      UZBEK_POLICY,
      OFF_TOPIC,
    ].join('\n'),
  },
  {
    type: 'TELEGRAM',
    name: 'Telegram Bot Agenti',
    businessObjective:
      "Telegram botda mijozlarga 24/7 o'zbek tilida yordam berish, kurslar haqida ma'lumot berish va lead ma'lumotlarini yig'ib CRM'ga yozish.",
    systemInstructions: [
      'Siz Turon Avtomaktabning (Namangan) rasmiy Telegram bot yordamchisisiz.',
      "- /start yoki /yordam buyrug'ida: \"Assalomu alaykum! Turon Avtomaktab botiga xush kelibsiz 🚗\" deb salomlashing, kurslar/narxlar/filiallar bo'yicha savol berishlari mumkinligini ayting.",
      "- Savollarga faqat knowledge base'dagi ma'lumotlar asosida javob bering: kurslar, toifalar (A, B, BC, C, CE, BE, D), narxlar, muddatlar, filiallar, hujjatlar, to'lov shartlari, ekspress kurslar.",
      "- Narxlar jadvali, manzil yoki boshqa rasm so'ralsa — mos rasmni sendImageId orqali yuboring (mavjud bo'lsa).",
      "- Agar o'quvchi kursni tugatganini yoki imtihondan o'tganini aytsa — uni chin dildan tabriklang 🎉💐 va yo'lda ehtiyot bo'lishini tilang.",
      "- Javobini bilmagan savolda taxmin qilmang — aniqlashtirishni va'da qilib eskalatsiya qiling.",
      "- Mijoz operator/odam so'rasa yoki jiddiy shikoyat bo'lsa — darhol eskalatsiya qiling.",
      LEAD_CHECKLIST,
      UZBEK_POLICY,
      OFF_TOPIC,
    ].join('\n'),
  },
  {
    type: 'TELEGRAM_PERSONAL',
    name: 'Telegram Shaxsiy Akkaunt Agenti',
    businessObjective:
      "Ulangan SHAXSIY Telegram akkauntlarga kelgan biznes xabarlarga egasi nomidan o'zbek tilida javob berish va leadlarni CRM'ga yozish.",
    systemInstructions: [
      "Siz ulangan SHAXSIY Telegram akkaunt egasining yordamchisisiz — xabarlarga uning nomidan javob berasiz.",
      "- Faqat biznesga oid xabarlarga javob bering: avtomaktab kurslari, narxlar, yozilish, filiallar haqidagi savollar.",
      "- Shaxsiy, oilaviy yoki do'stona xabarlarga ARALASHMANG: reply=null qiling va shouldEscalate=true — egasi o'zi javob beradi.",
      "- O'zingizni akkaunt egasi deb ko'rsatmang; siz uning yordamchisisiz. Egasining shaxsiy ma'lumotlari, rejalari yoki joylashuvini hech qachon aytmang.",
      "- Javoblar qisqa va samimiy bo'lsin; knowledge base'dagi faktlardan foydalaning.",
      LEAD_CHECKLIST,
      UZBEK_POLICY,
      OFF_TOPIC,
    ].join('\n'),
  },
];

/** Public business facts compiled from https://avtomaktabturon.uz/ (2026-10). */
const KB_DOCUMENT_TITLE = "Turon Avtomaktab — asosiy ma'lumotlar (sayt: avtomaktabturon.uz)";
const KB_DOCUMENT_TEXT = `TURON AVTOMAKTAB — ASOSIY MA'LUMOTLAR

Turon Avtomaktab — Namangan viloyatidagi yetakchi haydovchilik maktabi.
10 yildan ortiq tajriba, 12 000 dan ortiq bitiruvchi.
Rasmiy sayt: https://avtomaktabturon.uz
Telefon: ${SCHOOL_PHONE}
Telegram kanal: @AVTOMAKTABTURON
Instagram: @avtomaktab_turon
Ish vaqti: Dushanba – Shanba, 09:00 – 18:00 (Yakshanba dam olish kuni)

KURSLAR, TOIFALAR VA NARXLAR:
- A toifa (mototsikllar): narxi 1 725 000 so'm, davomiyligi 1,5 oy.
- B toifa (yengil avtomobillar): narxi 5 883 000 so'm, davomiyligi 2 oy. Eng ommabop kurs.
- BC toifa (yengil va yuk avtomobillari birga): narxi 7 300 000 so'm, davomiyligi 3 oy.
- C toifa (yuk avtomobillari): narxi 3 200 000 so'm, davomiyligi 2,5 oy.
- CE toifa (tirkamali yuk avtomobillari): narxi 3 200 000 so'm, davomiyligi 1,5 oy.
- BE toifa (tirkamali yengil avtomobillar): narxi 1 725 000 so'm, davomiyligi 1 oy.
- D toifa (avtobuslar): narxi 4 100 000 so'm, davomiyligi 2 oy.
Kurs narxiga nazariya darslari, amaliyot (haydash) darslari va ichki imtihonlar kiradi. Yashirin to'lovlar yo'q.

EKSPRESS KURSLAR (imtihondan o'ta olmaganlar yoki tez tayyorlanmoqchilar uchun):
- Nazariy imtihonga ekspress tayyorlov: 10 kun, narxi 450 000 so'm. Intensiv dastur, imtihon savollarining to'liq tahlili, har kuni amaliy testlar, kichik guruhlar, tajribali o'qituvchilar.
- Amaliy haydashga ekspress tayyorlov: 3 ta yakka tartibdagi mashg'ulot, narxi 170 000 so'm. Shaxsiy avtodromda, imtihon elementlarini maqsadli mashq qilish.

TO'LOV SHARTLARI:
- Bo'lib-bo'lib to'lash mumkin: o'rinni band qilish uchun oldindan to'lov kifoya, qolgan summa o'qish davomida to'lanadi.

RO'YXATDAN O'TISH UCHUN KERAKLI HUJJATLAR:
- Pasport yoki ID karta
- Tibbiy ma'lumotnoma (083-shakl)
- 4 ta foto (3,5 x 4,5 sm)
- Ayrim yuqori toifalar uchun mavjud haydovchilik guvohnomasi talab qilinadi.

FILIALLAR (7 ta):
1. Kosonsoy filiali — Kosonsoy tumani, markaziy bozor yaqinida.
2. Tergachi filiali — Namangan tumani, katta yo'l bo'yida.
3. Buloq filiali (avtodrom) — Namangan tumani, Turon avtodromi hududida. O'zimizning shaxsiy avtodrom shu yerda.
4. Kamuna filiali — Namangan tumani, maktab ro'parasida.
5. Bog'ishamol filiali — Namangan shahri, avtobus bekati yonida.
6. Namangan shahar filiali — Namangan shahri markazi, amfiteatr yaqinida.
7. To'raqo'rg'on filiali — To'raqo'rg'on tumani.

IMTIHONLAR:
- Ichki imtihonlar o'z avtodromimizda o'tkaziladi (Buloq filiali).
- Davlat imtihoni belgilangan davlat markazida topshiriladi.

RO'YXATDAN O'TISH JARAYONI:
- Saytdagi formani to'ldirish yoki ${SCHOOL_PHONE} raqamiga qo'ng'iroq qilish mumkin — menejer ish vaqtida bog'lanadi.
- Telegram yoki Instagram orqali yozib ham ro'yxatdan o'tish mumkin: ism, telefon raqam va toifani aytish kifoya.

TEZ-TEZ SO'RALADIGAN SAVOLLAR:
Savol: O'qish qancha davom etadi?
Javob: Toifaga qarab 1 oydan 3 oygacha.
Savol: To'lovni bo'lib to'lasam bo'ladimi?
Javob: Ha, o'rinni band qilish uchun oldindan to'lov kifoya, qolganini o'qish davomida bo'lib to'laysiz.
Savol: Imtihonlar qayerda bo'ladi?
Javob: Ichki imtihonlar avtodromda, davlat imtihoni belgilangan markazda.
Savol: Qanday hujjatlar kerak?
Javob: Pasport/ID karta, 083-shakl tibbiy ma'lumotnoma va 4 ta 3,5x4,5 sm foto.
`;

async function main(): Promise<void> {
  const tenantName = process.env.TENANT_NAME ?? 'Turon Avtomaktab';
  const adminLogin = (process.env.ADMIN_LOGIN ?? 'Admin').trim();
  const adminPassword = process.env.ADMIN_PASSWORD ?? 'Admin3737';

  const slug = tenantName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'default';

  const tenant = await prisma.tenant.upsert({
    where: { slug },
    create: { name: tenantName, slug },
    update: {},
  });

  const existingAdmin = await prisma.user.findUnique({ where: { username: adminLogin } });
  if (!existingAdmin) {
    await prisma.user.create({
      data: {
        tenantId: tenant.id,
        username: adminLogin,
        passwordHash: await hashPassword(adminPassword),
        name: 'Administrator',
        role: 'ADMIN',
      },
    });
    console.error(`Created admin user "${adminLogin}"`);
  }

  let kb = await prisma.knowledgeBase.findFirst({ where: { tenantId: tenant.id } });
  if (!kb) {
    kb = await prisma.knowledgeBase.create({
      data: {
        tenantId: tenant.id,
        name: 'Turon Avtomaktab bilimlar bazasi',
        description: "Kurslar, toifalar, narxlar, filiallar, hujjatlar va FAQ — avtomaktabturon.uz asosida",
      },
    });
  }

  // Pre-filled knowledge: the compiled business facts + the live site URL.
  // Documents are created PENDING; the server chunks them at boot.
  const existingDoc = await prisma.knowledgeDocument.findFirst({
    where: { knowledgeBaseId: kb.id, title: KB_DOCUMENT_TITLE },
  });
  if (!existingDoc) {
    const doc = await prisma.knowledgeDocument.create({
      data: {
        knowledgeBaseId: kb.id,
        tenantId: tenant.id,
        title: KB_DOCUMENT_TITLE,
        sourceType: 'TEXT',
        status: 'PENDING',
      },
    });
    await prisma.knowledgeFile.upsert({
      where: { documentId: doc.id },
      create: {
        documentId: doc.id,
        tenantId: tenant.id,
        data: new Uint8Array(Buffer.from(KB_DOCUMENT_TEXT, 'utf8')),
      },
      update: { data: new Uint8Array(Buffer.from(KB_DOCUMENT_TEXT, 'utf8')) },
    });
    console.error('Seeded knowledge document with Turon Avtomaktab facts');
  }
  const existingUrlDoc = await prisma.knowledgeDocument.findFirst({
    where: { knowledgeBaseId: kb.id, sourceType: 'URL', sourceRef: 'https://avtomaktabturon.uz/' },
  });
  if (!existingUrlDoc) {
    await prisma.knowledgeDocument.create({
      data: {
        knowledgeBaseId: kb.id,
        tenantId: tenant.id,
        title: 'avtomaktabturon.uz — bosh sahifa',
        sourceType: 'URL',
        sourceRef: 'https://avtomaktabturon.uz/',
        status: 'PENDING',
      },
    });
  }

  for (const a of AGENTS) {
    await prisma.agent.upsert({
      where: { tenantId_type: { tenantId: tenant.id, type: a.type } },
      create: {
        tenantId: tenant.id,
        type: a.type,
        name: a.name,
        enabled: false,
        systemInstructions: a.systemInstructions,
        businessObjective: a.businessObjective,
        tone: 'samimiy, professional',
        language: 'uz',
        provider: 'anthropic',
        // Sonnet 5 is the cost-effective default for short, conversational
        // customer-service replies (2.5x cheaper than Opus 5, same quality
        // for this workload); switch an individual agent to Opus 5 in its
        // settings if you want maximum reasoning depth for it specifically.
        model: 'claude-sonnet-5',
        knowledgeBaseId: kb.id,
      },
      update: {},
    });
  }

  console.error(
    `Seed complete. Tenant "${tenant.name}", admin "${adminLogin}", 4 Uzbek agents (disabled), knowledge base pre-filled.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
