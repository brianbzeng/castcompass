CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.sites (
    id text PRIMARY KEY,
    name text NOT NULL,
    region text NOT NULL,
    locality text,
    location geography(Point, 4326) NOT NULL,
    fishing_modes text[] NOT NULL DEFAULT ARRAY['shore']::text[],
    access_type text NOT NULL DEFAULT 'public',
    is_accessible boolean NOT NULL DEFAULT true,
    structure_tags text[] NOT NULL DEFAULT ARRAY[]::text[],
    regulation_url text NOT NULL,
    description text,
    access_notes text NOT NULL,
    parking_notes text,
    transit_notes text,
    amenities text[] NOT NULL DEFAULT ARRAY[]::text[],
    bathymetry_summary text,
    casting_zone jsonb,
    casting_zone_geom geography(Polygon, 4326),
    official_links jsonb NOT NULL DEFAULT '[]'::jsonb,
    source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT sites_fishing_modes_valid CHECK (
        fishing_modes <@ ARRAY['shore', 'beach', 'jetty', 'pier']::text[]
    )
);

CREATE INDEX IF NOT EXISTS sites_location_gix ON public.sites USING gist (location);
CREATE INDEX IF NOT EXISTS sites_casting_zone_gix ON public.sites USING gist (casting_zone_geom);
CREATE INDEX IF NOT EXISTS sites_accessible_idx ON public.sites (is_accessible, region);

CREATE TABLE IF NOT EXISTS public.model_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    model_version text NOT NULL UNIQUE,
    target_scope_kind text NOT NULL,
    target_taxon_id text,
    taxon_catalog_version text NOT NULL,
    observation_contract_version text,
    model_run_contract_version text NOT NULL,
    git_sha text,
    artifact_uri text,
    dataset_version text NOT NULL,
    metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'candidate',
    trained_at timestamptz,
    promoted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT model_runs_status_valid CHECK (status IN ('candidate', 'production', 'retired', 'failed')),
    CONSTRAINT model_runs_target_scope_kind_valid CHECK (
        target_scope_kind IN ('taxon', 'target-agnostic')
    ),
    CONSTRAINT model_runs_target_scope_valid CHECK (
        (
            target_scope_kind = 'target-agnostic'
            AND target_taxon_id IS NULL
            AND observation_contract_version IS NULL
        ) OR (
            target_scope_kind = 'taxon'
            AND target_taxon_id = 'california-halibut'
            AND observation_contract_version = 'castingcompass.observation/2.0.0'
        )
    ),
    CONSTRAINT model_runs_version_scope_valid CHECK (
        (
            target_scope_kind = 'target-agnostic'
            AND model_version ~ '^model-target-agnostic-[a-f0-9]{64}$'
        ) OR (
            target_scope_kind = 'taxon'
            AND model_version ~ '^model-california-halibut-[a-f0-9]{64}$'
        )
    ),
    CONSTRAINT model_runs_taxon_contract_valid CHECK (
        taxon_catalog_version = 'castingcompass.taxa/1.0.0'
    ),
    CONSTRAINT model_runs_contract_valid CHECK (
        model_run_contract_version = 'castingcompass.model-run/2.0.0'
    ),
    CONSTRAINT model_runs_id_target_version_unique UNIQUE (
        id,
        target_taxon_id,
        model_version
    )
);

CREATE TABLE IF NOT EXISTS public.opportunity_windows (
    id text PRIMARY KEY,
    species text NOT NULL,
    target_taxon_id text NOT NULL,
    taxon_catalog_version text NOT NULL,
    observation_contract_version text NOT NULL,
    model_run_contract_version text NOT NULL,
    opportunity_contract_version text NOT NULL,
    site_id text NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
    start_time timestamptz NOT NULL,
    end_time timestamptz NOT NULL,
    opportunity_score double precision NOT NULL,
    components jsonb NOT NULL,
    confidence jsonb NOT NULL,
    conditions jsonb,
    explanation_factors jsonb NOT NULL DEFAULT '[]'::jsonb,
    scoring_system_kind text NOT NULL,
    scoring_system_version text NOT NULL,
    scoring_system_sha256 text NOT NULL,
    model_run_id uuid,
    model_version text NOT NULL,
    generated_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT opportunity_window_time_valid CHECK (end_time > start_time),
    CONSTRAINT opportunity_score_valid CHECK (opportunity_score BETWEEN 0 AND 100),
    CONSTRAINT opportunity_species_valid CHECK (
        species = 'california-halibut' AND target_taxon_id = species
    ),
    CONSTRAINT opportunity_taxon_contract_valid CHECK (
        taxon_catalog_version = 'castingcompass.taxa/1.0.0'
    ),
    CONSTRAINT opportunity_observation_contract_valid CHECK (
        observation_contract_version = 'castingcompass.observation/2.0.0'
    ),
    CONSTRAINT opportunity_model_run_contract_valid CHECK (
        model_run_contract_version = 'castingcompass.model-run/2.0.0'
    ),
    CONSTRAINT opportunity_contract_valid CHECK (
        opportunity_contract_version = 'castingcompass.opportunity/2.0.0'
    ),
    CONSTRAINT opportunity_scoring_system_kind_valid CHECK (
        scoring_system_kind IN ('heuristic-configuration', 'trained-model')
    ),
    CONSTRAINT opportunity_scoring_system_reference_valid CHECK (
        (scoring_system_kind = 'heuristic-configuration' AND model_run_id IS NULL)
        OR (scoring_system_kind = 'trained-model' AND model_run_id IS NOT NULL)
    ),
    CONSTRAINT opportunity_scoring_system_version_match CHECK (
        scoring_system_version = model_version
    ),
    CONSTRAINT opportunity_scoring_system_sha256_valid CHECK (
        scoring_system_sha256 ~ '^[a-f0-9]{64}$'
    ),
    CONSTRAINT opportunity_heuristic_identity_valid CHECK (
        scoring_system_kind <> 'heuristic-configuration'
        OR scoring_system_version = (
            'heuristic-' || target_taxon_id || '-' || scoring_system_sha256
        )
    ),
    CONSTRAINT opportunity_model_run_target_fk
        FOREIGN KEY (model_run_id, target_taxon_id, model_version)
        REFERENCES public.model_runs(id, target_taxon_id, model_version),
    CONSTRAINT opportunity_window_model_unique UNIQUE (site_id, start_time, end_time, model_version)
);

CREATE INDEX IF NOT EXISTS opportunity_window_lookup_idx
    ON public.opportunity_windows (species, start_time, end_time, opportunity_score DESC);
CREATE INDEX IF NOT EXISTS opportunity_window_site_idx
    ON public.opportunity_windows (site_id, start_time DESC);

CREATE TABLE IF NOT EXISTS public.source_freshness (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    opportunity_window_id text NOT NULL REFERENCES public.opportunity_windows(id) ON DELETE CASCADE,
    source text NOT NULL,
    observed_at timestamptz,
    checked_at timestamptz NOT NULL,
    freshness_limit_minutes integer NOT NULL,
    status text NOT NULL,
    used_in_score boolean NOT NULL DEFAULT false,
    excluded_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT freshness_limit_positive CHECK (freshness_limit_minutes > 0),
    CONSTRAINT freshness_status_valid CHECK (status IN ('fresh', 'stale', 'missing', 'excluded')),
    CONSTRAINT stale_source_not_used CHECK (status = 'fresh' OR used_in_score = false),
    CONSTRAINT source_per_window_unique UNIQUE (opportunity_window_id, source)
);

CREATE INDEX IF NOT EXISTS source_freshness_status_idx
    ON public.source_freshness (status, checked_at DESC);

CREATE TABLE IF NOT EXISTS public.ingestion_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source text NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    status text NOT NULL DEFAULT 'running',
    records_read integer NOT NULL DEFAULT 0,
    records_written integer NOT NULL DEFAULT 0,
    source_observed_at timestamptz,
    error_message text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT ingestion_status_valid CHECK (status IN ('running', 'succeeded', 'failed', 'skipped'))
);

CREATE INDEX IF NOT EXISTS ingestion_runs_source_idx
    ON public.ingestion_runs (source, started_at DESC);

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sites_set_updated_at ON public.sites;
CREATE TRIGGER sites_set_updated_at
BEFORE UPDATE ON public.sites
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.opportunity_windows IS
    'Relative rankings among evaluated site/time candidates. Scores are not catch probabilities.';
COMMENT ON COLUMN public.sites.location IS
    'Public access/casting-site location only. CastingCompass bathymetry is not navigational data.';
