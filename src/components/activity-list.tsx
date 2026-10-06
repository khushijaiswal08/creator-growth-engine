import { ACTIVITY_KIND_LABELS, type ActivityKind } from "@/lib/activity";
import { formatDateTime } from "@/lib/format";

export type ActivityItem = {
  id: string;
  kind: string;
  body: string;
  createdAt: Date;
  user: { name: string };
  campaignCreator: { campaign: { name: string } } | null;
};

export function ActivityList({ items, className }: { items: ActivityItem[]; className?: string }) {
  if (items.length === 0) {
    return <p className="px-4 py-6 text-center text-muted-foreground">No activity yet.</p>;
  }

  return (
    <ol className={className}>
      {items.map((item) => (
        <li key={item.id} className="grid gap-0.5 border-b px-4 py-2.5 last:border-0">
          <p className="break-words">{item.body}</p>
          <p className="text-xs text-muted-foreground">
            <span className="font-medium">{ACTIVITY_KIND_LABELS[item.kind as ActivityKind] ?? item.kind}</span>
            {" · "}
            {item.user.name}
            {item.campaignCreator ? `, ${item.campaignCreator.campaign.name}` : ""}
            {" · "}
            <time dateTime={item.createdAt.toISOString()}>{formatDateTime(item.createdAt)}</time>
          </p>
        </li>
      ))}
    </ol>
  );
}
