# Discussion moderation runbook

Public trip summaries are fail-closed. Automated review stores a private candidate in
`trips.ai_review_json`; it never writes `site_discussion_posts`. A public row is readable
only when the feature switch is enabled, the post has human approval metadata, and the
linked trip is completed, consented, and approved.

Keep `PUBLIC_DISCUSSIONS_ENABLED=false` until this runbook has been exercised with a
synthetic report in production. Never roll back to a Worker version in which automated
review can write the public table.

## Safe rollout and rollback

1. First deploy and verify a dedicated safety commit with the public endpoint default-off
   and the AI-to-public writer removed. Record its commit and Cloudflare deployment ID as
   the oldest permitted rollback target. For this release, that source commit is `16db94b`.
   Build it in its clean worktree, then deploy the Worker **without** running the existing
   `release:cloudflare` or `deploy:cloudflare` scripts, because both apply migrations first:

   ```sh
   npm ci
   npm run build:cloudflare
   npx wrangler deploy --config wrangler.jsonc
   npx wrangler deployments list --config wrangler.jsonc
   ```

   From the full release worktree, run the live verifier against every hostname, including
   the `workers.dev` URL printed by Wrangler:

   ```sh
   npm run verify:discussion-safety -- \
     --base-url https://castingcompass.com \
     --base-url https://www.castingcompass.com \
     --base-url https://castcompass.brianbzeng.com \
     --base-url https://contourcast.brianbzeng.com \
     --base-url https://WORKER_SUBDOMAIN.workers.dev
   ```

2. Apply the additive approval migration while the feature remains off.

   ```sh
   npm run migrate:cloudflare:remote
   ```

3. Confirm every legacy row is quarantined after migration:

   ```sql
   SELECT COUNT(*) AS legacy_unapproved
   FROM site_discussion_posts
   WHERE approved_at IS NULL
      OR approved_by IS NULL
      OR source_ai_reviewed_at IS NULL;
   ```

4. Deploy the full human-gated release while the feature remains off. Verify every location
   endpoint returns an empty `posts` array.

   ```sh
   npm run build:cloudflare
   npm run deploy:cloudflare:worker-only
   npm run verify:discussion-safety -- --base-url https://castingcompass.com
   ```
5. If that release fails, redeploy the recorded safety commit. Do not select an older
   dashboard deployment, because it can restore automated publication.
6. Enabling discussions is a separate release after a synthetic approve/read/reject smoke
   test, vendor safeguards, distinct public-summary consent, truthful reporter status and
   correction/removal controls, moderator access controls, and an incident kill-switch drill.

## Human review checklist

Before approval, compare the complete trip record, raw note, AI candidate, and
`ai_reviewed_at`. Edit the candidate rather than trusting it. Reject any text containing:

- a name, handle, contact detail, address, coordinate, access code, or exact spot clue;
- information about a minor, a private person, or sensitive habitat;
- harassment, threats, illegal or unsafe instructions, or unsupported rules claims;
- copied text, fabricated details, prompt instructions, secrets, or unrelated material.

The final summary may restate only supported trip facts at the curated-site level. Use an
opaque operator label such as `operator:primary` for `approved_by`, not an email address.

## Approval procedure

1. In the authenticated Cloudflare D1 console, inspect the candidate and capture the exact
   `ai_reviewed_at`. Do not copy raw notes into tickets, chat, or source control.
2. While the trip remains `pending` and hidden, run the conditional upsert with the exact
   summary the human reviewed. A stale review timestamp must change zero rows.
3. Run the conditional trip approval last. If the AI review changes between the two steps,
   this update changes zero rows and the post remains hidden.
4. Re-read the row and verify the public endpoint before enabling the feature for users.

Replace every uppercase placeholder carefully and escape single quotes in approved text.

```sql
INSERT INTO site_discussion_posts (
  id, trip_id, site_id, summary, gear_summary, technique_tags_json,
  observed_at, created_at, updated_at, review_model,
  approved_at, approved_by, source_ai_reviewed_at
)
SELECT
  'discussion_' || lower(hex(randomblob(16))),
  id,
  site_id,
  'HUMAN_EDITED_SUMMARY',
  NULL,
  '[]',
  COALESCE(ended_at, started_at),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  ai_review_model,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'operator:primary',
  ai_reviewed_at
FROM trips
WHERE id = 'TRIP_ID'
  AND status = 'completed'
  AND consent = 1
  AND moderation_status = 'pending'
  AND ai_review_status = 'reviewed'
  AND ai_reviewed_at = 'EXPECTED_AI_REVIEWED_AT'
ON CONFLICT(trip_id) DO UPDATE SET
  site_id = excluded.site_id,
  summary = excluded.summary,
  gear_summary = excluded.gear_summary,
  technique_tags_json = excluded.technique_tags_json,
  observed_at = excluded.observed_at,
  updated_at = excluded.updated_at,
  review_model = excluded.review_model,
  approved_at = excluded.approved_at,
  approved_by = excluded.approved_by,
  source_ai_reviewed_at = excluded.source_ai_reviewed_at;
```

```sql
UPDATE trips
SET moderation_status = 'approved'
WHERE id = 'TRIP_ID'
  AND status = 'completed'
  AND consent = 1
  AND moderation_status = 'pending'
  AND ai_review_status = 'reviewed'
  AND ai_reviewed_at = 'EXPECTED_AI_REVIEWED_AT'
  AND EXISTS (
    SELECT 1
    FROM site_discussion_posts AS post
    WHERE post.trip_id = trips.id
      AND post.site_id = trips.site_id
      AND post.source_ai_reviewed_at = trips.ai_reviewed_at
      AND length(trim(post.approved_at)) > 0
      AND length(trim(post.approved_by)) > 0
  );
```

Approved reports are not owner-editable in the current beta. If a moderator returns a report
to `pending` or a new AI review is generated, the existing summary remains hidden until the
exact current draft is reviewed and approved again. To reject or withdraw a summary, set the
trip to `rejected`; then delete the public row after preserving only the minimum audit event
required by the retention policy.
