import {
  PrismaClient,
  type Campaign,
  type CreatorStatus,
  type Platform,
  type Role,
  type User,
} from "@prisma/client";
import bcrypt from "bcryptjs";

const db = new PrismaClient();

// The first user is the admin. Add teammates in the app under Admin > Users.
const USERS: { name: string; email: string; role: Role }[] = [
  { name: "Khushi Jaiswal", email: "khushijaiswal0005@gmail.com", role: "admin" },
];

const BRAND_ID = "ridhi";

const TEMPLATES = [
  {
    name: "First touch",
    purpose: "first",
    body: `Hi {name},

I'm {sender} from {brand}. We make hand block-printed home textiles. Your {platform} (@{handle}) caught our eye, and we think {product} would sit well in your home.

We'd love to send you one as a gift, with no obligation to post. Would you be open to that?

{sender}`,
  },
  {
    name: "Follow-up",
    purpose: "followup",
    body: `Hi {name},

Just following up on my earlier note about gifting you {product}. No pressure at all. If it's of interest, reply here and I'll take care of the rest.

{sender}`,
  },
  {
    name: "Agreed - next steps",
    purpose: "agreed",
    body: `Hi {name},

Lovely to have you on board. To send {product}, could you share your full name, shipping address and a phone number for the courier?

If you do post about it, please disclose that it was gifted (for example #gifted) so we both stay within FTC rules.

{sender}`,
  },
  {
    name: "Product selection link",
    purpose: "selection",
    body: `Hi {name},

So glad you'd like to work with {brand}! Please choose the piece you'd love and tell us where to send it here:

{selection_link}

It takes about a minute, and the link is just for you.

{sender}`,
  },
  {
    name: "Content reminder",
    purpose: "reminder",
    body: `Hi {name},

I hope your {brand} piece arrived safely and you're enjoying it. We'd love to see it in your space whenever you have a moment to share. If you post, please tag us and mention that it was gifted.

Let me know if you need anything from us.

{sender}`,
  },
  {
    name: "Thank you",
    purpose: "other",
    body: `Hi {name},

Thank you for sharing {product} on your {platform}. We really enjoyed seeing it in your space.

{sender}`,
  },
] as const;

const CAMPAIGNS = [
  {
    name: "Holiday Gifting 2026",
    brief:
      "Gift block-printed table linens and quilts to US home and lifestyle creators ahead of the holiday season. We want styled tablescapes and cosy bedroom scenes.",
    nicheKeywords: ["home decor", "tablescape", "holiday hosting", "cottagecore"],
    negativeKeywords: ["giveaway only", "dropshipping"],
    targetPosts: 20,
    deadline: new Date("2026-12-10T00:00:00Z"),
    status: "active",
  },
  {
    name: "Spring Table Linens 2027",
    brief:
      "Introduce the spring block-print tablecloth and napkin collection through US creators who style everyday dining and outdoor tables.",
    nicheKeywords: ["table styling", "spring decor", "slow living", "handmade"],
    negativeKeywords: ["fast fashion"],
    targetPosts: 12,
    deadline: new Date("2027-03-15T00:00:00Z"),
    status: "draft",
  },
] as const;

type SeedInfluencer = {
  name: string;
  email: string | null;
  location: string;
  usSignal: number;
  profiles: { platform: Platform; handle: string; followers: number; engagementRate: number; bio: string }[];
  // campaign index -> status
  campaigns: { campaign: 0 | 1; status: CreatorStatus; owner: 1 | 2 }[];
};

// Fictional people. Handles end in ".sample" so they cannot collide with real imports.
const INFLUENCERS: SeedInfluencer[] = [
  {
    name: "Maya Torres",
    email: "maya.torres@example.com",
    location: "Austin, TX",
    usSignal: 92,
    profiles: [
      { platform: "instagram", handle: "mayatorres.home.sample", followers: 48200, engagementRate: 3.4, bio: "Texas home, slow mornings, thrifted finds." },
      { platform: "tiktok", handle: "mayatorres.home.sample", followers: 121000, engagementRate: 6.1, bio: "Styling a 1940s bungalow." },
    ],
    campaigns: [{ campaign: 0, status: "contacted", owner: 1 }],
  },
  {
    name: "Hannah Whitfield",
    email: "hannah@example.com",
    location: "Portland, OR",
    usSignal: 88,
    profiles: [
      { platform: "instagram", handle: "whitfieldcottage.sample", followers: 23900, engagementRate: 4.8, bio: "Cottage interiors and garden tables." },
    ],
    campaigns: [
      { campaign: 0, status: "agreed", owner: 1 },
      { campaign: 1, status: "discovered", owner: 1 },
    ],
  },
  {
    name: "Priya Raman",
    email: null,
    location: "Edison, NJ",
    usSignal: 81,
    profiles: [
      { platform: "youtube", handle: "priyaramanhome.sample", followers: 67400, engagementRate: 2.2, bio: "Home tours, hosting and Indian textiles." },
      { platform: "instagram", handle: "priyaraman.home.sample", followers: 15800, engagementRate: 3.9, bio: "Hosting, textiles, tea." },
    ],
    campaigns: [{ campaign: 0, status: "interested", owner: 2 }],
  },
  {
    name: "Jordan Ellis",
    email: "jordan.ellis@example.com",
    location: "Nashville, TN",
    usSignal: 95,
    profiles: [
      { platform: "tiktok", handle: "jordanellis.diy.sample", followers: 310500, engagementRate: 7.3, bio: "Renter-friendly DIY and thrift flips." },
    ],
    campaigns: [{ campaign: 0, status: "approved", owner: 2 }],
  },
  {
    name: "Sofia Marchetti",
    email: "sofia@example.com",
    location: "Brooklyn, NY",
    usSignal: 76,
    profiles: [
      { platform: "instagram", handle: "sofia.sets.the.table.sample", followers: 9400, engagementRate: 5.6, bio: "Dinner parties in a small apartment." },
    ],
    campaigns: [
      { campaign: 0, status: "follow_up_due", owner: 1 },
      { campaign: 1, status: "approved", owner: 1 },
    ],
  },
  {
    name: "Claire Donovan",
    email: null,
    location: "Charleston, SC",
    usSignal: 90,
    profiles: [
      { platform: "instagram", handle: "clairedonovan.interiors.sample", followers: 132000, engagementRate: 1.9, bio: "Southern interiors and entertaining." },
    ],
    campaigns: [{ campaign: 0, status: "no_reply", owner: 2 }],
  },
  {
    name: "Aaliyah Brooks",
    email: "aaliyah.brooks@example.com",
    location: "Atlanta, GA",
    usSignal: 93,
    profiles: [
      { platform: "youtube", handle: "aaliyahathome.sample", followers: 41200, engagementRate: 3.1, bio: "Budget home makeovers and seasonal resets." },
      { platform: "tiktok", handle: "aaliyahathome.sample", followers: 88700, engagementRate: 5.4, bio: "Seasonal resets." },
    ],
    campaigns: [{ campaign: 1, status: "scored", owner: 2 }],
  },
  {
    name: "Emma Lindqvist",
    email: "emma@example.com",
    location: "Minneapolis, MN",
    usSignal: 84,
    profiles: [
      { platform: "instagram", handle: "emmalindqvist.home.sample", followers: 5600, engagementRate: 8.2, bio: "Scandi-meets-prairie home, hand sewing." },
    ],
    campaigns: [{ campaign: 0, status: "product_shipped", owner: 1 }],
  },
  {
    name: "Rachel Kim",
    email: null,
    location: "Los Angeles, CA",
    usSignal: 89,
    profiles: [
      { platform: "tiktok", handle: "rachelkim.table.sample", followers: 56300, engagementRate: 4.4, bio: "Tablescapes for every excuse." },
    ],
    campaigns: [
      { campaign: 0, status: "discovered", owner: 2 },
      { campaign: 1, status: "discovered", owner: 2 },
    ],
  },
  {
    name: "Nora Castellanos",
    email: "nora@example.com",
    location: "Santa Fe, NM",
    usSignal: 87,
    profiles: [
      { platform: "youtube", handle: "noracastellanos.sample", followers: 18900, engagementRate: 2.8, bio: "Adobe home, natural dyes, quilts." },
    ],
    campaigns: [{ campaign: 0, status: "review_later", owner: 1 }],
  },
];

async function main() {
  const password = process.env.SEED_USER_PASSWORD ?? "";
  if (password.length < 10) {
    throw new Error("Set SEED_USER_PASSWORD in .env (at least 10 characters) before seeding.");
  }
  const passwordHash = await bcrypt.hash(password, 12);

  // Existing users keep their password; the seed is safe to re-run.
  const users: User[] = [];
  for (const user of USERS) {
    users.push(
      await db.user.upsert({
        where: { email: user.email },
        update: {},
        create: { ...user, passwordHash },
      }),
    );
  }
  const admin = users[0];

  for (const template of TEMPLATES) {
    await db.template.upsert({ where: { name: template.name }, update: {}, create: template });
  }

  const campaigns: Campaign[] = [];
  for (const campaign of CAMPAIGNS) {
    campaigns.push(
      await db.campaign.upsert({
        where: { name: campaign.name },
        update: {},
        create: {
          ...campaign,
          isSample: true,
          brandId: BRAND_ID,
          nicheKeywords: [...campaign.nicheKeywords],
          negativeKeywords: [...campaign.negativeKeywords],
        },
      }),
    );
  }

  let created = 0;
  for (const seed of INFLUENCERS) {
    const first = seed.profiles[0];
    const exists = await db.socialProfile.findUnique({
      where: { platform_handle: { platform: first.platform, handle: first.handle } },
    });
    if (exists) continue;

    await db.$transaction(async (tx) => {
      const influencer = await tx.influencer.create({
        data: {
          name: seed.name,
          email: seed.email,
          location: seed.location,
          usSignal: seed.usSignal,
          notes: "Sample data from the seed script.",
          isSample: true,
          profiles: { create: seed.profiles.map((profile) => ({ ...profile, source: "manual" })) },
          activities: {
            create: { userId: admin.id, kind: "influencer_created", body: "Created by the seed script." },
          },
        },
      });

      for (const link of seed.campaigns) {
        const campaign = campaigns[link.campaign];
        await tx.campaignCreator.create({
          data: {
            campaignId: campaign.id,
            influencerId: influencer.id,
            status: link.status,
            ownerId: admin.id,
            activities: {
              create: {
                userId: admin.id,
                influencerId: influencer.id,
                kind: "added_to_campaign",
                body: `Added to ${campaign.name} with status ${link.status} by the seed script.`,
              },
            },
          },
        });
      }
    });
    created += 1;
  }

  console.log(
    `Seed complete: ${users.length} users, ${TEMPLATES.length} templates, ${campaigns.length} campaigns, ${created} new influencers.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
