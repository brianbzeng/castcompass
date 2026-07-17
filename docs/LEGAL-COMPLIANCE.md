# CastingCompass legal and product compliance register

Last reviewed: 2026-07-16

This is an engineering and product checklist, not legal advice. The public Terms and Privacy Policy are a practical launch baseline. A California attorney should review them before paid subscriptions, advertising, native-app distribution, SMS, large-scale marketing, or material growth.

## Current product and data map

| Surface | Data or risk | Current control |
| --- | --- | --- |
| Public forecast | Environmental and fishing guidance can be wrong or stale | Relative score language, source freshness, prominent work-in-progress notice, safety reminder, official-source links, Terms disclaimer |
| Account signup | Email, password, age eligibility | Age-only first screen; birth date is evaluated separately and never retained; a short-lived one-use eligibility proof or bounded ineligibility marker contains no birth date, age, email, or account details; credentials and legal acceptance are collected only after eligibility; password is salted and hashed; email challenge required |
| Legal acceptance | Terms and Privacy agreement | Affirmative unchecked boxes; accepted versions and timestamps stored; existing accounts must accept material versions before account features resume |
| Browser location | Potential precise location | Optional pre-prompt; coordinate stays in the browser tab and is used only for nearby sorting/radius; no account or trip persistence |
| Trip report | Time, site, catches, gear, notes, fishability, optional photo | Clear consent; user ownership representation; private-by-default raw data; metadata-stripped photo; pending edit/delete; public output limited to an anonymous reviewed summary |
| Automated review | Trip payload sent to Xiaomi MiMo | No email, account ID, device location, photo, or exact private coordinate in the review payload; separate AI disclosure; correction/removal contact |
| Email | Verification, recovery, welcome | Transactional only; Resend is the delivery provider; no marketing list or SMS |
| Storage | D1 account/trip records and optional R2 photos | Secure session cookies, same-origin mutation checks, rate limits, comprehensive JSON export plus separate authenticated photo downloads, durable deletion jobs, secure status receipts, scheduled retry of object cleanup, and pseudonymous deletion tombstones |

## Current legal baseline

### Children

- Accounts are limited to users age 13 or older.
- The age screen is neutral and does not suggest the qualifying answer.
- Birth dates are evaluated against the `America/Los_Angeles` calendar and are not retained. Eligibility proofs can be used for 10 minutes and are removed after an operational buffer of about 24 hours; a first-party ineligibility marker may remain for up to 24 hours. Neither artifact contains the entered date, age, email, or account details.
- The Privacy Policy provides a parent/guardian contact and deletion process.
- If the product is later directed to children or knowingly collects under-13 data, stop and implement a COPPA parental-consent program before collection.

Primary references:

- FTC COPPA FAQ: <https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions>
- FTC COPPA business guidance: <https://www.ftc.gov/business-guidance/resources/childrens-online-privacy-protection-rule-not-just-kids-sites>

### California privacy

- Maintain a conspicuous Privacy Policy describing categories, uses, disclosures, retention, choices, effective date, and contact.
- CalOPPA applies to commercial online services collecting California residents' personally identifiable information even when CCPA business thresholds are not met.
- CCPA/CPRA rights and opt-out links become mandatory only if statutory applicability and relevant data practices are triggered. CastingCompass voluntarily provides access and deletion now.
- Do not add advertising trackers, cross-context behavioral advertising, sale/sharing, or sensitive-data use without updating the data map, consent/notice, vendor contracts, and required opt-outs first.

Primary references:

- California Business and Professions Code § 22575: <https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=BPC&sectionNum=22575>
- California Attorney General CCPA page: <https://oag.ca.gov/privacy/ccpa>
- California Attorney General privacy-policy guidance: <https://oag.ca.gov/privacy/facts/online-privacy/privacy-policy>

### Location

- Keep browser location optional, purpose-limited, and ephemeral.
- Do not add it to trip reports or server logs without a new just-in-time notice, Privacy Policy update, retention rule, deletion path, and vendor review.
- Native apps must also complete Apple privacy disclosures and Google Play location/Data Safety declarations before release.

Primary references:

- Google Play location permission guidance: <https://support.google.com/googleplay/android-developer/answer/9799150>
- Google Play User Data policy: <https://support.google.com/googleplay/android-developer/answer/10144311>
- Apple App Review Guidelines: <https://developer.apple.com/app-store/review/guidelines/>
- FTC sensitive-location enforcement example: <https://www.ftc.gov/news-events/news/press-releases/2024/04/ftc-finalizes-order-x-mode-successor-outlogic-prohibiting-it-sharing-or-selling-sensitive-location>

### Automated systems and AI

- Do not call the score a probability, guarantee, trained neural model, or validated accuracy improvement unless the claim is supported.
- Keep the live hybrid model, experimental bathymetry pipeline, and language-model note review clearly separated.
- Disclose automated review where notes are collected and in the dedicated AI/Forecast Disclosure.
- Reassess California AB 2013 and SB 942 before releasing a covered generative-AI system or public synthetic-media generator. The current ranker and private text-review workflow should not be assumed to remain outside future requirements after feature changes.

Primary references:

- FTC artificial-intelligence guidance hub: <https://www.ftc.gov/industry/technology/artificial-intelligence>
- FTC deceptive AI claims enforcement: <https://www.ftc.gov/news-events/news/press-releases/2024/09/ftc-announces-crackdown-deceptive-ai-claims-schemes>
- California AB 2013: <https://leginfo.legislature.ca.gov/faces/billNavClient.xhtml?bill_id=202320240AB2013>
- California SB 942: <https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=202320240SB942>

### Fishing, weather, bathymetry, and safety

- Treat the product as planning assistance only, not navigation, emergency alerts, regulations, or a guarantee of safe access.
- Link to current CDFW and official forecast sources. Never make a cached rule or condition the sole source of truth.
- Do not imply NOAA bathymetry is a nautical chart.

Primary references:

- CDFW San Francisco fishing regulations map: <https://wildlife.ca.gov/Fishing/Ocean/Regulations/Fishing-Map/San-Francisco>
- National Weather Service disclaimer: <https://www.weather.gov/DISCLAIMER.PHP>
- NOAA National Bathymetric Source: <https://www.nauticalcharts.noaa.gov/learn/nbs.html>

## Feature gates before launch

### Paid subscriptions

- Attorney review of Terms, refund/cancellation language, recurring billing, tax, and consumer-renewal laws.
- Show price, billing period, automatic renewal, cancellation method, and material trial terms immediately before purchase.
- Native digital features must use the store billing method where the applicable Apple/Google rules require it; web checkout rules differ and store rules change.
- Add entitlement, cancellation, refund, failed-payment, and deletion behavior tests.

### Advertising or affiliate tracking

- Update Privacy Policy before activation, not after.
- Inventory every tracker and data flow; sign data-processing terms.
- Determine CCPA sale/share applicability and add “Do Not Sell or Share My Personal Information” and Global Privacy Control handling if triggered.
- Add consent controls for jurisdictions that require opt-in tracking.
- Implement Apple App Tracking Transparency before iOS cross-app tracking.

### SMS or phone numbers

- Do not collect phone numbers until there is a defined necessity and retention rule.
- Automated or marketing texts require a separate, conspicuous opt-in that is not bundled with the Terms; keep consent evidence and honor STOP/revocation.
- Transactional and marketing uses must remain separated. Obtain TCPA counsel before launch.

Primary reference: FCC TCPA consumer guide: <https://docs.fcc.gov/public/attachments/DA-15-997A1.pdf>

### Marketing email

- Keep current verification, recovery, and welcome mail transactional.
- Before newsletters or promotions, add preference and unsubscribe controls, accurate sender information, and CAN-SPAM review.

Primary reference: FTC CAN-SPAM compliance guide: <https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business>

### Native apps

- Complete Apple privacy nutrition labels, Google Play Data Safety, content rating, account deletion, location disclosures, and store-specific billing declarations.
- Re-test the age rating and whether the service is directed to children.
- Prepare an in-app account-deletion flow and a public deletion-request URL.

## Operational cadence

- Review this register and all public legal documents before every material data, AI, monetization, account, communication, or native-app feature.
- Record vendors, data categories, purposes, retention, security measures, deletion mechanics, and public/private output before implementation.
- Increment `LEGAL_VERSION` for material Terms or Privacy changes and require renewed acceptance.
- Run a quarterly check for broken legal links, inaccurate data-flow statements, expired vendor terms, and unimplemented deletion paths.
- Keep a private incident log. Define a security-incident and data-breach response plan before collecting materially more user data.
- Before any D1 restore, preserve the current deletion ledger, restore the backup in isolation, replay all deletion tombstones and unresolved object tasks, audit row/object counts, and only then allow the restored database to receive traffic.

## Privacy durability release gate

The repository implementation is a local release candidate, not evidence that the production migration, Cloudflare bindings, backup policy, or restore procedure has been completed. Do not describe durable deletion as live until all of the following have been verified against the production account:

- Apply the privacy migration through the guarded immutable release workflow and verify the expected age-proof, deletion-job, deletion-task, and tombstone tables.
- Confirm the age endpoint receives only a birth date, creates no email challenge or account for an ineligible or invalid date, and never stores the entered birth date.
- Confirm eligibility proofs cannot be used after 10 minutes and are removed after an operational buffer of about 24 hours, the ineligibility marker expires within 24 hours, and neither artifact contains the entered date, age, email, or account details.
- Confirm account deletion removes active D1 access and linked public rows before returning success, issues a 30-day secure status receipt when cleanup remains, retries R2 deletion, and retains unresolved cleanup jobs until resolved.
- Retain pseudonymous completed-deletion tombstones for 90 days. Document the production backup-retention window and prove through an isolated restore drill that the current deletion ledger is replayed before restored data can receive traffic.
- Verify exports against populated fixtures: account and consent records, saved locations, gear presets, full trip fields, discussion linkage, photo manifest, and successful authenticated download of each photo file that the export says is available.
- Review and document Cloudflare, Resend, and Xiaomi MiMo deletion and log-retention terms. Complete counsel review of the updated Terms, Privacy Policy, age gate, backup language, and user-request workflow.

## Open items for counsel

- Entity formation and whether the operator should be an LLC rather than an individual.
- Insurance appropriate for a public outdoor-planning service.
- Final limitation-of-liability, indemnity, forum, and dispute provisions.
- Trademark/name clearance for CastingCompass.
- Vendor DPAs and international data transfer terms as usage grows.
- Subscription, advertising, SMS, and native-store review before those features launch.
