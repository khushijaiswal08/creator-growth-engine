-- AlterEnum
ALTER TYPE "DataSource" ADD VALUE 'meta_marketplace';

-- CreateTable
CREATE TABLE "ApiCall" (
    "id" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" INTEGER,
    "ok" BOOLEAN NOT NULL,
    "errorCode" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApiCall_service_createdAt_idx" ON "ApiCall"("service", "createdAt");

