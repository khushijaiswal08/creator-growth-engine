-- CreateEnum
CREATE TYPE "ContentKind" AS ENUM ('video', 'photo', 'other');

-- CreateEnum
CREATE TYPE "ContentStatus" AS ENUM ('uploading', 'received', 'approved', 'changes_requested');

-- CreateEnum
CREATE TYPE "UsageRights" AS ENUM ('organic', 'paid', 'none');

-- AlterEnum
ALTER TYPE "TemplatePurpose" ADD VALUE 'upload';

-- AlterTable
ALTER TABLE "CampaignCreator" ADD COLUMN     "uploadExpiresAt" TIMESTAMP(3),
ADD COLUMN     "uploadSentAt" TIMESTAMP(3),
ADD COLUMN     "uploadToken" TEXT;

-- CreateTable
CREATE TABLE "ContentAsset" (
    "id" TEXT NOT NULL,
    "campaignCreatorId" TEXT NOT NULL,
    "kind" "ContentKind" NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "status" "ContentStatus" NOT NULL DEFAULT 'uploading',
    "usageRights" "UsageRights" NOT NULL,
    "productId" TEXT,
    "postUrl" TEXT,
    "postedAt" TIMESTAMP(3),
    "creatorNote" TEXT,
    "reviewNote" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ContentAsset_storageKey_key" ON "ContentAsset"("storageKey");

-- CreateIndex
CREATE INDEX "ContentAsset_campaignCreatorId_idx" ON "ContentAsset"("campaignCreatorId");

-- CreateIndex
CREATE INDEX "ContentAsset_status_archived_idx" ON "ContentAsset"("status", "archived");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignCreator_uploadToken_key" ON "CampaignCreator"("uploadToken");

-- AddForeignKey
ALTER TABLE "ContentAsset" ADD CONSTRAINT "ContentAsset_campaignCreatorId_fkey" FOREIGN KEY ("campaignCreatorId") REFERENCES "CampaignCreator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentAsset" ADD CONSTRAINT "ContentAsset_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentAsset" ADD CONSTRAINT "ContentAsset_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

