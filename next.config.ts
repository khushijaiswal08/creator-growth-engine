import type { NextConfig } from "next";

// Sent with every response. Vercel already redirects HTTP to HTTPS; HSTS tells
// browsers to never try plain HTTP again.
const SECURITY_HEADERS = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  // The floating development badge sat on top of "Sign out" in the narrow sidebar.
  devIndicators: false,
  // Dates are formatted on the server and in the browser; both must use the team's zone, or a date near
  // midnight reads differently in each and React throws a hydration error. Not a secret.
  env: { APP_TIME_ZONE: process.env.APP_TIME_ZONE ?? "" },
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  experimental: {
    serverActions: {
      // CSV imports are posted through a Server Action.
      bodySizeLimit: "4mb",
    },
  },
};

export default nextConfig;
