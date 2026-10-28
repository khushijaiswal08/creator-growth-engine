import { AdminTabs } from "@/components/nav";
import { requireAdmin } from "@/lib/session";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();

  return (
    <div className="flex flex-col [&>header]:order-first">
      <AdminTabs />
      {children}
    </div>
  );
}
