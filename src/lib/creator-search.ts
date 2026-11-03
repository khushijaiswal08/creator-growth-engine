import type { Prisma } from "@prisma/client";

/**
 * The search box on Creators, Search and the campaign toolbar: name, email or
 * location, or a handle typed with or without the "@". Returns only an OR
 * clause, so it never replaces the brand scope it is spread next to.
 */
export function creatorSearchWhere(q: string): Prisma.InfluencerWhereInput {
  const contains = { contains: q, mode: "insensitive" as const };
  return {
    OR: [{ name: contains }, { email: contains }, { location: contains }, { profiles: { some: { handle: { contains: q.replace(/^@/, "").toLowerCase() } } } }],
  };
}
