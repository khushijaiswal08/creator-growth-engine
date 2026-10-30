-- AlterTable
ALTER TABLE "GiftOrder" ADD COLUMN     "mcfCheckedAt" TIMESTAMP(3),
ADD COLUMN     "mcfError" TEXT,
ADD COLUMN     "mcfPackageNumber" INTEGER,
ADD COLUMN     "mcfSentAt" TIMESTAMP(3),
ADD COLUMN     "mcfStatus" TEXT,
ADD COLUMN     "trackingLink" TEXT;

-- CreateIndex
CREATE INDEX "GiftOrder_mcfSentAt_status_idx" ON "GiftOrder"("mcfSentAt", "status");

