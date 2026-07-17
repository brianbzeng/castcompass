/**
 * Cross-runtime identity and fail-closed validators for CastingCompass species
 * data. The JSON assets under `contracts/` are the language-neutral source of
 * truth; focused tests prevent this TypeScript view from drifting from them.
 */

export const TAXON_CATALOG_VERSION = "castingcompass.taxa/1.0.0" as const;
export const OBSERVATION_CONTRACT_VERSION = "castingcompass.observation/2.0.0" as const;
export const MODEL_RUN_CONTRACT_VERSION = "castingcompass.model-run/2.0.0" as const;
export const OPPORTUNITY_CONTRACT_VERSION = "castingcompass.opportunity/2.0.0" as const;

export const CONTRACT_VERSIONS = Object.freeze({
  taxa: TAXON_CATALOG_VERSION,
  observation: OBSERVATION_CONTRACT_VERSION,
  modelRun: MODEL_RUN_CONTRACT_VERSION,
  opportunity: OPPORTUNITY_CONTRACT_VERSION,
});

export const CALIFORNIA_HALIBUT_TAXON_ID = "california-halibut" as const;
export const PRODUCTION_TARGET_TAXON_ID = CALIFORNIA_HALIBUT_TAXON_ID;
export const UNRESOLVED_FISH_TAXON_ID = "unresolved-fish" as const;
export const UNRESOLVED_TAXON_ID = UNRESOLVED_FISH_TAXON_ID;
export const SYNTHETIC_TARGET_TAXON_ID = "synthetic-target" as const;

export const TAXON_IDS = Object.freeze({
  californiaHalibut: CALIFORNIA_HALIBUT_TAXON_ID,
  unresolvedFish: UNRESOLVED_FISH_TAXON_ID,
  syntheticTarget: SYNTHETIC_TARGET_TAXON_ID,
});

/** Persistence/envelope states. Only `valid` is a canonical v2 observation payload. */
export const PERSISTED_CONTRACT_STATUSES = Object.freeze(["valid", "legacy_unverified", "rejected"] as const);
export const CONTRACT_STATUSES = PERSISTED_CONTRACT_STATUSES;
export const OBSERVATION_OUTCOME_CLASSES = Object.freeze([
  "target_encountered",
  "non_target_only",
  "no_fish",
] as const);
export const IDENTIFICATION_CONFIDENCES = Object.freeze([
  "verified",
  "self_reported",
  "uncertain",
  "unresolved",
  "not_observed",
] as const);
export const IDENTIFICATION_BASES = Object.freeze([
  "official-survey-code",
  "expert-review",
  "photo-review",
  "angler-report",
  "unresolved",
  "not-observed",
  "synthetic-fixture",
] as const);
export const TARGET_EFFORT_UNITS = Object.freeze(["trip-hours", "angler-hours", "rod-hours"] as const);
export const SPATIAL_SUPPORT_KINDS = Object.freeze(["point", "site", "area"] as const);
export const TEMPORAL_PRECISIONS = Object.freeze(["exact", "bounded"] as const);
export const MODEL_PROJECTED_CRS_IDS = Object.freeze(["EPSG:26910", "EPSG:32610"] as const);
export const MODEL_RUN_STATUSES = Object.freeze(["unrun", "running", "completed", "failed"] as const);
export const OPPORTUNITY_CONFIDENCE_LEVELS = Object.freeze(["low", "medium", "high"] as const);

export type ContractEnvironment = "production" | "test";
export type ContractStatus = (typeof PERSISTED_CONTRACT_STATUSES)[number];
export type ObservationOutcomeClass = (typeof OBSERVATION_OUTCOME_CLASSES)[number];
export type IdentificationConfidence = (typeof IDENTIFICATION_CONFIDENCES)[number];
export type IdentificationBasis = (typeof IDENTIFICATION_BASES)[number];
export type TargetEffortUnit = (typeof TARGET_EFFORT_UNITS)[number];
export type SpatialSupportKind = (typeof SPATIAL_SUPPORT_KINDS)[number];
export type TemporalPrecision = (typeof TEMPORAL_PRECISIONS)[number];

export interface TaxonDefinition {
  taxon_id: string;
  kind: "taxon" | "unresolved-observation-bucket" | "synthetic-fixture";
  common_name: string;
  scientific_name: string | null;
  taxonomic_rank: "species" | "unresolved" | "synthetic";
  observation_eligible: boolean;
  model_eligible: boolean;
  production_observation_eligible: boolean;
  environments: readonly ContractEnvironment[];
}

export const TAXON_DEFINITIONS: readonly TaxonDefinition[] = Object.freeze([
  Object.freeze({
    taxon_id: CALIFORNIA_HALIBUT_TAXON_ID,
    kind: "taxon",
    common_name: "California halibut",
    scientific_name: "Paralichthys californicus",
    taxonomic_rank: "species",
    observation_eligible: true,
    model_eligible: true,
    production_observation_eligible: true,
    environments: Object.freeze(["production", "test"] as const),
  }),
  Object.freeze({
    taxon_id: UNRESOLVED_FISH_TAXON_ID,
    kind: "unresolved-observation-bucket",
    common_name: "Unresolved fish",
    scientific_name: null,
    taxonomic_rank: "unresolved",
    observation_eligible: true,
    model_eligible: false,
    production_observation_eligible: true,
    environments: Object.freeze(["production", "test"] as const),
  }),
  Object.freeze({
    taxon_id: SYNTHETIC_TARGET_TAXON_ID,
    kind: "synthetic-fixture",
    common_name: "Synthetic target",
    scientific_name: null,
    taxonomic_rank: "synthetic",
    observation_eligible: true,
    model_eligible: true,
    production_observation_eligible: false,
    environments: Object.freeze(["test"] as const),
  }),
]);

export const PROHIBITED_PRODUCTION_TARGET_TERMS = Object.freeze([
  "fish",
  "generic-rockfish",
  "rockfish",
  "unknown",
  "unknown-fish",
  "unresolved-fish",
] as const);

export interface TaxonObservation {
  taxon_id: string;
  encounter_count: number;
  retained_count: number;
  released_count: number;
  disposition_unknown_count: number;
  identification_confidence: IdentificationConfidence;
  identification_basis: IdentificationBasis;
}

export interface ObservationContractRecord {
  contract_version: typeof OBSERVATION_CONTRACT_VERSION;
  taxon_catalog_version: typeof TAXON_CATALOG_VERSION;
  contract_status: "valid";
  observation_id: string;
  effort_segment_id: string;
  primary_target_taxon_id: string;
  source: {
    source_id: string;
    source_record_id?: string;
    data_kind: "complete-effort-segment" | "synthetic-fixture";
    complete_attempt: true;
    expanded_estimate: false;
  };
  target_effort: {
    value: number;
    unit: TargetEffortUnit;
    mode: string;
  };
  temporal_support: {
    start_at: string;
    end_at: string;
    precision: TemporalPrecision;
  };
  spatial_support: {
    kind: SpatialSupportKind;
    support_id: string;
    crs?: string;
    x?: number;
    y?: number;
  };
  taxon_observations: TaxonObservation[];
  outcome_class: ObservationOutcomeClass;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export interface ValidationOptions {
  environment?: ContractEnvironment;
}

export interface ObservationModelEligibilityOptions extends ValidationOptions {
  expectedProjectedCrs: string;
}

type UnknownRecord = Record<string, unknown>;

const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const TAXON_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OFFSET_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function checkExactKeys(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[],
  errors: string[],
): value is UnknownRecord {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value).sort()) {
    if (!allowed.has(key)) errors.push(`${path}.${key} is not allowed`);
  }
  for (const key of required) {
    if (!hasOwn(value, key)) errors.push(`${path}.${key} is required`);
  }
  return true;
}

function checkEnum(value: unknown, values: readonly string[], path: string, errors: string[]): void {
  if (typeof value !== "string" || !values.includes(value)) {
    errors.push(`${path} must be one of: ${values.join(", ")}`);
  }
}

function checkStableId(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string" || value.length > 200 || !STABLE_ID_PATTERN.test(value)) {
    errors.push(`${path} must be a nonempty stable identifier`);
  }
}

function checkNonemptyString(value: unknown, path: string, errors: string[], maxLength = 200): void {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value.trim() !== value) {
    errors.push(`${path} must be a trimmed nonempty string no longer than ${maxLength} characters`);
  }
}

function checkNonnegativeInteger(value: unknown, path: string, errors: string[]): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) errors.push(`${path} must be a nonnegative safe integer`);
}

function checkPositiveFinite(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    errors.push(`${path} must be a positive finite number`);
  }
}

function checkSha256(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    errors.push(`${path} must be a lowercase 64-character SHA-256 hex digest`);
  }
}

function offsetDateTimeNanoseconds(value: unknown): bigint | null {
  if (typeof value !== "string") return null;
  const match = OFFSET_DATE_TIME_PATTERN.exec(value);
  if (!match) return null;

  const [
    , yearText, monthText, dayText, hourText, minuteText, secondText,
    fractionText = "", zoneText, offsetSign, offsetHourText = "0", offsetMinuteText = "0",
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = Number(offsetHourText);
  const offsetMinute = Number(offsetMinuteText);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59) return null;

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > daysInMonth[month - 1]) return null;

  const wallClock = new Date(0);
  wallClock.setUTCFullYear(year, month - 1, day);
  wallClock.setUTCHours(hour, minute, second, 0);
  const offsetDirection = zoneText === "Z" ? 0 : offsetSign === "+" ? 1 : -1;
  const offsetMilliseconds = offsetDirection * (offsetHour * 60 + offsetMinute) * 60_000;
  const epochMilliseconds = wallClock.getTime() - offsetMilliseconds;
  if (!Number.isFinite(epochMilliseconds)) return null;

  const fractionalNanoseconds = BigInt(fractionText.padEnd(9, "0") || "0");
  return BigInt(epochMilliseconds) * BigInt(1_000_000) + fractionalNanoseconds;
}

function isUtcDateTime(value: unknown): value is string {
  return offsetDateTimeNanoseconds(value) !== null;
}

function isStrictlyAfter(start: unknown, end: unknown): boolean {
  const startNanoseconds = offsetDateTimeNanoseconds(start);
  const endNanoseconds = offsetDateTimeNanoseconds(end);
  return startNanoseconds !== null && endNanoseconds !== null && endNanoseconds > startNanoseconds;
}

function checkUtcDateTime(value: unknown, path: string, errors: string[]): void {
  if (!isUtcDateTime(value)) errors.push(`${path} must be an ISO 8601 date-time with Z or an explicit UTC offset`);
}

export function getTaxonDefinition(taxonId: string): TaxonDefinition | undefined {
  return TAXON_DEFINITIONS.find((taxon) => taxon.taxon_id === taxonId);
}

export function isObservationEligible(taxonId: string, environment: ContractEnvironment = "production"): boolean {
  const taxon = getTaxonDefinition(taxonId);
  return Boolean(
    taxon?.observation_eligible
      && taxon.environments.includes(environment)
      && (environment !== "production" || taxon.production_observation_eligible),
  );
}

export function isKnownTaxon(taxonId: string): boolean {
  return getTaxonDefinition(taxonId) !== undefined;
}

export function isModelEligibleTaxon(
  taxonId: string,
  environment: ContractEnvironment = "production",
): boolean {
  const taxon = getTaxonDefinition(taxonId);
  return Boolean(
    taxon?.model_eligible
      && taxon.environments.includes(environment)
      && (environment !== "production" || taxon.production_observation_eligible),
  );
}

export function deriveObservationOutcomeClass(
  taxonObservations: readonly Pick<TaxonObservation, "taxon_id" | "encounter_count">[],
  primaryTargetTaxonId: string,
): ObservationOutcomeClass {
  const targetCount = taxonObservations
    .filter((row) => row.taxon_id === primaryTargetTaxonId)
    .reduce((sum, row) => sum + (Number.isSafeInteger(row.encounter_count) && row.encounter_count > 0 ? row.encounter_count : 0), 0);
  if (targetCount > 0) return "target_encountered";
  const nonTargetCount = taxonObservations
    .filter((row) => row.taxon_id !== primaryTargetTaxonId)
    .reduce((sum, row) => sum + (Number.isSafeInteger(row.encounter_count) && row.encounter_count > 0 ? row.encounter_count : 0), 0);
  return nonTargetCount > 0 ? "non_target_only" : "no_fish";
}

function validateIdentificationPair(row: UnknownRecord, path: string, errors: string[]): void {
  const confidence = row.identification_confidence;
  const basis = row.identification_basis;
  const allowedByConfidence: Readonly<Record<string, readonly string[]>> = {
    verified: ["official-survey-code", "expert-review", "photo-review", "synthetic-fixture"],
    self_reported: ["angler-report"],
    uncertain: ["angler-report", "photo-review"],
    unresolved: ["unresolved"],
    not_observed: ["not-observed"],
  };
  if (typeof confidence === "string" && typeof basis === "string") {
    if (!allowedByConfidence[confidence]?.includes(basis)) {
      errors.push(`${path}.identification_basis is inconsistent with identification_confidence`);
    }
  }
}

export function validateObservationContract(value: unknown, options: ValidationOptions = {}): ValidationResult {
  const environment = options.environment ?? "production";
  const errors: string[] = [];
  const required = [
    "contract_version",
    "taxon_catalog_version",
    "contract_status",
    "observation_id",
    "effort_segment_id",
    "primary_target_taxon_id",
    "source",
    "target_effort",
    "temporal_support",
    "spatial_support",
    "taxon_observations",
    "outcome_class",
  ] as const;
  if (!checkExactKeys(value, "$", required, [], errors)) return { ok: false, errors };

  if (value.contract_version !== OBSERVATION_CONTRACT_VERSION) errors.push("$.contract_version is unsupported");
  if (value.taxon_catalog_version !== TAXON_CATALOG_VERSION) errors.push("$.taxon_catalog_version is unsupported");
  if (value.contract_status !== "valid") errors.push("$.contract_status must be valid; legacy or rejected rows are not v2 records");
  checkStableId(value.observation_id, "$.observation_id", errors);
  checkStableId(value.effort_segment_id, "$.effort_segment_id", errors);

  const targetTaxonId = typeof value.primary_target_taxon_id === "string" ? value.primary_target_taxon_id : "";
  if (!TAXON_ID_PATTERN.test(targetTaxonId)) errors.push("$.primary_target_taxon_id must be a canonical taxon ID");
  if (!isModelEligibleTaxon(targetTaxonId, environment)) {
    const prohibited = PROHIBITED_PRODUCTION_TARGET_TERMS.includes(targetTaxonId as never);
    errors.push(prohibited && environment === "production"
      ? "$.primary_target_taxon_id is a prohibited unresolved or generic production target"
      : `$.primary_target_taxon_id is not a model-eligible ${environment} target`);
  }

  if (checkExactKeys(value.source, "$.source", ["source_id", "data_kind", "complete_attempt", "expanded_estimate"], ["source_record_id"], errors)) {
    checkStableId(value.source.source_id, "$.source.source_id", errors);
    if (hasOwn(value.source, "source_record_id")) checkStableId(value.source.source_record_id, "$.source.source_record_id", errors);
    checkEnum(value.source.data_kind, ["complete-effort-segment", "synthetic-fixture"], "$.source.data_kind", errors);
    if (value.source.complete_attempt !== true) errors.push("$.source.complete_attempt must be true; catch-only rows are rejected");
    if (value.source.expanded_estimate !== false) errors.push("$.source.expanded_estimate must be false; expanded estimates are rejected");
    if (environment === "production" && value.source.data_kind !== "complete-effort-segment") {
      errors.push("$.source.data_kind cannot be synthetic in production");
    }
    if (value.source.data_kind === "synthetic-fixture" && targetTaxonId !== SYNTHETIC_TARGET_TAXON_ID) {
      errors.push("$.source.data_kind synthetic-fixture requires the synthetic target");
    }
    if (targetTaxonId === SYNTHETIC_TARGET_TAXON_ID && value.source.data_kind !== "synthetic-fixture") {
      errors.push("$.primary_target_taxon_id synthetic-target requires synthetic-fixture data");
    }
  }

  if (checkExactKeys(value.target_effort, "$.target_effort", ["value", "unit", "mode"], [], errors)) {
    checkPositiveFinite(value.target_effort.value, "$.target_effort.value", errors);
    checkEnum(value.target_effort.unit, TARGET_EFFORT_UNITS, "$.target_effort.unit", errors);
    checkNonemptyString(value.target_effort.mode, "$.target_effort.mode", errors, 120);
  }

  if (checkExactKeys(value.temporal_support, "$.temporal_support", ["start_at", "end_at", "precision"], [], errors)) {
    checkUtcDateTime(value.temporal_support.start_at, "$.temporal_support.start_at", errors);
    checkUtcDateTime(value.temporal_support.end_at, "$.temporal_support.end_at", errors);
    checkEnum(value.temporal_support.precision, TEMPORAL_PRECISIONS, "$.temporal_support.precision", errors);
    if (isUtcDateTime(value.temporal_support.start_at) && isUtcDateTime(value.temporal_support.end_at)
      && !isStrictlyAfter(value.temporal_support.start_at, value.temporal_support.end_at)) {
      errors.push("$.temporal_support.end_at must be after start_at");
    }
  }

  if (checkExactKeys(value.spatial_support, "$.spatial_support", ["kind", "support_id"], ["crs", "x", "y"], errors)) {
    checkEnum(value.spatial_support.kind, SPATIAL_SUPPORT_KINDS, "$.spatial_support.kind", errors);
    checkStableId(value.spatial_support.support_id, "$.spatial_support.support_id", errors);
    if (value.spatial_support.kind === "point") {
      checkNonemptyString(value.spatial_support.crs, "$.spatial_support.crs", errors, 120);
      if (typeof value.spatial_support.crs === "string"
        && !MODEL_PROJECTED_CRS_IDS.includes(value.spatial_support.crs as never)) {
        errors.push(`$.spatial_support.crs must exactly match an approved projected CRS (${MODEL_PROJECTED_CRS_IDS.join(", ")})`);
      }
      if (typeof value.spatial_support.x !== "number" || !Number.isFinite(value.spatial_support.x)) errors.push("$.spatial_support.x must be finite");
      if (typeof value.spatial_support.y !== "number" || !Number.isFinite(value.spatial_support.y)) errors.push("$.spatial_support.y must be finite");
    } else if (hasOwn(value.spatial_support, "crs") || hasOwn(value.spatial_support, "x") || hasOwn(value.spatial_support, "y")) {
      errors.push("$.spatial_support CRS and coordinates are allowed only for point support");
    }
  }

  if (!Array.isArray(value.taxon_observations) || value.taxon_observations.length === 0) {
    errors.push("$.taxon_observations must contain the primary-target row, including for no_fish");
  } else {
    const seenTaxa = new Set<string>();
    let targetRows = 0;
    value.taxon_observations.forEach((row, index) => {
      const path = `$.taxon_observations[${index}]`;
      if (!checkExactKeys(row, path, [
        "taxon_id",
        "encounter_count",
        "retained_count",
        "released_count",
        "disposition_unknown_count",
        "identification_confidence",
        "identification_basis",
      ], [], errors)) return;
      const taxonId = typeof row.taxon_id === "string" ? row.taxon_id : "";
      if (!isObservationEligible(taxonId, environment)) errors.push(`${path}.taxon_id is not observation eligible in ${environment}`);
      if (seenTaxa.has(taxonId)) errors.push(`${path}.taxon_id duplicates another taxon row`);
      seenTaxa.add(taxonId);
      if (taxonId === targetTaxonId) targetRows += 1;

      for (const key of ["encounter_count", "retained_count", "released_count", "disposition_unknown_count"] as const) {
        checkNonnegativeInteger(row[key], `${path}.${key}`, errors);
      }
      checkEnum(row.identification_confidence, IDENTIFICATION_CONFIDENCES, `${path}.identification_confidence`, errors);
      checkEnum(row.identification_basis, IDENTIFICATION_BASES, `${path}.identification_basis`, errors);
      validateIdentificationPair(row, path, errors);

      const encounter = Number(row.encounter_count);
      const dispositionTotal = Number(row.retained_count) + Number(row.released_count) + Number(row.disposition_unknown_count);
      if ([row.encounter_count, row.retained_count, row.released_count, row.disposition_unknown_count].every(Number.isSafeInteger)
        && dispositionTotal !== encounter) {
        errors.push(`${path} disposition counts must sum exactly to encounter_count`);
      }
      if (encounter === 0 && (row.identification_confidence !== "not_observed" || row.identification_basis !== "not-observed")) {
        errors.push(`${path} zero encounters require not_observed/not-observed identification`);
      }
      if (encounter > 0 && row.identification_confidence === "not_observed") {
        errors.push(`${path} positive encounters cannot use not_observed identification`);
      }
      if (taxonId === UNRESOLVED_FISH_TAXON_ID && encounter > 0
        && (row.identification_confidence !== "unresolved" || row.identification_basis !== "unresolved")) {
        errors.push(`${path} unresolved fish must use unresolved/unresolved identification`);
      }
      if (taxonId !== UNRESOLVED_FISH_TAXON_ID && row.identification_confidence === "unresolved") {
        errors.push(`${path} named or synthetic taxa cannot use unresolved identification`);
      }
      if (row.identification_basis === "synthetic-fixture"
        && (environment !== "test" || taxonId !== SYNTHETIC_TARGET_TAXON_ID)) {
        errors.push(`${path} synthetic-fixture identification is restricted to synthetic-target test rows`);
      }
      if (taxonId === SYNTHETIC_TARGET_TAXON_ID && encounter > 0
        && (row.identification_confidence !== "verified" || row.identification_basis !== "synthetic-fixture")) {
        errors.push(`${path} positive synthetic encounters must use verified/synthetic-fixture identification`);
      }
    });
    if (targetRows !== 1) errors.push("$.taxon_observations must contain exactly one primary-target row");

    const expectedOutcome = deriveObservationOutcomeClass(
      value.taxon_observations.filter(isRecord).map((row) => ({
        taxon_id: typeof row.taxon_id === "string" ? row.taxon_id : "",
        encounter_count: typeof row.encounter_count === "number" ? row.encounter_count : 0,
      })),
      targetTaxonId,
    );
    checkEnum(value.outcome_class, OBSERVATION_OUTCOME_CLASSES, "$.outcome_class", errors);
    if (value.outcome_class !== expectedOutcome) {
      errors.push(`$.outcome_class must be ${expectedOutcome} for the declared counts`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function assertObservationContract(
  value: unknown,
  options: ValidationOptions = {},
): asserts value is ObservationContractRecord {
  const result = validateObservationContract(value, options);
  if (!result.ok) throw new Error(`Invalid observation contract: ${result.errors.join("; ")}`);
}

export function assessObservationModelEligibility(
  value: unknown,
  options: ObservationModelEligibilityOptions,
): ValidationResult {
  const validation = validateObservationContract(value, options ?? {});
  if (!validation.ok || !isRecord(value)) return validation;
  const errors: string[] = [];
  const expectedProjectedCrs = options?.expectedProjectedCrs;
  const exactExpectedCrs = typeof expectedProjectedCrs === "string" ? expectedProjectedCrs : "";
  if (!MODEL_PROJECTED_CRS_IDS.includes(exactExpectedCrs as never)) {
    errors.push(`$.spatial_support.crs requires an explicit supported projected CRS (${MODEL_PROJECTED_CRS_IDS.join(", ")})`);
  }
  if (!isRecord(value.spatial_support) || value.spatial_support.kind !== "point") {
    errors.push("$.spatial_support.kind must be point for terrain-model training");
  } else if (typeof value.spatial_support.crs !== "string"
    || value.spatial_support.crs !== exactExpectedCrs) {
    errors.push("$.spatial_support.crs must exactly match expectedProjectedCrs");
  }
  if (!isRecord(value.temporal_support) || value.temporal_support.precision !== "exact") {
    errors.push("$.temporal_support.precision must be exact for terrain-model training");
  }
  return { ok: errors.length === 0, errors };
}

export type ModelTargetScope =
  | { kind: "taxon"; taxon_id: string }
  | { kind: "target-agnostic"; taxon_id: null };

export function targetScope(targetTaxonId: string | null): ModelTargetScope {
  return targetTaxonId === null
    ? { kind: "target-agnostic", taxon_id: null }
    : { kind: "taxon", taxon_id: targetTaxonId };
}

export function targetVersionSlug(targetTaxonId: string | null): string {
  return targetTaxonId ?? "target-agnostic";
}

export function canonicalizeContractValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeContractValue).join(",")}]`;
  return `{${Object.keys(value as UnknownRecord).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalizeContractValue((value as UnknownRecord)[key])}`
  )).join(",")}}`;
}

export function buildModelVersionMaterial(value: UnknownRecord): string {
  return canonicalizeContractValue({
    git_revision: value.git_revision,
    command: value.command,
    dataset_kind: value.dataset_kind,
    model_run_contract_version: value.model_run_contract_version,
    observation_contract_version: value.observation_contract_version,
    taxon_catalog_version: value.taxon_catalog_version,
    target_scope: value.target_scope,
    config: value.config,
    inputs: Array.isArray(value.inputs)
      ? value.inputs.filter(isRecord).map((input) => ({ sha256: input.sha256 }))
      : value.inputs,
  });
}

function validateTargetScope(
  scopeValue: unknown,
  targetValue: unknown,
  environment: ContractEnvironment,
  path: string,
  errors: string[],
): string | null {
  if (!checkExactKeys(scopeValue, `${path}.target_scope`, ["kind", "taxon_id"], [], errors)) return null;
  if (scopeValue.kind === "target-agnostic") {
    if (scopeValue.taxon_id !== null || targetValue !== null) errors.push(`${path} target-agnostic scope requires null taxon IDs`);
    return null;
  }
  if (scopeValue.kind !== "taxon") {
    errors.push(`${path}.target_scope.kind must be taxon or target-agnostic`);
    return null;
  }
  if (typeof scopeValue.taxon_id !== "string" || targetValue !== scopeValue.taxon_id) {
    errors.push(`${path}.target_taxon_id must match target_scope.taxon_id`);
    return typeof scopeValue.taxon_id === "string" ? scopeValue.taxon_id : null;
  }
  if (!isModelEligibleTaxon(scopeValue.taxon_id, environment)) {
    errors.push(`${path}.target_scope.taxon_id is not model eligible in ${environment}`);
  }
  return scopeValue.taxon_id;
}

export function validateModelRunContract(value: unknown, options: ValidationOptions = {}): ValidationResult {
  const environment = options.environment ?? "production";
  const errors: string[] = [];
  const required = [
    "schema_version", "model_run_contract_version", "observation_contract_version",
    "taxon_catalog_version", "target_taxon_id", "target_scope", "run_id", "created_at",
    "status", "dataset_kind", "command", "experiment_version", "model_version",
    "git_revision", "runtime", "config", "inputs", "metrics", "notes",
  ] as const;
  if (!checkExactKeys(value, "$", required, [], errors)) return { ok: false, errors };
  if (value.schema_version !== MODEL_RUN_CONTRACT_VERSION) errors.push("$.schema_version is unsupported");
  if (value.model_run_contract_version !== MODEL_RUN_CONTRACT_VERSION) errors.push("$.model_run_contract_version is unsupported");
  if (value.taxon_catalog_version !== TAXON_CATALOG_VERSION) errors.push("$.taxon_catalog_version is unsupported");
  checkStableId(value.run_id, "$.run_id", errors);
  checkNonemptyString(value.dataset_kind, "$.dataset_kind", errors, 160);
  checkNonemptyString(value.command, "$.command", errors, 200);
  checkNonemptyString(value.git_revision, "$.git_revision", errors, 160);
  checkEnum(value.status, MODEL_RUN_STATUSES, "$.status", errors);
  checkUtcDateTime(value.created_at, "$.created_at", errors);

  const targetTaxonId = validateTargetScope(value.target_scope, value.target_taxon_id, environment, "$", errors);
  const targetAgnosticKinds = new Set(["official_unlabeled_bathymetry", "official_seafloor_character_probe"]);
  if (typeof value.dataset_kind === "string") {
    if (targetAgnosticKinds.has(value.dataset_kind)) {
      if (targetTaxonId !== null) errors.push(`$.dataset_kind ${value.dataset_kind} requires target-agnostic scope`);
    } else if (value.dataset_kind === "synthetic_fixture") {
      if (environment !== "test" || targetTaxonId !== SYNTHETIC_TARGET_TAXON_ID) {
        errors.push("$.dataset_kind synthetic_fixture requires synthetic-target in the test environment");
      }
    } else if (targetTaxonId !== CALIFORNIA_HALIBUT_TAXON_ID) {
      errors.push("$.dataset_kind labeled production runs require the California halibut target");
    }
  }
  if (targetTaxonId === null) {
    if (value.observation_contract_version !== null) {
      errors.push("$.observation_contract_version must be null for target-agnostic terrain runs");
    }
  } else if (value.observation_contract_version !== OBSERVATION_CONTRACT_VERSION) {
    errors.push("$.observation_contract_version must identify the canonical observation contract");
  }
  const versionPrefix = `model-${targetVersionSlug(targetTaxonId)}-`;
  if (typeof value.model_version !== "string" || !value.model_version.startsWith(versionPrefix)
    || !SHA256_PATTERN.test(value.model_version.slice(versionPrefix.length))) {
    errors.push(`$.model_version must be ${versionPrefix}<sha256>`);
  }
  const experimentPrefix = `exp-${targetVersionSlug(targetTaxonId)}-`;
  if (typeof value.experiment_version !== "string" || !value.experiment_version.startsWith(experimentPrefix)
    || !SHA256_PATTERN.test(value.experiment_version.slice(experimentPrefix.length))) {
    errors.push(`$.experiment_version must be ${experimentPrefix}<sha256>`);
  }
  if (checkExactKeys(value.runtime, "$.runtime", ["python", "platform"], [], errors)) {
    checkNonemptyString(value.runtime.python, "$.runtime.python", errors, 120);
    checkNonemptyString(value.runtime.platform, "$.runtime.platform", errors, 300);
  }
  if (!isRecord(value.config)) errors.push("$.config must be an object");
  if (!isRecord(value.metrics)) errors.push("$.metrics must be an object");
  if (typeof value.notes !== "string") errors.push("$.notes must be a string");
  if (!Array.isArray(value.inputs)) {
    errors.push("$.inputs must be an array");
  } else {
    value.inputs.forEach((input, index) => {
      const path = `$.inputs[${index}]`;
      if (!checkExactKeys(input, path, ["path", "sha256", "bytes"], [], errors)) return;
      checkNonemptyString(input.path, `${path}.path`, errors, 4096);
      checkSha256(input.sha256, `${path}.sha256`, errors);
      checkNonnegativeInteger(input.bytes, `${path}.bytes`, errors);
    });
  }
  if (value.status === "completed") {
    if (!Array.isArray(value.inputs) || value.inputs.length === 0) errors.push("$.inputs must be nonempty for completed runs");
    if (!isRecord(value.metrics) || Object.keys(value.metrics).length === 0) errors.push("$.metrics must be nonempty for completed runs");
    if (typeof value.notes !== "string" || value.notes.trim().length === 0) errors.push("$.notes must describe result scope for completed runs");
  }

  return { ok: errors.length === 0, errors };
}

export function assertModelRunContract(value: unknown, options: ValidationOptions = {}): void {
  const result = validateModelRunContract(value, options);
  if (!result.ok) throw new Error(`Invalid model-run contract: ${result.errors.join("; ")}`);
}

export function validateOpportunityContract(value: unknown, options: ValidationOptions = {}): ValidationResult {
  const environment = options.environment ?? "production";
  const errors: string[] = [];
  const commonRequired = [
    "id", "species", "target_taxon_id", "taxon_catalog_version", "observation_contract_version",
    "model_run_contract_version", "opportunity_contract_version", "scoring_system_kind",
    "scoring_system_sha256", "confidence",
  ] as const;
  if (!isRecord(value)) return { ok: false, errors: ["$ must be an object"] };
  for (const key of commonRequired) if (!hasOwn(value, key)) errors.push(`$.${key} is required`);

  const staticFields = ["siteId", "start", "end", "score", "modelVersion"] as const;
  const apiFields = ["site", "start_time", "end_time", "opportunity_score", "model_version", "scoring_system_version"] as const;
  const hasStaticFields = staticFields.some((key) => hasOwn(value, key));
  const hasApiFields = apiFields.some((key) => hasOwn(value, key));
  if (hasStaticFields === hasApiFields) {
    errors.push("$ must contain exactly one complete opportunity representation: static or API");
  }
  const representation = hasStaticFields && !hasApiFields ? "static" : hasApiFields && !hasStaticFields ? "api" : null;
  const representationFields = representation === "static" ? staticFields : representation === "api" ? apiFields : [];
  for (const key of representationFields) {
    if (!hasOwn(value, key)) errors.push(`$.${key} is required for the ${representation} representation`);
  }

  if (value.opportunity_contract_version !== OPPORTUNITY_CONTRACT_VERSION) errors.push("$.opportunity_contract_version is unsupported");
  if (value.taxon_catalog_version !== TAXON_CATALOG_VERSION) errors.push("$.taxon_catalog_version is unsupported");
  if (value.observation_contract_version !== OBSERVATION_CONTRACT_VERSION) errors.push("$.observation_contract_version is unsupported");
  if (value.model_run_contract_version !== MODEL_RUN_CONTRACT_VERSION) errors.push("$.model_run_contract_version is unsupported");
  checkStableId(value.id, "$.id", errors);
  const targetTaxonId = typeof value.target_taxon_id === "string" ? value.target_taxon_id : "";
  if (!isModelEligibleTaxon(targetTaxonId, environment)) errors.push("$.target_taxon_id is not model eligible");
  if (value.species !== targetTaxonId) errors.push("$.species must match target_taxon_id");
  checkEnum(value.scoring_system_kind, ["heuristic-configuration", "trained-model"], "$.scoring_system_kind", errors);
  checkSha256(value.scoring_system_sha256, "$.scoring_system_sha256", errors);
  const scoringSystemVersion = representation === "static" ? value.modelVersion : value.scoring_system_version;
  checkNonemptyString(scoringSystemVersion, "$.scoring_system_version", errors, 200);
  if (representation === "api" && value.model_version !== value.scoring_system_version) {
    errors.push("$.scoring_system_version must match $.model_version");
  }
  if (value.scoring_system_kind === "trained-model") {
    const prefix = `model-${targetTaxonId}-`;
    if (typeof scoringSystemVersion !== "string" || !scoringSystemVersion.startsWith(prefix)
      || !SHA256_PATTERN.test(scoringSystemVersion.slice(prefix.length))) {
      errors.push(`$.scoring_system_version must be ${prefix}<sha256> for trained models`);
    }
  }
  const start = representation === "static" ? value.start : value.start_time;
  const end = representation === "static" ? value.end : value.end_time;
  const score = representation === "static" ? value.score : value.opportunity_score;
  const siteId = representation === "static" ? value.siteId : isRecord(value.site) ? value.site.id : undefined;
  checkStableId(siteId, "$.site", errors);
  checkUtcDateTime(start, "$.start", errors);
  checkUtcDateTime(end, "$.end", errors);
  if (isUtcDateTime(start) && isUtcDateTime(end) && !isStrictlyAfter(start, end)) {
    errors.push("$.end must be after start");
  }
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 100) {
    errors.push("$.score must be between 0 and 100");
  }
  if (representation === "static" && isRecord(value.confidence)) {
    errors.push("$.confidence must be a string in the static representation");
  }
  if (representation === "api" && !isRecord(value.confidence)) {
    errors.push("$.confidence must be an object in the API representation");
  }
  const confidence = representation === "api" && isRecord(value.confidence)
    ? value.confidence.level
    : value.confidence;
  checkEnum(confidence, OPPORTUNITY_CONFIDENCE_LEVELS, "$.confidence", errors);
  return { ok: errors.length === 0, errors };
}

export function assertOpportunityContract(value: unknown, options: ValidationOptions = {}): void {
  const result = validateOpportunityContract(value, options);
  if (!result.ok) throw new Error(`Invalid opportunity contract: ${result.errors.join("; ")}`);
}
