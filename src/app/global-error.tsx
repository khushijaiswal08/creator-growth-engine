"use client";

/**
 * The last resort: the whole app failed, including the layout, so the page
 * styles and fonts are not there. It brings its own html and body and plain
 * inline styles. A full reload is the retry, since the app itself is what broke.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, background: "#f6f7f9", color: "#0f172a", fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif" }}>
        <div style={{ maxWidth: 440, width: "100%", boxSizing: "border-box", background: "#ffffff", border: "1px solid #e5e7eb", borderRadius: 24, padding: 32, textAlign: "center", boxShadow: "0 8px 30px rgba(15, 23, 42, 0.08)" }}>
          <h1 style={{ margin: "0 0 12px", fontSize: 24, fontWeight: 800 }}>The portal did not load</h1>
          <p style={{ margin: "0 0 20px", fontSize: 15, lineHeight: 1.5, color: "#64748b" }}>
            Something went wrong on our side. Reload the page in a moment. If it keeps happening, tell your portal admin and quote the reference below.
          </p>
          <a href="/today" style={{ display: "inline-block", padding: "10px 20px", borderRadius: 12, background: "#b24a6b", color: "#ffffff", fontWeight: 700, fontSize: 15, textDecoration: "none" }}>
            Reload the portal
          </a>
          {error.digest ? <p style={{ margin: "16px 0 0", fontSize: 12, fontWeight: 600, color: "#64748b" }}>Reference: {error.digest}</p> : null}
        </div>
      </body>
    </html>
  );
}
