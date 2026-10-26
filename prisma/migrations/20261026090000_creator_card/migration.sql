-- The creator card: clicks and sales per post (logged by hand until the Amazon reports are imported)
-- and the creator's own affiliate quote.
ALTER TABLE "Metric"
  ADD COLUMN "clicks" INTEGER,
  ADD COLUMN "salesUsd" DECIMAL(12,2);

ALTER TABLE "Influencer"
  ADD COLUMN "affiliateQuote" TEXT;
