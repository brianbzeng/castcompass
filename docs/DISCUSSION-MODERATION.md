# Discussion moderation runbook

Public trip summaries are fail-closed. Automated review stores a private candidate in
`trips.ai_review_json`; it never writes `site_discussion_posts`. A public row is readable
only when the feature switch is enabled, the post has human approval metadata, and the
linked trip is completed, consented, and approved.

Keep `PUBLIC_DISCUSSIONS_ENABLED=false` until this runbook has been exercised with a
synthetic report in production. Never roll back to a Worker version in which automated
review can write the public table.

## Safe rollout and rollback

0. Before any manual release, disable Cloudflare Git-connected automatic deployments and
   pause the current GitHub `Refresh public forecast snapshot` scheduled workflow. The
   workflow on the currently deployed default branch can push directly to that branch and
   trigger an older automatic build during this sequence. Record both disabled states and
   confirm that no build is running. Do not re-enable the scheduled workflow until the
   default branch contains the reviewed PR-only refresh workflow. Do not re-enable Cloudflare
   automatic deployment as part of this runbook; production remains on the guarded release
   path described in `CLOUDFLARE_DEPLOYMENT.md`.

   Still in the full release worktree, establish its provenance and installed tooling before
   any D1 preflight or mutation. Keep the same shell session and exported commit for the rest
   of this runbook:

   ```sh
   export RELEASE_COMMIT=FULL_RELEASE_COMMIT
   node scripts/verify-release-checkout.mjs \
     --root /ABSOLUTE/PATH/TO/FULL_RELEASE_WORKTREE \
     --expected-commit "$RELEASE_COMMIT"
   npm ci
   npm run verify:release-checkout
   ```

   Stop before touching production if either verification fails. `npm ci` establishes the
   reviewed lockfile's Wrangler; later commands invoke that local binary and cannot download a
   different CLI implicitly.

1. First deploy and verify a dedicated safety commit with the public endpoint default-off
   and the AI-to-public writer removed. Record its source commit, Cloudflare deployment ID,
   Worker version ID, and traffic percentage as the oldest permitted rollback target. For
   this release, the source commit is
   `e2c612246fadfdb231e481c405fa72e502458ed1`. It descends from the original containment
   commit `16db94b` and adds only patched build tools plus a cleared public API build override;
   `16db94b` is historical context, not a permitted deployment or rollback target. From the
   full release checkout, prove that
   the dedicated safety worktree is clean and resolves to that immutable commit before
   installing, building, or deploying it:

   ```sh
   node /ABSOLUTE/PATH/TO/FULL_RELEASE_WORKTREE/scripts/verify-release-checkout.mjs \
     --root /ABSOLUTE/PATH/TO/SAFETY_WORKTREE \
     --expected-commit e2c612246fadfdb231e481c405fa72e502458ed1
   ```

   In that verified safety worktree, deploy the Worker **without** running
   `release:cloudflare` or `deploy:cloudflare`, because both are legacy migration-first
   commands. Keep Wrangler's structured output in a private evidence directory outside the
   repository, then inspect the active deployment:

   ```sh
   npm ci
   NEXT_PUBLIC_API_URL= npm run build:cloudflare
   export WRANGLER_OUTPUT_FILE_DIRECTORY=/ABSOLUTE/PATH/TO/PRIVATE/RELEASE_EVIDENCE
   ./node_modules/.bin/wrangler deploy --config wrangler.jsonc
   ./node_modules/.bin/wrangler deployments status --config wrangler.jsonc --json
   ```

   The status must show exactly one version receiving `100%` of traffic. Copy the deployment
   ID, that version ID, and the percentage to the release record; a commit ID alone is not a
   Cloudflare rollback handle. From the full release checkout, run the live verifier against
   every hostname, including the exact `workers.dev` URL printed by Wrangler. `--base-url`
   hosts are tested directly. `--redirect-base-url` hosts are not followed: each must return
   exactly `308` and an absolute `Location` on the canonical host that preserves path and
   query.

   ```sh
   npm run verify:discussion-safety -- \
     --base-url https://castingcompass.com \
     --base-url https://WORKER_SUBDOMAIN.workers.dev \
     --canonical-base-url https://castingcompass.com \
     --redirect-base-url https://www.castingcompass.com \
     --redirect-base-url https://castcompass.brianbzeng.com \
     --redirect-base-url https://contourcast.brianbzeng.com
   ```

2. Continue with the authoritative [integrated production release](INTEGRATED-RELEASE.md).
   Production has the `0007` legal columns but not its ledger entry, and `0009` through `0015`
   are all pending. The old assumption that `0009` is the only pending migration is false.
   Do not run raw `wrangler d1 migrations apply`, and do not use `--file` for a read-only
   audit because remote D1 returns only a batch summary rather than the selected audit rows.

3. The integrated runbook records the Time Travel bookmark, verifies the exact drift,
   reconciles `0007`, applies only one reviewed migration at a time, deploys and verifies a
   maintenance bridge before the schema becomes incompatible with the older Worker, audits
   the complete final schema, and publishes the same reviewed release with maintenance off.
   Its postflight requires all discussion rows to remain without approval metadata.

4. Repeat the all-host verifier command from step 1 with
   `--expected-worker-version-id FULL_VERSION_ID`. Every direct host's health response must
   identify that version, every direct location endpoint must return an empty `posts` array
   with `Cache-Control: no-store`, and every redirect alias must return the exact canonical
   `308` response.

   Then run a real containment smoke test with photos disabled. Record the total public-row
   count, submit one unmistakably synthetic completed trip through the production product,
   wait for its automated review, and verify all of the following: the trip has private
   `ai_review_json` and `ai_reviewed_at`; no `site_discussion_posts` row exists for its trip
   ID; the total public-row count is unchanged; and every public endpoint still returns zero
   posts. Do not record the synthetic account email, session value, or raw note in release
   evidence. Delete the synthetic account through the product and confirm its active trip and
   account rows are gone. Also verify that an account on an outdated legal version receives
   `428 legal_acceptance_required` for a protected mutation and that accepting the current
   documents restores access.

5. Before `0011`, the recorded safety Worker is the rollback floor. After `0011`, keep the
   verified full-release maintenance version at `100%` and fix forward; the older Worker can
   no longer complete trips under the species-contract guards. A D1 Time Travel restore
   overwrites current data and requires a separate incident decision, a continuing write
   freeze, an impact review, and explicit authorization.

6. Enabling discussions is a separate release after a synthetic approve/read/reject smoke
   test, vendor safeguards, distinct public-summary consent, truthful reporter status and
   correction/removal controls, moderator access controls, and an incident kill-switch drill.

## Private release evidence record

Store the record outside the repository. It must include the UTC timestamp and operator; the
safety and full source commits; safety, maintenance, and final deployment IDs and Worker
version IDs; the observed `100%` traffic assignments; the exact direct and redirect host list;
live-verifier output; the D1 backend version; preflight and postflight aggregate hashes; the
pre-migration Time Travel bookmark; and every reconciliation/migration result. Do not include
raw notes, emails, session values, API tokens, or other user data. Include the
automatic-deployment pause evidence and the aggregate synthetic containment result without
its note or account identifier.

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
