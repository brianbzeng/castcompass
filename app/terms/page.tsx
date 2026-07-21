import type { Metadata } from "next";
import { LegalPage, LegalSection } from "../components/LegalPage";

const PAGE_URL = "https://castingcompass.com/terms";
const PAGE_TITLE = "Terms of Service · CastingCompass";
const PAGE_DESCRIPTION = "Terms governing use of the CastingCompass fishing opportunity planner and account features.";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: PAGE_DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  openGraph: {
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
    type: "website",
    url: PAGE_URL,
    siteName: "CastingCompass",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "CastingCompass — California Halibut Opportunity Planner" }],
  },
  twitter: {
    card: "summary_large_image",
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
    images: [{ url: "/og.png", alt: "CastingCompass — California Halibut Opportunity Planner" }],
  },
};

export default function TermsPage() {
  return (
    <LegalPage
      eyebrow="Legal · Terms"
      title="Terms of Service"
      summary="These Terms form an agreement between you and CastingCompass, operated by Brian Zeng, when you access the website, create an account, save a location, or submit a trip report."
    >
      <LegalSection title="1. Eligibility and agreement">
        <p>You must be at least 13 years old to create or use a CastingCompass account. By creating an account or using an account feature, you confirm that you meet this requirement and accept these Terms and the Privacy Policy. If you do not agree, do not create an account or submit information.</p>
        <p>The public forecast may be viewed without an account. We may suspend or close accounts used unlawfully, unsafely, fraudulently, or in a way that interferes with the service or other anglers.</p>
      </LegalSection>

      <LegalSection title="2. What the forecast means">
        <p>CastingCompass ranks currently evaluated locations and time windows for California halibut. An Opportunity Score is a relative percentile within the current comparison set. A score of 80 means the option ranks ahead of about 80% of the options being compared. It does not mean an 80% chance of catching a fish.</p>
        <p>Scores combine public environmental data, site and habitat information, seasonality, practical fishability adjustments, and experimental model outputs. Inputs can be missing, delayed, estimated, stale, imprecise, or wrong. Fish behavior and fishing results are uncertain. No score, explanation, map, chart, message, or discussion post guarantees that fish are present or that a location is accessible, safe, legal, or fishable.</p>
        <p>A separate official water-quality advisory overlay may suppress an exactly mapped site from recommendations. A no-posting result does not improve its score or mean water contact or seafood consumption is safe. Missing, stale, unmonitored, unavailable, or unmapped status remains unknown.</p>
      </LegalSection>

      <LegalSection title="3. Safety, navigation, access, and regulations">
        <p>CastingCompass is for informational and recreational planning only. It is not navigational data, a chart, a weather warning service, legal advice, medical advice, emergency guidance, or a substitute for your judgment. Do not use it to make decisions where an error could cause injury, death, property damage, trespass, or a regulatory violation.</p>
        <p>Before and during every trip, you are responsible for checking official weather and marine forecasts, tides, swell, surf, currents, water quality, closures, access rules, property boundaries, licensing requirements, species identification, size limits, bag limits, gear restrictions, and all other current regulations. Conditions can change faster than the service updates. Leave or do not enter when conditions are unsafe. Call 911 or the appropriate emergency authority in an emergency.</p>
        <p>Respect wildlife, habitat, other anglers, private property, and posted rules. Pack out line and trash. California halibut rules can change; always confirm the current California Department of Fish and Wildlife rules rather than relying on a number displayed by CastingCompass.</p>
      </LegalSection>

      <LegalSection title="4. Accounts and security">
        <p>Provide accurate account information, keep your password private, and notify us if you suspect unauthorized access. You are responsible for activity through your account. Email verification confirms control of an address but does not verify identity.</p>
        <p>You may download your account records or permanently delete your account from the Profile page. An accepted deletion request immediately removes account access, saved locations, gear presets, linked trip reports, and linked public discussion summaries from the active database. Stored trip-photo objects may require background cleanup; a secure deletion receipt reports whether that cleanup is completed, processing, or needs operator attention. Limited backup copies, security logs, pseudonymous deletion records, and information required by law may remain for their stated operational or legal retention periods.</p>
      </LegalSection>

      <LegalSection title="5. Trip reports, photos, and community summaries">
        <p>You keep ownership of content you submit. You grant CastingCompass a worldwide, non-exclusive, royalty-free license to host, store, reproduce, transform, analyze, and use that content to operate, secure, evaluate, research, and improve the service and its forecasting systems. This license lasts while the content is retained and includes creating de-identified or aggregated datasets and, after human approval, pseudonymous public summaries.</p>
        <p>You represent that you have the right to submit the content and that it does not violate privacy, intellectual-property, publicity, safety, or other rights. Do not submit private contact information, exact sensitive habitat locations, faces of people without permission, unlawful activity, abusive content, or misleading reports.</p>
        <p>Trip notes may be automatically reviewed for privacy, safety, relevance, and usefulness. Automated review may prepare a shortened pseudonymous draft, but it cannot publish or approve that draft. A human moderator must approve a draft before it can appear on a location discussion page. Automated and human review can make mistakes, and we may edit, withhold, or remove content.</p>
      </LegalSection>

      <LegalSection title="6. Automated systems and AI">
        <p>CastingCompass uses automated rules and models to rank fishing options, and a third-party language model may normalize gear information and prepare a possible discussion draft. The model cannot publish the draft; human approval is required. The live score is currently a hybrid planning model, not a fully trained catch-probability model. See the AI and Forecast Disclosure for details.</p>
        <p>You may not use the service to generate or submit deceptive, unlawful, dangerous, or privacy-invasive content, or to probe, scrape, reverse engineer, overload, evade safeguards, or extract non-public data from the service.</p>
      </LegalSection>

      <LegalSection title="7. Third-party services and links">
        <p>The service relies on or links to third parties, including public agencies, weather and marine data providers, maps, Cloudflare, Resend, and Xiaomi MiMo. Their data, availability, terms, and privacy practices are outside our control. A link or data source is not an endorsement, and we are not responsible for third-party services.</p>
      </LegalSection>

      <LegalSection title="8. No warranties">
        <p>To the maximum extent permitted by law, CastingCompass is provided “as is” and “as available,” without warranties of accuracy, availability, fitness for a particular purpose, merchantability, non-infringement, safety, legality, or results. We do not warrant that the service will be uninterrupted, secure, error-free, or suitable for any specific trip.</p>
      </LegalSection>

      <LegalSection title="9. Limitation of liability">
        <p>To the maximum extent permitted by law, Brian Zeng and CastingCompass will not be liable for indirect, incidental, special, consequential, exemplary, or punitive damages, or for lost data, lost profits, missed catches, travel costs, property damage, personal injury, regulatory penalties, access problems, or harm arising from conditions, third-party data, user content, or reliance on the service.</p>
        <p>Where liability cannot be excluded, aggregate liability arising from the service will not exceed the greater of the amount you paid CastingCompass during the 12 months before the claim or US $100. Some jurisdictions do not allow certain exclusions, so these limits apply only to the extent allowed by law. Nothing in these Terms excludes rights that cannot legally be waived.</p>
      </LegalSection>

      <LegalSection title="10. Indemnity">
        <p>To the extent permitted by law, you agree to defend and indemnify Brian Zeng and CastingCompass from third-party claims, losses, and reasonable costs caused by your unlawful or unsafe use of the service, your submitted content, your violation of these Terms, or your violation of another person’s rights.</p>
      </LegalSection>

      <LegalSection title="11. Changes, availability, and disputes">
        <p>We may change, suspend, or discontinue features. If we make material changes to these Terms, account holders will be asked to accept the updated version before continuing to use account features. Forecast methods and data sources may change without advance notice when needed to improve safety, accuracy, or reliability.</p>
        <p>California law governs these Terms, without regard to conflict-of-law rules. Before filing a claim, contact us and allow 30 days to try to resolve it informally. Unless the law requires otherwise, disputes may be brought in the state or federal courts serving Alameda County, California.</p>
      </LegalSection>

      <LegalSection title="12. Contact">
        <p>Questions about these Terms can be sent to <a href="mailto:bzeng0000@gmail.com">bzeng0000@gmail.com</a>. These Terms are a product baseline and may be updated as CastingCompass adds features.</p>
      </LegalSection>
    </LegalPage>
  );
}
