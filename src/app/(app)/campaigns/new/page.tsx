import type { Metadata } from "next";
import { CampaignForm } from "@/components/campaign-form";
import { PageHeader, Panel } from "@/components/panel";
import { allowed, viewed } from "@/lib/brand-scope";
import { BRANDS, DEFAULT_BRAND } from "@/lib/brands";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "New campaign" };

export default async function NewCampaignPage() {
  const user = await requireUser();
  // Someone tied to one brand can only create campaigns for it.
  const brands = BRANDS.filter((brand) => allowed(user).includes(brand.id)).map(({ id, name }) => ({ id, name }));
  const preferred = viewed(user).brandId ?? DEFAULT_BRAND;
  const defaultBrand = brands.some((brand) => brand.id === preferred) ? preferred : (brands[0]?.id ?? "");

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="New campaign" />
      <Panel>
        <CampaignForm brands={brands} defaultBrand={defaultBrand} />
      </Panel>
    </div>
  );
}
