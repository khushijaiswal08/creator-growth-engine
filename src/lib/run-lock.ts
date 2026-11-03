/** How long one slice may hold a run before another worker may take over. */
export const SLICE_LOCK_MS = 90 * 1000;

/** Runs nobody holds right now: never locked, or the lock has lapsed. */
export const unlocked = (now: Date) => ({ OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] });
