import Link from "next/link";

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <article className="card p-7 [&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:text-lg [&_li]:mt-1 [&_p]:mt-2 [&_ul]:mt-2 [&_ul]:list-disc [&_ul]:pl-5">
        {children}
      </article>
      <nav aria-label="Legal" className="mt-4 flex gap-4 text-muted-foreground">
        <Link href="/privacy" className="link">
          Privacy
        </Link>
        <Link href="/terms" className="link">
          Terms
        </Link>
        <Link href="/login" className="link">
          Sign in
        </Link>
      </nav>
    </main>
  );
}
