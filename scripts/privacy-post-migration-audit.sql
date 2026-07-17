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
  (SELECT COUNT(*) FROM pragma_table_info('signup_age_proofs')) AS age_proof_columns,
  (SELECT COUNT(*) FROM pragma_table_info('privacy_deletion_jobs')) AS deletion_job_columns,
  (SELECT COUNT(*) FROM pragma_table_info('privacy_deletion_tasks')) AS deletion_task_columns,
  (SELECT COUNT(*) FROM sqlite_master
    WHERE type = 'index' AND name = 'privacy_deletion_jobs_owner_state_idx') AS owner_lookup_indexes,
  (SELECT COUNT(*) FROM pragma_foreign_key_list('trips')
    WHERE "table" = 'users' AND "from" = 'user_id' AND upper(on_delete) = 'SET NULL') AS trip_user_ownership_foreign_keys;

SELECT
  (SELECT COUNT(*) FROM signup_age_proofs) AS age_proof_rows,
  (SELECT COUNT(*) FROM privacy_deletion_jobs) AS deletion_job_rows,
  (SELECT COUNT(*) FROM privacy_deletion_tasks) AS deletion_task_rows;

SELECT COUNT(*) AS forbidden_age_identity_columns
FROM pragma_table_info('signup_age_proofs')
WHERE lower(name) IN ('birth_date', 'birthdate', 'date_of_birth', 'dob', 'email', 'password', 'password_hash');

SELECT COUNT(*) AS foreign_key_violations
FROM pragma_foreign_key_check;

SELECT integrity_check
FROM pragma_integrity_check;
