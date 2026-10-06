-- AlterEnum
ALTER TYPE "CreatorStatus" ADD VALUE 'no_content';

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "noContentAfterDays" INTEGER NOT NULL DEFAULT 30;

