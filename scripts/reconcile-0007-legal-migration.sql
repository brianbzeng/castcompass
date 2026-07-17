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
    ('target_identification_confidence')
)
INSERT INTO d1_migrations(name)
SELECT '0007_legal_acceptance.sql'
WHERE COALESCE((
    SELECT json_group_array(name)
    FROM (SELECT name FROM d1_migrations ORDER BY id)
  ), '[]') = '["0000_unique_tusk.sql","0001_accounts_and_saved_sites.sql","0002_profile_trip_ownership.sql","0003_email_verification_and_recovery.sql","0004_advisory_trip_review.sql","0005_fishability_and_gear.sql","0006_moderated_location_discussions.sql"]'
  AND (SELECT COUNT(*) FROM expected_legal_columns) = 8
  AND (SELECT COUNT(*)
    FROM expected_legal_columns AS expected
    JOIN legal_columns AS actual
      ON actual.table_name = expected.table_name AND actual.name = expected.column_name
    WHERE actual.type = 'text' AND actual."notnull" = 0
      AND actual.dflt_value IS NULL AND actual.pk = 0
  ) = 8
  AND (SELECT COUNT(*)
    FROM pragma_table_info('site_discussion_posts')
    WHERE name IN ('approved_at', 'approved_by', 'source_ai_reviewed_at')
  ) = 0
  AND (SELECT COUNT(*) FROM sqlite_master
    WHERE type = 'table' AND name IN (SELECT name FROM later_tables)) = 0
  AND (SELECT COUNT(*) FROM pragma_table_info('trips')
    WHERE name IN (SELECT name FROM later_trip_columns)) = 0
  AND (SELECT COUNT(*) FROM sqlite_master
    WHERE type = 'trigger' AND name IN (
      'trips_completed_contract_insert_guard',
      'trips_completed_contract_update_guard'
    )) = 0
  AND (SELECT COUNT(*) FROM pragma_foreign_key_check) = 0
RETURNING name AS reconciled_migration;
