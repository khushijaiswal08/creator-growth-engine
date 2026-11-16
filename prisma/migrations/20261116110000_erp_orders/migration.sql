-- Gift orders sent to the company ERP as Content Creators orders.
ALTER TABLE "GiftOrder" ADD COLUMN "erpSentAt" TIMESTAMP(3);
ALTER TABLE "GiftOrder" ADD COLUMN "erpUrl" TEXT;
ALTER TABLE "GiftOrder" ADD COLUMN "erpError" TEXT;
