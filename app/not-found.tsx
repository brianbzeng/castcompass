import type { Metadata } from "next";
import Link from "next/link";
import { ArrowIcon, LogoMark } from "./components/icons";
import { NotFoundDocumentTitle } from "./components/NotFoundDocumentTitle";

export const metadata: Metadata = {
  title: "Page not found",
  description: "The requested CastingCompass page could not be found.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

export default function NotFound() {
  return (
    <>
      <NotFoundDocumentTitle />
      <main className="not-found-page">
        <header className="not-found-header">
          <Link className="not-found-brand" href="/" aria-label="CastingCompass home">
            <LogoMark />
            <span>CastingCompass</span>
          </Link>
        </header>

        <section className="not-found-card" aria-labelledby="not-found-title">
          <p className="not-found-eyebrow">404 · Off the chart</p>
          <h1 id="not-found-title">That page isn&apos;t here.</h1>
          <p className="not-found-copy">
            The link may be outdated, or the page may have moved. The latest California
            halibut opportunity forecast is still waiting at the main page.
          </p>
          <Link className="not-found-action" href="/">
            Return to the forecast
            <ArrowIcon />
          </Link>
          <nav className="not-found-links" aria-label="Helpful links">
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Terms</Link>
            <Link href="/ai-disclosure">AI disclosure</Link>
          </nav>
        </section>
      </main>
    </>
  );
}
