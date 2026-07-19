# SEO language and provider evidence

This document is the human-readable companion to the fail-closed policy in
[`seo/language-policy.json`](../seo/language-policy.json). It prepares language and
evidence collection only. It does not authorize a DNS change, dashboard import,
sitemap submission, live URL test, indexing request, IndexNow notification, or
production release.

Google recommends concise, descriptive, distinct titles and warns against keyword
stuffing. It primarily builds snippets from page content and may use a page-specific
meta description when that is a better summary. Titles and snippets are preferences,
not fields an operator can force. See Google's [title-link guidance](https://developers.google.com/search/docs/appearance/title-link)
and [snippet guidance](https://developers.google.com/search/docs/appearance/snippet).

## Four-page language sheet

Candidate phrases are research prompts for understanding audience intent. They are
not a direction to repeat keywords, a prediction of ranking, or permission to add a
claim that the page does not support.

### `/` — public opportunity planner

- **Audience questions:** How can someone compare public Bay Area halibut fishing
  windows? Which available shore, beach, jetty, or pier options fit the forecast
  inputs? Why is one option ranked above another?
- **Honest purpose:** Compare options with a transparent heuristic relative ranking,
  while showing inputs, freshness, and limitations.
- **Candidate phrases:** “California halibut fishing planner,” “Bay Area halibut
  shore fishing conditions,” “halibut fishing window comparison,” and “Bay Area
  pier beach jetty fishing planner.”
- **Current title:** “CastingCompass — California halibut opportunity planner.”
- **Desired snippet:** “Compare public Bay Area shore, beach, jetty, and pier fishing
  windows using explainable relative rankings from habitat, seasonality, and current
  conditions.”
- **Useful next action:** Review ranking inputs and freshness before choosing a
  public fishing window.

### `/privacy` — privacy policy

- **Audience questions:** What information is collected? How are account and trip
  data used and retained? How can a user export or delete account data?
- **Honest purpose:** Explain collection, purposes, providers, retention, user
  controls, and request routes.
- **Candidate phrases:** “CastingCompass privacy policy,” “CastingCompass data
  collection,” “CastingCompass account deletion,” and “CastingCompass data
  retention.”
- **Current title:** “Privacy Policy · CastingCompass.”
- **Desired snippet:** “How CastingCompass collects, uses, shares, retains, and
  protects information.”
- **Useful next action:** Read the policy and use the listed product controls or
  contact route for a request.

### `/terms` — terms of service

- **Audience questions:** What rules apply to use? What limitations apply to the
  fishing information? What responsibilities remain with the person planning a
  trip?
- **Honest purpose:** State the use conditions and important limits on forecast,
  access, regulatory, and safety information.
- **Candidate phrases:** “CastingCompass terms of service,” “CastingCompass use
  terms,” “CastingCompass forecast limitations,” and “CastingCompass account terms.”
- **Current title:** “Terms of Service · CastingCompass.”
- **Desired snippet:** “Terms governing use of the CastingCompass fishing
  opportunity planner and account features.”
- **Useful next action:** Read the terms and independently verify current
  regulations, access, conditions, and safety.

### `/ai-disclosure` — ranking and AI disclosure

- **Audience questions:** How are relative rankings produced? Is the live experience
  a trained catch-prediction model? Where is AI used, and where is human review
  required?
- **Honest purpose:** Explain the heuristic relative ranker, public inputs, model
  research boundary, uncertainty, and human-gated AI review.
- **Candidate phrases:** “CastingCompass AI disclosure,” “CastingCompass forecast
  method,” “CastingCompass relative ranking,” and “CastingCompass fishing model
  limitations.”
- **Current title:** “AI and Forecast Disclosure · CastingCompass.”
- **Desired snippet:** “How CastingCompass uses a heuristic relative ranker, public
  forecast inputs, model research, and human-gated AI review.”
- **Useful next action:** Review the method, freshness, uncertainty, and human-review
  boundaries before relying on a ranking.

The canonical policy contains the exact titles, descriptions, URLs, questions,
candidate phrases, next actions, and index intent. Automated tests bind it to the
four-page crawl set and the current rendered metadata.

## Prohibited claims

Do not publish or optimize around claims of catch probability, catch guarantees,
the “best” spot, scientific validation, proven accuracy, trained catch prediction,
complete real-time conditions, current-regulation certainty, guaranteed access or
safety, CDFW or government endorsement, search ranking, indexing, or production
parity. Do not turn a research protocol, an aggregate official-data snapshot, a
sitemap, or an indexing request into evidence for one of those claims.

Use the narrower product truth: CastingCompass currently provides explainable
**relative rankings** from a **heuristic** and public inputs. Show freshness and
uncertainty, and tell people to verify current conditions, regulations, access, and
safety. The JSON policy enumerates phrases that automated checks reject from the
page strategy fields; the underlying concepts remain prohibited even when reworded.

## Google and Bing state model

Keep these milestones separate:

1. dashboard created;
2. ownership verified;
3. sitemap submitted;
4. sitemap processed;
5. live URL tested;
6. indexing requested;
7. indexed; and
8. performance observed.

The operator reported creating both dashboards on July 17, 2026. The repository
does not contain evidence for any later state. A sitemap helps discovery but does
not guarantee crawling or indexing, and an indexing request does not guarantee an
indexed result. Google documents both limits in its [sitemap overview](https://developers.google.com/search/docs/crawling-indexing/sitemaps/overview)
and [URL Inspection guidance](https://support.google.com/webmasters/answer/9012289).
Bing likewise says no tool can guarantee when or how content appears and recommends
checking submission status, last-read time, and processing errors in the verified
account; see Bing's [sitemap guidance](https://blogs.bing.com/webmaster/July-2025/Keeping-Content-Discoverable-with-Sitemaps-in-AI-Powered-Search).

## Private evidence workflow

1. Keep the evidence folder outside Git and outside any public dashboard. Restrict
   it to the business owner and a specifically authorized reviewer.
2. Before taking a screenshot, close unrelated tabs and hide the account menu,
   email address, account/property identifiers that are not needed, verification
   values, tokens, billing details, and user information.
3. Record only the provider, property type, verification method, operator role, UTC
   timestamp, DNS record **name/type but not value**, sitemap URL/status, inspected
   URL/verdict, declared and provider-selected canonical, aggregate coverage or
   performance state, and a hash of the redacted screenshot.
4. Store the original and redacted screenshot privately. Only the redacted copy or
   its hash may be referenced from an issue or pull request after a manual review.
5. Record every state independently. Never infer ownership from dashboard creation,
   processing from submission, indexing from inspection/request, or ranking/traffic
   from indexing.

Search Console ownership is sensitive, high-permission access. A Domain property
covers protocol and subdomain variants and requires DNS verification; Google also
rechecks the verification record, so it should normally remain in DNS. Never commit
the record value. See Google's [ownership verification guidance](https://support.google.com/webmasters/answer/9008080).

Use a private record shaped like this, with no additional free text:

```text
provider:
property_type:
verification_method:
operator_role:
observed_at_utc:
dns_record_name_and_type:
sitemap_url:
sitemap_status:
inspected_url:
inspection_verdict:
declared_canonical:
provider_selected_canonical:
aggregate_coverage_state:
aggregate_performance_state:
redacted_screenshot_sha256:
```

Never record the DNS/HTML verification value, API or access token, session cookie,
authorization header, account email/identifier, recovery code, billing details, or
user/trip data in this template.

## Activation gate

The provider actions in the policy remain `false`. They may change only after the
P0 release checklist proves the reviewed commit is on the intended production
hosts, redirects and crawl headers are correct, and the owner explicitly starts
the provider phase. Provider evidence belongs in the private record; repository
status should contain only secret-free aggregate facts.
