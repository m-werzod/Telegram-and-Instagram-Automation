-- Dashboard authentication moves from email to username ("Login").
ALTER TABLE "User" ADD COLUMN "username" TEXT;
UPDATE "User" SET "username" = "email" WHERE "username" IS NULL;
ALTER TABLE "User" ALTER COLUMN "username" SET NOT NULL;
ALTER TABLE "User" ALTER COLUMN "email" DROP NOT NULL;
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- Knowledge source files move from local disk into Postgres so the app holds
-- no production state on the filesystem (stateless container, no volume).
CREATE TABLE "KnowledgeFile" (
    "documentId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeFile_pkey" PRIMARY KEY ("documentId")
);

CREATE INDEX "KnowledgeFile_tenantId_idx" ON "KnowledgeFile"("tenantId");

ALTER TABLE "KnowledgeFile" ADD CONSTRAINT "KnowledgeFile_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "KnowledgeDocument"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
