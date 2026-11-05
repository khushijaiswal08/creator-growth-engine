-- CreateTable
CREATE TABLE "ProfilePost" (
    "id" TEXT NOT NULL,
    "socialProfileId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "kind" TEXT,
    "postedAt" TIMESTAMP(3) NOT NULL,
    "views" INTEGER,
    "likes" INTEGER,
    "comments" INTEGER,
    "capturedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProfilePost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorInsight" (
    "id" TEXT NOT NULL,
    "socialProfileId" TEXT NOT NULL,
    "reach7d" INTEGER,
    "reach30d" INTEGER,
    "profileViews30d" INTEGER,
    "usAudiencePct" INTEGER,
    "evidence" TEXT,
    "note" TEXT,
    "asOf" DATE NOT NULL,
    "addedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreatorInsight_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProfilePost_socialProfileId_postedAt_idx" ON "ProfilePost"("socialProfileId", "postedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProfilePost_socialProfileId_externalId_key" ON "ProfilePost"("socialProfileId", "externalId");

-- CreateIndex
CREATE INDEX "CreatorInsight_socialProfileId_asOf_idx" ON "CreatorInsight"("socialProfileId", "asOf");

-- AddForeignKey
ALTER TABLE "ProfilePost" ADD CONSTRAINT "ProfilePost_socialProfileId_fkey" FOREIGN KEY ("socialProfileId") REFERENCES "SocialProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorInsight" ADD CONSTRAINT "CreatorInsight_socialProfileId_fkey" FOREIGN KEY ("socialProfileId") REFERENCES "SocialProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorInsight" ADD CONSTRAINT "CreatorInsight_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

