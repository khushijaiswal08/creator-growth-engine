-- AlterTable
ALTER TABLE "DiscoveryRun" ADD COLUMN     "cursor" JSONB,
ADD COLUMN     "lockedUntil" TIMESTAMP(3),
ADD COLUMN     "report" JSONB;

-- AlterTable
ALTER TABLE "FitAssessment" ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedById" TEXT,
ADD COLUMN     "reviewerNote" TEXT,
ADD COLUMN     "reviewerVerdict" BOOLEAN,
ADD COLUMN     "scoringPromptId" TEXT;

-- AlterTable
ALTER TABLE "ScoringRun" ADD COLUMN     "cursor" JSONB,
ADD COLUMN     "estimatedCostUsd" DECIMAL(10,4),
ADD COLUMN     "lockedUntil" TIMESTAMP(3),
ADD COLUMN     "scoringPromptId" TEXT;

-- CreateTable
CREATE TABLE "ScoringPrompt" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "systemPrompt" TEXT NOT NULL,
    "weights" JSONB NOT NULL,
    "note" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScoringPrompt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandSettings" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "dailyMessageTarget" INTEGER NOT NULL DEFAULT 20,
    "weeklyMessageTarget" INTEGER NOT NULL DEFAULT 100,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScoringPrompt_brandId_active_idx" ON "ScoringPrompt"("brandId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "ScoringPrompt_brandId_version_key" ON "ScoringPrompt"("brandId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "BrandSettings_brandId_key" ON "BrandSettings"("brandId");

-- AddForeignKey
ALTER TABLE "FitAssessment" ADD CONSTRAINT "FitAssessment_scoringPromptId_fkey" FOREIGN KEY ("scoringPromptId") REFERENCES "ScoringPrompt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FitAssessment" ADD CONSTRAINT "FitAssessment_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScoringRun" ADD CONSTRAINT "ScoringRun_scoringPromptId_fkey" FOREIGN KEY ("scoringPromptId") REFERENCES "ScoringPrompt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScoringPrompt" ADD CONSTRAINT "ScoringPrompt_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandSettings" ADD CONSTRAINT "BrandSettings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

