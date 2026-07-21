import type {
  WaterQualitySiteAssessment,
  WaterQualitySnapshot,
} from "../types";

const PACIFIC_TIME_ZONE = "America/Los_Angeles";
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function calendarOrdinal(value: string): number | null {
  const match = DATE_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ordinal = Date.UTC(year, month - 1, day) / 86_400_000;
  const roundTrip = new Date(ordinal * 86_400_000);
  if (
    roundTrip.getUTCFullYear() !== year
    || roundTrip.getUTCMonth() !== month - 1
    || roundTrip.getUTCDate() !== day
  ) {
    return null;
  }
  return ordinal;
}

function pacificCalendarDate(nowMs: number): string | null {
  if (!Number.isFinite(nowMs)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.year && values.month && values.day
    ? values.year + "-" + values.month + "-" + values.day
    : null;
}

function expireNeutralAssessment(
  assessment: WaterQualitySiteAssessment,
  currentOrdinal: number | null,
  maximumSampleAgeDays: number,
): WaterQualitySiteAssessment {
  if (assessment.status !== "no-active-posting") return assessment;
  const sampleOrdinals = assessment.sampleDates.map(calendarOrdinal);
  const invalid = (
    currentOrdinal === null
    || sampleOrdinals.length === 0
    || sampleOrdinals.some((ordinal) => ordinal === null)
  );
  const stale = invalid || sampleOrdinals.some((ordinal) => (
    ordinal === null
    || currentOrdinal - ordinal < 0
    || currentOrdinal - ordinal > maximumSampleAgeDays
  ));
  if (!stale) return assessment;
  return {
    ...assessment,
    status: "stale",
    recommendationEffect: "unknown",
    officialLabel: "Official sample is stale",
    detail: "The deployed official sample is missing, invalid, in the future, or older than the "
      + maximumSampleAgeDays
      + "-day freshness limit.",
  };
}

export function applyCurrentWaterQualityFreshness(
  snapshot: WaterQualitySnapshot,
  nowMs = Date.now(),
): WaterQualitySnapshot {
  const currentDate = pacificCalendarDate(nowMs);
  const currentOrdinal = currentDate === null ? null : calendarOrdinal(currentDate);
  const maximumSampleAgeDays = snapshot.freshness.maximumSampleAgeDays;
  return {
    ...snapshot,
    sites: Object.fromEntries(
      Object.entries(snapshot.sites).map(([siteId, assessment]) => [
        siteId,
        expireNeutralAssessment(assessment, currentOrdinal, maximumSampleAgeDays),
      ]),
    ),
  };
}
