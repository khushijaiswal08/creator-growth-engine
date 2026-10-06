/**
 * Product photos are the listing photos on Amazon's image servers. Amazon
 * serves any size when it is written before the file extension, so small
 * pictures are asked for by name instead of downloading the full photograph.
 * Any other address is returned unchanged.
 */
export function sizedImage(url: string, longestSidePx: number): string {
  const match = /^(https:\/\/m\.media-amazon\.com\/images\/I\/[^./]+)\.(jpe?g|png)$/i.exec(url);
  return match ? `${match[1]}._SL${longestSidePx}_.${match[2]}` : url;
}

/** An http(s) address, or null. Stops anything else (such as a script link) being stored as a link or picture. */
export function webAddress(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}
