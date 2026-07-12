"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ContourMap } from "./ContourMap";
import { TripReportFeature } from "./TripReportFeature";
import {
  ArrowIcon,
  ChevronIcon,
  ClockIcon,
  CloseIcon,
  DownloadIcon,
  InfoIcon,
  LayersIcon,
  ListIcon,
  LocateIcon,
  LogoMark,
  MapIcon,
  TemperatureIcon,
  TideIcon,
  WindIcon,
} from "./icons";
import type {
  CommunityPulse,
  FishingSite,
  OpportunitySnapshot,
  OpportunityWindow,
  SourceFreshness,
  TimeFilter,
  TripReportRequest,
} from "../types";

const PACIFIC_TIME_ZONE = "America/Los_Angeles";

const FALLBACK_SITES: FishingSite[] = [
  {
    id: "oyster-point-pier",
    name: "Oyster Point Pier",
    latitude: 37.665,
    longitude: -122.377,
    region: "South Bay",
    type: "Pier",
    access: "Public shoreline pier; verify posted access hours before departure.",
    regulationUrl: "https://wildlife.ca.gov/Fishing/Ocean/Regulations/Fishing-Map/sf-bay",
    structureTags: ["channel edge", "sand flat"],
  },
  {
    id: "pacifica-pier",
    name: "Pacifica Municipal Pier",
    latitude: 37.633,
    longitude: -122.495,
    region: "Coast",
    type: "Pier",
    access: "Public municipal pier; closures can occur during heavy swell.",
    regulationUrl: "https://wildlife.ca.gov/Fishing/Ocean/Regulations/Fishing-Map/San-Francisco",
    structureTags: ["open coast", "sand trough"],
  },
  {
    id: "berkeley-pier-shore",
    name: "Berkeley Marina Shoreline",
    latitude: 37.865,
    longitude: -122.314,
    region: "East Bay",
    type: "Shore",
    access: "Public shoreline access near the marina.",
    regulationUrl: "https://wildlife.ca.gov/Fishing/Ocean/Regulations/Fishing-Map/sf-bay",
    structureTags: ["marina edge", "mud-sand transition"],
  },
];

interface ApiSourceFreshness {
  source: string;
  observed_at: string | null;
  checked_at: string;
  age_minutes: number | null;
  freshness_limit_minutes: number;
  status: string;
  used_in_score: boolean;
  excluded_reason: string | null;
}

interface ApiOpportunityWindow {
  id: string;
  site: { id: string };
  start_time: string;
  end_time: string;
  opportunity_score: number;
  components: {
    habitat_score: number;
    seasonality_score: number;
    dynamic_score: number;
  };
  confidence: { level: string };
  explanation_factors: Array<{ label: string; detail: string }>;
  model_version: string;
  generated_at: string;
  source_freshness: ApiSourceFreshness[];
  conditions?: {
    tide_stage?: string | null;
    current_knots?: number | null;
    wind_mph?: number | null;
    swell_feet?: number | null;
    water_temp_f?: number | null;
    water_temp_source?: string | null;
    ndbc_observed_water_temp_f?: number | null;
    ndbc_observed_at?: string | null;
    daylight?: boolean | null;
  } | null;
  rank?: number | null;
}

interface ApiOpportunityResponse {
  generated_at: string;
  score_definition: string;
  windows: ApiOpportunityWindow[];
}

function normalizeApiSnapshot(payload: ApiOpportunityResponse): OpportunitySnapshot {
  const sourceMap = new Map<string, SourceFreshness>();
  payload.windows.forEach((window) => {
    window.source_freshness.forEach((source) => {
      const current = sourceMap.get(source.source);
      if (!current || new Date(source.checked_at) > new Date(current.observedAt)) {
        sourceMap.set(source.source, {
          name: source.source.replaceAll("_", " "),
          observedAt: source.observed_at ?? source.checked_at,
          status: source.status,
          ageMinutes: source.age_minutes ?? undefined,
          freshnessLimitMinutes: source.freshness_limit_minutes,
          detail: source.excluded_reason ?? undefined,
        });
      }
    });
  });

  return {
    generatedAt: payload.generated_at,
    modelVersion: payload.windows[0]?.model_version ?? "unknown",
    methodology: payload.score_definition,
    sources: Array.from(sourceMap.values()),
    windows: payload.windows.map((window) => ({
      id: window.id,
      siteId: window.site.id,
      start: window.start_time,
      end: window.end_time,
      score: window.opportunity_score,
      habitatScore: window.components.habitat_score,
      seasonalityScore: window.components.seasonality_score,
      dynamicScore: window.components.dynamic_score,
      confidence: window.confidence.level,
      rank: window.rank ?? undefined,
      explanationFactors: window.explanation_factors.map((factor) => factor.detail || factor.label),
      conditions: {
        tideStage: window.conditions?.tide_stage ?? undefined,
        currentKnots: window.conditions?.current_knots ?? undefined,
        windMph: window.conditions?.wind_mph ?? undefined,
        swellFeet: window.conditions?.swell_feet ?? undefined,
        waterTempF: window.conditions?.water_temp_f ?? undefined,
        waterTempSource: window.conditions?.water_temp_source ?? undefined,
        ndbcObservedWaterTempF: window.conditions?.ndbc_observed_water_temp_f ?? undefined,
        ndbcObservedAt: window.conditions?.ndbc_observed_at ?? undefined,
        daylight: window.conditions?.daylight ?? undefined,
      },
      modelVersion: window.model_version,
      sources: window.source_freshness.map((source) => ({
        name: source.source.replaceAll("_", " "),
        observedAt: source.observed_at ?? source.checked_at,
        status: source.status,
        ageMinutes: source.age_minutes ?? undefined,
        freshnessLimitMinutes: source.freshness_limit_minutes,
        detail: source.excluded_reason ?? undefined,
      })),
    })),
  };
}

async function loadForecastData() {
  const staticSitesPromise = fetch("/data/sites.json").then((response) => {
    if (!response.ok) throw new Error("sites unavailable");
    return response.json() as Promise<FishingSite[]>;
  });
  const communityPromise = fetch("/data/community-pulse.json")
    .then(async (response) => {
      if (!response.ok) return [];
      const payload = (await response.json()) as CommunityPulse[] | { pulses?: CommunityPulse[] };
      return Array.isArray(payload) ? payload : payload.pulses ?? [];
    })
    .catch(() => [] as CommunityPulse[]);
  const apiBase = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "");

  if (apiBase) {
    const [staticSites, community] = await Promise.all([staticSitesPromise, communityPromise]);
    try {
      const from = new Date().toISOString();
      const response = await fetch(
        `${apiBase}/v1/opportunities?species=california-halibut&from=${encodeURIComponent(from)}&hours=72`,
      );
      if (!response.ok) throw new Error(`API returned ${response.status}`);
      const apiSnapshot = (await response.json()) as ApiOpportunityResponse;
      return {
        sites: staticSites,
        snapshot: normalizeApiSnapshot(apiSnapshot),
        community,
        state: "live" as const,
      };
    } catch {
      const response = await fetch("/data/opportunities.json");
      if (!response.ok) throw new Error("API and snapshot unavailable");
      return {
        sites: staticSites,
        snapshot: (await response.json()) as OpportunitySnapshot,
        community,
        state: "cached" as const,
      };
    }
  }

  const [staticSites, staticSnapshot, community] = await Promise.all([
    staticSitesPromise,
    fetch("/data/opportunities.json").then((response) => {
      if (!response.ok) throw new Error("snapshot unavailable");
      return response.json() as Promise<OpportunitySnapshot>;
    }),
    communityPromise,
  ]);
  const state = staticSnapshot.sources.some((source) => source.status.startsWith("fresh")) ? "live" : "cached";
  return { sites: staticSites, snapshot: staticSnapshot, community, state: state as "live" | "cached" };
}

function fallbackSnapshot(): OpportunitySnapshot {
  const start = new Date();
  start.setMinutes(0, 0, 0);
  const sources: SourceFreshness[] = [
    {
      name: "Cached planning snapshot",
      observedAt: start.toISOString(),
      status: "aging",
      detail: "Live sources unavailable; scores are illustrative until refreshed.",
    },
  ];
  const windows = FALLBACK_SITES.map((site, index) => ({
    id: `${site.id}-${start.toISOString()}`,
    siteId: site.id,
    start: new Date(start.getTime() + index * 60 * 60 * 1000).toISOString(),
    end: new Date(start.getTime() + (index + 2) * 60 * 60 * 1000).toISOString(),
    score: 72 - index * 7,
    habitatScore: 76 - index * 5,
    seasonalityScore: 68,
    dynamicScore: 69 - index * 4,
    confidence: "low",
    rank: index + 1,
    explanationFactors: ["Accessible casting zone", "Seasonal halibut pattern", "Cached conditions"],
    conditions: { tideStage: "Loading", windMph: 9, waterTempF: 58, daylight: true },
    modelVersion: "fallback-0.1",
    sources,
  }));
  return {
    generatedAt: start.toISOString(),
    modelVersion: "fallback-0.1",
    methodology: "Offline interface fallback",
    sources,
    windows,
  };
}

function distanceMiles(a: [number, number], b: [number, number]) {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const earthRadiusMiles = 3958.8;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadiusMiles * Math.asin(Math.sqrt(h));
}

function scoreTone(score: number) {
  if (score >= 80) return "excellent";
  if (score >= 65) return "good";
  if (score >= 45) return "fair";
  return "quiet";
}

function googleMapsSearchUrl(site: FishingSite) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${site.name}, California`)}`;
}

function googleStreetViewUrl(site: FishingSite) {
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${site.latitude}%2C${site.longitude}`;
}

function googleSatelliteUrl(site: FishingSite) {
  return `https://www.google.com/maps/@?api=1&map_action=map&center=${site.latitude}%2C${site.longitude}&zoom=17&basemap=satellite`;
}

function googleDirectionsUrl(site: FishingSite) {
  return `https://www.google.com/maps/dir/?api=1&destination=${site.latitude}%2C${site.longitude}`;
}

function formatWindow(startIso: string, endIso: string, compact = false) {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const sameDay = dateInputValue(start) === dateInputValue(new Date());
  const day = sameDay
    ? "Today"
    : start.toLocaleDateString("en-US", { weekday: "short", timeZone: PACIFIC_TIME_ZONE });
  const timeOptions: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    timeZone: PACIFIC_TIME_ZONE,
  };
  if (compact) return `${day}, ${start.toLocaleTimeString("en-US", timeOptions)}`;
  return `${day} · ${start.toLocaleTimeString("en-US", timeOptions)}–${end.toLocaleTimeString("en-US", timeOptions)}`;
}

function formatAge(iso: string) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function dateInputValue(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function shiftDateInput(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number);
  return dateInputValue(new Date(Date.UTC(year, month - 1, day + days, 12)));
}

function dateFromInput(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function defaultCustomEnd() {
  return shiftDateInput(dateInputValue(new Date()), 2);
}

function pacificClockMinutes(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

function timeInputMinutes(value: string) {
  if (!value) return null;
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function overlapsAvailableHours(window: OpportunityWindow, availableFrom: string, availableUntil: string) {
  const from = timeInputMinutes(availableFrom);
  const until = timeInputMinutes(availableUntil);
  if (from === null && until === null) return true;

  const windowStart = new Date(window.start);
  const windowEnd = new Date(window.end);
  const startMinute = pacificClockMinutes(windowStart);
  let endMinute = pacificClockMinutes(windowEnd);
  if (dateInputValue(windowStart) !== dateInputValue(windowEnd) || endMinute <= startMinute) endMinute += 1440;

  if (from !== null && until === null) return endMinute > from;
  if (from === null && until !== null) return startMinute < until;
  if (from === null || until === null) return true;

  if (until > from) return endMinute > from && startMinute < until;

  // An end time before the start time means the angler is available overnight.
  const overlapsEvening = endMinute > from && startMinute < until + 1440;
  const overlapsEarlyMorning = endMinute > from - 1440 && startMinute < until;
  return overlapsEvening || overlapsEarlyMorning;
}

function filterWindow(
  window: OpportunityWindow,
  filter: TimeFilter,
  nowMs: number,
  customStart: string,
  customEnd: string,
  availableFrom: string,
  availableUntil: string,
) {
  const start = new Date(window.start);
  const end = new Date(window.end);
  if (end.getTime() <= nowMs) return false;

  const now = new Date(nowMs);
  let matchesDate = false;
  if (filter === "today") {
    matchesDate = dateInputValue(start) === dateInputValue(now) || (start.getTime() <= nowMs && end.getTime() > nowMs);
  } else if (filter === "tomorrow") {
    matchesDate = dateInputValue(start) === shiftDateInput(dateInputValue(now), 1);
  } else {
    const rangeStart = dateFromInput(customStart);
    const rangeEndExclusive = dateFromInput(customEnd);
    rangeEndExclusive.setDate(rangeEndExclusive.getDate() + 1);
    matchesDate = end > rangeStart && start < rangeEndExclusive;
  }

  return matchesDate && overlapsAvailableHours(window, availableFrom, availableUntil);
}

function latestPerSite(
  windows: OpportunityWindow[],
  filter: TimeFilter,
  nowMs: number,
  customStart: string,
  customEnd: string,
  availableFrom: string,
  availableUntil: string,
) {
  const result = new Map<string, OpportunityWindow>();
  windows
    .filter((window) => filterWindow(
      window,
      filter,
      nowMs,
      customStart,
      customEnd,
      availableFrom,
      availableUntil,
    ))
    .forEach((window) => {
      const existing = result.get(window.siteId);
      if (!existing || window.score > existing.score) result.set(window.siteId, window);
    });
  return result;
}

interface StructureGuide {
  label: string;
  lookFor: string;
  fishIt: string;
}

const STRUCTURE_GUIDES: Record<string, StructureGuide> = {
  "channel-approach": {
    label: "Channel approach",
    lookFor: "Water that steadily deepens toward the main channel, often with a color or current change.",
    fishIt: "Fan casts across the change and work the lure from the shallow side into deeper water.",
  },
  "channel-edge": {
    label: "Channel edge",
    lookFor: "A drop from a flat into deeper moving water; foam, debris, or a color line can trace it.",
    fishIt: "Cast across the edge so the lure spends time moving up or down the drop.",
  },
  "channel-shoulder": {
    label: "Channel shoulder",
    lookFor: "The gentler ledge just before the bottom falls into the main channel.",
    fishIt: "Keep the lure close to bottom and cover both the top and face of the ledge.",
  },
  "current-seam": {
    label: "Current seam",
    lookFor: "A visible line where fast and slow water meet, sometimes marked by foam or drifting grass.",
    fishIt: "Work both sides of the seam, especially the slower side where fish can wait for bait.",
  },
  "dredged-channel": {
    label: "Dredged channel",
    lookFor: "A man-made deep lane beside a harbor, marina, or shipping route.",
    fishIt: "Target the lip rather than only the deepest middle; halibut often sit where the bottom changes.",
  },
  "dredged-edge": {
    label: "Dredged edge",
    lookFor: "The sharp boundary between a maintained channel and the surrounding shallow flat.",
    fishIt: "Cast diagonally along the edge and slow down when the lure reaches the depth change.",
  },
  "eelgrass-edge": {
    label: "Eelgrass edge",
    lookFor: "The border between grass and open sand, plus sandy pockets inside the grass.",
    fishIt: "Keep the lure on the clean sand beside the grass to stay near cover without fouling every cast.",
  },
  "gravel-slope": {
    label: "Gravel slope",
    lookFor: "A firmer, steeper patch where gravel or shell meets softer sand.",
    fishIt: "Work the bottom slowly across the change and note where the lure begins to tick harder ground.",
  },
  "pier-pilings": {
    label: "Pier pilings",
    lookFor: "Current shadows, bait, and scoured pockets around pilings—especially on the down-current side.",
    fishIt: "Cast beside the pilings and let the presentation sweep past them while staying ready for snags.",
  },
  pilings: {
    label: "Pilings",
    lookFor: "Current shadows, bait, and small scoured holes around the posts.",
    fishIt: "Fish close enough to use the cover, but keep the lure moving to avoid wrapping a post.",
  },
  "rip-channel": {
    label: "Rip channel",
    lookFor: "A gap in breaking waves or a darker lane where water and foam pull away from shore.",
    fishIt: "Cast across the rip and work its edges; avoid wading into the outgoing flow.",
  },
  "rock-sand-edge": {
    label: "Rock-to-sand edge",
    lookFor: "A visible color or texture change where reef, riprap, or scattered rock gives way to sand.",
    fishIt: "Favor the sand side of the boundary, where halibut can ambush bait without costing every lure.",
  },
  "reef-edge": {
    label: "Reef edge",
    lookFor: "The outside edge of rock or reef next to a clean sand lane.",
    fishIt: "Run the lure parallel to the edge or pull it onto the sand before it settles into the rocks.",
  },
  "sand-bar": {
    label: "Sand bar",
    lookFor: "A shallow bar marked by breaking water, with calmer or darker water on either side.",
    fishIt: "Cover the deeper inside trough and any cut where water crosses the bar.",
  },
  "sand-flat": {
    label: "Sand flat",
    lookFor: "Broad clean sand with small dips, darker patches, bait dimples, or subtle current lines.",
    fishIt: "Fan cast to cover water; repeat casts where depth or bottom feel changes even slightly.",
  },
  "mud-sand-flat": {
    label: "Mud-to-sand flat",
    lookFor: "A soft-bottom flat with firmer sandy lanes or patches that may concentrate bait.",
    fishIt: "Use a slow retrieve close to bottom and pay attention to changes in drag or lure feel.",
  },
  "sand-mud-flat": {
    label: "Sand-to-mud flat",
    lookFor: "Clean sand fading into softer mud, often visible as a water-color or bottom-feel change.",
    fishIt: "Work along the transition rather than straight across one uniform bottom type.",
  },
  "sand-trough": {
    label: "Sand trough",
    lookFor: "A long darker lane between the beach and an outer bar, often running parallel to shore.",
    fishIt: "Make some casts down the trough, not only straight out, and work any cuts that connect it offshore.",
  },
  trough: {
    label: "Trough",
    lookFor: "A deeper lane beside a beach, bar, jetty, or shoreline shelf.",
    fishIt: "Cast along the lane so the lure stays in the deeper water for more of the retrieve.",
  },
  "shelf-break": {
    label: "Shelf break",
    lookFor: "A broad shallow area that gives way to deeper water, sometimes marked by current or color.",
    fishIt: "Cover the lip and the first part of the slope instead of casting past it every time.",
  },
  "slope-break": {
    label: "Depth break",
    lookFor: "A noticeable bottom drop that interrupts an otherwise even flat.",
    fishIt: "Slow the retrieve as the lure climbs or falls across the break; that change is the target.",
  },
  "tidal-channel": {
    label: "Tidal channel",
    lookFor: "A deeper winding lane that drains a flat as the tide moves.",
    fishIt: "Focus on bends, mouths, and the slower edge of the flow rather than the fastest center.",
  },
  "tidal-drain": {
    label: "Tidal drain",
    lookFor: "A small cut where water leaves a marsh, flat, or harbor and carries bait with it.",
    fishIt: "Fish the mouth and down-current seam while water is moving, without blocking wildlife or access.",
  },
  riprap: {
    label: "Riprap edge",
    lookFor: "The base of shoreline rocks where hard cover meets sand and current is deflected.",
    fishIt: "Work parallel to the rocks or just off their base to stay near structure while limiting snags.",
  },
  jetty: {
    label: "Jetty edge",
    lookFor: "The sand beside the rocks, the current shadow, and the deeper water near the jetty tip.",
    fishIt: "Cast along the rock-to-sand line and give extra attention to the down-current side.",
  },
  "jetty-edge": {
    label: "Jetty edge",
    lookFor: "The boundary where jetty rock ends and a clean sand lane begins.",
    fishIt: "Keep the lure over sand but close to the rocks, especially around current breaks.",
  },
  "creek-mouth": {
    label: "Creek mouth",
    lookFor: "A cut, color change, or bait movement where creek water meets the bay or ocean.",
    fishIt: "Work the edges of the outflow when water is moving and avoid sensitive habitat.",
  },
  "estuary-mouth": {
    label: "Estuary mouth",
    lookFor: "A channel, sand edge, and current seam where protected water opens to the coast.",
    fishIt: "Target the slower edge of moving water and any nearby sandy pocket.",
  },
  "harbor-mouth": {
    label: "Harbor mouth",
    lookFor: "The channel edge and current break where protected harbor water meets open water.",
    fishIt: "Cover the inside corners and sand beside the channel while staying clear of vessel traffic.",
  },
  "lagoon-mouth": {
    label: "Lagoon mouth",
    lookFor: "A sandy cut and outflow seam where lagoon water reaches the ocean.",
    fishIt: "Work the edges when the mouth is open and respect seasonal closures and protected areas.",
  },
  "marina-mouth": {
    label: "Marina mouth",
    lookFor: "A dredged entrance, piling line, or current seam that gathers bait near deeper water.",
    fishIt: "Fish the edges and current shadows while keeping well clear of boats and restricted docks.",
  },
  cove: {
    label: "Cove edge",
    lookFor: "Protected water next to a point, beach, or deeper outside edge where bait can collect.",
    fishIt: "Start with the mouth and points, then cover the calmer sand inside.",
  },
  "protected-cove": {
    label: "Protected cove",
    lookFor: "Calmer water, a sandy pocket, and small current lines near the cove entrance.",
    fishIt: "Fish the mouth first, then fan cast the pocket if bait is present.",
  },
  "protected-bay": {
    label: "Protected bay",
    lookFor: "Calmer flats broken up by channels, points, grass, or marina edges.",
    fishIt: "Use the visible changes to narrow the water instead of casting the entire flat at random.",
  },
  "open-coast": {
    label: "Open beach",
    lookFor: "Troughs, rip cuts, points, and gaps in the breakers rather than one featureless stretch.",
    fishIt: "Walk and fan cast until you find a depth change or bait, then slow down and work that section.",
  },
};

function structureGuidesForSite(site: FishingSite) {
  const seen = new Set<string>();
  return site.structureTags
    .map((tag) => STRUCTURE_GUIDES[tag.toLowerCase().replaceAll(" ", "-")])
    .filter((guide): guide is StructureGuide => Boolean(guide))
    .filter((guide) => {
      if (seen.has(guide.label)) return false;
      seen.add(guide.label);
      return true;
    })
    .slice(0, 3);
}

function structureLabel(tag: string) {
  return STRUCTURE_GUIDES[tag.toLowerCase().replaceAll(" ", "-")]?.label
    ?? tag.replaceAll("-", " ");
}

function MetricBar({ label, value, note }: { label: string; value: number; note: string }) {
  return (
    <div className="metric-row">
      <div className="metric-copy">
        <span>{label}</span>
        <strong>{Math.round(value)}</strong>
      </div>
      <div className="metric-track" aria-label={`${label} ${Math.round(value)} out of 100`}>
        <span style={{ width: `${Math.max(3, Math.min(100, value))}%` }} />
      </div>
      <small>{note}</small>
    </div>
  );
}

function SourceStatus({ source }: { source: SourceFreshness }) {
  const statusTone = source.status.startsWith("fresh")
    ? "fresh"
    : source.status.startsWith("aging") || source.status.startsWith("provisional") || source.status.startsWith("demo")
      ? "aging"
      : "stale";
  const statusLabel = source.status.split(";")[0];
  return (
    <div className="source-row">
      <span className={`source-dot ${statusTone}`} />
      <div>
        <strong>{source.name}</strong>
        <small>{statusLabel} · {formatAge(source.observedAt)}</small>
      </div>
    </div>
  );
}

export function OpportunityApp() {
  const detailDialogRef = useRef<HTMLElement>(null);
  const detailTriggerRef = useRef<HTMLElement | null>(null);
  const detailTriggerSiteIdRef = useRef<string | null>(null);
  const [sites, setSites] = useState<FishingSite[]>(FALLBACK_SITES);
  const [snapshot, setSnapshot] = useState<OpportunitySnapshot>(fallbackSnapshot);
  const [communityPulses, setCommunityPulses] = useState<CommunityPulse[]>([]);
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null);
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("today");
  const [customStart, setCustomStart] = useState(() => dateInputValue(new Date()));
  const [customEnd, setCustomEnd] = useState(defaultCustomEnd);
  const [availableFrom, setAvailableFrom] = useState("");
  const [availableUntil, setAvailableUntil] = useState("");
  const [clockMs, setClockMs] = useState(() => Date.now());
  const [view, setView] = useState<"map" | "list">("map");
  const [region, setRegion] = useState("All water");
  const [radiusFilter, setRadiusFilter] = useState<"all" | "5" | "15" | "30" | "custom">("all");
  const [customRadiusMiles, setCustomRadiusMiles] = useState("20");
  const [userPosition, setUserPosition] = useState<[number, number] | null>(null);
  const [locationMessage, setLocationMessage] = useState("");
  const [showMethod, setShowMethod] = useState(false);
  const [showCompare, setShowCompare] = useState(false);
  const [dataState, setDataState] = useState<"loading" | "live" | "cached">("loading");
  const [installPrompt, setInstallPrompt] = useState<Event | null>(null);
  const [tripReportRequest, setTripReportRequest] = useState<TripReportRequest | null>(null);
  const tripReportRequestKey = useRef(0);

  useEffect(() => {
    let active = true;
    loadForecastData()
      .then(({ sites: nextSites, snapshot: nextSnapshot, community, state }) => {
        if (!active) return;
        setSites(nextSites);
        setSnapshot(nextSnapshot);
        setCommunityPulses(community);
        setDataState(state);
      })
      .catch(() => {
        if (active) setDataState("cached");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClockMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  useEffect(() => {
    if (!selectedSiteId || !detailDialogRef.current) return;

    const dialog = detailDialogRef.current;
    const previousBodyOverflow = document.body.style.overflow;
    const focusFrame = window.requestAnimationFrame(() => dialog.focus({ preventScroll: true }));

    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setSelectedSiteId(null);
        return;
      }

      if (event.key !== "Tab") return;

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.getAttribute("aria-hidden") !== "true");

      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = document.activeElement;

      if (event.shiftKey && (activeElement === first || !dialog.contains(activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (activeElement === last || !dialog.contains(activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousBodyOverflow;

      const trigger = detailTriggerRef.current;
      const triggerSiteId = detailTriggerSiteIdRef.current;
      window.requestAnimationFrame(() => {
        if (trigger?.isConnected) {
          trigger.focus({ preventScroll: true });
          return;
        }

        if (!triggerSiteId) return;
        document
          .querySelector<HTMLElement>(`[data-detail-trigger-for="${triggerSiteId}"]`)
          ?.focus({ preventScroll: true });
      });
    };
  }, [selectedSiteId]);

  const windowsBySite = useMemo(
    () => latestPerSite(
      snapshot.windows,
      timeFilter,
      clockMs,
      customStart,
      customEnd,
      availableFrom,
      availableUntil,
    ),
    [snapshot.windows, timeFilter, clockMs, customStart, customEnd, availableFrom, availableUntil],
  );

  const maxForecastDate = useMemo(() => {
    const latest = snapshot.windows.reduce(
      (maximum, window) => Math.max(maximum, new Date(window.start).getTime()),
      clockMs,
    );
    return dateInputValue(new Date(latest));
  }, [snapshot.windows, clockMs]);

  const regions = useMemo(
    () => ["All water", ...Array.from(new Set(sites.map((site) => site.region))).sort()],
    [sites],
  );

  const closedSites = useMemo(
    () => sites.filter((site) => site.accessStatus === "closed"),
    [sites],
  );

  const activeRadiusMiles = radiusFilter === "all"
    ? null
    : radiusFilter === "custom"
      ? Math.min(50, Math.max(1, Number(customRadiusMiles) || 20))
      : Number(radiusFilter);
  const locationStatusMessage = userPosition
    ? activeRadiusMiles
      ? `Showing access within ${activeRadiusMiles} miles`
      : "Sorted with nearby access first"
    : locationMessage;

  const rankedSites = useMemo(() => {
    return sites
      .filter((site) => site.accessStatus !== "closed")
      .filter((site) => region === "All water" || site.region === region)
      .map((site) => ({
        ...site,
        distanceMiles: userPosition
          ? distanceMiles(userPosition, [site.longitude, site.latitude])
          : undefined,
      }))
      .filter((site) => (
        !userPosition || activeRadiusMiles === null ||
        site.distanceMiles === undefined || site.distanceMiles <= activeRadiusMiles
      ))
      .filter((site) => windowsBySite.has(site.id))
      .sort((a, b) => {
        if (userPosition && a.distanceMiles !== undefined && b.distanceMiles !== undefined) {
          const distanceDifference = a.distanceMiles - b.distanceMiles;
          if (Math.abs(distanceDifference) > 8) return distanceDifference;
        }
        return (windowsBySite.get(b.id)?.score ?? 0) - (windowsBySite.get(a.id)?.score ?? 0);
      });
  }, [activeRadiusMiles, sites, region, userPosition, windowsBySite]);

  const bestSite = rankedSites[0] ?? null;
  const bestWindow = bestSite ? windowsBySite.get(bestSite.id) ?? null : null;
  const selectedSite = sites.find((site) => site.id === selectedSiteId) ?? null;
  const selectedWindow = selectedSiteId ? windowsBySite.get(selectedSiteId) ?? null : null;
  const selectedCommunity = selectedSiteId
    ? communityPulses.find((pulse) => pulse.siteId === selectedSiteId) ?? null
    : null;
  const selectedStructureGuides = selectedSite ? structureGuidesForSite(selectedSite) : [];
  const hasHourFilter = Boolean(availableFrom || availableUntil);
  const strongestWindowLabel = hasHourFilter
    ? "Best match for your hours"
    : timeFilter === "today"
      ? "Best option left today"
      : timeFilter === "tomorrow"
        ? "Best option tomorrow"
        : "Best option in your range";

  const requestLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setLocationMessage("Location is not available in this browser.");
      return;
    }
    setLocationMessage("Locating…");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setUserPosition([position.coords.longitude, position.coords.latitude]);
        setLocationMessage(activeRadiusMiles
          ? `Showing access within ${activeRadiusMiles} miles`
          : "Sorted with nearby access first");
      },
      () => setLocationMessage("Location permission was not granted."),
      { enableHighAccuracy: false, timeout: 8000 },
    );
  }, [activeRadiusMiles]);

  const triggerInstall = useCallback(() => {
    if (!installPrompt) return;
    const promptEvent = installPrompt as Event & { prompt: () => Promise<void> };
    void promptEvent.prompt();
    setInstallPrompt(null);
  }, [installPrompt]);

  const openSiteDetail = useCallback((siteId: string) => {
    const activeElement = document.activeElement;
    detailTriggerRef.current = activeElement instanceof HTMLElement ? activeElement : null;
    detailTriggerSiteIdRef.current = siteId;
    setSelectedSiteId(siteId);
  }, []);

  const closeSiteDetail = useCallback(() => {
    setSelectedSiteId(null);
  }, []);

  const openTripReport = useCallback((mode: "start" | "past", siteId?: string, window?: OpportunityWindow) => {
    tripReportRequestKey.current += 1;
    setTripReportRequest({ key: tripReportRequestKey.current, mode, siteId, window });
  }, []);

  const scrollToSection = useCallback((sectionId: "forecast" | "sources") => {
    setShowMethod(false);
    setShowCompare(false);

    window.requestAnimationFrame(() => {
      const target = document.getElementById(sectionId);
      if (!target) return;

      const topbar = document.querySelector<HTMLElement>(".topbar");
      const topbarHeight = topbar?.getBoundingClientRect().height ?? 0;
      const top = target.getBoundingClientRect().top + window.scrollY - topbarHeight - 16;
      const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      window.scrollTo({
        top: Math.max(0, top),
        behavior: prefersReducedMotion ? "auto" : "smooth",
      });

      const hash = `#${sectionId}`;
      if (window.location.hash !== hash) window.history.pushState(null, "", hash);
    });
  }, []);

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="ContourCast home">
          <LogoMark />
          <span>ContourCast</span>
          <em>Bay Area beta</em>
        </a>
        <nav className="desktop-nav" aria-label="Primary navigation">
          <button type="button" onClick={() => scrollToSection("forecast")}>Forecast</button>
          <button type="button" onClick={() => setShowMethod(true)}>How It Works</button>
          <button type="button" onClick={() => scrollToSection("sources")}>Data</button>
        </nav>
        <div className="topbar-actions">
          <button className="log-trip-button" type="button" onClick={() => openTripReport("past")}>Log trip</button>
          <button
            className={`data-pill ${dataState}`}
            type="button"
            onClick={() => scrollToSection("sources")}
            aria-label={`Open forecast data sources. Current status: ${dataState}`}
          >
            <i /> {dataState === "loading" ? "Loading" : dataState === "live" ? "Live data" : "Cached"}
          </button>
          {installPrompt ? (
            <button className="install-button" type="button" onClick={triggerInstall}>
              <DownloadIcon /> Install
            </button>
          ) : null}
        </div>
      </header>

      <section className="forecast-intro" id="top">
        <div className="eyebrow-row">
          <span className="eyebrow"><span /> California halibut</span>
          <button className="method-link" type="button" onClick={() => setShowMethod(true)}>
            What does the score mean? <InfoIcon />
          </button>
        </div>
        <div className="intro-grid">
          <div>
            <h1>Find the water<br />worth fishing.</h1>
            <p>
              Pick the hours you have. We compare public shore and pier spots using bottom structure,
              time of year, tides, wind, and water conditions.
            </p>
          </div>
          {bestSite && bestWindow ? (
            <button className="next-window-card" type="button" onClick={() => openSiteDetail(bestSite.id)}>
              <div className={`score-orbit ${scoreTone(bestWindow.score)}`}>
                <span>{Math.round(bestWindow.score)}</span>
                <small>of 100</small>
              </div>
              <div className="next-window-copy">
                <span>{strongestWindowLabel}</span>
                <strong>{bestSite.name}</strong>
                <p><ClockIcon /> {formatWindow(bestWindow.start, bestWindow.end)}</p>
              </div>
              <ArrowIcon className="next-arrow" />
            </button>
          ) : (
            <div className="empty-window">No fishing times match your current choices.</div>
          )}
        </div>
      </section>

      <section className="control-deck" id="forecast">
        <div className="time-tabs" role="tablist" aria-label="Forecast period">
          {([
            ["today", "Today"],
            ["tomorrow", "Tomorrow"],
            ["custom", "Custom"],
          ] as [TimeFilter, string][]).map(([value, label]) => (
            <button
              key={value}
              role="tab"
              aria-selected={timeFilter === value}
              className={timeFilter === value ? "active" : ""}
              type="button"
              onClick={() => setTimeFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {timeFilter === "custom" ? (
          <div className="custom-date-range" aria-label="Custom forecast date range">
            <label>
              <span>From</span>
              <input
                type="date"
                min={dateInputValue(new Date(clockMs))}
                max={maxForecastDate}
                value={customStart}
                onChange={(event) => {
                  const nextStart = event.target.value;
                  setCustomStart(nextStart);
                  if (nextStart > customEnd) setCustomEnd(nextStart);
                }}
              />
            </label>
            <span aria-hidden="true">to</span>
            <label>
              <span>Through</span>
              <input
                type="date"
                min={customStart}
                max={maxForecastDate}
                value={customEnd}
                onChange={(event) => setCustomEnd(event.target.value)}
              />
            </label>
          </div>
        ) : null}
        <div className="availability-filter" aria-label="Hours available to fish">
          <div className="availability-copy">
            <strong>When can you fish?</strong>
            <span>The best time to fish is when you have time. We’ll find your best options inside it.</span>
          </div>
          <label>
            <span>From</span>
            <input
              type="time"
              step="1800"
              value={availableFrom}
              onChange={(event) => setAvailableFrom(event.target.value)}
              aria-label="Available from"
            />
          </label>
          <span aria-hidden="true">to</span>
          <label>
            <span>Until</span>
            <input
              type="time"
              step="1800"
              value={availableUntil}
              onChange={(event) => setAvailableUntil(event.target.value)}
              aria-label="Available until"
            />
          </label>
          {hasHourFilter ? (
            <button type="button" onClick={() => {
              setAvailableFrom("");
              setAvailableUntil("");
            }}>Any time</button>
          ) : null}
        </div>
        <div className="filters">
          <label>
            <span>Area</span>
            <select value={region} onChange={(event) => setRegion(event.target.value)}>
              {regions.map((option) => <option key={option}>{option}</option>)}
            </select>
          </label>
          <label className="radius-filter">
            <span>Radius</span>
            <select
              aria-label="Distance from my location"
              value={radiusFilter}
              onChange={(event) => {
                const nextRadius = event.target.value as typeof radiusFilter;
                setRadiusFilter(nextRadius);
                if (nextRadius !== "all" && !userPosition) requestLocation();
              }}
            >
              <option value="all">Any distance</option>
              <option value="5">Within 5 mi</option>
              <option value="15">Within 15 mi</option>
              <option value="30">Within 30 mi</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          {radiusFilter === "custom" ? (
            <label className="custom-radius-filter">
              <span>Miles</span>
              <input
                aria-label="Custom radius in miles"
                type="number"
                min="1"
                max="50"
                step="1"
                inputMode="numeric"
                value={customRadiusMiles}
                onChange={(event) => setCustomRadiusMiles(event.target.value)}
                onBlur={() => setCustomRadiusMiles(String(activeRadiusMiles ?? 20))}
              />
            </label>
          ) : null}
          <button type="button" className="location-button" onClick={requestLocation}>
            <LocateIcon /> Near me
          </button>
          <div className="view-toggle" aria-label="View">
            <button type="button" className={view === "map" ? "active" : ""} onClick={() => setView("map")} aria-label="Map view"><MapIcon /></button>
            <button type="button" className={view === "list" ? "active" : ""} onClick={() => setView("list")} aria-label="List view"><ListIcon /></button>
          </div>
        </div>
        {locationStatusMessage ? <p className="location-message">{locationStatusMessage}</p> : null}
        {closedSites.length > 0 ? (
          <p className="closure-notice">
            {closedSites.length} temporarily closed access point{closedSites.length === 1 ? " is" : "s are"} excluded from ranking.
            {closedSites[0].accessSourceUrl ? (
              <> <a href={closedSites[0].accessSourceUrl} target="_blank" rel="noreferrer">Official status ↗</a></>
            ) : null}
          </p>
        ) : null}
      </section>

      <section className={`workspace ${view === "list" ? "list-only" : ""}`}>
        <div className="map-wrap">
          <ContourMap
            sites={rankedSites}
            windowsBySite={windowsBySite}
            selectedSiteId={selectedSiteId}
            onSelectSite={openSiteDetail}
            userPosition={userPosition}
          />
          <div className="map-overlay-label"><LayersIcon /> {rankedSites.length} spots · tap a group to spread it out</div>
          <div className="map-legend">
            <span><i className="cluster" />Grouped</span>
            <span><i className="excellent" />80+</span>
            <span><i className="good" />65–79</span>
            <span><i className="fair" />45–64</span>
            <span><i className="quiet" />Below 45</span>
          </div>
        </div>

        <div className="ranking-panel">
          <div className="panel-heading">
            <div>
              <span>Fishing spots</span>
              <h2>{rankedSites.length} options</h2>
            </div>
            <div className="panel-actions">
              <small>Updated {formatAge(snapshot.generatedAt)}</small>
              <button type="button" onClick={() => setShowCompare(true)}>Compare top 3</button>
            </div>
          </div>
          <div className="site-list">
            {rankedSites.map((site, index) => {
              const window = windowsBySite.get(site.id)!;
              return (
                <button
                  type="button"
                  className={`site-card ${selectedSiteId === site.id ? "selected" : ""}`}
                  key={site.id}
                  data-detail-trigger-for={site.id}
                  onClick={() => openSiteDetail(site.id)}
                >
                  <span className="site-rank">{String(index + 1).padStart(2, "0")}</span>
                  <div className={`site-score ${scoreTone(window.score)}`}>{Math.round(window.score)}</div>
                  <div className="site-card-copy">
                    <div><strong>{site.name}</strong><em>{site.type}</em></div>
                    <p><ClockIcon /> {formatWindow(window.start, window.end, true)}</p>
                    <div className="tag-row">
                      {site.structureTags.slice(0, 2).map((tag) => <span key={tag}>{structureLabel(tag)}</span>)}
                      {site.distanceMiles !== undefined ? <span>{site.distanceMiles.toFixed(1)} mi</span> : null}
                    </div>
                  </div>
                  <ChevronIcon className="site-chevron" />
                </button>
              );
            })}
            {rankedSites.length === 0 ? (
              <div className="no-results">
                <strong>No fishing times match</strong>
                <p>Try widening your hours, date range, area, or distance.</p>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <section className="score-note">
        <div className="score-note-number">80</div>
        <div>
          <span>Read the score correctly</span>
          <p>
            A score of 80 means this window ranks above 80% of the options evaluated right now.
            It is <strong>not</strong> an 80% chance of catching a fish.
          </p>
        </div>
        <button type="button" onClick={() => setShowMethod(true)}>How It Works <ArrowIcon /></button>
      </section>

      <TripReportFeature sites={sites} snapshot={snapshot} request={tripReportRequest} />

      <section className="source-section" id="sources">
        <div className="source-heading">
          <span>Forecast check</span>
          <h2>See what is current.</h2>
          <p>Old weather and tide readings are not treated as live. If something is too old to trust, it is left out.</p>
        </div>
        <div className="source-grid">
          {snapshot.sources.map((source) => <SourceStatus key={source.name} source={source} />)}
        </div>
      </section>

      <footer>
        <a className="brand footer-brand" href="#top"><LogoMark /><span>ContourCast</span></a>
        <p>Planning aid only. Not navigational data, legal advice, or a guarantee of catch.</p>
        <div>
          <a href="https://wildlife.ca.gov/Fishing/Ocean/Regulations/Fishing-Map/sf-bay" target="_blank" rel="noreferrer">CDFW Bay regulations ↗</a>
          <a href="https://wildlife.ca.gov/Fishing/Ocean/Regulations/Fishing-Map/San-Francisco" target="_blank" rel="noreferrer">Coast regulations ↗</a>
          <a href="https://open-meteo.com/en/docs/marine-weather-api" target="_blank" rel="noreferrer">Marine weather by Open-Meteo · Météo-France ↗</a>
        </div>
      </footer>

      {selectedSite && selectedWindow ? (
        <div className="detail-layer" role="presentation" onClick={(event) => {
          if (event.target === event.currentTarget) closeSiteDetail();
        }}>
          <aside
            ref={detailDialogRef}
            className="detail-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="detail-title"
            tabIndex={-1}
          >
            <div className="sheet-handle" />
            <button className="sheet-close" type="button" onClick={closeSiteDetail} aria-label="Close details"><CloseIcon /></button>
            <div className="sheet-topline">
              <span>{selectedSite.region} · {selectedSite.type}</span>
              <span className={`confidence ${selectedWindow.confidence}`}>{selectedWindow.confidence} confidence</span>
            </div>
            <h2 id="detail-title">{selectedSite.name}</h2>
            <p className="sheet-window"><ClockIcon /> {formatWindow(selectedWindow.start, selectedWindow.end)}</p>

            <button
              className="fish-window-button"
              type="button"
              onClick={() => {
                openTripReport("start", selectedSite.id, selectedWindow);
                closeSiteDetail();
              }}
            >
              Fish this window <ArrowIcon />
            </button>

            <div className="place-media-block">
              <h3>See the access</h3>
              <p>Check photos, the shoreline, and directions before you leave.</p>
              <div className="place-media-links">
                <a href={googleMapsSearchUrl(selectedSite)} target="_blank" rel="noreferrer">Photos &amp; reviews ↗</a>
                <a href={googleStreetViewUrl(selectedSite)} target="_blank" rel="noreferrer">Street View 360° ↗</a>
                <a href={googleSatelliteUrl(selectedSite)} target="_blank" rel="noreferrer">Satellite view ↗</a>
                <a href={googleDirectionsUrl(selectedSite)} target="_blank" rel="noreferrer">Directions ↗</a>
              </div>
              <small>Street View coverage varies, and Google may open the nearest available panorama.</small>
            </div>

            <div className="detail-score-block">
              <div className={`detail-score ${scoreTone(selectedWindow.score)}`}>
                <strong>{Math.round(selectedWindow.score)}</strong>
                <span>Opportunity<br />Score</span>
              </div>
              <p>Ranks ahead of <strong>{Math.round(selectedWindow.score)}%</strong> of the spots and times currently available.</p>
            </div>

            <div className="component-block">
              <h3>Why this time stands out</h3>
              <MetricBar label="Bottom" value={selectedWindow.habitatScore} note="How fishy the nearby structure looks" />
              <MetricBar label="Time of year" value={selectedWindow.seasonalityScore} note="How this month usually fishes" />
              <MetricBar label="Today’s conditions" value={selectedWindow.dynamicScore} note="Tide, wind, swell, and daylight" />
            </div>

            {selectedStructureGuides.length > 0 ? (
              <div className="structure-guide-block">
                <h3>Structure to look for</h3>
                <p>Use these clues to narrow down the water once you arrive.</p>
                <div className="structure-guide-grid">
                  {selectedStructureGuides.map((guide) => (
                    <article key={guide.label}>
                      <strong>{guide.label}</strong>
                      <p>{guide.lookFor}</p>
                      <small><b>How to fish it:</b> {guide.fishIt}</small>
                    </article>
                  ))}
                </div>
                {selectedSite.depthProfile ? <p className="structure-depth-note">At this spot: {selectedSite.depthProfile}</p> : null}
              </div>
            ) : null}

            <div className="factor-block">
              {selectedWindow.explanationFactors.map((factor) => <span key={factor}>{factor}</span>)}
            </div>

            <div className="conditions-grid">
              <div><TideIcon /><span>Tide</span><strong>{selectedWindow.conditions.tideStage ?? "Unavailable"}</strong></div>
              <div><WindIcon /><span>Wind</span><strong>{isFiniteNumber(selectedWindow.conditions.windMph) ? `${Math.round(selectedWindow.conditions.windMph)} mph` : "Unavailable"}</strong></div>
              <div>
                <TemperatureIcon />
                <span>Water temp</span>
                <strong>
                  {isFiniteNumber(selectedWindow.conditions.waterTempF)
                    ? `${Math.round(selectedWindow.conditions.waterTempF)}°F`
                    : "Unavailable"}
                </strong>
              </div>
            </div>
            {isFiniteNumber(selectedWindow.conditions.ndbcObservedWaterTempF) ? (
              <p className="condition-source-note">
                Latest nearby buoy reading: {Math.round(selectedWindow.conditions.ndbcObservedWaterTempF)}°F
                {selectedWindow.conditions.ndbcObservedAt ? ` · ${formatAge(selectedWindow.conditions.ndbcObservedAt)}` : ""}. For reference only.
              </p>
            ) : null}

            <div className="detail-freshness">
              <h3>Latest conditions</h3>
              {(selectedWindow.sources ?? snapshot.sources).slice(0, 6).map((source) => {
                const tone = source.status.startsWith("fresh")
                  ? "fresh"
                  : source.status.includes("excluded") || source.status.includes("not integrated")
                    ? "stale"
                    : "aging";
                return (
                  <span key={source.name} title={source.detail}>
                    <i className={tone} /> {source.name.replace("NOAA ", "")}
                  </span>
                );
              })}
            </div>

            <div className="access-block">
              <h3>Access notes</h3>
              <p>{selectedSite.access}</p>
              {selectedSite.accessSourceUrl ? (
                <a href={selectedSite.accessSourceUrl} target="_blank" rel="noreferrer">Check official access status ↗</a>
              ) : null}
            </div>

            <div className="community-pulse-block">
              <div className="community-pulse-heading">
                <h3>What anglers have said</h3>
                <span>Past discussion, not a live bite report</span>
              </div>
              {selectedCommunity ? (
                <>
                  <p>{selectedCommunity.summary}</p>
                  <div className="factor-block community-themes">
                    {selectedCommunity.themes.map((theme) => (
                      <span key={theme.label} title={theme.note}>{theme.label}</span>
                    ))}
                  </div>
                  <p className="community-meta">
                    {selectedCommunity.confidence} confidence · {selectedCommunity.coverage} · reviewed {formatAge(selectedCommunity.reviewedAt)}
                  </p>
                  <div className="community-sources" aria-label="Community pulse sources">
                    {selectedCommunity.sources.map((source) => (
                      <a key={`${source.url}-${source.label}`} href={source.url} target="_blank" rel="noreferrer">
                        {source.label}{source.publishedAt ? ` · ${source.publishedAt.slice(0, 10)}` : ""} ↗
                      </a>
                    ))}
                  </div>
                </>
              ) : (
                <p>We have not added an angler discussion summary for this spot yet.</p>
              )}
              <small>
                These summaries do not change the score. Logging a complete catch or skunk helps us check and improve the rankings.
              </small>
            </div>

            <a className="regulations-link" href={selectedSite.regulationUrl} target="_blank" rel="noreferrer">
              Check current CDFW regulations <ArrowIcon />
            </a>
            <p className="model-stamp">Forecast {selectedWindow.modelVersion ?? snapshot.modelVersion} · updated {formatAge(snapshot.generatedAt)}</p>
            <p className="legal-note">Rules and access can change. Confirm official regulations and posted site closures before fishing.</p>
          </aside>
        </div>
      ) : null}

      {showMethod ? (
        <div className="modal-layer" role="presentation" onClick={(event) => {
          if (event.target === event.currentTarget) setShowMethod(false);
        }}>
          <section className="method-modal" role="dialog" aria-modal="true" aria-labelledby="method-title">
            <button className="sheet-close" type="button" onClick={() => setShowMethod(false)} aria-label="Close methodology"><CloseIcon /></button>
            <span className="eyebrow"><span /> Model note</span>
            <h2 id="method-title">A ranking, not a promise.</h2>
            <p>
              ContourCast compares reachable casting zones and upcoming two-hour windows. The 0–100 value is a percentile within that current comparison set—not a catch probability.
            </p>
            <div className="method-equation">
              <div><span>01</span><strong>Habitat</strong><p>Depth, slope, roughness, channel edges, shoreline distance, and public historical catch patterns.</p></div>
              <b>×</b>
              <div><span>02</span><strong>Season</strong><p>Monthly California halibut catch and effort patterns from public recreational fisheries data.</p></div>
              <b>×</b>
              <div><span>03</span><strong>Conditions</strong><p>Tide, current, wind, swell, and daylight—with hard bounds. Modeled SST is shown separately as unscored context.</p></div>
            </div>
            <div className="method-callout">
              <InfoIcon />
              <p><strong>Deep-learning status: research pipeline, not the live score.</strong> The current live Habitat score is a labeled, curated proxy—not output from a trained neural network.</p>
            </div>
            <div className="method-callout">
              <InfoIcon />
              <p>
                The research pipeline sends a ten-channel, three-scale bathymetry stack into a shared-weight ResNet/SimCLR encoder. Full-survey self-supervised pretraining is complete on 4,096 official USGS 2 m locations. A frozen probe beat depth-only features on an unseen region, but did not beat the strongest classical structure baseline, so it was not promoted to the live score.
              </p>
            </div>
            <a
              href="#sources"
              onClick={(event) => {
                event.preventDefault();
                scrollToSection("sources");
              }}
            >
              Inspect source freshness <ArrowIcon />
            </a>
          </section>
        </div>
      ) : null}

      {showCompare ? (
        <div className="modal-layer" role="presentation" onClick={(event) => {
          if (event.target === event.currentTarget) setShowCompare(false);
        }}>
          <section className="compare-modal" role="dialog" aria-modal="true" aria-labelledby="compare-title">
            <button className="sheet-close" type="button" onClick={() => setShowCompare(false)} aria-label="Close comparison"><CloseIcon /></button>
            <span className="eyebrow"><span /> Side by side</span>
            <h2 id="compare-title">Compare your<br />best options.</h2>
            <p>These are the three best matches for your current area, date, and available hours.</p>
            <div className="compare-grid">
              {rankedSites.slice(0, 3).map((site, index) => {
                const window = windowsBySite.get(site.id)!;
                return (
                  <article key={site.id}>
                    <div className="compare-card-top">
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <strong className={scoreTone(window.score)}>{Math.round(window.score)}</strong>
                    </div>
                    <h3>{site.name}</h3>
                    <p><ClockIcon /> {formatWindow(window.start, window.end)}</p>
                    <MetricBar label="Bottom" value={window.habitatScore} note="Structure" />
                    <MetricBar label="Time of year" value={window.seasonalityScore} note="Season" />
                    <MetricBar label="Conditions" value={window.dynamicScore} note="Tide, wind, and swell" />
                    <button type="button" onClick={() => {
                      setShowCompare(false);
                      openSiteDetail(site.id);
                    }}>Open details <ArrowIcon /></button>
                  </article>
                );
              })}
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
