/** Helpers for the CSV files the portal hands out. */

/** Quotes a cell, and defuses values a spreadsheet would run as a formula. */
export function csvCell(value: string | number | boolean | Date | null | undefined): string {
  let text = value === null || value === undefined ? "" : value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A download. The BOM makes Excel read the file as UTF-8. */
export function csvResponse(lines: string[], fileName: string): Response {
  return new Response(`﻿${lines.join("\r\n")}\r\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store",
    },
  });
}

/** "CPC Past Outreach 2025-26" -> "cpc-past-outreach-2025-26". */
export function fileSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
