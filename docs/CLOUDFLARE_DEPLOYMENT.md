# Cloudflare deployment

CastingCompass deploys as a Cloudflare Worker at
`https://castingcompass.com`. The earlier `castcompass.brianbzeng.com`,
`contourcast.brianbzeng.com`, and normal `workers.dev` addresses remain
available as migration fallbacks; the two brianbzeng.com hostnames redirect to
the canonical standalone domain.

## Resources

- Worker: `contourcast-halibut`
- D1 binding: `DB`
- D1 database: `contourcast-trips`
- Primary custom domain: `castingcompass.com`
- Canonical www redirect: `www.castingcompass.com`
- Legacy redirects: `castcompass.brianbzeng.com`, `contourcast.brianbzeng.com`

The Cloudflare build deliberately sets `NEXT_PUBLIC_PHOTO_UPLOADS=false` and clears
`NEXT_PUBLIC_API_URL` instead of trusting inherited shell or dashboard values.
Structured trip reports, catches, and skunks are stored in D1, but the optional
photo field stays hidden until R2 and Cloudflare Images are enabled on the
account. This prevents users from seeing an upload control that cannot succeed.

## Production release rule

Production Worker deployments and production schema changes are separate operations. A
production deploy command must not run migrations automatically. In the current release,
`release:cloudflare`, `deploy:cloudflare`, and `deploy:cloudflare:worker-only` are all
Worker-only and all rebuild with the production environment before publishing.
`migrate:cloudflare:remote` is the separately reviewed schema operation; it also requires the
same verified `RELEASE_COMMIT` before it can mutate D1.

For a Worker-only release, authenticate Wrangler and provide the exact reviewed commit in
`RELEASE_COMMIT`. The release and deploy entry points fail before publishing unless the
checkout is at that commit, the worktree is clean, and no ignored `.env*`/`.dev.vars*`
override exists:

```bash
export RELEASE_COMMIT=REVIEWED_COMMIT
npm ci
npm run release:cloudflare
./node_modules/.bin/wrangler deployments status --config wrangler.jsonc --json
```

Record the Cloudflare deployment ID and Worker version ID, and confirm that exactly one
version receives `100%` of traffic. Keep release evidence outside the repository.

For a release with a D1 change, write a change-specific sequence that deploys a
backward-compatible safety Worker first, records a D1 Time Travel bookmark, inspects the
complete remote pending-migration set, applies only the reviewed migration, audits the live
schema and data invariants, and then deploys the final Worker. Never assume that the remote
migration ledger matches the files in the checkout. The human-gated discussion release uses
the stricter sequence in [Discussion moderation](DISCUSSION-MODERATION.md).

Repository checks do not prove dashboard controls or recovery readiness. Complete the
[production operations gate](PRODUCTION-OPERATIONS.md) before marking hardening finished.

## Cloudflare Git integration

Keep Cloudflare Git-connected automatic deployments disabled for this release. A dashboard
build can publish whatever commit the integration selects and cannot establish that an
operator reviewed the supplied `RELEASE_COMMIT`. GitHub CI may build and test changes, but
production publication follows the guarded manual release above.

If a future protected release workflow replaces the manual path, it must pass an explicitly
approved immutable commit to the same checkout verifier and must keep D1 migration approval
separate. Do not configure a Git deploy command that derives `RELEASE_COMMIT` from the checkout
being deployed; that would turn the provenance check into a tautology.

## Snapshot publication while automatic deploys are off

The scheduled GitHub workflow generates the 72-hour snapshot on a fixed automation branch and
opens or updates a pull request; it does not publish production. During the public beta,
`operator:primary` owns review and a guarded manual Worker release. The target is one reviewed
snapshot every three hours and the maximum unattended interval is six hours, matching the
shortest active NWS/NDBC freshness limit.

If that cadence is missed, do not bypass review or re-enable an unguarded Git deploy. The client
recomputes source age when it loads: sources beyond their declared limit change from `fresh` to
`stale`, and the overall badge changes to `Cached` if any required time-sensitive input at or
below the six-hour operations limit is no longer fresh. Long-lived tide or seasonal data cannot
keep the badge `Live`. Expired windows drop out of rankings. Pause promotion until a
generated-data PR passes its data-contract tests
and a reviewed commit is released through the guarded path. A future protected snapshot release
workflow must preserve these stale-data behaviors and attach its deployment/version evidence.

Wrangler reads the Worker name, D1 database, assets directory, and custom domain
from `wrangler.jsonc`. Do not copy the generated `dist/server/wrangler.json` into
the dashboard; it contains local Sites placeholders rather than the production
D1 database ID.

## Enabling verification photos later

1. Enable R2 and Cloudflare Images in the Cloudflare dashboard.
2. Create a private bucket such as `contourcast-trip-photos`.
3. Add it to `wrangler.jsonc` with binding `TRIP_PHOTOS`.
4. Add the Cloudflare Images binding expected by `worker/index.ts`.
5. Change `build:cloudflare` to set `NEXT_PUBLIC_PHOTO_UPLOADS=true`.
6. Rebuild and deploy.

Raw notes and photos have no public read endpoint. Trip summaries expose totals
only, and new reports remain pending review.
