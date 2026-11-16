import type { Metadata } from "next";
import { Figtree } from "next/font/google";
import { RegisterServiceWorker } from "@/components/register-sw";
import { THEME_SCRIPT } from "@/lib/theme";
import "./globals.css";

// One typeface for the whole portal; headings and figures differ by weight only.
const figtree = Figtree({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-figtree",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Creator Setu", template: "%s | Creator Setu" },
  description: "Internal portal for finding, contacting and tracking creators.",
  robots: { index: false, follow: false },
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Creator Setu", statusBarStyle: "default" },
};

export const viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#171a21" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover" as const,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // data-theme is set by THEME_SCRIPT before the first paint (light unless the person chose otherwise),
  // so the server's HTML and the browser's legitimately differ on this one attribute.
  return (
    <html lang="en" className={figtree.variable} data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        {children}
        <RegisterServiceWorker />
      </body>
    </html>
  );
}
