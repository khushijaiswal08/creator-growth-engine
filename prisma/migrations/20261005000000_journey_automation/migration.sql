-- CreateEnum
CREATE TYPE "CollaborationType" AS ENUM ('gifted', 'affiliate', 'paid');

-- CreateEnum
CREATE TYPE "GiftOrderStatus" AS ENUM ('needs_approval', 'approved', 'ordered', 'shipped', 'delivered', 'exception', 'cancelled');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TemplatePurpose" ADD VALUE 'selection';
ALTER TYPE "TemplatePurpose" ADD VALUE 'reminder';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isSystem" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "closeAfterDays" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN     "contentDueDays" INTEGER NOT NULL DEFAULT 21,
ADD COLUMN     "contentReminderDays" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN     "deliveryWaitDays" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "followUpAfterDays" INTEGER NOT NULL DEFAULT 4,
ADD COLUMN     "giftArticles" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "maxFollowUps" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "selectionWaitDays" INTEGER NOT NULL DEFAULT 5;

-- AlterTable
ALTER TABLE "CampaignCreator" ADD COLUMN     "approvedFee" INTEGER,
ADD COLUMN     "collaborationType" "CollaborationType",
ADD COLUMN     "contentDueAt" TIMESTAMP(3),
ADD COLUMN     "followUpsSent" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "nextAction" TEXT,
ADD COLUMN     "nextActionDueAt" TIMESTAMP(3),
ADD COLUMN     "reengageAfter" TIMESTAMP(3),
ADD COLUMN     "requestedFee" INTEGER,
ADD COLUMN     "selectionSentAt" TIMESTAMP(3),
ADD COLUMN     "selectionToken" TEXT,
ADD COLUMN     "waitingOn" TEXT;

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "collabInvite" BOOLEAN,
ADD COLUMN     "format" TEXT,
ADD COLUMN     "productShown" BOOLEAN;

-- AlterTable
ALTER TABLE "Activity" ADD COLUMN     "automated" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "asin" TEXT,
    "title" TEXT NOT NULL,
    "color" TEXT,
    "size" TEXT,
    "amazonUrl" TEXT,
    "websiteUrl" TEXT,
    "imageUrl" TEXT,
    "stock" INTEGER,
    "giftable" BOOLEAN NOT NULL DEFAULT true,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiftOrder" (
    "id" TEXT NOT NULL,
    "campaignCreatorId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "status" "GiftOrderStatus" NOT NULL,
    "shipName" TEXT NOT NULL,
    "address1" TEXT NOT NULL,
    "address2" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "postalCode" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "phone" TEXT,
    "creatorNote" TEXT,
    "approvalNote" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "orderNumber" TEXT,
    "carrier" TEXT,
    "trackingNumber" TEXT,
    "trackingStatus" TEXT,
    "shippedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GiftOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRun" (
    "id" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "summary" JSONB,

    CONSTRAINT "AutomationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Product_sku_key" ON "Product"("sku");

-- CreateIndex
CREATE INDEX "Product_brandId_title_idx" ON "Product"("brandId", "title");

-- CreateIndex
CREATE INDEX "Product_asin_idx" ON "Product"("asin");

-- CreateIndex
CREATE INDEX "GiftOrder_status_idx" ON "GiftOrder"("status");

-- CreateIndex
CREATE INDEX "GiftOrder_campaignCreatorId_idx" ON "GiftOrder"("campaignCreatorId");

-- CreateIndex
CREATE INDEX "GiftOrder_orderNumber_idx" ON "GiftOrder"("orderNumber");

-- CreateIndex
CREATE INDEX "AutomationRun_startedAt_idx" ON "AutomationRun"("startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignCreator_selectionToken_key" ON "CampaignCreator"("selectionToken");

-- CreateIndex
CREATE INDEX "CampaignCreator_nextActionDueAt_idx" ON "CampaignCreator"("nextActionDueAt");

-- AddForeignKey
ALTER TABLE "GiftOrder" ADD CONSTRAINT "GiftOrder_campaignCreatorId_fkey" FOREIGN KEY ("campaignCreatorId") REFERENCES "CampaignCreator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftOrder" ADD CONSTRAINT "GiftOrder_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftOrder" ADD CONSTRAINT "GiftOrder_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Two brands. Existing campaigns belong to Ridhi.
UPDATE "Campaign" SET "brandId" = 'ridhi' WHERE "brandId" = 'ridhi-home';
