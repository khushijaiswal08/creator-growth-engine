-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TemplatePurpose" ADD VALUE 'delivered';
ALTER TYPE "TemplatePurpose" ADD VALUE 'arrival';
ALTER TYPE "TemplatePurpose" ADD VALUE 'deadline';

-- AlterTable
ALTER TABLE "Influencer" ADD COLUMN     "amazonGmvDetail" TEXT,
ADD COLUMN     "amazonMonthlyGmvUsd" DECIMAL(12,2),
ADD COLUMN     "amazonTier" TEXT;

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "arrivalCheckDays" INTEGER NOT NULL DEFAULT 3;

