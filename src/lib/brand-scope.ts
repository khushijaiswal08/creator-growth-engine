import type { Prisma } from "@prisma/client";

/**
 * Who sees which brand's data.
 *
 * Every person either works on one brand or on both. Two questions follow,
 * and they are answered separately on purpose:
 *
 *   allowed(user)  What may this person open or change at all? Fixed by the
 *                  brand on their account. Use it for every single record a
 *                  page opens and for every change a Server Action makes.
 *   viewed(user)   What do the lists show right now? The same brand for
 *                  someone tied to one; for someone who may see both, whatever
 *                  they picked in the sidebar. Use it for lists and counts only.
 *
 * Both return the same shape: ready-made filters to spread into a query, so a
 * record outside the brand is simply not found. A creator (Influencer) belongs
 * to a brand through the campaigns they are in, and may be in both.
 *
 * An unrecognised brand on an account matches nothing: it fails closed.
 */
export type BrandViewer = {
  id: string;
  /** The brand on the account; null means both brands. */
  brandId: string | null;
  /** The brand the lists are narrowed to; null means both. Never wider than brandId. */
  viewBrand: string | null;
};

export type BrandScope = {
  /** The one brand this scope is limited to, or null for no limit. */
  brandId: string | null;
  campaigns: Prisma.CampaignWhereInput;
  /** Creators in campaigns (CampaignCreator rows). */
  creators: Prisma.CampaignCreatorWhereInput;
  /** People: in the scope when they are in at least one of the brand's campaigns. */
  influencers: Prisma.InfluencerWhereInput;
  gifts: Prisma.GiftOrderWhereInput;
  products: Prisma.ProductWhereInput;
  /** Whether a record of this brand falls inside the scope. */
  includes(brandId: string): boolean;
};

function scopeFor(brandId: string | null): BrandScope {
  if (brandId === null) {
    return { brandId, campaigns: {}, creators: {}, influencers: {}, gifts: {}, products: {}, includes: () => true };
  }
  return {
    brandId,
    campaigns: { brandId },
    creators: { campaign: { brandId } },
    influencers: { campaigns: { some: { campaign: { brandId } } } },
    gifts: { campaignCreator: { campaign: { brandId } } },
    products: { brandId },
    includes: (other) => other === brandId,
  };
}

/** What this person may open or change. */
export function allowed(user: BrandViewer): BrandScope {
  return scopeFor(user.brandId);
}

/** What this person's lists and counts show right now. */
export function viewed(user: BrandViewer): BrandScope {
  // The account's own brand always wins, so a sidebar choice can never widen what someone sees.
  return scopeFor(user.brandId ?? user.viewBrand);
}

/**
 * Activity entries inside a scope. Entries about a creator in a campaign carry
 * the campaign's brand. Entries about the person only (created, edited) show
 * to every brand that works with them. Entries about nothing in particular
 * (an import, a new campaign) cannot be tied to a brand, so in a one-brand
 * scope a person sees only their own.
 */
export function activityIn(scope: BrandScope, userId: string): Prisma.ActivityWhereInput {
  if (scope.brandId === null) return {};
  return {
    OR: [
      { campaignCreator: scope.creators },
      { campaignCreatorId: null, influencer: scope.influencers },
      { campaignCreatorId: null, influencerId: null, userId },
    ],
  };
}

/** One creator's activity, as far as this scope may see it: their own entries and the brand's campaigns only. */
export function activityOfInfluencer(scope: BrandScope, influencerId: string): Prisma.ActivityWhereInput {
  if (scope.brandId === null) return { influencerId };
  return { influencerId, OR: [{ campaignCreatorId: null }, { campaignCreator: scope.creators }] };
}
