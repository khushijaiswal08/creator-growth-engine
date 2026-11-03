import type { Metadata } from "next";
import { CampaignForm } from "@/components/campaign-form";
import { PageHeader, Panel } from "@/components/panel";
import { allowed, brandsIn, viewed } from "@/lib/brand-scope";
import { DEFAULT_BRAND } from "@/lib/brands";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "New campaign" };

export default async function NewCampaignPage() {
  const user = await requireUser();
  // Someone tied to one brand can only create campaigns for it.
  const brands = brandsIn(allowed(user)).map(({ id, name }) => ({ id, name }));
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
