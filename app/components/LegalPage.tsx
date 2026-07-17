import Link from "next/link";
import type { ReactNode } from "react";

export const LEGAL_EFFECTIVE_DATE = "July 16, 2026";
export const LEGAL_DOCUMENT_VERSION = "2026-07-16.2";

export function LegalPage({
  eyebrow,
  title,
  summary,
  children,
}: {
  eyebrow: string;
  title: string;
  summary: string;
  children: ReactNode;
}) {
  return (
    <main className="legal-page">
      <header className="legal-header">
        <Link className="legal-brand" href="/">CastingCompass</Link>
        <nav aria-label="Legal documents">
          <Link href="/terms">Terms</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/ai-disclosure">AI disclosure</Link>
        </nav>
      </header>
      <article className="legal-document">
        <p className="legal-eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="legal-summary">{summary}</p>
        <p className="legal-date">Effective and last updated: {LEGAL_EFFECTIVE_DATE} · Document version {LEGAL_DOCUMENT_VERSION}</p>
        <div className="legal-callout">
          Plain-language notice: CastingCompass is a work in progress and a planning aid for California halibut anglers. It is not a catch guarantee, navigation system, emergency service, legal guide, or substitute for checking real conditions.
        </div>
        {children}
      </article>
      <footer className="legal-footer">
        <Link href="/">Back to the forecast</Link>
        <a href="mailto:bzeng0000@gmail.com">bzeng0000@gmail.com</a>
      </footer>
    </main>
  );
}

export function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="legal-section"><h2>{title}</h2>{children}</section>;
}
