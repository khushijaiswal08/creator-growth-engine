/** "Maya.Torres_Home" -> "mayatorreshome". Used to compare handles across platforms. */
export function normaliseForMatch(handle: string): string {
  return handle.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Levenshtein distance, giving up (returning max + 1) as soon as it must exceed `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    previous = current;
  }
  return previous[b.length];
}

// Short handles are within two edits of almost anything, so they must match exactly.
const MIN_FUZZY_LENGTH = 6;
const MAX_DISTANCE = 2;

/** True when two normalised handles look like the same name. */
export function similarHandles(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length < MIN_FUZZY_LENGTH || b.length < MIN_FUZZY_LENGTH) return false;
  return editDistance(a, b, MAX_DISTANCE) <= MAX_DISTANCE;
}
