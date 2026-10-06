import type { Metadata } from "next";
import { setTemplateArchived } from "@/actions/admin";
import { TemplateForm } from "@/components/admin-forms";
import { PageHeader, Panel } from "@/components/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

export const metadata: Metadata = { title: "Message templates" };

export default async function TemplatesPage() {
  await requireAdmin();

  const templates = await db.template.findMany({
    orderBy: [{ archived: "asc" }, { name: "asc" }],
    include: { _count: { select: { messages: true } } },
  });

  return (
    <>
      <PageHeader title="Message templates" meta="Archived templates no longer appear in the Message dialog." />

      <div className="grid gap-4 lg:grid-cols-2">
        {templates.map((template) => (
          <Panel
            key={template.id}
            title={template.name}
            aside={
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Used {template._count.messages} times</span>
                {template.archived ? <Badge variant="secondary">Archived</Badge> : null}
                <form action={setTemplateArchived.bind(null, template.id, !template.archived)}>
                  <Button type="submit" size="xs" variant="outline">
                    {template.archived ? "Restore" : "Archive"}
                  </Button>
                </form>
              </div>
            }
          >
            <TemplateForm
              template={{ id: template.id, name: template.name, purpose: template.purpose, body: template.body }}
            />
          </Panel>
        ))}

        <Panel title="Add a template">
          <TemplateForm />
        </Panel>
      </div>
    </>
  );
}
