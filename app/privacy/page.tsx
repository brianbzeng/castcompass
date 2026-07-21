import type { Metadata } from "next";
import { LegalPage, LegalSection } from "../components/LegalPage";

const PAGE_URL = "https://castingcompass.com/privacy";
const PAGE_TITLE = "Privacy Policy · CastingCompass";
const PAGE_DESCRIPTION = "How CastingCompass collects, uses, shares, retains, and protects information.";

export const metadata: Metadata = {
  title: "Privacy Policy",
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

export default function PrivacyPage() {
  return (
    <LegalPage
      eyebrow="Legal · Privacy"
      title="Privacy Policy"
      summary="This Policy explains what CastingCompass, operated by Brian Zeng, collects and how it is used. CastingCompass does not currently sell personal information, run targeted advertising, collect phone numbers, or retain your device’s precise location."
    >
      <LegalSection title="1. Information we collect">
        <ul>
          <li><strong>Account information:</strong> email address, a salted password hash, account timestamps, and records showing acceptance of the current legal documents.</li>
          <li><strong>Age eligibility:</strong> signup first sends a birth date by itself to decide whether account creation is available using the California calendar. The entered birth date is not retained. The service keeps a short-lived, one-use eligibility proof or ineligibility marker without the birth date, email address, or account details; after account creation, it retains the time of the successful eligibility check. Terms and Privacy acceptance versions are retained separately.</li>
          <li><strong>Fishing preferences:</strong> saved locations and optional gear presets.</li>
          <li><strong>Trip reports:</strong> curated fishing location, date and time, effort, method, catches or skunks, gear, practical fishability observations, notes, forecast context, model version, and an optional photo.</li>
          <li><strong>Security and technical data:</strong> session tokens stored in secure cookies, hashed email identifiers used for rate limiting, a five-character password-hash prefix used only when checking a new password against known breach data, request and error logs, IP address and device/browser information processed by infrastructure providers, and security events.</li>
        </ul>
      </LegalSection>

      <LegalSection title="2. Optional browser location">
        <p>If you choose “Near me” or a distance radius, the browser asks for your current location. CastingCompass uses it in the open browser tab to sort nearby public fishing locations and apply the radius. The coordinate is not sent to the CastingCompass account API, not saved to your account, and not added to a trip report. Closing or refreshing the tab clears the app’s in-memory copy. Your browser and operating system control the underlying permission.</p>
      </LegalSection>

      <LegalSection title="3. How information is used">
        <p>We use information to create and secure accounts, remember saved locations, provide forecasts and trip tools, respond to support requests, prevent abuse, operate the location discussion, measure forecast performance, and research or improve the service. Trip outcomes and observations may be used to evaluate and train future forecasting models.</p>
      </LegalSection>

      <LegalSection title="4. Automated review and public summaries">
        <p>Completed trip data may be sent to Xiaomi MiMo for gear normalization and review of notes for privacy, safety, relevance, and usefulness. The review payload can include the curated site, trip time, method, catch totals, gear, fishability observations, forecast/model context, and up to 1,000 characters of notes. CastingCompass deliberately omits your email address, account ID, uploaded photo, and structured browser-location or coordinate fields. Free-text trip fields are sent as entered and could contain details you type, so do not include names, contact details, exact locations, access codes, or other private information.</p>
        <p>A queued review is authorized only after a final deletion-record check. A deletion committed before that check prevents the provider request. A request already authorized or sent before the deletion transaction cannot be recalled and may finish processing under the provider&apos;s retention terms; its response cannot restore the deleted trip or publish a discussion post.</p>
        <p>Automated review may prepare a shortened pseudonymous discussion draft, but it cannot publish or approve the draft. A human moderator must approve a draft before it can appear on the curated location’s discussion page. Public summaries can still be imperfect; contact us to request correction or removal.</p>
      </LegalSection>

      <LegalSection title="5. Service providers and disclosures">
        <p>We disclose information only as needed to operate the service, follow the law, protect safety and rights, or complete a transaction you request. Current providers include:</p>
        <ul>
          <li><strong>Cloudflare:</strong> website hosting, security, logs, D1 account/trip storage, optional R2 photo storage, and Turnstile account-abuse checks when enabled. Turnstile may use network, browser, and device security signals to decide whether to present or accept a challenge; CastingCompass does not add your email, birth date, password, account ID, or precise location to the Turnstile verification request.</li>
          <li><strong>Resend:</strong> verification, password-recovery, and welcome email delivery.</li>
          <li><strong>Have I Been Pwned Pwned Passwords:</strong> when you establish or reset a password, the server computes a SHA-1 lookup hash and sends only its first five characters through the provider&apos;s padded range API. The password, email address, and complete hash are not sent. CastingCompass compares the remaining hash characters locally and does not retain the provider response.</li>
          <li><strong>Xiaomi MiMo:</strong> automated gear and trip-note review as described above.</li>
          <li><strong>Public data providers:</strong> forecast requests use public weather, tide, marine, bathymetry, and fisheries sources. Links to Google Maps and official agencies open their services under their own policies.</li>
        </ul>
        <p>We do not currently sell or share personal information for cross-context behavioral advertising, and we do not currently use third-party advertising trackers. Therefore a “Do Not Sell or Share” link is not presently required or offered. We will update this Policy and add applicable choices before activating advertising or such sharing.</p>
      </LegalSection>

      <LegalSection title="6. Retention">
        <ul>
          <li>Accounts, saved locations, gear presets, and trip reports are retained until deleted, unless a shorter period is required.</li>
          <li>Signup eligibility proofs can be used for 10 minutes and are removed after a short operational buffer of about 24 hours. A browser that receives an ineligibility result may keep a first-party marker for up to 24 hours so returning to the prior screen does not restart collection; neither artifact contains the entered birth date, age, email address, or account details.</li>
          <li>Sessions expire after 30 days and expired session records are periodically removed.</li>
          <li>Email challenges expire after 15 minutes and are removed after a short operational buffer.</li>
          <li>Rate-limit attempts are retained for up to about 30 days.</li>
          <li>After an account deletion request, the secure browser status receipt expires after 30 days or sooner if you dismiss it. Dismissing the receipt does not cancel cleanup. Pseudonymous completed-deletion records are retained for about 90 days to prevent deleted data from being unintentionally restored. Unresolved photo-cleanup jobs are retained until cleanup succeeds or is resolved by an operator.</li>
          <li>Provider security and delivery logs may follow the provider’s retention schedule.</li>
          <li>De-identified or aggregated information that can no longer reasonably identify you may be retained for research and service improvement.</li>
        </ul>
        <p>Deletion removes account access and linked database records from the active service first. Stored trip-photo objects may require background cleanup. The deletion-status receipt reports whether that cleanup is completed, processing, or needs operator attention. Backup copies may remain for a limited operational period and are not intended for ordinary service use; deletion records must be replayed before a backup restoration can return to service.</p>
      </LegalSection>

      <LegalSection title="7. Your choices and privacy rights">
        <p>From Profile, you can view saved locations and reports, edit or remove pending reports, download a machine-readable JSON copy of account records, and permanently delete the account. When background packaging is enabled, the private JSON file is available only to the signed-in owner and expires after 24 hours; otherwise the authenticated response is generated directly. When stored photos exist, the export includes a manifest with authenticated links for downloading those photo files separately; the photos are not embedded in the JSON file. You can also deny or revoke browser location permission and use the public forecast without an account.</p>
        <p>After an accepted deletion request, sign-in access, saved locations, gear presets, linked trip reports, and linked public discussion summaries are removed from the active database. CastingCompass also clears its account-related trip drafts and anonymous reporting identifier from the current browser when browser storage is available, and reports when the browser blocks that cleanup. If photo-object cleanup continues in the background, Profile displays that limited status using a secure receipt that cannot restore account access.</p>
        <p>California residents may have rights to know, access, correct, delete, and receive information, to opt out of certain sale or sharing, to limit certain uses of sensitive personal information, and to receive non-discriminatory treatment. CastingCompass does not currently meet every business threshold that makes the CCPA apply, but we provide access and deletion tools voluntarily. Email <a href="mailto:bzeng0000@gmail.com">bzeng0000@gmail.com</a> for a request that the product controls do not cover. We may need to verify the request.</p>
      </LegalSection>

      <LegalSection title="8. Children’s privacy">
        <p>CastingCompass accounts are not available to children under 13. We use a neutral, age-only first screen and do not retain the entered birth date. A short-lived eligibility or ineligibility result may be kept without the birth date, age, email address, or other account details as described above. If we learn that personal information was collected from a child under 13, we will delete it. A parent or guardian can contact us about a suspected underage account.</p>
      </LegalSection>

      <LegalSection title="9. Security, transfers, and Do Not Track">
        <p>We use reasonable safeguards such as salted password hashing, secure HttpOnly cookies, same-origin checks, rate limits, access controls, and stripped photo metadata. No system is perfectly secure, and we cannot guarantee absolute security.</p>
        <p>Service providers may process information in the United States or other locations where they operate. CastingCompass does not currently respond differently to browser “Do Not Track” signals because it does not currently run cross-site advertising trackers. Third-party sites linked from the service may collect information across sites under their own policies.</p>
      </LegalSection>

      <LegalSection title="10. Changes and contact">
        <p>We will revise this Policy before materially changing how information is collected, used, or shared. Account holders will be asked to acknowledge material changes where appropriate. Questions, privacy requests, and summary-removal requests can be sent to <a href="mailto:bzeng0000@gmail.com">bzeng0000@gmail.com</a>.</p>
      </LegalSection>
    </LegalPage>
  );
}
