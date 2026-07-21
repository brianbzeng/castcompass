export type SiteType = "Pier" | "Shore" | "Beach" | "Jetty";

export interface FishingSite {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  streetViewLatitude?: number;
  streetViewLongitude?: number;
  streetViewRoadDistanceMeters?: number;
  region: string;
  type: SiteType | string;
  access: string;
  regulationUrl: string;
  depthProfile?: string;
  structureTags: string[];
  parking?: string;
  transit?: string;
  amenities?: string[];
  accessSourceUrl?: string;
  accessStatus?: "open" | "limited" | "closed" | "unknown";
  accessStatusNote?: string;
  accessStatusUpdatedAt?: string;
  tideStation?: string;
  distanceMiles?: number;
}

export interface CommunityPulseTheme {
  label: string;
  note: string;
}

export interface CommunityPulseSource {
  label: string;
  url: string;
  publishedAt?: string;
  kind: "official" | "discussion" | "guide" | string;
}

export interface CommunityPulse {
  siteId: string;
  reviewedAt: string;
  coverage: string;
  confidence: "high" | "medium" | "low";
  summary: string;
  themes: CommunityPulseTheme[];
  sources: CommunityPulseSource[];
}

export interface LocationDiscussionPost {
  id: string;
  siteId: string;
  summary: string;
  gearSummary?: string | null;
  techniqueTags: string[];
  observedAt: string;
  postedAt: string;
}

export interface SourceFreshness {
  name: string;
  observedAt: string;
  status: "fresh" | "aging" | "stale" | "unavailable" | string;
  ageMinutes?: number;
  freshnessLimitMinutes?: number;
  freshnessLimitHours?: number;
  detail?: string;
  url?: string;
}

export interface Conditions {
  tideStage?: string;
  tideChangeFeet?: number;
  tideLevelsFeet?: [number, number, number, number];
  currentKnots?: number;
  currentDirectionDegrees?: number;
  currentDirection?: string;
  windMph?: number;
  windDirection?: string;
  swellFeet?: number;
  swellPeriodSeconds?: number;
  swellDirectionDegrees?: number;
  swellDirection?: string;
  wavePowerKwM?: number;
  breakingIntensity?: "light" | "workable" | "difficult" | "severe" | string;
  breakingWaveHeightFeet?: number;
  fishabilityLabel?: string;
  fishabilityReasons?: string[];
  waterTempF?: number;
  waterTempSource?: string;
  ndbcObservedWaterTempF?: number;
  ndbcObservedAt?: string;
  daylight?: boolean;
  cloudCoverPct?: number;
  pressureHpa?: number;
  pressureTrendHpa3h?: number;
  pressureObservedAt?: string;
  moonPhase?: string;
  moonIlluminationPct?: number;
  fishingPressure?: "light" | "moderate" | "high" | string;
  fishingPressurePct?: number;
  accessAdjustmentPoints?: number;
  fishingPressureBasis?: string;
  summary?: string;
}

export interface OpportunityWindow {
  id: string;
  siteId: string;
  start: string;
  end: string;
  score: number;
  habitatScore: number;
  seasonalityScore: number;
  dynamicScore: number;
  fishabilityScore: number;
  confidence: "high" | "medium" | "low" | string;
  rank?: number;
  explanationFactors: string[];
  conditions: Conditions;
  modelVersion?: string;
  sources?: SourceFreshness[];
}

export interface OpportunitySnapshot {
  generatedAt: string;
  modelVersion: string;
  methodology?: string;
  sources: SourceFreshness[];
  windows: OpportunityWindow[];
}

export type WaterQualityAdvisoryStatus =
  | "closure"
  | "posted"
  | "advisory"
  | "no-active-posting"
  | "stale"
  | "unmonitored"
  | "unknown"
  | "source-unavailable"
  | "not-covered";

export interface WaterQualitySiteAssessment {
  status: WaterQualityAdvisoryStatus;
  recommendationEffect: "suppress" | "neutral" | "unknown";
  officialLabel: string;
  detail: string;
  stationIds: string[];
  stationNames: string[];
  sampleDates: string[];
  checkedAt: string;
  scoreDelta: null;
  sourceUrl: string;
}

export interface WaterQualitySnapshot {
  schemaVersion: "castingcompass.water-quality-advisory/1.0.0";
  policyVersion: string;
  policySha256: string;
  collectorSha256: string;
  siteCatalogSha256: string;
  generatedAt: string;
  status: "fresh" | "partial" | "unavailable";
  meaning: string;
  freshness: {
    maximumSampleAgeDays: number;
  };
  scoreContribution: {
    mode: "excluded-pending-frozen-baseline-validation";
    positiveContributionAllowed: false;
    activeAgencyStatusSuppressesRecommendation: true;
  };
  source: {
    agency: string;
    programUrl: string;
    statusUrl: string;
    machineUrl: string;
    errorCategory: string | null;
  };
  sites: Record<string, WaterQualitySiteAssessment>;
}

export type TimeFilter = "today" | "tomorrow" | "custom";

export interface TripReportRequest {
  key: number;
  mode: "start" | "past";
  siteId?: string;
  window?: OpportunityWindow;
}
