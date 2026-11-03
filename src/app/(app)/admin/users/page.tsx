import type { Metadata } from "next";
import { CreateUserForm, UserRow } from "@/components/admin-forms";
import { PageHeader, Panel } from "@/components/panel";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";

/** The note beside someone who still holds a temporary password; null once they have chosen their own. */
function temporaryPasswordNote(user: { mustChangePassword: boolean; tempPasswordExpiresAt: Date | null }, now: number): string | null {
  if (!user.mustChangePassword) return null;
  if (!user.tempPasswordExpiresAt) return "Has a temporary password";
  if (user.tempPasswordExpiresAt.getTime() < now) return "Temporary password expired; reset it";
  return `Temporary password, expires ${formatDateTime(user.tempPasswordExpiresAt)}`;
}

export const metadata: Metadata = { title: "Users" };

export default async function UsersPage() {
  const admin = await requireAdmin();

  const users = await db.user.findMany({
    where: { isSystem: false },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, email: true, role: true, brandId: true, mustChangePassword: true, tempPasswordExpiresAt: true },
  });
  const now = Date.now();

  return (
    <>
      <PageHeader
        title="Users"
        meta="There is no self sign-up. New users get a temporary password that works for 24 hours and must be changed at first sign-in. Give each person the brand they work on: they will see only that brand."
      />

      <div className="grid gap-4">
        <Panel title={`Team (${users.length})`}>
          <ul className="divide-y">
            {users.map((user) => (
              <UserRow
                key={user.id}
                user={{ id: user.id, name: user.name, email: user.email, role: user.role, brandId: user.role === "admin" ? null : user.brandId }}
                temporaryPassword={temporaryPasswordNote(user, now)}
                isSelf={user.id === admin.id}
              />
            ))}
          </ul>
        </Panel>

        <Panel title="Create a user">
          <CreateUserForm />
        </Panel>
      </div>
    </>
  );
}
