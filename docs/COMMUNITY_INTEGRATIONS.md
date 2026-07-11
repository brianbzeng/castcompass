# Community and third-party place content

## Current release

ContourCast links users to Google Maps for photos, reviews, Street View,
satellite imagery, and directions. Google content is not scraped, copied, or
stored. Historical fishing discussion in `data/community-pulse.json` is an
original editorial summary with outbound sources and is never used in the
Opportunity Score.

## Google Maps

Automated crawling of Google Maps or copying review text is not an acceptable
integration path. If inline Google content becomes a product requirement, use
the experimental [Places UI Kit Place Details
component](https://developers.google.com/maps/documentation/javascript/places-ui-kit/overview)
with a billing-enabled Google Maps Platform project and a browser-restricted
API key. Its service-specific terms permit the component alongside a
non-Google map, subject to Google branding and attribution requirements.

The raw Places API is less suitable for this interface: Place Details returns
a limited relevance-sorted review/photo set, invokes paid SKUs, and carries
strict display, attribution, and caching rules. Store stable Place IDs, not
review text, photo resources, or copied derivative summaries. A visitor's
Google login does not grant ContourCast broader access to public Maps reviews.

References:

- [Places UI Kit](https://developers.google.com/maps/documentation/javascript/places-ui-kit/overview)
- [Google Maps Platform terms](https://cloud.google.com/maps-platform/terms)
- [Places API policies](https://developers.google.com/maps/documentation/places/web-service/policies)
- [Maps URLs](https://developers.google.com/maps/documentation/urls/get-started)

## Fishbrain

Fishbrain does not publish a supported third-party review API, OAuth flow,
embed SDK, or "Sign in with Fishbrain" integration. A Fishbrain Pro
subscription is a consumer license; it does not authorize automated access,
republishing, credential proxying, or commercial crawling. ContourCast must not
collect Fishbrain passwords, cookies, or session tokens.

Compliant options are limited to an outbound Fishbrain link, a user-provided
plain URL on the user's own report without metadata scraping, or a written
commercial partnership and licensed data feed from Fishbrain.

Reference: [Fishbrain Terms of Service](https://fishbrain.com/policies/terms-of-service/latest)

## Recommended first-party path

Build structured ContourCast Trip Reports rather than a generic comment wall:

- site, visit time, fishing mode, target species, and catch/no-catch outcome;
- tide, wind, water clarity, bait or lure, optional note, and optional photo;
- zero-catch reports made as easy and visible as successful reports;
- separate access-status updates from fishing reports;
- authentication, edit/delete, reporting, blocking, rate limits, and a
  moderation queue;
- photo EXIF removal and no user-supplied exact coordinates outside curated
  access sites;
- explicit consent before any report can be used for model research.

Supabase authentication and Postgres are appropriate for this phase. Google
sign-in can authenticate the ContourCast account, but it must not be described
as authorization to crawl Google Maps.
