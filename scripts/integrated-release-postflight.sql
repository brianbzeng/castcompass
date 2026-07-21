WITH expected_species_columns(name) AS (
  VALUES
    ('observation_contract_version'),
    ('taxon_catalog_version'),
    ('target_taxon_id'),
    ('contract_status'),
    ('taxon_observations_json'),
    ('outcome_class'),
    ('target_encounter_count'),
    ('any_fish_encounter_count'),
    ('target_identification_confidence')
), expected_validation_tables(name) AS (
  VALUES
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
)
SELECT
  COALESCE((
    SELECT json_group_array(name)
    FROM (SELECT name FROM d1_migrations ORDER BY id)
  ), '[]') AS applied_migrations_json,
  (SELECT COUNT(*) FROM pragma_table_info('site_discussion_posts')
    WHERE name IN ('approved_at', 'approved_by', 'source_ai_reviewed_at')
      AND lower(type) = 'text' AND "notnull" = 0
  ) AS exact_approval_columns,
  (SELECT COUNT(*) FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'signup_age_proofs', 'privacy_deletion_jobs', 'privacy_deletion_tasks',
      'privacy_export_jobs'
    )
  ) AS privacy_tables,
  (SELECT COUNT(*) FROM pragma_table_info('privacy_deletion_tasks')
    WHERE name = 'object_store' AND lower(type) = 'text' AND "notnull" = 1
      AND dflt_value = '''trip_photos'''
  ) AS privacy_deletion_store_columns,
  (SELECT COUNT(*) FROM pragma_table_info('trips')
    WHERE name IN (SELECT name FROM expected_species_columns)
  ) AS species_columns,
  (SELECT COUNT(*) FROM sqlite_master
    WHERE type = 'trigger' AND name IN (
      'trips_completed_contract_insert_guard',
      'trips_completed_contract_update_guard'
    )
  ) AS species_completion_triggers,
  (SELECT COUNT(*) FROM sqlite_master
    WHERE type = 'table' AND name IN (SELECT name FROM expected_validation_tables)
  ) AS validation_tables,
  (SELECT COUNT(*) FROM pragma_table_info('validation_feasibility_events')
    WHERE name = 'snapshot_suppression_sha256'
  ) + (SELECT COUNT(*) FROM pragma_table_info('validation_feasibility_recruitment_events')
    WHERE name = 'snapshot_suppression_sha256'
  ) AS snapshot_suppression_columns,
  (SELECT COUNT(*) FROM sqlite_master
    WHERE type = 'index' AND name IN (
      'auth_sessions_expires_idx',
      'saved_sites_user_created_idx',
      'auth_attempts_attempted_idx',
      'email_challenges_expires_idx',
      'email_challenges_user_idx',
      'signup_age_proofs_consumed_idx',
      'privacy_deletion_jobs_scope_subject_idx',
      'privacy_deletion_jobs_state_completed_idx',
      'trips_user_history_idx',
      'trips_user_created_idx',
      'trips_ai_review_backlog_idx',
      'trips_reporter_active_created_idx',
      'trip_validation_provenance_forecast_trip_idx',
      'validation_feasibility_recruitment_user_sequence_idx',
      'validation_feasibility_correction_activation_sequence_idx'
    )
  ) AS data_resilience_indexes,
  (
    SELECT COUNT(*) FROM pragma_table_info('trips')
    WHERE name = 'idempotency_key_hash'
      AND lower(type) = 'text' AND "notnull" = 0
      AND dflt_value IS NULL AND pk = 0
  ) AS exact_trip_idempotency_columns,
  (SELECT COUNT(*) FROM sqlite_master
    WHERE type = 'table' AND name = 'ai_review_jobs'
  ) AS ai_review_queue_tables,
  (SELECT COUNT(*) FROM sqlite_master
    WHERE type = 'index' AND name IN (
      'ai_review_jobs_trip_unique', 'ai_review_jobs_dispatch_idx'
    )
  ) AS ai_review_queue_indexes,
  (SELECT COUNT(*) FROM ai_review_jobs) AS ai_review_queue_rows,
  (SELECT COUNT(*) FROM sqlite_master
    WHERE type = 'table' AND name = 'privacy_export_jobs'
  ) AS privacy_export_queue_tables,
  (SELECT COUNT(*) FROM sqlite_master
    WHERE type = 'index' AND name IN (
      'privacy_export_jobs_active_user_unique',
      'privacy_export_jobs_object_key_unique',
      'privacy_export_jobs_dispatch_idx',
      'privacy_export_jobs_expiry_idx',
      'privacy_export_jobs_owner_idx'
    )
  ) AS privacy_export_queue_indexes,
  (SELECT COUNT(*) FROM privacy_export_jobs) AS privacy_export_queue_rows,
  (SELECT COUNT(*) FROM users) AS users,
  (SELECT COUNT(*) FROM users WHERE age_eligibility_confirmed_at IS NULL) AS users_missing_age_eligibility,
  (SELECT COUNT(*) FROM users
    WHERE terms_accepted_at IS NULL OR terms_version IS NULL
      OR privacy_accepted_at IS NULL OR privacy_version IS NULL
  ) AS users_missing_legal_acceptance,
  (SELECT COUNT(*) FROM trips) AS trips,
  (SELECT COUNT(*) FROM trips WHERE contract_status != 'legacy_unverified' OR contract_status IS NULL)
    AS non_legacy_trip_rows,
  (SELECT COUNT(*) FROM trips WHERE photo_key IS NOT NULL) AS trip_photo_locators,
  (SELECT COUNT(*) FROM site_discussion_posts) AS discussion_rows,
  (SELECT COUNT(*) FROM site_discussion_posts
    WHERE approved_at IS NOT NULL OR approved_by IS NOT NULL OR source_ai_reviewed_at IS NOT NULL
  ) AS discussion_rows_with_approval_metadata,
  (SELECT COUNT(*) FROM validation_feasibility_activations) AS validation_activation_rows,
  (SELECT COUNT(*) FROM validation_feasibility_events) AS validation_event_rows,
  (SELECT COUNT(*) FROM validation_feasibility_recruitment_events) AS validation_recruitment_rows,
  (SELECT COUNT(*) FROM pragma_foreign_key_check) AS foreign_key_violations;
