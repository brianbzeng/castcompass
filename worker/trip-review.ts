import type { CuratedSite, D1DatabaseLike, TripRow } from "./trips";
import { publishTripDiscussion, type PublicDiscussionDraft } from "./discussions";

interface ReviewEnv {
  DB?: D1DatabaseLike;
  MIMO_API_KEY?: string;
  MIMO_MODEL?: string;
}

interface MimoResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export async function reviewTripWithMimo(env: ReviewEnv, trip: TripRow, sites: readonly CuratedSite[]) {
  if (!env.DB || !env.MIMO_API_KEY || trip.status !== "completed") return;
  const model = env.MIMO_MODEL ?? "mimo-v2.5";
  const site = sites.find((candidate) => candidate.id === trip.site_id);
  await env.DB.prepare("UPDATE trips SET ai_review_status = 'processing' WHERE id = ?")
    .bind(trip.id)
    .run();

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
    otherSpecies: trip.other_species,
    observedFishability: safeJson(trip.observations_json),
    forecastFishabilityScore: trip.fishability_score,
    forecastMetadata: safeJson(trip.prediction_metadata_json),
    notes: trip.notes?.slice(0, 1000) ?? null,
  };

  try {
    const response = await fetch("https://api.xiaomimimo.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.MIMO_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_completion_tokens: 950,
        messages: [
          {
            role: "developer",
            content: `You review California halibut trip reports for data quality and normalize angler gear. Never decide whether a person is truthful and never approve or reject a report. Identify only completeness, internal consistency, impossible numeric/time combinations, and details a human reviewer should check. Do not rank brands or claim one product catches more fish without sufficient aggregate evidence. Normalize recognizable rod, reel, and lure brands/series/models; preserve uncertainty and do not invent a missing model.

If notes contain useful spot context, write a short anonymous discussion summary. Remove names, handles, contact details, exact sub-location clues, and anything unsafe, abusive, or unrelated. The summary may mention the general curated site, time of day, catch or skunk, technique, normalized gear, crowding, clarity, shorebreak, and fishability. Set publish false when notes are empty, cannot be safely anonymized, are off-topic, or need human review.

Return JSON only with keys: quality_score (0-100), flags (string array), summary (one sentence), needs_human_review (boolean), gear_analysis ({rod, reel, lure, setup_tags, compatibility_flags, technique_match_summary}; rod/reel/lure each have brand, series, model, confidence), and discussion ({publish, summary, gear_summary, technique_tags}).`,
          },
          { role: "user", content: JSON.stringify(safeTrip) },
        ],
      }),
    });
    if (!response.ok) throw new Error(`MiMo returned ${response.status}`);
    const payload = await response.json() as MimoResponse;
    const content = payload.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("MiMo returned no review content");
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("MiMo review was not JSON");
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
      ai_review_model = ?, ai_reviewed_at = ? WHERE id = ?`)
      .bind(stored, model, new Date().toISOString(), trip.id)
      .run();
    await publishTripDiscussion(env, trip, discussion, model);
  } catch (error) {
    console.error("Advisory MiMo trip review failed", error);
    await env.DB.prepare("UPDATE trips SET ai_review_status = 'retry', ai_review_model = ? WHERE id = ?")
      .bind(model, trip.id)
      .run();
  }
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
