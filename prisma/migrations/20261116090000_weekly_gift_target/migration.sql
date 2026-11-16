-- A weekly gift target per brand, for the whole team (Home and Settings).
ALTER TABLE "BrandSettings" ADD COLUMN "weeklyGiftTarget" INTEGER NOT NULL DEFAULT 100;
