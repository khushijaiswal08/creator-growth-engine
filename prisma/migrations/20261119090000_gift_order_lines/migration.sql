-- Several products in one gift: one row per product with its units (19 Nov 2026).
-- Additive only: existing gifts keep their single product on GiftOrder.productId and have no lines.
CREATE TABLE "GiftOrderLine" (
    "id" TEXT NOT NULL,
    "giftOrderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GiftOrderLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GiftOrderLine_giftOrderId_position_key" ON "GiftOrderLine"("giftOrderId", "position");
CREATE INDEX "GiftOrderLine_productId_idx" ON "GiftOrderLine"("productId");

ALTER TABLE "GiftOrderLine" ADD CONSTRAINT "GiftOrderLine_giftOrderId_fkey" FOREIGN KEY ("giftOrderId") REFERENCES "GiftOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GiftOrderLine" ADD CONSTRAINT "GiftOrderLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
