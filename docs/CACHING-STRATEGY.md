# Caching strategy

This matrix is the caching contract for the current web Worker, PWA, and optional read-only
FastAPI service. A cache entry is an availability optimization, never an authorization source.
Authentication, account, trip, deletion, moderation, health, and every other `/api/*` response
remain `no-store` at both browser and CDN layers. Responses that set cookies, redirects without
an explicit public policy, and all errors also fail closed to `no-store` in `worker/security.ts`.

| Data class | Owner / privacy | Cache key | Browser / edge TTL | Invalidation | Stale and failure behavior |
| --- | --- | --- | --- | --- | --- |
| Hashed framework assets | Release engineering; public | Full content-hashed URL | Provider-managed long-lived immutable asset policy | New content hash on build | Old releases remain safe to execute only with their matching HTML; release smoke tests check version skew |
| `sw.js` | Release engineering; public | Exact `/sw.js` URL | `no-cache, no-store, must-revalidate` | Every deployment | Registration uses `updateViaCache: none`; the controller reloads once after a replacement |
| Public HTML shell | Web; public, except that cookie-bearing responses are private | Canonical path; no account/cookie variation may enter the PWA cache | Origin policy; only `/`, `/privacy`, `/terms`, and `/ai-disclosure` enter the versioned offline cache | Deployment bumps the PWA cache version and removes prior CastingCompass caches | Network first; the exact public path is used offline, then `/` as the final shell fallback. `/profile`, unknown routes, errors, `private`, and `no-store` responses are never inserted |
| `sites.json` | Data operations; public access metadata | Exact path and deployment representation | Browser revalidates; edge 1 hour, stale-while-revalidate 24 hours | New reviewed snapshot/deployment; urgent access corrections require an edge purge plus PWA cache-version bump | PWA is network first and may show its last verified copy offline; UI must label data age and retain official-source links |
| `opportunities.json` | Forecast pipeline; public heuristic snapshot | Exact path and scoring/snapshot identity inside the document | Browser revalidates; edge 5 minutes, stale-while-revalidate 10 minutes | New verified snapshot/deployment or explicit purge | Network first, then the last verified PWA copy. Freshness logic must downgrade stale sources and must never invent missing values |
| `community-pulse.json` | Moderation/data operations; public aggregate | Exact path and deployment representation | Browser revalidates; edge 5 minutes, stale-while-revalidate 10 minutes | New moderated aggregate/deployment or explicit purge | Network first, then an offline copy; an unavailable document degrades to an empty aggregate |
| Optional FastAPI `/v1/sites*` | API/data operations; public | Full normalized URL; no credentials | Browser/shared max-age 1 hour, stale-while-revalidate 24 hours | Site-table update or service purge; in-process accessible-site cache expires after 60 seconds | Hybrid repository falls back to the verified file snapshot on database errors; 503 responses are `no-store` |
| Optional FastAPI `/v1/opportunities*` | API/data operations; public | Full normalized URL including species/from/hours | Browser/shared max-age 5 minutes, stale-while-revalidate 10 minutes | New opportunity generation or service purge | Hybrid repository falls back to the verified file snapshot; malformed or mixed identities fail closed and are never cached as success |
| D1/account/health/discussion APIs | Account, security, privacy, or fast-changing moderated data | No cache key is permitted | Browser and CDN `no-store` | Not applicable | Always reach the Worker. The service worker bypasses every `/api/` request and never supplies an offline API response |
| Postgres accessible-site process cache | Optional API/data operations; public | Repository instance and complete accessible-site set | 60 seconds monotonic, bounded to 0–300 seconds by configuration | TTL, process restart, or explicit repository close | It reduces repeated site scans only. Database failure still uses the published file snapshot; it never caches credentials or user data |

## Release and incident rules

1. Change the service-worker cache version whenever the app shell, data compatibility, or
   offline behavior changes. Never reuse a cache name across incompatible releases.
2. Purge `sites.json` immediately for a material access/safety correction; do not wait for the
   normal edge TTL. Publish the official source and bump the PWA cache when an offline copy must
   be displaced.
3. A snapshot rollover is atomic at the document level. Consumers validate its embedded contract
   and scoring identity before use; cache age alone never makes a malformed snapshot acceptable.
4. Do not add authenticated variation to a public URL. If a route can observe a session or set a
   cookie, it must stay outside public and PWA caches even when its current body looks generic.
5. Verify canonical and alias headers, a warm/cold fetch, an explicit purge, offline fallback,
   and old-service-worker cleanup in staging before production activation.

The cache contract deliberately does not add a D1 query-result cache. D1 writes and account reads
need current authorization and consistency; their measurable optimization is bounded queries and
workload-backed indexes, not potentially stale shared state.
