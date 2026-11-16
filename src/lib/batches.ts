/**
 * Runs `run` over `items` a few at a time, keeping the input order. Reports use it so that independent
 * periods load together (fast) without sending a hundred queries at once, which would queue past the
 * database pool's wait limit (Prisma P2024) when the pool is small or the database is far away.
 */
export async function inBatches<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += size) results.push(...(await Promise.all(items.slice(start, start + size).map(run))));
  return results;
}
