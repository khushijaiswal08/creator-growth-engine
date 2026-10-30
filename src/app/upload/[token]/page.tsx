import type { Metadata } from "next";
import { headers } from "next/headers";
import { brandName } from "@/lib/brands";
import { CONTENT_STATUS_LABELS, loadUploadTarget, UPLOAD_LINK_DAYS } from "@/lib/content-upload";
import { storageMode } from "@/lib/content-storage";
import { callerIp, hitRateLimit, isRateLimited, RATE_LIMITS, recordHit } from "@/lib/rate-limit";
import { firstName } from "@/lib/template";
import { UploadForm } from "./upload-form";

export const metadata: Metadata = { title: "Send your content", robots: { index: false, follow: false } };

function Shell({ brand, children }: { brand: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <p className="eyebrow mb-2">{brand}</p>
      <div className="card p-7">{children}</div>
    </main>
  );
}

/**
 * PUBLIC page: the creator's own content-upload link. As with the selection
 * link, the token is the only key, the page shows nothing beyond the
 * creator's first name and what they were sent, and visits are rate limited
 * per caller, misses more tightly.
 */
export default async function UploadPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ip = callerIp(await headers());

  if ((await isRateLimited(RATE_LIMITS.uploadMiss, ip)) || (await hitRateLimit(RATE_LIMITS.uploadView, ip))) {
    return (
      <Shell brand="Send your content">
        <h1 className="text-2xl">Please try again later</h1>
        <p className="mt-2 text-muted-foreground">Too many requests from this connection. The link will work again in a little while.</p>
      </Shell>
    );
  }

  const creator = await loadUploadTarget(token);
  if (!creator) {
    await recordHit(RATE_LIMITS.uploadMiss, ip);
    return (
      <Shell brand="Send your content">
        <h1 className="text-2xl">This link is no longer active</h1>
        <p className="mt-2 text-muted-foreground">Links work for {UPLOAD_LINK_DAYS} days. Please reply to our message and we will send you a new one.</p>
      </Shell>
    );
  }

  const brand = brandName(creator.campaign.brandId);
  const product = creator.giftOrders[0]?.product ?? null;
  const productLabel = product ? [product.title, product.color, product.size].filter(Boolean).join(", ") : null;

  return (
    <Shell brand={brand}>
      <h1 className="text-[28px] leading-tight">Hi {firstName(creator.influencer.name)}, send us your content</h1>
      <p className="mt-2 text-muted-foreground">
        Upload the original video and photos{productLabel ? ` with your ${productLabel}` : ""}, in full quality. You can come back to this link to send more.
      </p>

      {creator.contentAssets.length > 0 ? (
        <section className="mt-5 rounded-xl bg-surface-2 p-4" aria-label="Already received">
          <p className="text-sm font-bold text-foreground">Already received</p>
          <ul className="mt-2 grid gap-1 text-sm">
            {creator.contentAssets.map((asset) => (
              <li key={asset.id} className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate">{asset.fileName}</span>
                <span className="shrink-0 font-semibold text-muted-foreground">{asset.status === "received" ? "Received" : CONTENT_STATUS_LABELS[asset.status]}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="mt-6">
        {storageMode() ? (
          <UploadForm token={token} />
        ) : (
          <p className="rounded-xl bg-warning-soft p-4 text-warning-text">Uploads are not switched on yet. Please reply to our message with a link to your files (Google Drive, Dropbox or WeTransfer all work).</p>
        )}
      </div>
    </Shell>
  );
}
