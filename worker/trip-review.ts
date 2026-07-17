import type { CuratedSite, D1DatabaseLike, TripRow } from "./trips";

interface ReviewEnv {
  DB?: D1DatabaseLike;
  MIMO_API_KEY?: string;
  MIMO_MODEL?: string;
}

interface PublicDiscussionDraft {
  publish: boolean;
  summary: string;
  gearSummary?: string | null;
  techniqueTags?: string[];
}

interface MimoResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

class ReviewError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, status?: number) {
    super(code);
    this.name = "ReviewError";
    this.code = code;
    this.status = status;
  }
}

export async function reviewTripWithMimo(env: ReviewEnv, tripOrId: TripRow | string, sites: readonly CuratedSite[]) {
  if (!env.DB || !env.MIMO_API_KEY) return;
  const tripId = typeof tripOrId === "string" ? tripOrId : tripOrId.id;
  const model = env.MIMO_MODEL ?? "mimo-v2.5";
  const claimed = await env.DB.prepare(`UPDATE trips SET ai_review_status = 'processing'
    WHERE id = ? AND status = 'completed'
      AND (ai_review_status IS NULL OR ai_review_status = 'queued' OR ai_review_status = 'retry')`)
    .bind(tripId)
    .run();
  if (Number(claimed.meta?.changes ?? 0) !== 1) return;
  const trip = await env.DB.prepare(`SELECT * FROM trips
    WHERE id = ? AND status = 'completed' AND ai_review_status = 'processing' LIMIT 1`)
    .bind(tripId).first<TripRow>();
  if (!trip) return;
  const site = sites.find((candidate) => candidate.id === trip.site_id);

  const safeTrip = {
    siteId: trip.site_id,
    siteType: site?.type ?? "unknown",
    startedAt: trip.started_at,
    endedAt: trip.ended_at,
    mode: trip.mode,
    fishingMethod: trip.fishing_method,
    gear: trip.gear,
    rod: trip.rod,
    reel: trip.reel,
    baitOrLure: trip.bait_lure,
    rig: trip.rig,
    anglerCount: trip.angler_count,
    anglerHours: trip.angler_hours,
    keeperCount: trip.keeper_count,
    shortReleasedCount: trip.short_released_count,
    halibutEncounters: trip.halibut_encounters,
    noCatch: Boolean(trip.no_catch),
    otherCatchCount: trip.other_catch_count,
    reportedOtherSpeciesLabel: trip.other_species,
    observationContractVersion: trip.observation_contract_version,
    taxonCatalogVersion: trip.taxon_catalog_version,
    primaryTargetTaxonId: trip.target_taxon_id,
    contractStatus: trip.contract_status,
    taxonObservations: safeJson(trip.taxon_observations_json),
    outcomeClass: trip.outcome_class,
    targetEncounterCount: trip.target_encounter_count,
    anyFishEncounterCount: trip.any_fish_encounter_count,
    targetIdentificationConfidence: trip.target_identification_confidence,
    observedFishability: safeJson(trip.observations_json),
    forecastFishabilityScore: trip.fishability_score,
    notes: trip.notes?.slice(0, 1000) ?? null,
  };

  try {
    if (await deletionRequestedBeforeDispatch(env.DB, trip)) return;
    const response = await fetch("https://api.xiaomimimo.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "api-key": env.MIMO_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_completion_tokens: 950,
        response_format: { type: "json_object" },
        thinking: { type: "disabled" },
        messages: [
          {
            role: "system",
            content: `You review California halibut trip reports for data quality and normalize angler gear. Never decide whether a person is truthful and never approve or reject a report. Identify only completeness, internal consistency, impossible numeric/time combinations, and details a human reviewer should check. Do not rank brands or claim one product catches more fish without sufficient aggregate evidence. Normalize recognizable rod, reel, and lure brands/series/models; preserve uncertainty and do not invent a missing model. The server-controlled structured observation fields are authoritative only when contractStatus is valid. Treat legacy_unverified or missing structured evidence as non-model evidence, and do not infer a species identity from reportedOtherSpeciesLabel.

If notes contain useful spot context, prepare a short pseudonymous discussion draft for a human moderator. You cannot publish or approve it. Remove names, handles, contact details, exact sub-location clues, and anything unsafe, abusive, or unrelated. The draft may mention the general curated site, time of day, catch or skunk, technique, normalized gear, crowding, clarity, shorebreak, and fishability. Set publish false when notes are empty, cannot be safely minimized, are off-topic, or need human review.

Return JSON only with keys: quality_score (0-100), flags (string array), summary (one sentence), needs_human_review (boolean), gear_analysis ({rod, reel, lure, setup_tags, compatibility_flags, technique_match_summary}; rod/reel/lure each have brand, series, model, confidence), and discussion ({publish, summary, gear_summary, technique_tags}).`,
          },
          { role: "user", content: JSON.stringify(safeTrip) },
        ],
      }),
    });
    if (!response.ok) {
      const status = response.status;
      await response.body?.cancel().catch(() => undefined);
      throw new ReviewError("upstream_status", status);
    }
    const payload = await response.json() as MimoResponse;
    const content = payload.choices?.[0]?.message?.content?.trim();
    if (!content) throw new ReviewError("empty_response");
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new ReviewError("invalid_response_shape");
    const review = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const needsHumanReview = Boolean(review.needs_human_review);
    const gearAnalysis = normalizeGearAnalysis(review.gear_analysis);
    const discussion = normalizeDiscussion(review.discussion, needsHumanReview);
    const stored = JSON.stringify({
      qualityScore: clampNumber(review.quality_score, 0, 100),
      flags: Array.isArray(review.flags) ? review.flags.filter((value) => typeof value === "string").slice(0, 8) : [],
      summary: typeof review.summary === "string" ? review.summary.slice(0, 300) : "Review completed.",
      needsHumanReview,
      gearAnalysis,
      discussion,
    });
    await env.DB.prepare(`UPDATE trips SET ai_review_status = 'reviewed', ai_review_json = ?,
      ai_review_model = ?, ai_reviewed_at = ? WHERE id = ? AND ai_review_status = 'processing'`)
      .bind(stored, model, new Date().toISOString(), trip.id)
      .run();
  } catch (error) {
    console.error("Automated trip review failed", {
      name: error instanceof Error ? error.name : "UnknownError",
      code: error instanceof ReviewError ? error.code : "review_failed",
      status: error instanceof ReviewError ? error.status : undefined,
    });
    await env.DB.prepare(`UPDATE trips SET ai_review_status = 'retry', ai_review_model = ?
      WHERE id = ? AND ai_review_status = 'processing'`)
      .bind(model, trip.id)
      .run();
  }
}

async function deletionRequestedBeforeDispatch(db: D1DatabaseLike, trip: TripRow) {
  const tripSubjectHash = await sha256(`trip:${trip.id}`);
  const ownerSubjectHash = trip.user_id ? await sha256(`account:${trip.user_id}`) : null;
  const tombstone = ownerSubjectHash
    ? await db.prepare(`SELECT 1 AS requested FROM privacy_deletion_jobs
        WHERE (scope = 'trip' AND subject_hash = ?)
          OR (scope = 'account' AND owner_subject_hash = ?) LIMIT 1`)
      .bind(tripSubjectHash, ownerSubjectHash).first<{ requested: number }>()
    : await db.prepare("SELECT 1 AS requested FROM privacy_deletion_jobs WHERE scope = 'trip' AND subject_hash = ? LIMIT 1")
      .bind(tripSubjectHash).first<{ requested: number }>();
  return Boolean(tombstone);
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function reviewTripBacklog(env: ReviewEnv, sites: readonly CuratedSite[], limit = 10) {
  if (!env.DB || !env.MIMO_API_KEY) return 0;
  const rows = await env.DB.prepare(`SELECT id FROM trips
    WHERE status = 'completed' AND (ai_review_status IS NULL OR ai_review_status = 'retry')
    ORDER BY COALESCE(completed_at, ended_at, started_at) ASC
    LIMIT ?`)
    .bind(limit)
    .all<{ id: string }>();
  const trips = rows.results ?? [];
  for (const trip of trips) await reviewTripWithMimo(env, trip.id, sites);
  return trips.length;
}

function normalizeGearAnalysis(value: unknown) {
  const source = isRecord(value) ? value : {};
  return {
    rod: normalizeGearItem(source.rod),
    reel: normalizeGearItem(source.reel),
    lure: normalizeGearItem(source.lure),
    setupTags: stringArray(source.setup_tags, 8, 60),
    compatibilityFlags: stringArray(source.compatibility_flags, 8, 120),
    techniqueMatchSummary: textValue(source.technique_match_summary, 300),
  };
}

function normalizeGearItem(value: unknown) {
  const source = isRecord(value) ? value : {};
  return {
    brand: textValue(source.brand, 80),
    series: textValue(source.series, 100),
    model: textValue(source.model, 120),
    confidence: textValue(source.confidence, 30) ?? "low",
  };
}

function normalizeDiscussion(value: unknown, needsHumanReview: boolean): PublicDiscussionDraft {
  const source = isRecord(value) ? value : {};
  return {
    publish: !needsHumanReview && Boolean(source.publish),
    summary: textValue(source.summary, 420) ?? "",
    gearSummary: textValue(source.gear_summary, 220),
    techniqueTags: stringArray(source.technique_tags, 6, 42),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function textValue(value: unknown, maximum: number) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maximum) : null;
}

function stringArray(value: unknown, count: number, maximum: number) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.slice(0, maximum)).slice(0, count)
    : [];
}

function clampNumber(value: unknown, minimum: number, maximum: number) {
  const number = typeof value === "number" && Number.isFinite(value) ? value : minimum;
  return Math.max(minimum, Math.min(maximum, number));
}

function safeJson(value: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
