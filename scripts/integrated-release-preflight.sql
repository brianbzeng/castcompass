WITH expected_legal_columns(table_name, column_name) AS (
  VALUES
    ('users', 'age_eligibility_confirmed_at'),
    ('users', 'terms_accepted_at'),
    ('users', 'terms_version'),
    ('users', 'privacy_accepted_at'),
    ('users', 'privacy_version'),
    ('email_challenges', 'age_eligibility_confirmed_at'),
    ('email_challenges', 'terms_version'),
    ('email_challenges', 'privacy_version')
), legal_columns AS (
  SELECT 'users' AS table_name, name, lower(type) AS type, "notnull", dflt_value, pk
  FROM pragma_table_info('users')
  UNION ALL
  SELECT 'email_challenges' AS table_name, name, lower(type) AS type, "notnull", dflt_value, pk
  FROM pragma_table_info('email_challenges')
), later_tables(name) AS (
  VALUES
    ('signup_age_proofs'),
    ('privacy_deletion_jobs'),
    ('privacy_deletion_tasks'),
    ('forecast_impressions'),
    ('trip_validation_provenance'),
    ('validation_feasibility_activations'),
    ('validation_feasibility_events'),
    ('validation_feasibility_recruitment_campaigns'),
    ('validation_feasibility_recruitment_events'),
    ('validation_feasibility_corrections'),
    ('validation_feasibility_recruitment_removals'),
    ('validation_feasibility_correction_removals'),
    ('validation_feasibility_privacy_removals'),
    ('validation_feasibility_snapshot_suppressions')
), later_trip_columns(name) AS (
  VALUES
    ('observation_contract_version'),
    ('taxon_catalog_version'),
    ('target_taxon_id'),
    ('contract_status'),
    ('taxon_observations_json'),
    ('outcome_class'),
    ('target_encounter_count'),
    ('any_fish_encounter_count'),
    ('target_identification_confidence'),
    ('idempotency_key_hash')
), later_indexes(name) AS (
  VALUES
    ('auth_sessions_expires_idx'),
    ('saved_sites_user_created_idx'),
    ('auth_attempts_attempted_idx'),
    ('email_challenges_expires_idx'),
    ('email_challenges_user_idx'),
    ('signup_age_proofs_consumed_idx'),
    ('privacy_deletion_jobs_scope_subject_idx'),
    ('privacy_deletion_jobs_state_completed_idx'),
    ('trips_user_history_idx'),
    ('trips_user_created_idx'),
    ('trips_ai_review_backlog_idx'),
    ('trips_reporter_active_created_idx'),
    ('trip_validation_provenance_forecast_trip_idx'),
    ('validation_feasibility_recruitment_user_sequence_idx'),
    ('validation_feasibility_correction_activation_sequence_idx')
)
SELECT
  COALESCE((
    SELECT json_group_array(name)
    FROM (SELECT name FROM d1_migrations ORDER BY id)
  ), '[]') AS applied_migrations_json,
  (SELECT COUNT(*) FROM expected_legal_columns) AS legal_columns_expected,
  (SELECT COUNT(*)
    FROM expected_legal_columns AS expected
    JOIN legal_columns AS actual
      ON actual.table_name = expected.table_name AND actual.name = expected.column_name
  ) AS legal_columns_present,
  (SELECT COUNT(*)
    FROM expected_legal_columns AS expected
    JOIN legal_columns AS actual
      ON actual.table_name = expected.table_name AND actual.name = expected.column_name
    WHERE actual.type = 'text' AND actual."notnull" = 0
      AND actual.dflt_value IS NULL AND actual.pk = 0
  ) AS legal_columns_exact,
  (SELECT COUNT(*)
    FROM pragma_table_info('site_discussion_posts')
    WHERE name IN ('approved_at', 'approved_by', 'source_ai_reviewed_at')
  ) AS approval_columns_found,
  (SELECT COUNT(*)
    FROM sqlite_master
    WHERE type = 'table' AND name IN (SELECT name FROM later_tables)
  ) AS later_tables_found,
  (SELECT COUNT(*)
    FROM pragma_table_info('trips')
    WHERE name IN (SELECT name FROM later_trip_columns)
  ) AS later_trip_columns_found,
  (SELECT COUNT(*)
    FROM sqlite_master
    WHERE type = 'index' AND name IN (SELECT name FROM later_indexes)
  ) AS later_indexes_found,
  (SELECT COUNT(*)
    FROM sqlite_master
    WHERE type = 'trigger' AND name IN (
      'trips_completed_contract_insert_guard',
      'trips_completed_contract_update_guard'
    )
  ) AS later_triggers_found,
  (SELECT COUNT(*) FROM users) AS users,
  (SELECT COUNT(*) FROM users WHERE age_eligibility_confirmed_at IS NULL) AS users_missing_age_eligibility,
  (SELECT COUNT(*) FROM users
    WHERE terms_accepted_at IS NULL OR terms_version IS NULL
      OR privacy_accepted_at IS NULL OR privacy_version IS NULL
  ) AS users_missing_legal_acceptance,
  (SELECT COUNT(*) FROM trips) AS trips,
  (SELECT COUNT(*) FROM site_discussion_posts) AS discussion_rows,
  (SELECT COUNT(*) FROM trips WHERE photo_key IS NOT NULL) AS trip_photo_locators,
  (SELECT COUNT(*) FROM pragma_foreign_key_check) AS foreign_key_violations;
