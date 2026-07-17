import type { OpportunitySnapshot, SourceFreshness } from "../types";

function currentSourceFreshness(source: SourceFreshness, nowMs: number): SourceFreshness {
  const observedAtMs = Date.parse(source.observedAt);
  const limitMinutes = source.freshnessLimitMinutes
    ?? (source.freshnessLimitHours === undefined ? undefined : source.freshnessLimitHours * 60);
  const ageMinutes = Number.isFinite(observedAtMs)
    ? Math.max(0, Math.round((nowMs - observedAtMs) / 60_000))
    : undefined;

  if (!source.status.startsWith("fresh")) {
    return ageMinutes === undefined ? source : { ...source, ageMinutes };
  }
  if (ageMinutes === undefined) {
    return {
      ...source,
      status: "stale; invalid observation timestamp",
      detail: source.detail ?? "This source cannot be treated as fresh because its observation time is invalid.",
    };
  }
  if (limitMinutes !== undefined && ageMinutes > limitMinutes) {
    return {
      ...source,
      ageMinutes,
      status: "stale; freshness limit exceeded",
      detail: source.detail ?? `The deployed snapshot is older than this source's ${limitMinutes}-minute freshness limit.`,
    };
  }
  return { ...source, ageMinutes };
}

export function applyCurrentFreshness(
  snapshot: OpportunitySnapshot,
  nowMs = Date.now(),
): OpportunitySnapshot {
  return {
    ...snapshot,
    sources: snapshot.sources.map((source) => currentSourceFreshness(source, nowMs)),
    windows: snapshot.windows.map((window) => ({
      ...window,
      sources: window.sources?.map((source) => currentSourceFreshness(source, nowMs)),
    })),
  };
}

export function hasLiveForecastInputs(snapshot: OpportunitySnapshot): boolean {
  const timeSensitiveSources = snapshot.sources.filter((source) => {
    const limitMinutes = source.freshnessLimitMinutes
      ?? (source.freshnessLimitHours === undefined ? undefined : source.freshnessLimitHours * 60);
    return limitMinutes !== undefined && limitMinutes <= 6 * 60;
  });

  return timeSensitiveSources.length >= 2
    && timeSensitiveSources.every((source) => source.status.startsWith("fresh"));
}

export function sourceStatusTone(status: string): "fresh" | "aging" | "stale" {
  if (status.startsWith("fresh")) return "fresh";
  if (
    status.startsWith("aging")
    || status.startsWith("provisional")
    || status.startsWith("demo")
  ) return "aging";
  return "stale";
}
