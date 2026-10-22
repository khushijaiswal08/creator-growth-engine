-- AlterEnum
ALTER TYPE "MessageChannel" ADD VALUE 'amazon';

-- AlterTable
ALTER TABLE "BrandSettings" ADD COLUMN     "creatorConnectionsUrl" TEXT;
