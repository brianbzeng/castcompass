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

function filterWindow(
  window: OpportunityWindow,
  filter: TimeFilter,
  nowMs: number,
  customStart: string,
  customEnd: string,
) {
  const start = new Date(window.start);
  const end = new Date(window.end);
  if (end.getTime() <= nowMs) return false;

  const now = new Date(nowMs);
  if (filter === "today") {
    return dateInputValue(start) === dateInputValue(now) || (start.getTime() <= nowMs && end.getTime() > nowMs);
  }
  if (filter === "tomorrow") {
    return dateInputValue(start) === shiftDateInput(dateInputValue(now), 1);
  }

  const rangeStart = dateFromInput(customStart);
  const rangeEndExclusive = dateFromInput(customEnd);
  rangeEndExclusive.setDate(rangeEndExclusive.getDate() + 1);
  return end > rangeStart && start < rangeEndExclusive;
}

function latestPerSite(
  windows: OpportunityWindow[],
  filter: TimeFilter,
  nowMs: number,
  customStart: string,
  customEnd: string,
) {
  const result = new Map<string, OpportunityWindow>();
  windows
    .filter((window) => filterWindow(window, filter, nowMs, customStart, customEnd))
    .forEach((window) => {
      const existing = result.get(window.siteId);
      if (!existing || window.score > existing.score) result.set(window.siteId, window);
    });
  return result;
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
    () => latestPerSite(snapshot.windows, timeFilter, clockMs, customStart, customEnd),
    [snapshot.windows, timeFilter, clockMs, customStart, customEnd],
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
  const strongestWindowLabel = timeFilter === "today"
    ? "Strongest remaining today"
    : timeFilter === "tomorrow"
      ? "Strongest tomorrow"
      : "Strongest in your range";

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
          <button type="button" onClick={() => setShowMethod(true)}>How it works</button>
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
              Ranked two-hour windows for public shore and pier access—built from seafloor structure,
              seasonality, and current conditions.
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
            <div className="empty-window">No ranked windows match this filter.</div>
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
          <div className="map-overlay-label"><LayersIcon /> {rankedSites.length} zones · tap grouped circles to expand</div>
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
              <span>Ranked access</span>
              <h2>{rankedSites.length} locations</h2>
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
                      {site.structureTags.slice(0, 2).map((tag) => <span key={tag}>{tag}</span>)}
                      {site.distanceMiles !== undefined ? <span>{site.distanceMiles.toFixed(1)} mi</span> : null}
                    </div>
                  </div>
                  <ChevronIcon className="site-chevron" />
                </button>
              );
            })}
            {rankedSites.length === 0 ? (
              <div className="no-results">
                <strong>No windows in this slice</strong>
                <p>Try another area or forecast period.</p>
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
        <button type="button" onClick={() => setShowMethod(true)}>See methodology <ArrowIcon /></button>
      </section>

      <TripReportFeature sites={sites} snapshot={snapshot} request={tripReportRequest} />

      <section className="source-section" id="sources">
        <div className="source-heading">
          <span>Forecast inputs</span>
          <h2>Nothing hidden behind the score.</h2>
          <p>Every source carries an observed time and freshness limit. Expired live inputs are excluded instead of silently filled.</p>
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
              <p>Open current Google Maps imagery and routing outside ContourCast.</p>
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
              <p>Better than <strong>{Math.round(selectedWindow.score)}%</strong> of the site/window combinations currently evaluated.</p>
            </div>

            <div className="component-block">
              <h3>Why it ranks here</h3>
              <MetricBar label="Habitat" value={selectedWindow.habitatScore} note="Long-term seafloor structure" />
              <MetricBar label="Seasonality" value={selectedWindow.seasonalityScore} note="Public monthly catch and effort" />
              <MetricBar label="Conditions" value={selectedWindow.dynamicScore} note="Bounded live modifier" />
            </div>

            <div className="factor-block">
              {selectedWindow.explanationFactors.map((factor) => <span key={factor}>{factor}</span>)}
            </div>

            <div className="conditions-grid">
              <div><TideIcon /><span>Tide</span><strong>{selectedWindow.conditions.tideStage ?? "Unavailable"}</strong></div>
              <div><WindIcon /><span>Wind</span><strong>{isFiniteNumber(selectedWindow.conditions.windMph) ? `${Math.round(selectedWindow.conditions.windMph)} mph` : "Unavailable"}</strong></div>
              <div>
                <TemperatureIcon />
                <span>Modeled SST</span>
                <strong>
                  {isFiniteNumber(selectedWindow.conditions.waterTempF)
                    ? `${Math.round(selectedWindow.conditions.waterTempF)}°F`
                    : "Unavailable"}
                </strong>
              </div>
            </div>
            {isFiniteNumber(selectedWindow.conditions.ndbcObservedWaterTempF) ? (
              <p className="condition-source-note">
                Latest regional NDBC observation: {Math.round(selectedWindow.conditions.ndbcObservedWaterTempF)}°F
                {selectedWindow.conditions.ndbcObservedAt ? ` · ${formatAge(selectedWindow.conditions.ndbcObservedAt)}` : ""}. Shown for comparison, not scoring.
              </p>
            ) : null}

            <div className="detail-freshness">
              <h3>Input status</h3>
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
              {selectedSite.depthProfile ? <small>{selectedSite.depthProfile}</small> : null}
              {selectedSite.accessSourceUrl ? (
                <a href={selectedSite.accessSourceUrl} target="_blank" rel="noreferrer">Check official access status ↗</a>
              ) : null}
            </div>

            <div className="community-pulse-block">
              <div className="community-pulse-heading">
                <h3>Community pulse — historical discussion</h3>
                <span>Not a live bite report</span>
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
                <p>No curated discussion summary is available for this access point yet.</p>
              )}
              <small>
                Editorial summaries stay separate from the Opportunity Score. Use the trip logger to add a complete catch or no-catch result to the validation dataset.
              </small>
            </div>

            <a className="regulations-link" href={selectedSite.regulationUrl} target="_blank" rel="noreferrer">
              Check current CDFW regulations <ArrowIcon />
            </a>
            <p className="model-stamp">Model {selectedWindow.modelVersion ?? snapshot.modelVersion} · generated {formatAge(snapshot.generatedAt)}</p>
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
                The research pipeline sends six-channel bathymetry patches into a self-supervised ResNet/SimCLR encoder, then fine-tunes presence and <code>log1p(CPUA)</code> heads. It is promoted only after geographically blocked validation shows a reliable ranking gain over simpler baselines.
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
            <h2 id="compare-title">Top windows,<br />same scale.</h2>
            <p>These are the three strongest locations in the current area and time filter. Components use the same 0–100 scale.</p>
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
                    <MetricBar label="Habitat" value={window.habitatScore} note="Structure" />
                    <MetricBar label="Season" value={window.seasonalityScore} note="Catch / effort" />
                    <MetricBar label="Conditions" value={window.dynamicScore} note="Fresh inputs" />
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
