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

The Cloudflare build deliberately sets `NEXT_PUBLIC_PHOTO_UPLOADS=false`, the Worker
configuration sets `TRIP_PHOTO_UPLOADS_ENABLED=false`, and the build clears
`NEXT_PUBLIC_API_URL` instead of trusting inherited shell or dashboard values.
Structured trip reports, catches, and skunks are stored in D1, but the optional
photo field stays hidden until R2 and Cloudflare Images are enabled on the
account. This prevents users from seeing an upload control that cannot succeed.

## Production release rule

Production Worker deployments and production schema changes are separate operations. A
production deploy command must not run migrations automatically. In the current release,
`release:cloudflare`, `deploy:cloudflare`, and `deploy:cloudflare:worker-only` are all
Worker-only and all rebuild with the production environment before publishing.
`migrate:cloudflare:remote` is a separately reviewed, one-file schema operation; the guarded
wrapper also requires the same verified `RELEASE_COMMIT`, an exact migration filename, the
exact primary ledger prefix, and confirmation that a Time Travel bookmark was stored before
it can mutate D1. Never invoke raw `wrangler d1 migrations apply` against production.

For a Worker-only release, authenticate Wrangler and provide the exact reviewed commit in
`RELEASE_COMMIT`. The release and deploy entry points fail before publishing unless the
checkout is at that commit, the worktree is clean, and no ignored `.env*`/`.dev.vars*`
override exists:

Use the exact Node version in `.node-version`; do not let a local or Cloudflare default select
a different major or older patch. The immutable release checks include the dependency audits
and lock-bound CycloneDX SBOM documented in
[Software supply-chain policy](SECURITY-SUPPLY-CHAIN.md). A successful repository build is not
proof that Cloudflare used the intended runtime, so record the production build runtime and
deployment identity separately.

```bash
export RELEASE_COMMIT=REVIEWED_COMMIT
npm ci
npm run release:cloudflare
./node_modules/.bin/wrangler deployments status --config wrangler.jsonc --json
```

Record the Cloudflare deployment ID and Worker version ID, and confirm that exactly one
version receives `100%` of traffic. Keep release evidence outside the repository.

For a release with a D1 change, use a change-specific sequence that deploys a
backward-compatible safety Worker first, records a D1 Time Travel bookmark, inspects the
complete remote pending-migration set, applies only the reviewed migration, audits the live
schema and data invariants, and then deploys the final Worker. Never assume that the remote
migration ledger matches the files in the checkout. The current multi-migration release uses
the authoritative [integrated production release](INTEGRATED-RELEASE.md), including its
maintenance bridge; the human-approval smoke tests remain in
[Discussion moderation](DISCUSSION-MODERATION.md).

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

## Worker rate-limit binding activation

The six checked-in Workers Rate Limiting bindings are inert while
`RATE_LIMITING_ENABLED=false`. Keep that default for the first deployment. The bindings cover
auth, email-producing flows, general writes, sensitive export/deletion/retry operations,
reads, and application-wide AI-provider dispatch. The policy and reviewed thresholds are in
[Production operations](PRODUCTION-OPERATIONS.md#abuse-controls).

Before a later reviewed activation, store a dedicated random value of at least 32 characters
as the Worker secret `RATE_LIMIT_KEY_SECRET`; never add it to `wrangler.jsonc`, a local env
file, a screenshot, logs, or release evidence. Confirm all six bindings on the exact deployed
version and exercise the synthetic 429 and fail-closed 503 cases before changing the switch.
Activation requires a separate immutable config commit containing the exact string
`RATE_LIMITING_ENABLED=true`. A missing secret, missing binding, malformed switch, missing
Cloudflare client address, or binding failure intentionally blocks protected API routes while
health remains available. Emergency disablement is the guarded release of
`RATE_LIMITING_ENABLED=false`; the D1 email/login/trip ceilings continue to operate.

The Worker binding is per Cloudflare location and eventually consistent, not a precise global
quota. Configure and verify complementary outer WAF rate limits before promotion, and monitor
Worker response classes and provider use. Do not claim live protection from the checked-in
bindings alone; attach the production evidence required by
[Production operations](PRODUCTION-OPERATIONS.md#production-evidence-checklist).

## Enabling verification photos later

Photo uploads are blocked by the Worker even if a client submits a multipart `photo` and both
storage bindings exist. Keep that fail-closed gate in place until all of these release blockers
are complete:

1. Implement and test a database deletion fence or equivalent stable-inventory protocol so a
   photo write cannot commit after account deletion inventories object locators. The current
   pre-inventory flow is safe only because uploads are disabled.
2. Bound each cleanup invocation below the deployed Cloudflare plan's D1-query and subrequest
   budgets, or capture reviewed evidence that the selected plan safely covers the worst case.
3. Enable R2 and Cloudflare Images in the Cloudflare dashboard and create a private bucket such
   as `contourcast-trip-photos`.
4. Add the private bucket to `wrangler.jsonc` with binding `TRIP_PHOTOS`, add the Cloudflare
   Images binding expected by `worker/index.ts`, and verify the exact bucket identity.
5. Pass the object-inventory, retry-alerting, export, deletion, orphan-upload cleanup, and R2
   restore/deletion drills in [Privacy durability](PRIVACY-DURABILITY.md).
6. In one reviewed release, set `TRIP_PHOTO_UPLOADS_ENABLED=true` and change
   `build:cloudflare` to set `NEXT_PUBLIC_PHOTO_UPLOADS=true`; rebuild, test, and deploy.

Raw notes and photos have no public read endpoint. Trip summaries expose totals
only, and new reports remain pending review.

## Turnstile account protection

Turnstile is implemented for the seven public account-abuse flows: age-proof
creation, signup-code request and verification, code resend, password-reset
request and completion, and login. It is deliberately **off by default** through
`TURNSTILE_ENABLED=false`. Account deletion and privacy export/status routes do
not themselves depend on Turnstile. An authenticated user can still reach those
routes during a provider outage; a signed-out user may need the operator to use
the kill switch before they can authenticate and exercise account rights.

The browser reads the public site key at runtime from
`GET /api/auth/turnstile-config`; no `NEXT_PUBLIC_*` build input is used. That
endpoint never returns the secret or hostname allowlist. The Worker alone sends
the challenge token, secret, and a random idempotency key to Cloudflare
Siteverify. It does not send `remoteip`, email, birth date, password, account ID,
user agent, or custom data. Successful responses must carry the exact expected
action and one exact lowercase hostname from `TURNSTILE_ALLOWED_HOSTNAMES`.
Enabled but incomplete configuration, provider errors, timeouts, malformed
responses, reused tokens, wrong actions, and wrong hostnames all fail closed.
The browser shares only an in-flight runtime-config request, then discards it so
an already-open tab or PWA can observe enablement, emergency disablement, and key
rotation on the next challenge reset. Provider auto-retry and the direct-to-
Cloudflare feedback form are disabled; a visible retry is initiated by the user.

Activation is a separate, reviewed production operation:

1. Deploy and verify the updated client and Worker while the checked-in kill
   switch remains `false`. Confirm both a fresh browser and installed PWA can
   load the new account UI; never enable enforcement while an older cached
   client is still the expected path.
2. Create a **Managed** Turnstile widget in Cloudflare and restrict its hostname
   management to the exact production hosts that will display it. Use separate
   widgets and keys for non-production environments.
3. Store `TURNSTILE_SECRET_KEY` only as a Cloudflare Worker secret. Do not place
   it in Wrangler vars, `.env` files committed to Git, logs, screenshots, or
   release evidence.
4. In a reviewed config change, set the public `TURNSTILE_SITE_KEY`, a
   comma-separated exact lowercase `TURNSTILE_ALLOWED_HOSTNAMES`, and finally
   `TURNSTILE_ENABLED=true`. A non-boolean switch value is treated as a broken
   enabled configuration and blocks protected actions.
5. Exercise every protected action, token expiry/reuse, action/hostname
   rejection, provider failure, accessibility, and 320/360px layouts before
   promotion. Keep the separate edge rate limits in
   [Production operations](PRODUCTION-OPERATIONS.md); Turnstile does not replace
   them.

Emergency rollback is the reviewed runtime change
`TURNSTILE_ENABLED=false`. Turning it off bypasses Siteverify immediately while
leaving the durable per-email/code/login ceilings in place. Follow the normal
immutable-release procedure above; do not expose or rotate the secret through
the public config endpoint. Server-side validation behavior follows Cloudflare's
[current Siteverify requirements](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/),
including five-minute, single-use tokens.

The current Privacy Policy already names Cloudflare security processing and the
IP/device/browser security-data category; the Turnstile sentence is a narrower
clarification of that existing provider and purpose, and this default-off code
change does not increment `LEGAL_VERSION`. Before production enablement, the
operator must re-check the actual dashboard/widget configuration and provider
terms against that disclosure. If enablement adds a provider, data category,
purpose, retention practice, or other material privacy change, update the legal
documents, increment `LEGAL_VERSION`, and collect renewed acceptance first.
