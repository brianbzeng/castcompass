# SEO launch gate

CastingCompass SEO is a staged product operation, not one checkbox. Local crawl
readiness, the reviewed production release, search-engine ownership/submission,
and observed indexing are separate evidence milestones. Do not claim that a page
is indexed merely because it appears in a sitemap or an indexing request was sent.

## Current scope and claims

The intended indexable set is deliberately small:

- `https://castingcompass.com/`
- `https://castingcompass.com/privacy`
- `https://castingcompass.com/terms`
- `https://castingcompass.com/ai-disclosure`

`/profile`, APIs, preview hosts, and generated data assets are not search landing
pages. The homepage may describe explainable **relative rankings** for California
halibut opportunity windows. It must not describe the live heuristic configuration
as a trained catch-probability model or imply that access, regulations, safety, or
catch outcomes are guaranteed.

Operator-reported state on July 17, 2026: Google Search Console and Bing Webmaster
Tools dashboards have been created. Repository evidence does not yet prove property
ownership, sitemap submission, URL inspection, indexing, or search performance, so
those milestones remain open.

The four-page audience questions, page purposes, candidate phrases, desired snippets,
prohibited claims, and secret-free evidence contract are frozen in
[`SEO_LANGUAGE_AND_EVIDENCE.md`](SEO_LANGUAGE_AND_EVIDENCE.md) and the machine-checked
[`seo/language-policy.json`](../seo/language-policy.json). The desired snippets are
preferences only; search engines may select different page text.

## Milestone 1 — local crawl foundation

- [x] Each public page has one HTTPS self-canonical and route-specific title,
      description, Open Graph, and Twitter metadata.
- [x] `/profile` has a self-canonical plus `noindex, nofollow` and is omitted from
      the sitemap. It remains crawlable so robots can observe the `noindex`.
- [x] `robots.txt` allows public crawling and names the XML sitemap.
- [x] `sitemap.xml` contains exactly the four public pages with absolute HTTPS URLs.
- [x] The homepage publishes narrow `WebSite` JSON-LD only; no ratings, accuracy,
      business status, products, FAQs, or dataset claims are invented.
- [x] Unknown routes return a useful branded page, a real `404` status, noindex
      metadata, and a clear return-to-home action; the page is absent from the sitemap.
- [x] Automated tests enforce the rendered and static crawl contract.

### Local performance and privacy hygiene

- [x] The 34px header mark uses the existing 192px icon instead of downloading
      and offline-caching a 1MB legacy source image.
- [x] The service worker uses a new cache version and no longer precaches that
      legacy image.
- [x] The Vinext build uses platform font stacks and makes no browser request to
      Google Fonts. Locally bundled brand fonts can be reconsidered during the
      later visual refresh without reopening third-party font requests.
- [ ] Record real-user Core Web Vitals after the reviewed production release;
      local transfer checks are not a substitute for CrUX field data.

Google recommends `WebSite` structured data on the homepage for a preferred site
name and warns that a robots-blocked page can hide its `noindex` directive. See
[site names](https://developers.google.com/search/docs/appearance/site-names) and
[robots meta directives](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag).

### Error and short-maintenance semantics

The custom not-found page is permanent error handling: it returns `404`, not `200`
and not a redirect to the homepage. During a short emergency or release bridge,
browser documents instead receive self-contained static HTML with `503`, numeric
`Retry-After`, and browser/CDN `no-store`; APIs receive the equivalent JSON `503`
before body parsing or data access. The temporary maintenance document deliberately
does **not** publish `noindex`, while `/robots.txt` and `/sitemap.xml` remain available.
The PWA forwards marked maintenance responses without caching them and a new cache
version removes prior application shells when the maintenance release activates.

This follows Google's current guidance to return useful `404` pages with the real
status and to reserve whole-site `503` maintenance for brief outages while keeping
`robots.txt` crawlable. See [soft 404 guidance](https://developers.google.com/search/docs/crawling-indexing/troubleshoot-crawling-errors)
and [temporarily pausing a site](https://developers.google.com/search/docs/crawling-indexing/pause-online-business).

## Milestone 2 — reviewed production release

- [ ] Complete the P0 release gate first, including the canonical HTTP-to-HTTPS
      redirect, security/API noindex headers, remote CI, alerts, backup, restore,
      and staged migration evidence.
- [ ] Deploy this SEO commit through the immutable Worker release process.
- [ ] Fetch all four pages, `/profile`, `/robots.txt`, and `/sitemap.xml` from the
      apex, `www`, legacy aliases, and the exact Worker host. Record status,
      redirect, canonical, robots, sitemap, and structured-data evidence without
      user or account data.
- [ ] Confirm `/profile` is `noindex, nofollow`, is not in the sitemap, and is not
      blocked by `robots.txt`.

Google's sitemap guidance requires absolute canonical URLs and does not require
`lastmod`; omit it until the value can be maintained accurately. See
[Build and submit a sitemap](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap).

## Milestone 3 — Google Search Console

- [ ] Add or select the `castingcompass.com` **Domain property**.
- [ ] Copy Google's ownership TXT value into Cloudflare DNS and retain the record.
      Do not commit a verification value to this repository.
- [ ] Submit `https://castingcompass.com/sitemap.xml`.
- [ ] Inspect and live-test the four public URLs, then request indexing.
- [ ] Inspect `/profile` only to confirm `noindex`; do not request indexing.
- [ ] Record Page Indexing, sitemap, Performance, and Core Web Vitals baselines.
      Zero impressions and “not enough data” are valid initial results.

Keep a private evidence record with the property type, verification timestamp and
operator, DNS record **name/type but not its value**, sitemap submission/processing
timestamps, each inspected URL and verdict, the Google-selected canonical, and links
or screenshots of initial reports. Dashboard creation by itself is not verification.

See Google's [ownership verification](https://support.google.com/webmasters/answer/9008080),
[URL Inspection](https://support.google.com/webmasters/answer/9012289), and
[Core Web Vitals report](https://support.google.com/webmasters/answer/9205520).

## Milestone 4 — Bing Webmaster Tools

- [ ] Prefer importing the verified Google property; otherwise complete Bing's
      own ownership verification without committing a token.
- [ ] Submit or confirm the imported sitemap.
- [ ] Use Live URL inspection for the four public pages and request indexing.
- [ ] Confirm `/profile` reports `noindex`.
- [ ] Record the initial Site Explorer and SEO Reports state after Bing has data.

The private evidence record should state whether Bing was imported from Google or
verified independently, the permission granted during import, sitemap source and
processing status, each Live URL result, Bing-selected canonical/markup findings,
and the date of the first Site Explorer/SEO Reports baseline. Do not commit Bing
verification codes or broad account-access artifacts.

See Bing's [site verification](https://www.bing.com/webmasters/help/add-and-verify-site-12184f8b),
[sitemap guidance](https://www.bing.com/webmasters/help/sitemaps-3b5cf6ed), and
[URL Inspection](https://www.bing.com/webmasters/help/URL-Inspection-55a30305).

IndexNow is optional after the snapshot pipeline can notify only genuinely changed
public URLs. It is not required for this launch gate and does not guarantee indexing.

## Measurement and privacy

Search Console and Bing performance reports are the first acquisition baseline.
Do not add browser analytics merely to finish this checklist. Any future funnel
measurement needs a defined purpose, minimal event set, retention period, provider
review, legal disclosure, and a test proving that no precise location, trip content,
email, account identifier, or free text enters analytics.

Track only aggregate launch signals initially: valid indexed pages, crawl errors,
search impressions, clicks, query themes, branded versus non-branded discovery,
device class, and Core Web Vitals eligibility. Search-engine submission is not a
promise of ranking, traffic, or indexing.
