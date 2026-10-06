-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('instagram', 'tiktok', 'youtube');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('admin', 'marketer');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('draft', 'active', 'paused', 'completed', 'archived');

-- CreateEnum
CREATE TYPE "CreatorStatus" AS ENUM ('discovered', 'scored', 'approved', 'rejected', 'review_later', 'blacklisted', 'outreach_scheduled', 'contacted', 'follow_up_due', 'replied', 'interested', 'not_interested', 'negotiating', 'agreed', 'address_collected', 'product_shipped', 'content_expected', 'content_posted', 'completed', 'no_reply', 'invalid_contact', 'bounced', 'unsubscribed', 'duplicate', 'on_hold');

-- CreateEnum
CREATE TYPE "MessageChannel" AS ENUM ('email', 'dm');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('in', 'out');

-- CreateEnum
CREATE TYPE "TemplatePurpose" AS ENUM ('first', 'followup', 'agreed', 'other');

-- CreateEnum
CREATE TYPE "DataSource" AS ENUM ('csv', 'manual', 'meta_free', 'vendor');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'marketer',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Influencer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "location" TEXT,
    "usSignal" INTEGER,
    "notes" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Influencer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialProfile" (
    "id" TEXT NOT NULL,
    "influencerId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "handle" TEXT NOT NULL,
    "followers" INTEGER,
    "engagementRate" DOUBLE PRECISION,
    "bio" TEXT,
    "website" TEXT,
    "lastFetchedAt" TIMESTAMP(3),
    "source" "DataSource" NOT NULL DEFAULT 'manual',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "brief" TEXT NOT NULL,
    "nicheKeywords" TEXT[],
    "negativeKeywords" TEXT[],
    "targetPosts" INTEGER,
    "deadline" TIMESTAMP(3),
    "status" "CampaignStatus" NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignCreator" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "influencerId" TEXT NOT NULL,
    "status" "CreatorStatus" NOT NULL DEFAULT 'discovered',
    "ownerId" TEXT,
    "fitScore" INTEGER,
    "fitReason" TEXT,
    "lastContactedAt" TIMESTAMP(3),
    "repliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignCreator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agreement" (
    "id" TEXT NOT NULL,
    "campaignCreatorId" TEXT NOT NULL,
    "postsAgreed" INTEGER NOT NULL,
    "deadline" TIMESTAMP(3),
    "productsGifted" TEXT[],
    "discountCode" TEXT,
    "requiresDisclosure" BOOLEAN NOT NULL DEFAULT true,
    "guidelines" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agreement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Post" (
    "id" TEXT NOT NULL,
    "campaignCreatorId" TEXT NOT NULL,
    "socialProfileId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "postedAt" TIMESTAMP(3),
    "caption" TEXT,
    "hasDisclosure" BOOLEAN,
    "mentionsBrand" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Post_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Metric" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "views" INTEGER,
    "likes" INTEGER,
    "comments" INTEGER,
    "shares" INTEGER,
    "codeUses" INTEGER,

    CONSTRAINT "Metric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL,
    "campaignCreatorId" TEXT NOT NULL,
    "byUserId" TEXT NOT NULL,
    "easeRating" INTEGER,
    "qualityRating" INTEGER,
    "workAgain" BOOLEAN,
    "notes" TEXT,
    "creatorFormReturnedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "campaignCreatorId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" "MessageChannel" NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "body" TEXT NOT NULL,
    "templateId" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "classification" TEXT,
    "classificationConfidence" DOUBLE PRECISION,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Template" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" "TemplatePurpose" NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL,
    "campaignCreatorId" TEXT,
    "influencerId" TEXT,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Suppression" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "platform" "Platform",
    "handle" TEXT,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Suppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscoveryRun" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "source" "DataSource" NOT NULL,
    "query" JSONB NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "found" INTEGER NOT NULL DEFAULT 0,
    "added" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DiscoveryRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Influencer_email_idx" ON "Influencer"("email");

-- CreateIndex
CREATE INDEX "Influencer_archived_idx" ON "Influencer"("archived");

-- CreateIndex
CREATE INDEX "Influencer_name_idx" ON "Influencer"("name");

-- CreateIndex
CREATE INDEX "SocialProfile_influencerId_idx" ON "SocialProfile"("influencerId");

-- CreateIndex
CREATE UNIQUE INDEX "SocialProfile_platform_handle_key" ON "SocialProfile"("platform", "handle");

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_name_key" ON "Campaign"("name");

-- CreateIndex
CREATE INDEX "Campaign_status_idx" ON "Campaign"("status");

-- CreateIndex
CREATE INDEX "Campaign_brandId_idx" ON "Campaign"("brandId");

-- CreateIndex
CREATE INDEX "CampaignCreator_campaignId_status_idx" ON "CampaignCreator"("campaignId", "status");

-- CreateIndex
CREATE INDEX "CampaignCreator_influencerId_idx" ON "CampaignCreator"("influencerId");

-- CreateIndex
CREATE INDEX "CampaignCreator_ownerId_idx" ON "CampaignCreator"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignCreator_campaignId_influencerId_key" ON "CampaignCreator"("campaignId", "influencerId");

-- CreateIndex
CREATE UNIQUE INDEX "Agreement_campaignCreatorId_key" ON "Agreement"("campaignCreatorId");

-- CreateIndex
CREATE UNIQUE INDEX "Post_url_key" ON "Post"("url");

-- CreateIndex
CREATE INDEX "Post_campaignCreatorId_idx" ON "Post"("campaignCreatorId");

-- CreateIndex
CREATE INDEX "Post_socialProfileId_idx" ON "Post"("socialProfileId");

-- CreateIndex
CREATE INDEX "Metric_postId_capturedAt_idx" ON "Metric"("postId", "capturedAt");

-- CreateIndex
CREATE INDEX "Feedback_campaignCreatorId_idx" ON "Feedback"("campaignCreatorId");

-- CreateIndex
CREATE INDEX "Message_campaignCreatorId_sentAt_idx" ON "Message"("campaignCreatorId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "Template_name_key" ON "Template"("name");

-- CreateIndex
CREATE INDEX "Activity_influencerId_createdAt_idx" ON "Activity"("influencerId", "createdAt");

-- CreateIndex
CREATE INDEX "Activity_campaignCreatorId_createdAt_idx" ON "Activity"("campaignCreatorId", "createdAt");

-- CreateIndex
CREATE INDEX "Activity_kind_idx" ON "Activity"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "Suppression_email_key" ON "Suppression"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Suppression_platform_handle_key" ON "Suppression"("platform", "handle");

-- CreateIndex
CREATE INDEX "DiscoveryRun_campaignId_startedAt_idx" ON "DiscoveryRun"("campaignId", "startedAt");

-- AddForeignKey
ALTER TABLE "SocialProfile" ADD CONSTRAINT "SocialProfile_influencerId_fkey" FOREIGN KEY ("influencerId") REFERENCES "Influencer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignCreator" ADD CONSTRAINT "CampaignCreator_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignCreator" ADD CONSTRAINT "CampaignCreator_influencerId_fkey" FOREIGN KEY ("influencerId") REFERENCES "Influencer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignCreator" ADD CONSTRAINT "CampaignCreator_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agreement" ADD CONSTRAINT "Agreement_campaignCreatorId_fkey" FOREIGN KEY ("campaignCreatorId") REFERENCES "CampaignCreator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_campaignCreatorId_fkey" FOREIGN KEY ("campaignCreatorId") REFERENCES "CampaignCreator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_socialProfileId_fkey" FOREIGN KEY ("socialProfileId") REFERENCES "SocialProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Metric" ADD CONSTRAINT "Metric_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_campaignCreatorId_fkey" FOREIGN KEY ("campaignCreatorId") REFERENCES "CampaignCreator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_byUserId_fkey" FOREIGN KEY ("byUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_campaignCreatorId_fkey" FOREIGN KEY ("campaignCreatorId") REFERENCES "CampaignCreator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "Template"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_campaignCreatorId_fkey" FOREIGN KEY ("campaignCreatorId") REFERENCES "CampaignCreator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_influencerId_fkey" FOREIGN KEY ("influencerId") REFERENCES "Influencer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveryRun" ADD CONSTRAINT "DiscoveryRun_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

