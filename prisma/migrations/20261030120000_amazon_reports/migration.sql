-- CreateTable
CREATE TABLE "AttributionLink" (
    "id" TEXT NOT NULL,
    "campaignCreatorId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "maas" TEXT NOT NULL,
    "asin" TEXT,
    "adGroupName" TEXT NOT NULL,
    "addedById" TEXT NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttributionLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttributionStat" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "detailPageViews" INTEGER NOT NULL DEFAULT 0,
    "addToCarts" INTEGER NOT NULL DEFAULT 0,
    "purchases" INTEGER NOT NULL DEFAULT 0,
    "unitsSold" INTEGER NOT NULL DEFAULT 0,
    "productSales" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "brandReferralBonus" DECIMAL(12,2),
    "importId" TEXT NOT NULL,

    CONSTRAINT "AttributionStat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportImport" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "rows" INTEGER NOT NULL,
    "matched" INTEGER NOT NULL,
    "unmatched" JSONB,
    "importedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductMonthlySales" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "childAsin" TEXT NOT NULL,
    "parentAsin" TEXT,
    "sku" TEXT,
    "title" TEXT,
    "productId" TEXT,
    "unitsOrdered" INTEGER NOT NULL,
    "unitsOrderedB2B" INTEGER,
    "orderedProductSales" DECIMAL(12,2) NOT NULL,
    "totalOrderItems" INTEGER,
    "sessions" INTEGER,
    "pageViews" INTEGER,
    "importId" TEXT NOT NULL,

    CONSTRAINT "ProductMonthlySales_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AttributionLink_maas_key" ON "AttributionLink"("maas");

-- CreateIndex
CREATE INDEX "AttributionLink_campaignCreatorId_idx" ON "AttributionLink"("campaignCreatorId");

-- CreateIndex
CREATE INDEX "AttributionLink_adGroupName_idx" ON "AttributionLink"("adGroupName");

-- CreateIndex
CREATE INDEX "AttributionStat_periodStart_idx" ON "AttributionStat"("periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "AttributionStat_linkId_periodStart_periodEnd_key" ON "AttributionStat"("linkId", "periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "ReportImport_brandId_kind_createdAt_idx" ON "ReportImport"("brandId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "ProductMonthlySales_brandId_month_idx" ON "ProductMonthlySales"("brandId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "ProductMonthlySales_brandId_month_childAsin_key" ON "ProductMonthlySales"("brandId", "month", "childAsin");

-- AddForeignKey
ALTER TABLE "AttributionLink" ADD CONSTRAINT "AttributionLink_campaignCreatorId_fkey" FOREIGN KEY ("campaignCreatorId") REFERENCES "CampaignCreator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttributionLink" ADD CONSTRAINT "AttributionLink_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttributionStat" ADD CONSTRAINT "AttributionStat_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "AttributionLink"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttributionStat" ADD CONSTRAINT "AttributionStat_importId_fkey" FOREIGN KEY ("importId") REFERENCES "ReportImport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportImport" ADD CONSTRAINT "ReportImport_importedById_fkey" FOREIGN KEY ("importedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMonthlySales" ADD CONSTRAINT "ProductMonthlySales_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMonthlySales" ADD CONSTRAINT "ProductMonthlySales_importId_fkey" FOREIGN KEY ("importId") REFERENCES "ReportImport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

