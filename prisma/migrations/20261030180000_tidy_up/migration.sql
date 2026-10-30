-- Admin > Tidy up old work: each Apply, and every creator it changed with the status before, so it can be undone.

-- CreateTable
CREATE TABLE "TidyUp" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "days" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoneAt" TIMESTAMP(3),
    "undoneById" TEXT,
    CONSTRAINT "TidyUp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TidyChange" (
    "id" TEXT NOT NULL,
    "tidyUpId" TEXT NOT NULL,
    "campaignCreatorId" TEXT NOT NULL,
    "group" TEXT NOT NULL,
    "fromStatus" "CreatorStatus" NOT NULL,
    "toStatus" "CreatorStatus" NOT NULL,
    "prevNextAction" TEXT,
    "prevNextActionDueAt" TIMESTAMP(3),
    "prevWaitingOn" TEXT,
    "prevContentDueAt" TIMESTAMP(3),
    "gifts" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoneAt" TIMESTAMP(3),
    CONSTRAINT "TidyChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TidyUp_createdAt_idx" ON "TidyUp"("createdAt");

-- CreateIndex
CREATE INDEX "TidyChange_tidyUpId_undoneAt_idx" ON "TidyChange"("tidyUpId", "undoneAt");

-- CreateIndex
CREATE INDEX "TidyChange_campaignCreatorId_idx" ON "TidyChange"("campaignCreatorId");

-- AddForeignKey
ALTER TABLE "TidyUp" ADD CONSTRAINT "TidyUp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TidyChange" ADD CONSTRAINT "TidyChange_tidyUpId_fkey" FOREIGN KEY ("tidyUpId") REFERENCES "TidyUp"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TidyChange" ADD CONSTRAINT "TidyChange_campaignCreatorId_fkey" FOREIGN KEY ("campaignCreatorId") REFERENCES "CampaignCreator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
