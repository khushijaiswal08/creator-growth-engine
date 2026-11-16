-- Automatic Amazon (MCF) orders per brand: off by default, with a hold after approval and a 24-hour cap.
ALTER TABLE "BrandSettings" ADD COLUMN "mcfAutoSend" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "BrandSettings" ADD COLUMN "mcfAutoHoldMinutes" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "BrandSettings" ADD COLUMN "mcfAutoDailyCap" INTEGER NOT NULL DEFAULT 10;
