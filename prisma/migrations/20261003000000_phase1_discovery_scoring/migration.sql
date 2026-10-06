-- CreateEnum
CREATE TYPE "UsSignal" AS ENUM ('confirmed', 'likely', 'unknown', 'unlikely');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('found', 'not_found');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('running', 'completed', 'stopped_quota', 'not_configured', 'failed');

-- AlterEnum
ALTER TYPE "DataSource" ADD VALUE 'youtube';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Influencer" ADD COLUMN     "isSample" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "SocialProfile" ADD COLUMN     "country" TEXT,
ADD COLUMN     "fetchNote" TEXT,
ADD COLUMN     "lastPostAt" TIMESTAMP(3),
ADD COLUMN     "lastPostUrl" TEXT,
ADD COLUMN     "recentCaptions" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "isSample" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "CampaignCreator" ADD COLUMN     "discoveryRunId" TEXT,
ADD COLUMN     "priorityReview" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Template" ADD COLUMN     "archived" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "DiscoveryRun" ADD COLUMN     "alreadyKnown" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "quotaUsed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "skipped" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "startedById" TEXT NOT NULL,
ADD COLUMN     "status" "RunStatus" NOT NULL DEFAULT 'running';

-- CreateTable
CREATE TABLE "FitAssessment" (
    "id" TEXT NOT NULL,
    "campaignCreatorId" TEXT NOT NULL,
    "scoringRunId" TEXT,
    "score" INTEGER NOT NULL,
    "usSignal" "UsSignal" NOT NULL,
    "emailStatus" "EmailStatus" NOT NULL,
    "reasons" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FitAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScoringRun" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "startedById" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "scored" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,

    CONSTRAINT "ScoringRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Hashtag" (
    "id" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "firstUsedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Hashtag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FitAssessment_campaignCreatorId_createdAt_idx" ON "FitAssessment"("campaignCreatorId", "createdAt");

-- CreateIndex
CREATE INDEX "FitAssessment_scoringRunId_idx" ON "FitAssessment"("scoringRunId");

-- CreateIndex
CREATE INDEX "ScoringRun_campaignId_startedAt_idx" ON "ScoringRun"("campaignId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Hashtag_tag_key" ON "Hashtag"("tag");

-- CreateIndex
CREATE INDEX "CampaignCreator_campaignId_priorityReview_fitScore_idx" ON "CampaignCreator"("campaignId", "priorityReview", "fitScore");

-- CreateIndex
CREATE INDEX "CampaignCreator_discoveryRunId_idx" ON "CampaignCreator"("discoveryRunId");

-- AddForeignKey
ALTER TABLE "CampaignCreator" ADD CONSTRAINT "CampaignCreator_discoveryRunId_fkey" FOREIGN KEY ("discoveryRunId") REFERENCES "DiscoveryRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveryRun" ADD CONSTRAINT "DiscoveryRun_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FitAssessment" ADD CONSTRAINT "FitAssessment_campaignCreatorId_fkey" FOREIGN KEY ("campaignCreatorId") REFERENCES "CampaignCreator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FitAssessment" ADD CONSTRAINT "FitAssessment_scoringRunId_fkey" FOREIGN KEY ("scoringRunId") REFERENCES "ScoringRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScoringRun" ADD CONSTRAINT "ScoringRun_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScoringRun" ADD CONSTRAINT "ScoringRun_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Flag the seed data so it can be archived in one click.
UPDATE "Influencer" SET "isSample" = true WHERE "notes" = 'Sample data from the seed script.';
UPDATE "Campaign" SET "isSample" = true WHERE "name" IN ('Holiday Gifting 2026', 'Spring Table Linens 2027');
