import type { Metadata } from "next";
import { Figtree } from "next/font/google";
import { RegisterServiceWorker } from "@/components/register-sw";
import "./globals.css";

// One typeface for the whole portal; headings and figures differ by weight only.
const figtree = Figtree({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-figtree",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Creator Growth Engine", template: "%s | Creator Growth Engine" },
  description: "Internal portal for finding, contacting and tracking creators.",
  robots: { index: false, follow: false },
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Creator Growth", statusBarStyle: "default" },
};

export const viewport = { themeColor: "#ffffff", width: "device-width", initialScale: 1, viewportFit: "cover" as const };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={figtree.variable}>
      <body>
        {children}
        <RegisterServiceWorker />
      </body>
    </html>
  );
}
