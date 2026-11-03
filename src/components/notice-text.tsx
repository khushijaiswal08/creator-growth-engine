import { cn } from "cn";

/** What a click left to say, and whether the request was refused. */
export type Notice = { text: string; refused: boolean };

/** A result line after a click: read out as an alert when the request was refused, as a status otherwise. */
export function NoticeText({ notice, as: Tag = "span", className }: { notice: Notice; as?: "span" | "p"; className?: string }) {
  return (
    <Tag role={notice.refused ? "alert" : "status"} className={cn(className, notice.refused ? "font-semibold text-danger-text" : "text-success-text")}>
      {notice.text}
    </Tag>
  );
}
