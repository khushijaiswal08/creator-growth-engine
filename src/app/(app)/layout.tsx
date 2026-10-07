import { cookies } from "next/headers";
import { logout } from "@/actions/auth";
import { AppShell } from "@/components/app-shell";
import type { SidebarPreference } from "@/components/sidebar-context";
import { brandName, brandShortName } from "@/lib/brands";
import { requireUser } from "@/lib/session";
import { SIDEBAR_COOKIE } from "@/lib/sidebar";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  // The person's own choice for the sidebar, so every page loads the way they left it.
  const stored = (await cookies()).get(SIDEBAR_COOKIE)?.value;
  const initialPreference: SidebarPreference = stored === "collapsed" || stored === "expanded" ? stored : null;

  return (
    <AppShell
      user={{
        name: user.name,
        email: user.email,
        role: user.role,
        avatarUrl: user.avatarUrl,
        brandName: user.brandId ? brandName(user.brandId) : null,
        brandShort: user.brandId ? brandShortName(user.brandId) : null,
        viewBrand: user.viewBrand,
      }}
      isAdmin={user.role === "admin"}
      initialPreference={initialPreference}
      logout={logout}
    >
      {children}
    </AppShell>
  );
}
