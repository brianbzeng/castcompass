SELECT
  (SELECT COUNT(*) FROM users) AS users,
  (SELECT COUNT(*) FROM users WHERE age_eligibility_confirmed_at IS NULL) AS users_missing_age_eligibility,
  (SELECT COUNT(*) FROM users
    WHERE terms_version IS NULL OR privacy_version IS NULL
      OR terms_version != '2026-07-16.2' OR privacy_version != '2026-07-16.2') AS users_needing_legal_reacceptance,
  (SELECT COUNT(*) FROM trips) AS trips,
  (SELECT COUNT(*) FROM trips WHERE photo_key IS NOT NULL) AS trip_photo_locators,
  (SELECT COUNT(*) FROM site_discussion_posts) AS discussion_rows,
  (SELECT COUNT(*) FROM saved_sites) AS saved_sites,
  (SELECT COUNT(*) FROM gear_profiles) AS gear_profiles;

SELECT
  COALESCE(SUM(CASE WHEN name = 'signup_age_proofs' THEN 1 ELSE 0 END), 0) AS age_proof_tables,
  COALESCE(SUM(CASE WHEN name = 'privacy_deletion_jobs' THEN 1 ELSE 0 END), 0) AS deletion_job_tables,
  COALESCE(SUM(CASE WHEN name = 'privacy_deletion_tasks' THEN 1 ELSE 0 END), 0) AS deletion_task_tables
FROM sqlite_master
WHERE type = 'table'
  AND name IN ('signup_age_proofs', 'privacy_deletion_jobs', 'privacy_deletion_tasks');

SELECT COUNT(*) AS foreign_key_violations
FROM pragma_foreign_key_check;
