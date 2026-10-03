-- Media library: images the agents can send (bytes in Postgres — stateless app).
CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MediaAsset_tenantId_idx" ON "MediaAsset"("tenantId");

ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Operator-editable platform settings (encrypted values; override env vars).
CREATE TABLE "AppSetting" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "valueEncrypted" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AppSetting_tenantId_key_key" ON "AppSetting"("tenantId", "key");

ALTER TABLE "AppSetting" ADD CONSTRAINT "AppSetting_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Personal Telegram accounts connected to the bot via Telegram Business:
-- one row per connected account, with per-account admin controls.
CREATE TABLE "TelegramPersonalAccount" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "businessConnectionId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "ownerName" TEXT NOT NULL DEFAULT '',
    "ownerUsername" TEXT,
    "userChatId" TEXT NOT NULL DEFAULT '',
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "canReply" BOOLEAN NOT NULL DEFAULT false,
    "canReadMessages" BOOLEAN NOT NULL DEFAULT false,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "displayName" TEXT NOT NULL DEFAULT '',
    "instructions" TEXT,
    "knowledgeBaseId" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramPersonalAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TelegramPersonalAccount_businessConnectionId_key"
    ON "TelegramPersonalAccount"("businessConnectionId");
CREATE INDEX "TelegramPersonalAccount_tenantId_idx" ON "TelegramPersonalAccount"("tenantId");

ALTER TABLE "TelegramPersonalAccount" ADD CONSTRAINT "TelegramPersonalAccount_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TelegramPersonalAccount" ADD CONSTRAINT "TelegramPersonalAccount_knowledgeBaseId_fkey"
    FOREIGN KEY ("knowledgeBaseId") REFERENCES "KnowledgeBase"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
