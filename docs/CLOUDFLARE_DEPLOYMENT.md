# Cloudflare deployment

ContourCast deploys as a Cloudflare Worker at
`https://contourcast.brianbzeng.com`, with the normal `workers.dev` address
left enabled as a fallback.

## Resources

- Worker: `contourcast-halibut`
- D1 binding: `DB`
- D1 database: `contourcast-trips`
- Custom domain: `contourcast.brianbzeng.com`

The Cloudflare build deliberately sets `NEXT_PUBLIC_PHOTO_UPLOADS=false`.
Structured trip reports, catches, and skunks are stored in D1, but the optional
photo field stays hidden until R2 and Cloudflare Images are enabled on the
account. This prevents users from seeing an upload control that cannot succeed.

## Local release

Authenticate Wrangler once, then run:

```bash
npm install
npm run release:cloudflare
```

The release script builds the Worker, applies any unapplied D1 migrations, and
publishes both the `workers.dev` deployment and the custom domain.

## Cloudflare Git build settings

If the repository is connected under Workers & Pages → Builds, use:

- Build command: `npm run build:cloudflare`
- Deploy command: `npm run deploy:cloudflare`
- Root directory: `/`
- Node.js: `22.16` or newer

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
