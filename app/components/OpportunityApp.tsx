"use client";

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { AccountModal, useAccount } from "./AccountFeature";
import { TripReportFeature } from "./TripReportFeature";
import {
  ArrowIcon,
  ChevronIcon,
  CloudIcon,
  ClockIcon,
  CloseIcon,
  DownloadIcon,
  InfoIcon,
  LayersIcon,
  ListIcon,
  LocateIcon,
  MapIcon,
  MoonIcon,
  PressureIcon,
  TemperatureIcon,
  TideIcon,
  WindIcon,
  WaveIcon,
} from "./icons";
import type {
  CommunityPulse,
  FishingSite,
  LocationDiscussionPost,
  OpportunitySnapshot,
  OpportunityWindow,
  SourceFreshness,
  TimeFilter,
  TripReportRequest,
} from "../types";
import {
  applyCurrentFreshness,
  hasLiveForecastInputs,
  sourceStatusTone,
} from "../lib/forecast-freshness";

const PACIFIC_TIME_ZONE = "America/Los_Angeles";
const ContourMap = lazy(() => import("./ContourMap").then((module) => ({ default: module.ContourMap })));

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
    fishability_score?: number;
  };
  confidence: { level: string };
  explanation_factors: Array<{ label: string; detail: string }>;
  model_version: string;
  generated_at: string;
  source_freshness: ApiSourceFreshness[];
  conditions?: {
    tide_stage?: string | null;
    tide_change_feet?: number | null;
    tide_levels_feet?: [number, number, number, number] | null;
    current_knots?: number | null;
    current_direction_degrees?: number | null;
    current_direction?: string | null;
    wind_mph?: number | null;
    swell_feet?: number | null;
    swell_period_seconds?: number | null;
    swell_direction_degrees?: number | null;
    swell_direction?: string | null;
    wave_power_kw_m?: number | null;
    breaking_intensity?: string | null;
    breaking_wave_height_feet?: number | null;
    fishability_label?: string | null;
    fishability_reasons?: string[] | null;
    water_temp_f?: number | null;
    water_temp_source?: string | null;
    ndbc_observed_water_temp_f?: number | null;
    ndbc_observed_at?: string | null;
    daylight?: boolean | null;
    cloud_cover_pct?: number | null;
    pressure_hpa?: number | null;
    pressure_trend_hpa_3h?: number | null;
    pressure_observed_at?: string | null;
    moon_phase?: string | null;
    moon_illumination_pct?: number | null;
    fishing_pressure?: string | null;
    fishing_pressure_pct?: number | null;
    access_adjustment_points?: number | null;
    fishing_pressure_basis?: string | null;
  } | null;
  rank?: number | null;
}

interface ApiOpportunityResponse {
  generated_at: string;
  score_definition: string;
  windows: ApiOpportunityWindow[];
}

function sourceUrlForName(name: string) {
  const normalized = name.toLowerCase();
  if (normalized.includes("tide")) return "https://api.tidesandcurrents.noaa.gov/api/prod/";
  if (normalized.includes("weather") || normalized.includes("nws")) return "https://api.weather.gov/";
  if (normalized.includes("buoy") || normalized.includes("ndbc") || normalized.includes("pressure")) return "https://www.ndbc.noaa.gov/";
  if (normalized.includes("temperature") || normalized.includes("sst") || normalized.includes("marine") || normalized.includes("wave")) return "https://open-meteo.com/en/docs/marine-weather-api";
  if (normalized.includes("moon")) return "https://aa.usno.navy.mil/data/MoonFraction";
  if (normalized.includes("bathymetry")) return "https://www.ncei.noaa.gov/maps/bathymetry/";
  return undefined;
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
          url: sourceUrlForName(source.source),
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
      fishabilityScore: window.components.fishability_score ?? window.components.dynamic_score,
      confidence: window.confidence.level,
      rank: window.rank ?? undefined,
      explanationFactors: window.explanation_factors.map((factor) => factor.detail || factor.label),
      conditions: {
        tideStage: window.conditions?.tide_stage ?? undefined,
        tideChangeFeet: window.conditions?.tide_change_feet ?? undefined,
        tideLevelsFeet: window.conditions?.tide_levels_feet ?? undefined,
        currentKnots: window.conditions?.current_knots ?? undefined,
        currentDirectionDegrees: window.conditions?.current_direction_degrees ?? undefined,
        currentDirection: window.conditions?.current_direction ?? undefined,
        windMph: window.conditions?.wind_mph ?? undefined,
        swellFeet: window.conditions?.swell_feet ?? undefined,
        swellPeriodSeconds: window.conditions?.swell_period_seconds ?? undefined,
        swellDirectionDegrees: window.conditions?.swell_direction_degrees ?? undefined,
        swellDirection: window.conditions?.swell_direction ?? undefined,
        wavePowerKwM: window.conditions?.wave_power_kw_m ?? undefined,
        breakingIntensity: window.conditions?.breaking_intensity ?? undefined,
        breakingWaveHeightFeet: window.conditions?.breaking_wave_height_feet ?? undefined,
        fishabilityLabel: window.conditions?.fishability_label ?? undefined,
        fishabilityReasons: window.conditions?.fishability_reasons ?? undefined,
        waterTempF: window.conditions?.water_temp_f ?? undefined,
        waterTempSource: window.conditions?.water_temp_source ?? undefined,
        ndbcObservedWaterTempF: window.conditions?.ndbc_observed_water_temp_f ?? undefined,
        ndbcObservedAt: window.conditions?.ndbc_observed_at ?? undefined,
        daylight: window.conditions?.daylight ?? undefined,
        cloudCoverPct: window.conditions?.cloud_cover_pct ?? undefined,
        pressureHpa: window.conditions?.pressure_hpa ?? undefined,
        pressureTrendHpa3h: window.conditions?.pressure_trend_hpa_3h ?? undefined,
        pressureObservedAt: window.conditions?.pressure_observed_at ?? undefined,
        moonPhase: window.conditions?.moon_phase ?? undefined,
        moonIlluminationPct: window.conditions?.moon_illumination_pct ?? undefined,
        fishingPressure: window.conditions?.fishing_pressure ?? undefined,
        fishingPressurePct: window.conditions?.fishing_pressure_pct ?? undefined,
        accessAdjustmentPoints: window.conditions?.access_adjustment_points ?? undefined,
        fishingPressureBasis: window.conditions?.fishing_pressure_basis ?? undefined,
      },
      modelVersion: window.model_version,
      sources: window.source_freshness.map((source) => ({
        name: source.source.replaceAll("_", " "),
        observedAt: source.observed_at ?? source.checked_at,
        status: source.status,
        ageMinutes: source.age_minutes ?? undefined,
        freshnessLimitMinutes: source.freshness_limit_minutes,
        detail: source.excluded_reason ?? undefined,
        url: sourceUrlForName(source.source),
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
      const snapshot = applyCurrentFreshness(normalizeApiSnapshot(apiSnapshot));
      return {
        sites: staticSites,
        snapshot,
        community,
        state: hasLiveForecastInputs(snapshot)
          ? "live" as const
          : "cached" as const,
      };
    } catch {
      const response = await fetch("/data/opportunities.json");
      if (!response.ok) throw new Error("API and snapshot unavailable");
      const snapshot = applyCurrentFreshness((await response.json()) as OpportunitySnapshot);
      return {
        sites: staticSites,
        snapshot,
        community,
        state: hasLiveForecastInputs(snapshot)
          ? "live" as const
          : "cached" as const,
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
  const currentSnapshot = applyCurrentFreshness(staticSnapshot);
  const state = hasLiveForecastInputs(currentSnapshot) ? "live" : "cached";
  return { sites: staticSites, snapshot: currentSnapshot, community, state: state as "live" | "cached" };
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
    fishabilityScore: 66 - index * 3,
    confidence: "low",
    rank: index + 1,
    explanationFactors: ["Accessible casting zone", "Seasonal halibut pattern", "Cached conditions"],
    conditions: {
      tideStage: "Loading",
      windMph: 9,
      waterTempF: 58,
      daylight: true,
      cloudCoverPct: 45,
      moonPhase: "waxing crescent",
      moonIlluminationPct: 32,
    },
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
  const latitude = site.streetViewLatitude ?? site.latitude;
  const longitude = site.streetViewLongitude ?? site.longitude;
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${latitude}%2C${longitude}`;
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
  if (compact) return `${day}, ${start.toLocaleTimeString("en-US", timeOptions)}–${end.toLocaleTimeString("en-US", timeOptions)}`;
  return `${day} · ${start.toLocaleTimeString("en-US", timeOptions)}–${end.toLocaleTimeString("en-US", timeOptions)}`;
}

function formatTimeOnly(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: PACIFIC_TIME_ZONE,
  });
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

interface AvailabilityFit {
  matches: boolean;
  overlapMinutes: number;
  gapMinutes: number;
}

function availabilityFit(window: OpportunityWindow, availableFrom: string, availableUntil: string): AvailabilityFit {
  const from = timeInputMinutes(availableFrom);
  const until = timeInputMinutes(availableUntil);
  if (from === null && until === null) return { matches: true, overlapMinutes: 0, gapMinutes: 0 };

  const windowStart = new Date(window.start);
  const windowEnd = new Date(window.end);
  const startMinute = pacificClockMinutes(windowStart);
  let endMinute = pacificClockMinutes(windowEnd);
  if (dateInputValue(windowStart) !== dateInputValue(windowEnd) || endMinute <= startMinute) endMinute += 1440;

  const availableStart = from ?? 0;
  let availableEnd = until ?? 1440;
  if (from !== null && until !== null && until <= from) availableEnd += 1440;

  const candidates = [-1440, 0, 1440].map((shift) => ({
    start: startMinute + shift,
    end: endMinute + shift,
  }));
  let overlapMinutes = 0;
  let gapMinutes = Number.POSITIVE_INFINITY;

  candidates.forEach((candidate) => {
    overlapMinutes = Math.max(
      overlapMinutes,
      Math.max(0, Math.min(candidate.end, availableEnd) - Math.max(candidate.start, availableStart)),
    );
    gapMinutes = Math.min(
      gapMinutes,
      candidate.end < availableStart
        ? availableStart - candidate.end
        : candidate.start > availableEnd
          ? candidate.start - availableEnd
          : 0,
    );
  });

  // Availability is a preference, not a brick wall. A strong window that
  // overlaps the angler's hours—or sits within an hour of them—can still rank.
  return {
    matches: overlapMinutes > 0 || gapMinutes <= 60,
    overlapMinutes,
    gapMinutes,
  };
}

function availabilityMatchScore(window: OpportunityWindow, availableFrom: string, availableUntil: string) {
  const fit = availabilityFit(window, availableFrom, availableUntil);
  if (!availableFrom && !availableUntil) return window.score;
  return window.score + Math.min(4, fit.overlapMinutes / 30) - Math.min(4, fit.gapMinutes / 15);
}

function availabilityMatchSummary(window: OpportunityWindow, availableFrom: string, availableUntil: string) {
  if (!availableFrom && !availableUntil) return null;
  const fit = availabilityFit(window, availableFrom, availableUntil);
  if (fit.overlapMinutes > 0) {
    const hours = fit.overlapMinutes / 60;
    return `Overlaps your available hours by ${Number.isInteger(hours) ? hours : hours.toFixed(1)} ${hours === 1 ? "hour" : "hours"}.`;
  }
  return `Starts within ${fit.gapMinutes} minutes of your available hours.`;
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

  return matchesDate && availabilityFit(window, availableFrom, availableUntil).matches;
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
      if (
        !existing ||
        availabilityMatchScore(window, availableFrom, availableUntil) >
          availabilityMatchScore(existing, availableFrom, availableUntil)
      ) result.set(window.siteId, window);
    });
  return result;
}

interface StructureGuide {
  label: string;
  lookFor: string;
  fishIt: string;
  image?: StructureImage;
}

interface StructureImage {
  src: string;
  alt: string;
  credit: string;
  sourceUrl: string;
  license: string;
}

const STRUCTURE_IMAGES: Record<string, StructureImage> = {
  riprap: {
    src: "/structure-guides/riprap.jpg",
    alt: "Large riprap rocks meeting the shoreline and shallow water",
    credit: "Greekswax / Wikimedia Commons",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Enrochement_Sopot.jpg",
    license: "CC0",
  },
  "eelgrass-edge": {
    src: "/structure-guides/eelgrass.jpg",
    alt: "An underwater eelgrass meadow growing across the seafloor",
    credit: "Olivier Dugornay, Ifremer / Wikimedia Commons",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Pr%C3%A9l%C3%A8vement_d%27herbiers_de_zost%C3%A8res_dans_le_golfe_du_Morbihan_(Ifremer_00560-67191_-_42945).jpg",
    license: "CC BY 4.0",
  },
  "pier-pilings": {
    src: "/structure-guides/pilings.jpg",
    alt: "Concrete pier pilings standing in shallow coastal water",
    credit: "Sharon Mollerus / Wikimedia Commons",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Pier_Pilings_(1495162510).jpg",
    license: "CC BY 2.0",
  },
  "sand-bar": {
    src: "/structure-guides/sandbar.jpg",
    alt: "Aerial view showing pale sandbars and deeper channels",
    credit: "U.S. Geological Survey / Wikimedia Commons",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Aerial_shot_of_sandbars_near_Bay_St.Louis,_MS_(5593961735).jpg",
    license: "CC BY 2.0",
  },
  jetty: {
    src: "/structure-guides/jetty.jpg",
    alt: "A stone jetty extending across shallow coastal water",
    credit: "Hirho / Wikimedia Commons",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Seaside_Momochi_Seaside_Park_breakwater_jetty_area_around_Momochi-hama_4-ch%C5%8Dme_Sawara-ku_Fukuoka_20230106.jpg",
    license: "CC BY-SA 4.0",
  },
  "tidal-channel": {
    src: "/structure-guides/tidal-channel.jpg",
    alt: "Aerial view of winding tidal channels through a wetland",
    credit: "U.S. Fish and Wildlife Service / Wikimedia Commons",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Aerial_view_of_Muddy_Creek_wetland_restoration_project._(26212443183).png",
    license: "Public domain",
  },
  "estuary-mouth": {
    src: "/structure-guides/estuary.jpg",
    alt: "Aerial view of a river mouth opening into the ocean",
    credit: "U.S. Army Corps of Engineers / Wikimedia Commons",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Klamath_River_mouth_aerial_view.jpg",
    license: "Public domain",
  },
};

const STRUCTURE_IMAGE_ALIASES: Record<string, keyof typeof STRUCTURE_IMAGES> = {
  "channel-approach": "tidal-channel",
  "channel-edge": "tidal-channel",
  "channel-shoulder": "tidal-channel",
  "current-seam": "tidal-channel",
  "dredged-channel": "tidal-channel",
  "dredged-edge": "tidal-channel",
  "tidal-drain": "tidal-channel",
  pilings: "pier-pilings",
  "rip-channel": "sand-bar",
  "sand-flat": "sand-bar",
  "mud-sand-flat": "sand-bar",
  "sand-mud-flat": "sand-bar",
  "sand-trough": "sand-bar",
  trough: "sand-bar",
  "open-coast": "sand-bar",
  "jetty-edge": "jetty",
  "rock-sand-edge": "riprap",
  "reef-edge": "riprap",
  "creek-mouth": "estuary-mouth",
  "lagoon-mouth": "estuary-mouth",
  "harbor-mouth": "estuary-mouth",
  "marina-mouth": "estuary-mouth",
};

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
    .map((tag): StructureGuide | undefined => {
      const key = tag.toLowerCase().replaceAll(" ", "-");
      const guide = STRUCTURE_GUIDES[key];
      if (!guide) return undefined;
      const imageKey = STRUCTURE_IMAGE_ALIASES[key] ?? key;
      const image = STRUCTURE_IMAGES[imageKey];
      return image ? { ...guide, image } : guide;
    })
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

function pressureTrendLabel(value?: number) {
  if (!isFiniteNumber(value) || Math.abs(value) <= 1.5) return "steady";
  return value > 0 ? "rising" : "falling";
}

function wavePowerReport(power?: number, period?: number, applies = true) {
  if (!applies) return { value: "Sheltered water", note: "Open-coast wave power is not applied at this Bay location", tone: "calm" };
  if (!isFiniteNumber(power)) return { value: "Unavailable", note: "No fresh wave height + period pair", tone: "unknown" };
  const periodText = isFiniteNumber(period) ? ` · ${Math.round(period)} s period` : "";
  if (power >= 15) return { value: `${power.toFixed(1)} kW/m${periodText}`, note: "Very powerful surf—exposed water may be unsafe or unfishable", tone: "danger" };
  if (power >= 10) return { value: `${power.toFixed(1)} kW/m${periodText}`, note: "Powerful surf—expect heavy shore break and wash", tone: "danger" };
  if (power >= 6) return { value: `${power.toFixed(1)} kW/m${periodText}`, note: "Moderate-to-strong surf energy", tone: "caution" };
  return { value: `${power.toFixed(1)} kW/m${periodText}`, note: "Low-to-moderate surf energy", tone: "calm" };
}

function TideChart({ site, window }: { site: FishingSite; window: OpportunityWindow }) {
  const levels = window.conditions.tideLevelsFeet;
  if (!levels || levels.length !== 4 || levels.some((level) => !isFiniteNumber(level))) return null;

  const minimum = Math.min(...levels);
  const maximum = Math.max(...levels);
  const spread = Math.max(0.2, maximum - minimum);
  const xPositions = [8, 36, 64, 92];
  const points = levels.map((level, index) => {
    const y = 46 - ((level - minimum) / spread) * 34;
    return `${xPositions[index]},${y.toFixed(1)}`;
  }).join(" ");
  const stationUrl = site.tideStation
    ? `https://tidesandcurrents.noaa.gov/noaatidepredictions.html?id=${encodeURIComponent(site.tideStation)}`
    : "https://tidesandcurrents.noaa.gov/";

  return (
    <div className="tide-chart-block">
      <div className="tide-chart-heading">
        <div>
          <span>Tide cycle</span>
          <strong>{window.conditions.tideStage ?? "Unavailable"}</strong>
        </div>
        <a href={stationUrl} target="_blank" rel="noreferrer">NOAA chart ↗</a>
      </div>
      <svg viewBox="0 0 100 56" role="img" aria-label={`Tide around this window: ${levels.map((level) => `${level.toFixed(1)} feet`).join(", ")}`}>
        <rect x="36" y="4" width="28" height="46" rx="2" />
        <line x1="8" y1="46" x2="92" y2="46" />
        <polyline points={points} />
        {points.split(" ").map((point, index) => {
          const [cx, cy] = point.split(",");
          return <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={index === 1 || index === 2 ? 2.1 : 1.5} />;
        })}
      </svg>
      <div className="tide-chart-labels">
        <span>2h before<br /><b>{levels[0].toFixed(1)} ft</b></span>
        <span>Start<br /><b>{levels[1].toFixed(1)} ft</b></span>
        <span>End<br /><b>{levels[2].toFixed(1)} ft</b></span>
        <span>2h after<br /><b>{levels[3].toFixed(1)} ft</b></span>
      </div>
      <p>The highlighted section is your fishing window.</p>
    </div>
  );
}

function smoothChartPath(points: Array<{ x: number; y: number }>) {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;

  return points.slice(1).reduce((path, point, index) => {
    const previous = points[index];
    const previousPrevious = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 2)];
    const controlOneX = previous.x + (point.x - previousPrevious.x) / 6;
    const controlOneY = previous.y + (point.y - previousPrevious.y) / 6;
    const controlTwoX = point.x - (next.x - previous.x) / 6;
    const controlTwoY = point.y - (next.y - previous.y) / 6;
    return `${path} C ${controlOneX.toFixed(2)} ${controlOneY.toFixed(2)}, ${controlTwoX.toFixed(2)} ${controlTwoY.toFixed(2)}, ${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
  }, `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`);
}

function OpportunityDayChart({
  windows,
  selectedWindow,
}: {
  windows: OpportunityWindow[];
  selectedWindow: OpportunityWindow;
}) {
  if (windows.length < 2) return null;

  const points = windows.map((window) => ({
    x: 6 + (pacificClockMinutes(new Date(window.start)) / 1440) * 88,
    y: 58 - (Math.max(0, Math.min(100, window.score)) / 100) * 46,
    window,
  }));
  const linePath = smoothChartPath(points);
  const areaPath = `${linePath} L ${points.at(-1)!.x.toFixed(2)} 64 L ${points[0].x.toFixed(2)} 64 Z`;
  const peak = windows.reduce((best, window) => window.score > best.score ? window : best, windows[0]);
  const dayLabel = new Date(selectedWindow.start).toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: PACIFIC_TIME_ZONE,
  });

  return (
    <section className="opportunity-day-chart" aria-labelledby="day-chart-title">
      <div className="opportunity-chart-heading">
        <div>
          <span>All-day outlook</span>
          <h3 id="day-chart-title">Opportunity through the day</h3>
        </div>
        <p><strong>Peak {formatTimeOnly(peak.start)}</strong><br />{Math.round(peak.score)} score</p>
      </div>
      <svg viewBox="0 0 100 68" role="img" aria-label={`${dayLabel} opportunity scores from ${formatTimeOnly(windows[0].start)} to ${formatTimeOnly(windows.at(-1)!.end)}`}>
        <line className="chart-grid-line" x1="6" y1="35" x2="94" y2="35" />
        <line className="chart-grid-line" x1="6" y1="58" x2="94" y2="58" />
        <path className="opportunity-chart-area" d={areaPath} />
        <path className="opportunity-chart-line" d={linePath} />
        {points.map((point) => (
          <circle
            key={point.window.id}
            className={point.window.id === selectedWindow.id ? "selected" : ""}
            cx={point.x}
            cy={point.y}
            r={point.window.id === selectedWindow.id ? 2.7 : 1.35}
          />
        ))}
      </svg>
      <div className="opportunity-chart-axis">
        <span>{formatTimeOnly(windows[0].start)}</span>
        <strong>{dayLabel}</strong>
        <span>{formatTimeOnly(windows.at(-1)!.end)}</span>
      </div>
      <p className="opportunity-chart-note">The curve follows each two-hour forecast. Use the arrows above to inspect a specific window.</p>
    </section>
  );
}

function SourceStatus({ source }: { source: SourceFreshness }) {
  const statusTone = sourceStatusTone(source.status);
  const statusLabel = source.status.split(";")[0];
  return (
    <div className="source-row">
      <span className={`source-dot ${statusTone}`} />
      <div>
        <strong>{source.name}</strong>
        <small>{statusLabel} · {formatAge(source.observedAt)}</small>
      </div>
      {source.url ? <a href={source.url} target="_blank" rel="noreferrer" aria-label={`Open ${source.name}`}>↗</a> : null}
    </div>
  );
}

export function OpportunityApp() {
  const account = useAccount();
  const detailDialogRef = useRef<HTMLElement>(null);
  const detailTriggerRef = useRef<HTMLElement | null>(null);
  const detailTriggerSiteIdRef = useRef<string | null>(null);
  const mapWrapRef = useRef<HTMLDivElement>(null);
  const [sites, setSites] = useState<FishingSite[]>(FALLBACK_SITES);
  const [snapshot, setSnapshot] = useState<OpportunitySnapshot>(fallbackSnapshot);
  const [communityPulses, setCommunityPulses] = useState<CommunityPulse[]>([]);
  const [discussionFeed, setDiscussionFeed] = useState<{ siteId: string; posts: LocationDiscussionPost[] } | null>(null);
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null);
  const [selectedDetailWindowId, setSelectedDetailWindowId] = useState<string | null>(null);
  const [detailExpanded, setDetailExpanded] = useState(false);
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
  const [tripReportRequest, setTripReportRequest] = useState<TripReportRequest | null>(null);
  const [mapEnabled, setMapEnabled] = useState(false);
  const [showRespectNotice, setShowRespectNotice] = useState(false);
  const [rememberRespectNotice, setRememberRespectNotice] = useState(false);
  const [showLocationDisclosure, setShowLocationDisclosure] = useState(false);
  const tripReportRequestKey = useRef(0);
  const initialSiteHandledRef = useRef(false);
  const discussionPosts = discussionFeed?.siteId === selectedSiteId ? discussionFeed.posts : [];

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
    if (!selectedSiteId) return;
    const siteId = selectedSiteId;
    const controller = new AbortController();
    const loadDiscussion = () => fetch(`/api/discussions/${encodeURIComponent(siteId)}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => response.ok ? response.json() as Promise<{ posts?: LocationDiscussionPost[] }> : { posts: [] })
      .then((payload) => setDiscussionFeed({ siteId, posts: payload.posts ?? [] }))
      .catch((error) => {
        if ((error as Error).name !== "AbortError") setDiscussionFeed({ siteId, posts: [] });
      });
    void loadDiscussion();
    const timer = window.setInterval(() => void loadDiscussion(), 15_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [selectedSiteId]);

  useEffect(() => {
    const timer = window.setInterval(() => setClockMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const respectWaterDismissed =
      window.localStorage.getItem("castingcompass.respect-water.v1") ??
      window.localStorage.getItem("contourcast.respect-water.v1");
    if (respectWaterDismissed === "dismissed") return;
    const frame = window.requestAnimationFrame(() => setShowRespectNotice(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!showRespectNotice) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [showRespectNotice]);

  useEffect(() => {
    if (mapEnabled || view !== "map" || !mapWrapRef.current) return;
    if (typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        setMapEnabled(true);
        observer.disconnect();
      },
      {
        // Wait until the map is meaningfully inside the viewport. This keeps
        // MapLibre out of the critical render path while still loading as the
        // angler scrolls toward it.
        rootMargin: "-36% 0px",
        threshold: 0.01,
      },
    );
    observer.observe(mapWrapRef.current);
    return () => observer.disconnect();
  }, [mapEnabled, view]);

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
    () => ["All water", "Saved locations", ...Array.from(new Set(sites.map((site) => site.region))).sort()],
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
      .filter((site) => (
        region === "All water" ||
        (region === "Saved locations" ? account.savedSiteIds.has(site.id) : site.region === region)
      ))
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
  }, [account.savedSiteIds, activeRadiusMiles, sites, region, userPosition, windowsBySite]);

  const bestSite = rankedSites[0] ?? null;
  const bestWindow = bestSite ? windowsBySite.get(bestSite.id) ?? null : null;
  const selectedSite = sites.find((site) => site.id === selectedSiteId) ?? null;
  const defaultSelectedWindow = selectedSiteId ? windowsBySite.get(selectedSiteId) ?? null : null;
  const selectedWindow = selectedSiteId && selectedDetailWindowId
    ? snapshot.windows.find((window) => window.siteId === selectedSiteId && window.id === selectedDetailWindowId)
      ?? defaultSelectedWindow
    : defaultSelectedWindow;
  const detailDayWindows = useMemo(() => {
    if (!selectedSiteId || !selectedWindow) return [];
    const selectedDay = dateInputValue(new Date(selectedWindow.start));
    return snapshot.windows
      .filter((window) => window.siteId === selectedSiteId && dateInputValue(new Date(window.start)) === selectedDay)
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  }, [selectedSiteId, selectedWindow, snapshot.windows]);
  const selectedDayWindowIndex = selectedWindow
    ? detailDayWindows.findIndex((window) => window.id === selectedWindow.id)
    : -1;
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

  const useBrowserLocation = useCallback(() => {
    setShowLocationDisclosure(false);
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

  const requestLocation = useCallback(() => {
    if (userPosition) {
      setLocationMessage(activeRadiusMiles ? `Showing access within ${activeRadiusMiles} miles` : "Sorted with nearby access first");
      return;
    }
    setShowLocationDisclosure(true);
  }, [activeRadiusMiles, userPosition]);

  const continueFromRespectNotice = useCallback(() => {
    if (rememberRespectNotice) {
      window.localStorage.setItem("castingcompass.respect-water.v1", "dismissed");
      window.localStorage.removeItem("contourcast.respect-water.v1");
    }
    setShowRespectNotice(false);
  }, [rememberRespectNotice]);

  const openSiteDetail = useCallback((siteId: string) => {
    const activeElement = document.activeElement;
    detailTriggerRef.current = activeElement instanceof HTMLElement ? activeElement : null;
    detailTriggerSiteIdRef.current = siteId;
    setDetailExpanded(false);
    setSelectedDetailWindowId(windowsBySite.get(siteId)?.id ?? null);
    setSelectedSiteId(siteId);
  }, [windowsBySite]);

  useEffect(() => {
    if (initialSiteHandledRef.current || !sites.length) return;
    const siteId = new URLSearchParams(window.location.search).get("site");
    if (!siteId || !sites.some((site) => site.id === siteId)) {
      initialSiteHandledRef.current = true;
      return;
    }
    initialSiteHandledRef.current = true;
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.delete("site");
    window.history.replaceState(null, "", `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
    const frame = window.requestAnimationFrame(() => openSiteDetail(siteId));
    return () => window.cancelAnimationFrame(frame);
  }, [openSiteDetail, sites]);

  const closeSiteDetail = useCallback(() => {
    setSelectedSiteId(null);
    setSelectedDetailWindowId(null);
    setDetailExpanded(false);
  }, []);

  const openTripReport = useCallback((mode: "start" | "past", siteId?: string, window?: OpportunityWindow) => {
    if (!account.user) {
      account.openAccount("Sign in before submitting a trip report. Complete trips and skunks are tied to an account so reports can be reviewed privately before any separate decision about model evidence.");
      return;
    }
    tripReportRequestKey.current += 1;
    setTripReportRequest({ key: tripReportRequestKey.current, mode, siteId, window });
  }, [account]);

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
        <a className="brand" href="#top" aria-label="CastingCompass home">
          <span className="brand-icon" aria-hidden="true" />
          <span>CastingCompass</span>
          <em>Bay Area beta</em>
        </a>
        <nav className="desktop-nav" aria-label="Primary navigation">
          <button type="button" onClick={() => scrollToSection("forecast")}>Forecast</button>
          <button type="button" onClick={() => setShowMethod(true)}>How It Works</button>
          <button type="button" onClick={() => scrollToSection("sources")}>Data</button>
        </nav>
        <div className="topbar-actions">
          <button className="account-button" type="button" onClick={() => {
            if (account.user) window.location.assign("/profile");
            else account.openAccount();
          }}>
            <span className="account-label">{account.loading ? "Account" : account.user ? account.user.email.split("@")[0] : "Sign in"}</span>
            <span className="account-label-compact">{account.user ? "Profile" : "Sign in"}</span>
          </button>
          <button className="log-trip-button" type="button" onClick={() => openTripReport("past")}>Log trip</button>
          <button
            className={`data-pill ${dataState}`}
            type="button"
            onClick={() => scrollToSection("sources")}
            aria-label={`Open forecast data sources. Current status: ${dataState}`}
          >
            <i /> {dataState === "loading" ? "Loading" : dataState === "live" ? "Live data" : "Cached"}
          </button>
          <button className="install-button" type="button" disabled title="Coming Soon" aria-label="Install app — coming soon">
            <DownloadIcon /> Install
            <span>Coming Soon</span>
          </button>
        </div>
      </header>

      <section className="forecast-intro" id="top">
        <div className="eyebrow-row">
          <span className="eyebrow"><span /> California halibut</span>
        </div>
        <div className="work-in-progress-note">
          <strong>Work in progress</strong>
          <span>CastingCompass currently hunts for California halibut only. Every score and condition adjustment is tuned around halibut habitat and behavior.</span>
        </div>
        <div className="intro-grid">
          <div>
            <h1>Find the water<br />worth fishing.</h1>
            <p>
              Pick the hours you have. We compare public shore and pier spots using bottom structure,
              time of year, tide, current, wind, swell, wave power, water temperature, clouds, pressure, daylight, moon phase, and expected fishing pressure.
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
        <div className="forecast-time-controls">
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
        </div>
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
            <select value={region} onChange={(event) => {
              const nextRegion = event.target.value;
              if (nextRegion === "Saved locations" && !account.user) {
                account.openAccount("Sign in to see saved fishing locations across devices.");
                return;
              }
              setRegion(nextRegion);
            }}>
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
        <div className="map-wrap" ref={mapWrapRef}>
          {mapEnabled ? (
            <Suspense fallback={<div className="map-loading-panel"><span /> Loading interactive map…</div>}>
              <ContourMap
                sites={rankedSites}
                windowsBySite={windowsBySite}
                selectedSiteId={selectedSiteId}
                onSelectSite={openSiteDetail}
                userPosition={userPosition}
              />
            </Suspense>
          ) : (
            <button className="map-load-panel" type="button" onClick={() => setMapEnabled(true)}>
              <MapIcon />
              <strong>Open interactive map</strong>
              <span>The map loads when you reach it, keeping the forecast quick to open.</span>
            </button>
          )}
          {mapEnabled ? (
            <>
              <div className="map-overlay-label"><LayersIcon /> {rankedSites.length} spots · tap a group to spread it out</div>
              <div className="map-legend">
                <span><i className="cluster" />Grouped</span>
                <span><i className="excellent" />80+</span>
                <span><i className="good" />65–79</span>
                <span><i className="fair" />45–64</span>
                <span><i className="quiet" />Below 45</span>
              </div>
            </>
          ) : null}
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

      <TripReportFeature
        sites={sites}
        snapshot={snapshot}
        request={tripReportRequest}
        canSubmit={Boolean(account.user?.legalAccepted)}
        onRequireLogin={() => account.openAccount("Sign in before submitting a trip report. Complete trips and skunks are tied to an account so reports can be reviewed privately before any separate decision about model evidence.")}
      />

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
        <a className="brand footer-brand" href="#top"><span className="brand-icon" aria-hidden="true" /><span>CastingCompass</span></a>
        <div className="footer-center">
          <p>Planning aid only. Not navigational data, legal advice, or a guarantee of catch.</p>
          <div className="contact-bar" aria-label="Contact Brian Zeng">
            <a href="https://brianzeng.com" target="_blank" rel="noreferrer">Portfolio ↗</a>
            <a href="mailto:bzeng0000@gmail.com">Email ↗</a>
            <a href="https://github.com/brianbzeng" target="_blank" rel="noreferrer">GitHub ↗</a>
            <a href="https://www.linkedin.com/in/brianbzeng" target="_blank" rel="noreferrer">LinkedIn ↗</a>
          </div>
          <div className="footer-legal" aria-label="Legal and privacy">
            <Link href="/terms">Terms</Link>
            <Link href="/privacy">Privacy</Link>
            <Link href="/ai-disclosure">AI disclosure</Link>
          </div>
        </div>
        <div>
          <a href="https://wildlife.ca.gov/Fishing/Ocean/Regulations/Fishing-Map/sf-bay" target="_blank" rel="noreferrer">CDFW Bay regulations ↗</a>
          <a href="https://wildlife.ca.gov/Fishing/Ocean/Regulations/Fishing-Map/San-Francisco" target="_blank" rel="noreferrer">Coast regulations ↗</a>
          <a href="https://open-meteo.com/en/docs/marine-weather-api" target="_blank" rel="noreferrer">Marine weather by Open-Meteo · Météo-France ↗</a>
        </div>
      </footer>

      {showRespectNotice ? (
        <div className="respect-modal-layer" role="presentation">
          <section className="respect-modal" role="dialog" aria-modal="true" aria-labelledby="respect-title">
            <span className="eyebrow"><span /> Before you fish</span>
            <h2 id="respect-title">Respect the water.</h2>
            <p>
              Pack out line and trash, avoid disturbing wildlife and habitat, and follow current access rules and fishing regulations.
              California halibut must be at least <strong>22 inches total length</strong> to keep.
            </p>
            <a href="https://wildlife.ca.gov/Fishing/Ocean/Regulations/Fishing-Map/San-Francisco" target="_blank" rel="noreferrer">Check current CDFW rules ↗</a>
            <label>
              <input
                type="checkbox"
                checked={rememberRespectNotice}
                onChange={(event) => setRememberRespectNotice(event.target.checked)}
              />
              Do not show this reminder again on this device
            </label>
            <button type="button" onClick={continueFromRespectNotice}>Continue to CastingCompass <ArrowIcon /></button>
          </section>
        </div>
      ) : null}

      {showLocationDisclosure ? (
        <div className="respect-modal-layer" role="presentation">
          <section className="respect-modal location-disclosure-modal" role="dialog" aria-modal="true" aria-labelledby="location-disclosure-title">
            <span className="eyebrow"><span /> Optional location</span>
            <h2 id="location-disclosure-title">Find nearby fishing access.</h2>
            <p>CastingCompass uses your current location once to sort nearby public spots and apply your selected distance radius. The location stays in this browser tab, is not saved to your account, and is not added to trip reports.</p>
            <p>You can keep using the forecast without sharing your location.</p>
            <div className="location-disclosure-actions">
              <button type="button" className="account-secondary" onClick={() => setShowLocationDisclosure(false)}>Not now</button>
              <button type="button" onClick={useBrowserLocation}>Continue to browser prompt <ArrowIcon /></button>
            </div>
            <Link href="/privacy">Read the Privacy Policy</Link>
          </section>
        </div>
      ) : null}

      {selectedSite && selectedWindow ? (
        <div className="detail-layer" role="presentation" onClick={(event) => {
          if (event.target === event.currentTarget) closeSiteDetail();
        }}>
          <aside
            ref={detailDialogRef}
            className={`detail-sheet ${detailExpanded ? "expanded" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="detail-title"
            tabIndex={-1}
          >
            <div className="sheet-handle" />
            <button
              className="sheet-expand"
              type="button"
              onClick={() => setDetailExpanded((expanded) => !expanded)}
              aria-label={detailExpanded ? "Return to compact report" : "Expand to full-screen report"}
              title={detailExpanded ? "Compact report" : "Full-screen report"}
            >
              <ChevronIcon />
            </button>
            <button className="sheet-close" type="button" onClick={closeSiteDetail} aria-label="Close details"><CloseIcon /></button>
            <div className="sheet-topline">
              <span>{selectedSite.region} · {selectedSite.type}</span>
              <span className={`confidence ${selectedWindow.confidence}`}>{selectedWindow.confidence} confidence</span>
            </div>
            <h2 id="detail-title">{selectedSite.name}</h2>
            <div className="window-navigator" aria-label="Choose another forecast window on this day">
              <button
                type="button"
                aria-label="Previous fishing window"
                disabled={selectedDayWindowIndex <= 0}
                onClick={() => setSelectedDetailWindowId(detailDayWindows[selectedDayWindowIndex - 1]?.id ?? null)}
              >
                <ChevronIcon className="previous-window-icon" />
              </button>
              <div>
                <span>Selected window</span>
                <strong><ClockIcon /> {formatWindow(selectedWindow.start, selectedWindow.end)}</strong>
                {availabilityMatchSummary(selectedWindow, availableFrom, availableUntil) ? (
                  <small>{availabilityMatchSummary(selectedWindow, availableFrom, availableUntil)}</small>
                ) : (
                  <small>{Math.max(1, selectedDayWindowIndex + 1)} of {detailDayWindows.length} today</small>
                )}
              </div>
              <button
                type="button"
                aria-label="Next fishing window"
                disabled={selectedDayWindowIndex < 0 || selectedDayWindowIndex >= detailDayWindows.length - 1}
                onClick={() => setSelectedDetailWindowId(detailDayWindows[selectedDayWindowIndex + 1]?.id ?? null)}
              >
                <ChevronIcon />
              </button>
            </div>

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

            <button
              className={`save-site-button ${account.savedSiteIds.has(selectedSite.id) ? "saved" : ""}`}
              type="button"
              onClick={() => void account.toggleSavedSite(selectedSite.id)}
            >
              <span>{account.savedSiteIds.has(selectedSite.id) ? "★" : "☆"}</span>
              {account.savedSiteIds.has(selectedSite.id) ? "Saved location" : "Save location"}
            </button>

            <OpportunityDayChart windows={detailDayWindows} selectedWindow={selectedWindow} />

            <div className="place-media-block">
              <h3>See the access</h3>
              <p>Check photos, the shoreline, and directions before you leave.</p>
              <div className="place-media-links">
                <a href={googleMapsSearchUrl(selectedSite)} target="_blank" rel="noreferrer">Photos &amp; reviews ↗</a>
                <a href={googleStreetViewUrl(selectedSite)} target="_blank" rel="noreferrer">Street View 360° ↗</a>
                <a href={googleSatelliteUrl(selectedSite)} target="_blank" rel="noreferrer">Satellite view ↗</a>
                <a href={googleDirectionsUrl(selectedSite)} target="_blank" rel="noreferrer">Directions ↗</a>
              </div>
              <small>Street View starts from the nearest mapped road or access point instead of the fishing marker in the water. Coverage still varies.</small>
            </div>

            <div className="detail-score-block">
              <div className={`detail-score ${scoreTone(selectedWindow.score)}`}>
                <strong>{Math.round(selectedWindow.score)}</strong>
                <span>Opportunity<br />Score</span>
              </div>
              <p>Relative rank among current options, with a practical fishability cap when conditions make the water hard to work.</p>
            </div>

            <div className="component-block">
              <h3>Why this time stands out</h3>
              <MetricBar label="Bottom" value={selectedWindow.habitatScore} note="How fishy the nearby structure looks" />
              <MetricBar label="Time of year" value={selectedWindow.seasonalityScore} note="How this month usually fishes" />
              <MetricBar label="Today’s conditions" value={selectedWindow.dynamicScore} note="Tide, current, wind, surf energy, water temperature, cloud cover, pressure, daylight, and moon phase" />
              <MetricBar label="Fishability" value={selectedWindow.fishabilityScore} note="Whether you can cast, control the presentation, and comfortably cover water" />
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
                      {guide.image ? (
                        <details className="structure-image-details">
                          <summary>See an example</summary>
                          <figure>
                            <Image src={guide.image.src} alt={guide.image.alt} width={1000} height={650} loading="lazy" unoptimized />
                            <figcaption>
                              Reference example—not this exact spot. <a href={guide.image.sourceUrl} target="_blank" rel="noreferrer">{guide.image.credit} · {guide.image.license} ↗</a>
                            </figcaption>
                          </figure>
                        </details>
                      ) : null}
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
              <div><WindIcon /><span>Modeled current</span><strong>{isFiniteNumber(selectedWindow.conditions.currentKnots) ? `${selectedWindow.conditions.currentKnots.toFixed(2)} kt${selectedWindow.conditions.currentDirection ? ` · ${selectedWindow.conditions.currentDirection}` : ""}` : "Unavailable"}</strong></div>
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
              <div><CloudIcon /><span>Cloud cover</span><strong>{isFiniteNumber(selectedWindow.conditions.cloudCoverPct) ? `${Math.round(selectedWindow.conditions.cloudCoverPct)}%` : "Unavailable"}</strong></div>
              <div>
                <PressureIcon />
                <span>Pressure</span>
                <strong>{isFiniteNumber(selectedWindow.conditions.pressureHpa) ? `${Math.round(selectedWindow.conditions.pressureHpa)} hPa · ${pressureTrendLabel(selectedWindow.conditions.pressureTrendHpa3h)}` : "Unavailable"}</strong>
              </div>
              <div>
                <MoonIcon />
                <span>Moon</span>
                <strong>{selectedWindow.conditions.moonPhase ? `${selectedWindow.conditions.moonPhase} · ${Math.round(selectedWindow.conditions.moonIlluminationPct ?? 0)}%` : "Unavailable"}</strong>
              </div>
              <div className="fishing-pressure-condition">
                <LayersIcon />
                <span>Expected fishing pressure</span>
                <strong>{selectedWindow.conditions.fishingPressure ? `${selectedWindow.conditions.fishingPressure} · ${Math.round(selectedWindow.conditions.fishingPressurePct ?? 0)}/100` : "Unavailable"}</strong>
                <small>Schedule estimate, not live headcount{isFiniteNumber(selectedWindow.conditions.accessAdjustmentPoints) ? ` · ${selectedWindow.conditions.accessAdjustmentPoints > 0 ? "+" : ""}${selectedWindow.conditions.accessAdjustmentPoints} score pts` : ""}</small>
              </div>
              {(() => {
                const report = wavePowerReport(
                  selectedWindow.conditions.wavePowerKwM,
                  selectedWindow.conditions.swellPeriodSeconds,
                  ["Point Reyes", "Marin Coast", "San Francisco Coast", "San Mateo Coast", "Half Moon Bay"].includes(selectedSite.region),
                );
                return (
                  <div className={`wave-power-condition ${report.tone}`}>
                    <WaveIcon />
                    <span>Estimated wave power</span>
                    <strong>{report.value}</strong>
                    <small>{report.note}</small>
                  </div>
                );
              })()}
              <div className="fishability-condition">
                <WaveIcon />
                <span>Practical fishability</span>
                <strong>{selectedWindow.conditions.fishabilityLabel ? `${selectedWindow.conditions.fishabilityLabel} · ${Math.round(selectedWindow.fishabilityScore)}/100` : `${Math.round(selectedWindow.fishabilityScore)}/100`}</strong>
                <small>
                  {isFiniteNumber(selectedWindow.conditions.breakingWaveHeightFeet)
                    ? `Estimated breaking exposure ${selectedWindow.conditions.breakingWaveHeightFeet.toFixed(1)} ft${selectedWindow.conditions.swellDirection ? ` · swell from ${selectedWindow.conditions.swellDirection}` : ""}`
                    : "Uses wind, current, surf exposure, beach slope, and expected crowding."}
                </small>
              </div>
            </div>
            {selectedWindow.conditions.fishabilityReasons?.length ? (
              <div className="fishability-reasons">
                <strong>Can you fish it effectively?</strong>
                {selectedWindow.conditions.fishabilityReasons.map((reason) => <p key={reason}>{reason}</p>)}
              </div>
            ) : null}
            <TideChart site={selectedSite} window={selectedWindow} />
            {isFiniteNumber(selectedWindow.conditions.ndbcObservedWaterTempF) ? (
              <p className="condition-source-note">
                Latest nearby buoy reading: {Math.round(selectedWindow.conditions.ndbcObservedWaterTempF)}°F
                {selectedWindow.conditions.ndbcObservedAt ? ` · ${formatAge(selectedWindow.conditions.ndbcObservedAt)}` : ""}. For reference only.
              </p>
            ) : null}

            <div className="detail-freshness">
              <h3>Latest conditions</h3>
              {(selectedWindow.sources ?? snapshot.sources).slice(0, 6).map((source) => {
                const tone = sourceStatusTone(source.status);
                const label = <><i className={tone} /> {source.name.replace("NOAA ", "")}{source.url ? " ↗" : ""}</>;
                return source.url ? (
                  <a key={source.name} href={source.url} target="_blank" rel="noreferrer" title={source.detail}>{label}</a>
                ) : (
                  <span key={source.name} title={source.detail}>{label}</span>
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
              {discussionPosts.length ? (
                <div className="location-discussion-feed">
                  <h4>Human-reviewed CastingCompass trip notes</h4>
                  {discussionPosts.map((post) => (
                    <article key={post.id}>
                      <p>{post.summary}</p>
                      {post.gearSummary ? <small><b>Setup:</b> {post.gearSummary}</small> : null}
                      {post.techniqueTags.length ? <div>{post.techniqueTags.map((tag) => <span key={tag}>{tag}</span>)}</div> : null}
                      <time dateTime={post.observedAt}>{new Date(post.observedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</time>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="location-discussion-empty">No human-approved CastingCompass trip summaries have been posted for this location yet.</p>
              )}
              <small>
                Static summaries do not change the score. Automated review can prepare a draft, but a human moderator must approve it before publication.
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
              CastingCompass compares reachable casting zones and upcoming two-hour windows. Before the practical cap, the 0–100 value ranks within the current comparison set. Fishability can lower it when the water is too difficult to work effectively. It is not a catch probability.
            </p>
            <div className="predictor-list" aria-label="Predictors used in the live score">
              <details open>
                <summary><span>Bottom and habitat</span><b>44% of combined score</b></summary>
                <p>Nearby depth, slope, roughness, channel edges, shoreline distance, sediment and structure tags, plus the current curated habitat prior. The trained bathymetry encoder remains in research until it beats the strongest classical baseline.</p>
              </details>
              <details>
                <summary><span>Time of year</span><b>16% of combined score</b></summary>
                <p>Monthly California halibut seasonality. This is still a provisional public-data prior while the reproducible RecFIN extract is being finished.</p>
              </details>
              <details>
                <summary><span>Tide and current</span><b>Live, bounded input</b></summary>
                <p>NOAA tide stage and change, plus Open-Meteo modeled current speed. Direction is shown to anglers, while the score uses speed only because the effect of direction depends on each shoreline.</p>
              </details>
              <details>
                <summary><span>Weather, light and water</span><b>Live, bounded input</b></summary>
                <p>Wind, water temperature, cloud cover, atmospheric-pressure trend, daylight, moon phase and illumination. Moon and pressure stay low-weight to avoid double-counting tides or overstating a weak local signal.</p>
              </details>
              <details>
                <summary><span>Practical fishability</span><b>20% plus a hard score cap</b></summary>
                <p>Wind, current, expected crowding, swell height, period, direction, estimated wave power, beach slope, and nearshore exposure estimate whether an angler can cast and control a lure or bait. Difficult or severe surf can cap the final score even when habitat looks excellent.</p>
              </details>
              <details>
                <summary><span>Expected fishing pressure</span><b>Small access modifier</b></summary>
                <p>A time-of-day and weekend schedule is combined with a curated estimate of how constrained each spot usually feels. It is not Google Popular Times or live headcount, and it can move the raw score by only a few points.</p>
              </details>
            </div>
            <div className="method-callout">
              <InfoIcon />
              <p><strong>Deep-learning status: research pipeline, not the live score.</strong> The current live Habitat score is a labeled, curated proxy. It is not output from a trained neural network.</p>
            </div>
            <div className="method-callout">
              <InfoIcon />
              <p><strong>Why several plausible predictors are still out.</strong> Dissolved oxygen, pH, turbidity, salinity, chlorophyll, bait density and predator density are not yet scored. Public coverage is too sparse, too coarse, cloud-limited or not forecast reliably at all 47 casting zones. They will be added only when a blocked validation test shows useful lift.</p>
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

      <AccountModal account={account} sites={sites} onOpenSite={openSiteDetail} />

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
                    <MetricBar label="Fishability" value={window.fishabilityScore} note="Casting and presentation" />
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
