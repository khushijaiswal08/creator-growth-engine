import { redirect } from "next/navigation";

// The dashboard and the work queue became one page: Today.
export default function DashboardPage() {
  redirect("/today");
}
