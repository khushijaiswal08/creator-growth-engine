"use client";

import { FileSpreadsheet } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { uploadAttributionReport, uploadBusinessReport } from "@/actions/amazon";
import { NativeSelect } from "@/components/native-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AttributionImportResult, BusinessImportResult } from "@/lib/amazon-import";
import { compactGrid } from "@/lib/amazon-reports";

/** Opens the CSV or Excel file in the browser and keeps its cells as text, first sheet only. */
async function readGrid(file: File): Promise<string[][]> {
  if (/\.xls$/i.test(file.name)) throw new Error("Old-style .xls files are not supported. Save it as .xlsx or CSV, or download it from Amazon again.");
  if (/\.xlsx$/i.test(file.name)) {
    const { read, utils } = await import("xlsx");
    const workbook = read(await file.arrayBuffer());
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    return sheet ? utils.sheet_to_json<string[]>(sheet, { header: 1, defval: "", raw: false }) : [];
  }
  const Papa = (await import("papaparse")).default;
  return Papa.parse<string[]>(await file.text(), { skipEmptyLines: "greedy" }).data;
}

/** The month `offset` months from this one as a form value ("2026-09" for last month, offset -1), on this computer's calendar. */
function monthValue(offset: number): string {
  const now = new Date();
  const month = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  return `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}`;
}

/** A file too big for one upload ends with this error from Next.js; anything else is a file that would not open. */
function uploadError(error: unknown, fallback: string): string {
  const text = error instanceof Error ? error.message : "";
  if (text.includes("xls")) return text;
  if (/body|size|limit|413/i.test(text)) return "The file is too large to send in one go. Download a shorter date range from Amazon and upload each part.";
  return fallback;
}

type Brand = { id: string; name: string };

function BrandField({ brands, value, onChange, id }: { brands: Brand[]; value: string; onChange: (value: string) => void; id: string }) {
  if (brands.length < 2) return null;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>Brand</Label>
      <NativeSelect id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Choose the brand</option>
        {brands.map((brand) => (
          <option key={brand.id} value={brand.id}>
            {brand.name}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

function FilePicker({ id, file, onFile }: { id: string; file: File | null; onFile: (file: File | null) => void }) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center gap-3 rounded-xl border-2 border-dashed border-border bg-surface px-4 py-3 hover:border-primary hover:bg-primary-faint">
      <FileSpreadsheet className="size-5 shrink-0 text-primary-text" strokeWidth={1.9} />
      <span className="min-w-0 flex-1 truncate text-sm font-semibold">{file ? file.name : "Choose the CSV or Excel file"}</span>
      <input id={id} type="file" accept=".csv,.xlsx,.txt" className="sr-only" onChange={(event) => onFile(event.target.files?.[0] ?? null)} />
    </label>
  );
}

function ImportError({ text }: { text: string }) {
  return (
    <p role="alert" className="rounded-xl bg-danger-soft px-4 py-3 text-sm font-semibold text-danger-text">
      {text}
    </p>
  );
}

/** The Amazon Attribution report: daily campaign report from the Amazon Ads console, CSV or Excel. */
export function AttributionUpload({ brands }: { brands: Brand[] }) {
  const router = useRouter();
  const [brand, setBrand] = useState(brands.length === 1 ? brands[0].id : "");
  const [file, setFile] = useState<File | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AttributionImportResult | null>(null);

  async function submit() {
    if (!file) return;
    setBusy(true);
    setResult(null);
    try {
      // Only the header and the columns the portal reads are sent, so big exports fit in one upload.
      const rows = compactGrid(await readGrid(file), "attribution");
      const outcome = await uploadAttributionReport({ brandId: brand, rows, fileName: file.name, from, to });
      setResult(outcome);
      if (outcome.ok) router.refresh();
    } catch (error) {
      setResult({ ok: false, error: uploadError(error, "The file could not be opened. Upload it exactly as Amazon produced it.") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-3">
      <BrandField brands={brands} value={brand} onChange={setBrand} id="aa-brand" />
      <FilePicker id="aa-file" file={file} onFile={setFile} />
      <details className="disclosure">
        <summary>Summary file with no dates?</summary>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <div className="grid gap-1.5">
            <Label htmlFor="aa-from">First day</Label>
            <Input id="aa-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="aa-to">Last day</Label>
            <Input id="aa-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </div>
        </div>
      </details>
      <Button onClick={submit} disabled={busy || !file || (brands.length > 1 && !brand)}>
        {busy ? "Reading..." : "Import Attribution report"}
      </Button>
      {result ? (
        result.ok ? (
          <div role="status" className="rounded-xl bg-success-soft px-4 py-3 text-sm text-success-text">
            <p className="font-bold">
              {result.matchedRows} of {result.rows} rows matched to {result.creators} {result.creators === 1 ? "creator" : "creators"} ({result.from} to {result.to}).
            </p>
            {result.unmatched.length > 0 ? (
              <div className="mt-2 text-foreground">
                <p className="text-xs font-semibold">Not matched: save these ad group names on the creator&apos;s Amazon tracking link, then import again.</p>
                <ul className="mt-1 grid gap-0.5 text-xs">
                  {result.unmatched.map((row) => (
                    <li key={`${row.campaign}|${row.adGroup}`}>
                      <span className="font-mono">{row.adGroup}</span>
                      <span className="text-muted-foreground">
                        {" "}
                        · {row.clicks} clicks, {row.purchases} orders{row.campaign ? ` · ${row.campaign}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : (
          <ImportError text={result.error} />
        )
      ) : null}
    </div>
  );
}

/** One month of Seller Central's Business Report (Detail Page Sales and Traffic by Child Item). */
export function BusinessUpload({ brands }: { brands: Brand[] }) {
  const router = useRouter();
  const [brand, setBrand] = useState(brands.length === 1 ? brands[0].id : "");
  const [file, setFile] = useState<File | null>(null);
  const [month, setMonth] = useState(() => monthValue(-1));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BusinessImportResult | null>(null);

  async function submit() {
    if (!file) return;
    setBusy(true);
    setResult(null);
    try {
      const rows = compactGrid(await readGrid(file), "business");
      const outcome = await uploadBusinessReport({ brandId: brand, rows, fileName: file.name, month });
      setResult(outcome);
      if (outcome.ok) router.refresh();
    } catch (error) {
      setResult({ ok: false, error: uploadError(error, "The file could not be opened. Upload the CSV exactly as Seller Central produced it.") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-3">
      <BrandField brands={brands} value={brand} onChange={setBrand} id="br-brand" />
      <FilePicker id="br-file" file={file} onFile={setFile} />
      <div className="grid gap-1.5">
        <Label htmlFor="br-month">Month the file covers</Label>
        <Input id="br-month" type="month" value={month} max={monthValue(0)} onChange={(event) => setMonth(event.target.value)} />
      </div>
      <Button onClick={submit} disabled={busy || !file || !month || (brands.length > 1 && !brand)}>
        {busy ? "Reading..." : "Import Business Report"}
      </Button>
      {result ? (
        result.ok ? (
          <div role="status" className="rounded-xl bg-success-soft px-4 py-3 text-sm text-success-text">
            <p className="font-bold">
              {result.month}: {result.products} products, {result.units.toLocaleString("en-US")} units, ${result.sales.toLocaleString("en-US", { minimumFractionDigits: 2 })} sales.
            </p>
            {result.unmatched.length > 0 ? <p className="mt-1 text-xs text-foreground">Not in the catalogue: {result.unmatched.join(", ")}</p> : null}
          </div>
        ) : (
          <ImportError text={result.error} />
        )
      ) : null}
    </div>
  );
}
