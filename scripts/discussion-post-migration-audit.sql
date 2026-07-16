SELECT
  COUNT(*) AS approval_columns_found,
  COALESCE(SUM(CASE WHEN lower(type) = 'text' AND "notnull" = 0 THEN 1 ELSE 0 END), 0)
    AS nullable_text_approval_columns
FROM pragma_table_info('site_discussion_posts')
WHERE name IN ('approved_at', 'approved_by', 'source_ai_reviewed_at');

SELECT
  COUNT(*) AS total_discussion_rows,
  COALESCE(SUM(CASE
    WHEN approved_at IS NULL
     AND approved_by IS NULL
     AND source_ai_reviewed_at IS NULL
    THEN 1 ELSE 0 END), 0) AS fully_quarantined_rows,
  COALESCE(SUM(CASE
    WHEN approved_at IS NOT NULL
      OR approved_by IS NOT NULL
      OR source_ai_reviewed_at IS NOT NULL
    THEN 1 ELSE 0 END), 0) AS rows_with_any_approval_metadata,
  COALESCE(SUM(CASE
    WHEN (approved_at IS NOT NULL) +
         (approved_by IS NOT NULL) +
         (source_ai_reviewed_at IS NOT NULL) BETWEEN 1 AND 2
    THEN 1 ELSE 0 END), 0) AS partially_populated_approval_rows
FROM site_discussion_posts;

SELECT COUNT(*) AS publicly_eligible_rows
FROM site_discussion_posts AS post
JOIN trips AS trip ON trip.id = post.trip_id
WHERE post.site_id = trip.site_id
  AND post.source_ai_reviewed_at = trip.ai_reviewed_at
  AND length(trim(post.approved_at)) > 0
  AND length(trim(post.approved_by)) > 0
  AND trip.status = 'completed'
  AND trip.consent = 1
  AND trip.moderation_status = 'approved'
  AND trip.ai_review_status = 'reviewed';
