import type { Metadata } from "next";
import { LegalPage, LegalSection } from "../components/LegalPage";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How CastingCompass collects, uses, shares, and protects information.",
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
          <li><strong>Age eligibility:</strong> the signup form checks a birth date to confirm that you are at least 13. The birth date itself is not stored; only the date and time of the successful eligibility check is retained.</li>
          <li><strong>Fishing preferences:</strong> saved locations and optional gear presets.</li>
          <li><strong>Trip reports:</strong> curated fishing location, date and time, effort, method, catches or skunks, gear, practical fishability observations, notes, forecast context, model version, and an optional photo.</li>
          <li><strong>Security and technical data:</strong> session tokens stored in secure cookies, hashed email identifiers used for rate limiting, request and error logs, IP address and device/browser information processed by infrastructure providers, and security events.</li>
        </ul>
      </LegalSection>

      <LegalSection title="2. Optional browser location">
        <p>If you choose “Near me” or a distance radius, the browser asks for your current location. CastingCompass uses it in the open browser tab to sort nearby public fishing locations and apply the radius. The coordinate is not sent to the CastingCompass account API, not saved to your account, and not added to a trip report. Closing or refreshing the tab clears the app’s in-memory copy. Your browser and operating system control the underlying permission.</p>
      </LegalSection>

      <LegalSection title="3. How information is used">
        <p>We use information to create and secure accounts, remember saved locations, provide forecasts and trip tools, respond to support requests, prevent abuse, operate the location discussion, measure forecast performance, and research or improve the service. Trip outcomes and observations may be used to evaluate and train future forecasting models.</p>
      </LegalSection>

      <LegalSection title="4. Automated review and public summaries">
        <p>Completed trip data may be sent to Xiaomi MiMo for gear normalization and review of notes for privacy, safety, relevance, and usefulness. The review payload can include the curated site, trip time, method, catch totals, gear, fishability observations, forecast/model context, and up to 1,000 characters of notes. It does not include your email address, account ID, uploaded photo, device location, or exact private coordinates.</p>
        <p>If the review finds useful location context, CastingCompass may publish a short anonymous summary on that curated location’s discussion page. Raw notes, identity, and photos remain private. A public summary can still be imperfect; contact us to request correction or removal.</p>
      </LegalSection>

      <LegalSection title="5. Service providers and disclosures">
        <p>We disclose information only as needed to operate the service, follow the law, protect safety and rights, or complete a transaction you request. Current providers include:</p>
        <ul>
          <li><strong>Cloudflare:</strong> website hosting, security, logs, D1 account/trip storage, and optional R2 photo storage.</li>
          <li><strong>Resend:</strong> verification, password-recovery, and welcome email delivery.</li>
          <li><strong>Xiaomi MiMo:</strong> automated gear and trip-note review as described above.</li>
          <li><strong>Public data providers:</strong> forecast requests use public weather, tide, marine, bathymetry, and fisheries sources. Links to Google Maps and official agencies open their services under their own policies.</li>
        </ul>
        <p>We do not currently sell or share personal information for cross-context behavioral advertising, and we do not currently use third-party advertising trackers. Therefore a “Do Not Sell or Share” link is not presently required or offered. We will update this Policy and add applicable choices before activating advertising or such sharing.</p>
      </LegalSection>

      <LegalSection title="6. Retention">
        <ul>
          <li>Accounts, saved locations, gear presets, and trip reports are retained until deleted, unless a shorter period is required.</li>
          <li>Sessions expire after 30 days and expired session records are periodically removed.</li>
          <li>Email challenges expire after 15 minutes and are removed after a short operational buffer.</li>
          <li>Rate-limit attempts are retained for up to about 30 days.</li>
          <li>Provider security and delivery logs may follow the provider’s retention schedule.</li>
          <li>De-identified or aggregated information that can no longer reasonably identify you may be retained for research and service improvement.</li>
        </ul>
      </LegalSection>

      <LegalSection title="7. Your choices and privacy rights">
        <p>From Profile, you can view saved locations and reports, edit or remove pending reports, download a machine-readable copy of account data, and permanently delete the account. You can also deny or revoke browser location permission and use the public forecast without an account.</p>
        <p>California residents may have rights to know, access, correct, delete, and receive information, to opt out of certain sale or sharing, to limit certain uses of sensitive personal information, and to receive non-discriminatory treatment. CastingCompass does not currently meet every business threshold that makes the CCPA apply, but we provide access and deletion tools voluntarily. Email <a href="mailto:bzeng0000@gmail.com">bzeng0000@gmail.com</a> for a request that the product controls do not cover. We may need to verify the request.</p>
      </LegalSection>

      <LegalSection title="8. Children’s privacy">
        <p>CastingCompass accounts are not available to children under 13. We use a neutral age screen and do not retain the entered birth date. If we learn that personal information was collected from a child under 13, we will delete it. A parent or guardian can contact us about a suspected underage account.</p>
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
