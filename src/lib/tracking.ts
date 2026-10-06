/**
 * Where to look up a parcel. The carrier name decides when it is known;
 * otherwise the shape of the tracking number does. Anything unrecognised
 * goes to a web search, which usually finds the right carrier page.
 */
export function trackingUrl(carrier: string | null, trackingNumber: string): string {
  const number = trackingNumber.trim();
  const name = (carrier ?? "").toLowerCase();
  const encoded = encodeURIComponent(number);

  if (/ups/.test(name) || /^1Z[0-9A-Z]{16}$/i.test(number)) return `https://www.ups.com/track?loc=en_US&tracknum=${encoded}`;
  if (/usps|postal/.test(name) || /^(9[2-5]\d{20,24}|[A-Z]{2}\d{9}US)$/i.test(number)) {
    return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encoded}`;
  }
  if (/fedex/.test(name) || /^\d{12}$|^\d{15}$|^\d{20}$/.test(number)) return `https://www.fedex.com/fedextrack/?trknbr=${encoded}`;
  if (/amazon|amzl|swa/.test(name) || /^TBA\d{9,}$/i.test(number)) return `https://track.amazon.com/tracking/${encoded}`;
  if (/dhl/.test(name)) return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${encoded}`;
  if (/ontrac/.test(name)) return `https://www.ontrac.com/tracking/?number=${encoded}`;
  return `https://www.google.com/search?q=${encodeURIComponent(`${carrier ?? ""} ${number} tracking`.trim())}`;
}
