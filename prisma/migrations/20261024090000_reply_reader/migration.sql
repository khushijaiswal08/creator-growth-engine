-- Rachna reads replies: her guess is kept beside the person's choice, and the latest warmth sits on the creator.
ALTER TABLE "Message"
  ADD COLUMN "suggestedClass" TEXT,
  ADD COLUMN "suggestedConfidence" DOUBLE PRECISION,
  ADD COLUMN "warmth" TEXT,
  ADD COLUMN "readSummary" TEXT,
  ADD COLUMN "readQuestions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "readBy" TEXT;

ALTER TABLE "CampaignCreator"
  ADD COLUMN "replyWarmth" TEXT,
  ADD COLUMN "replyRead" TEXT;
