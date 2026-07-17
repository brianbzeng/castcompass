import type { Metadata } from "next";
import { OpportunityApp } from "./components/OpportunityApp";

const HOME_URL = "https://castingcompass.com/";
const HOME_TITLE = "CastingCompass — California halibut opportunity planner";
const HOME_DESCRIPTION =
  "Compare public Bay Area shore, beach, jetty, and pier fishing windows using explainable relative rankings from habitat, seasonality, and current conditions.";

export const metadata: Metadata = {
  title: { absolute: HOME_TITLE },
  description: HOME_DESCRIPTION,
  alternates: { canonical: HOME_URL },
  openGraph: {
    title: HOME_TITLE,
    description: HOME_DESCRIPTION,
    type: "website",
    url: HOME_URL,
    siteName: "CastingCompass",
    images: [{
      url: "/og.png",
      width: 1200,
      height: 630,
      alt: "CastingCompass — California Halibut Opportunity Planner",
    }],
  },
  twitter: {
    card: "summary_large_image",
    title: HOME_TITLE,
    description: HOME_DESCRIPTION,
    images: [{
      url: "/og.png",
      alt: "CastingCompass — California Halibut Opportunity Planner",
    }],
  },
};

const websiteStructuredData = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "CastingCompass",
  alternateName: "Casting Compass",
  url: HOME_URL,
  description: HOME_DESCRIPTION,
  inLanguage: "en-US",
};

export default function Home() {
  return (
    <>
      <script
        id="castingcompass-website-schema"
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(websiteStructuredData).replace(/</g, "\\u003c"),
        }}
      />
      <OpportunityApp />
    </>
  );
}
