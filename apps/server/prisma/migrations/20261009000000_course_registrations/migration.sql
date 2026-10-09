-- CreateEnum
CREATE TYPE "RegistrationStatus" AS ENUM ('NEW', 'CONTACT_NEEDED', 'CONTACTED', 'TRIAL_BOOKED', 'ENROLLED', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "OwnerInstruction" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "appliesTo" "AgentType",
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OwnerInstruction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourseRegistration" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "conversationId" TEXT,
    "fullName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "course" TEXT NOT NULL,
    "preferredTime" TEXT,
    "note" TEXT,
    "sourceChannel" "Channel" NOT NULL,
    "sourceAccount" TEXT,
    "status" "RegistrationStatus" NOT NULL DEFAULT 'NEW',
    "assignedToUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourseRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegistrationEvent" (
    "id" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "fromStatus" "RegistrationStatus",
    "toStatus" "RegistrationStatus" NOT NULL,
    "note" TEXT,
    "byUserId" TEXT,
    "byTelegramId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistrationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OwnerInstruction_tenantId_enabled_idx" ON "OwnerInstruction"("tenantId", "enabled");

-- CreateIndex
CREATE INDEX "CourseRegistration_tenantId_status_idx" ON "CourseRegistration"("tenantId", "status");

-- CreateIndex
CREATE INDEX "CourseRegistration_tenantId_createdAt_idx" ON "CourseRegistration"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CourseRegistration_tenantId_leadId_course_key" ON "CourseRegistration"("tenantId", "leadId", "course");

-- CreateIndex
CREATE INDEX "RegistrationEvent_registrationId_createdAt_idx" ON "RegistrationEvent"("registrationId", "createdAt");

-- AddForeignKey
ALTER TABLE "OwnerInstruction" ADD CONSTRAINT "OwnerInstruction_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseRegistration" ADD CONSTRAINT "CourseRegistration_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseRegistration" ADD CONSTRAINT "CourseRegistration_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseRegistration" ADD CONSTRAINT "CourseRegistration_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseRegistration" ADD CONSTRAINT "CourseRegistration_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationEvent" ADD CONSTRAINT "RegistrationEvent_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "CourseRegistration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

