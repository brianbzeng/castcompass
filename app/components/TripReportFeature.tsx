"use client";

import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import type { FishingSite, OpportunitySnapshot, OpportunityWindow, TripReportRequest } from "../types";
import { ArrowIcon, ClockIcon, CloseIcon } from "./icons";
import { GearCatalogFields } from "./GearCatalogFields";
import { SiteCombobox } from "./SiteCombobox";
import { useClientNetworkState } from "../lib/use-client-network-state";
import { useModalDialog } from "../lib/use-modal-dialog";
import {
  ACTIVE_TRIP_KEY,
  LEGACY_ACTIVE_TRIP_KEY,
  LEGACY_REPORTER_KEY,
  REPORTER_KEY,
  TRIP_DRAFT_PREFIX,
  TRIP_PENDING_PREFIX,
  TRIP_REQUEST_PREFIX,
} from "../lib/account-browser-storage";
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const ACCEPTED_PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const PHOTO_UPLOADS_ENABLED = process.env.NEXT_PUBLIC_PHOTO_UPLOADS === "true";
// Keep a slow request pending. If its response is lost, the stable request
// identity below makes an explicit user retry idempotent; nothing auto-replays.
const SLOW_SUBMISSION_NOTICE_MS = 4_000;

type Panel = "start" | "complete" | "past";
type SubmitState = "idle" | "submitting" | "success" | "error" | "ambiguous";
type PhotoTransferState = "idle" | "selected" | "sending" | "confirmed" | "failed" | "ambiguous";
type TripReceiptOperation = "start" | "complete" | "past";

interface RejectedPhoto {
  name: string;
  type: string;
  size: number;
  message: string;
}

interface TripRequestMaterial {
  id: string;
  token: string;
}

interface StoredActiveTrip {
  id: string;
  token: string;
  siteId: string;
  siteName: string;
  startedAt: string;
  anglerCount: number;
  mode: string;
  opportunityWindowId?: string;
  opportunityScore?: number;
  modelVersion?: string;
  fishingMethod: string;
  gearProfileId: string;
  rod: string;
  reel: string;
  baitLure: string;
  rig: string;
  scoreInfluencedChoice: boolean;
}

interface SummaryView {
  completedTrips: number;
  anglerHours: number;
  halibutEncounters: number;
  sitesCovered: number;
  past24Hours: {
    completedTrips: number;
    anglerHours: number;
    halibutEncounters: number;
    sitesCovered: number;
  };
}

interface TripReportFeatureProps {
  sites: FishingSite[];
  snapshot: OpportunitySnapshot;
  request: TripReportRequest | null;
  canSubmit: boolean;
  onRequireLogin(): void;
}

interface FormFields {
  siteId: string;
  startedAt: string;
  endedAt: string;
  anglerCount: number;
  keeperCount: number;
  shortReleasedCount: number;
  fishingMethod: string;
  gearProfileId: string;
  rod: string;
  reel: string;
  baitLure: string;
  rig: string;
  mode: string;
  scoreInfluencedChoice: "" | "yes" | "no";
  primaryTargetConfirmed: boolean;
  completeAttempt: boolean;
  otherCatchCount: number;
  otherSpecies: string;
  shorebreak: string;
  wadingDepth: string;
  waterClarity: string;
  crowding: string;
  fishabilityRating: string;
  observedWaveHeightFeet: string;
  fishabilityNotes: string;
  notes: string;
  consent: boolean;
}

interface GearProfile {
  id: string;
  name: string;
  rod: string | null;
  reel: string | null;
  bait_lure: string | null;
  rig: string | null;
}

function localDateTimeValue(value: Date) {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}

function isoFromLocalInput(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("Enter a valid date and time.");
  return parsed.toISOString();
}

function freshFields(siteId = ""): FormFields {
  const now = new Date();
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  return {
    siteId,
    startedAt: localDateTimeValue(twoHoursAgo),
    endedAt: localDateTimeValue(now),
    anglerCount: 1,
    keeperCount: 0,
    shortReleasedCount: 0,
    fishingMethod: "bait",
    gearProfileId: "",
    rod: "",
    reel: "",
    baitLure: "",
    rig: "",
    mode: "",
    scoreInfluencedChoice: "",
    primaryTargetConfirmed: false,
    completeAttempt: false,
    otherCatchCount: 0,
    otherSpecies: "",
    shorebreak: "",
    wadingDepth: "",
    waterClarity: "",
    crowding: "",
    fishabilityRating: "",
    observedWaveHeightFeet: "",
    fishabilityNotes: "",
    notes: "",
    consent: false,
  };
}

function parseFormDraft(raw: string | null, fallback: FormFields) {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<FormFields>;
    return {
      ...fallback,
      ...parsed,
      anglerCount: Number(parsed.anglerCount ?? fallback.anglerCount),
      keeperCount: Number(parsed.keeperCount ?? fallback.keeperCount),
      shortReleasedCount: Number(parsed.shortReleasedCount ?? fallback.shortReleasedCount),
      otherCatchCount: Number(parsed.otherCatchCount ?? fallback.otherCatchCount),
      consent: Boolean(parsed.consent),
      primaryTargetConfirmed: Boolean(parsed.primaryTargetConfirmed),
      completeAttempt: Boolean(parsed.completeAttempt),
      scoreInfluencedChoice:
        parsed.scoreInfluencedChoice === "yes" || parsed.scoreInfluencedChoice === "no"
          ? parsed.scoreInfluencedChoice
          : fallback.scoreInfluencedChoice,
    };
  } catch {
    return fallback;
  }
}

function findForecastWindow(snapshot: OpportunitySnapshot, siteId: string, startedAt: string, endedAt?: string) {
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : start;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const midpoint = (start + end) / 2;
  const candidates = snapshot.windows.filter((window) => window.siteId === siteId);
  const overlapping = candidates.filter((window) => {
    const windowStart = new Date(window.start).getTime();
    const windowEnd = new Date(window.end).getTime();
    return windowStart <= end && windowEnd >= start;
  });
  const pool = overlapping.length ? overlapping : candidates;
  const matched = pool.sort((left, right) => {
    const leftMidpoint = (new Date(left.start).getTime() + new Date(left.end).getTime()) / 2;
    const rightMidpoint = (new Date(right.start).getTime() + new Date(right.end).getTime()) / 2;
    return Math.abs(leftMidpoint - midpoint) - Math.abs(rightMidpoint - midpoint);
  })[0];
  if (!matched) return null;
  const matchedMidpoint = (new Date(matched.start).getTime() + new Date(matched.end).getTime()) / 2;
  return Math.abs(matchedMidpoint - midpoint) <= 6 * 60 * 60 * 1000 ? matched : null;
}

function forecastFields(window: OpportunityWindow | null) {
  if (!window) return {};
  return { opportunityWindowId: window.id };
}

function integerValue(value: string) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function parseStoredTrip(raw: string | null): StoredActiveTrip | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredActiveTrip>;
    if (
      typeof value.id !== "string" ||
      typeof value.token !== "string" ||
      typeof value.siteId !== "string" ||
      typeof value.siteName !== "string" ||
      typeof value.startedAt !== "string"
    ) return null;
    return {
      id: value.id,
      token: value.token,
      siteId: value.siteId,
      siteName: value.siteName,
      startedAt: value.startedAt,
      anglerCount: typeof value.anglerCount === "number" ? value.anglerCount : 1,
      mode: typeof value.mode === "string" ? value.mode : "shore",
      opportunityWindowId: value.opportunityWindowId,
      opportunityScore: value.opportunityScore,
      modelVersion: value.modelVersion,
      fishingMethod: typeof value.fishingMethod === "string" ? value.fishingMethod : "bait",
      gearProfileId: typeof value.gearProfileId === "string" ? value.gearProfileId : "",
      rod: typeof value.rod === "string" ? value.rod : "",
      reel: typeof value.reel === "string" ? value.reel : "",
      baitLure: typeof value.baitLure === "string" ? value.baitLure : "",
      rig: typeof value.rig === "string" ? value.rig : "",
      scoreInfluencedChoice:
        typeof value.scoreInfluencedChoice === "boolean"
          ? value.scoreInfluencedChoice
          : typeof (value as { contourCastInfluenced?: unknown }).contourCastInfluenced === "boolean"
            ? Boolean((value as { contourCastInfluenced: boolean }).contourCastInfluenced)
            : false,
    };
  } catch {
    return null;
  }
}

function readCount(source: unknown, keys: string[]) {
  if (!source || typeof source !== "object") return 0;
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function normalizeSummary(payload: unknown): SummaryView {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const source = root.summary && typeof root.summary === "object" ? root.summary : root;
  const recent = source && typeof source === "object" && (source as Record<string, unknown>).past24Hours && typeof (source as Record<string, unknown>).past24Hours === "object"
    ? (source as Record<string, unknown>).past24Hours
    : {};
  return {
    completedTrips: readCount(source, ["completedTrips", "completed_trips", "totalTrips", "total_trips"]),
    anglerHours: readCount(source, ["anglerHours", "angler_hours"]),
    halibutEncounters: readCount(source, ["halibutEncounters", "halibut_encounters", "totalHalibut", "total_halibut"]),
    sitesCovered: readCount(source, ["sitesCovered", "sites_covered"]),
    past24Hours: {
      completedTrips: readCount(recent, ["completedTrips", "completed_trips"]),
      anglerHours: readCount(recent, ["anglerHours", "angler_hours"]),
      halibutEncounters: readCount(recent, ["halibutEncounters", "halibut_encounters"]),
      sitesCovered: readCount(recent, ["sitesCovered", "sites_covered"]),
    },
  };
}

function RecentDelta({ value, decimals = 0 }: { value: number; decimals?: number }) {
  if (!(value > 0)) return null;
  return <small className="recent-delta" aria-label={`${value.toFixed(decimals)} added in the past 24 hours`}>↗ +{value.toFixed(decimals)} · 24h</small>;
}

function anonymousReporterKey() {
  const existing =
    window.localStorage.getItem(REPORTER_KEY) ??
    window.localStorage.getItem(LEGACY_REPORTER_KEY);
  if (existing) return existing;
  const key = typeof window.crypto?.randomUUID === "function"
    ? window.crypto.randomUUID()
    : `anon-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  window.localStorage.setItem(REPORTER_KEY, key);
  return key;
}

async function responsePayload(response: Response) {
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const nestedError = payload.error && typeof payload.error === "object"
      ? (payload.error as Record<string, unknown>).message
      : payload.error;
    const detail = nestedError ?? payload.message ?? payload.detail;
    throw new Error(typeof detail === "string" ? detail : "The report could not be saved. Please try again.");
  }
  return payload;
}

class AmbiguousTripSubmissionError extends Error {
  constructor() {
    super("The server response did not provide an exact trip receipt.");
    this.name = "AmbiguousTripSubmissionError";
  }
}

async function tripSubmissionPayload(response: Response) {
  let payload: Record<string, unknown>;
  try {
    payload = await response.json() as Record<string, unknown>;
  } catch {
    if (response.ok || response.status >= 500) throw new AmbiguousTripSubmissionError();
    throw new Error("The report was rejected without a readable explanation. Review it and try again.");
  }
  if (!response.ok) {
    if (response.status >= 500) throw new AmbiguousTripSubmissionError();
    const nestedError = payload.error && typeof payload.error === "object"
      ? (payload.error as Record<string, unknown>).message
      : payload.error;
    const detail = nestedError ?? payload.message ?? payload.detail;
    throw new Error(typeof detail === "string" ? detail : "The report was not accepted. Review it and try again.");
  }
  return payload;
}

function exactTripReceipt(
  payload: Record<string, unknown>,
  operation: TripReceiptOperation,
  tripId: string,
  status: "active" | "completed",
  source: "live" | "past_report",
  expectedHasPhoto?: boolean,
) {
  const receipt = payload.receipt && typeof payload.receipt === "object"
    ? payload.receipt as Record<string, unknown>
    : {};
  const trip = payload.trip && typeof payload.trip === "object"
    ? payload.trip as Record<string, unknown>
    : {};
  if (
    receipt.operation !== operation || receipt.tripId !== tripId ||
    trip.id !== tripId || trip.status !== status || trip.source !== source ||
    (typeof expectedHasPhoto === "boolean" && trip.hasPhoto !== expectedHasPhoto)
  ) throw new AmbiguousTripSubmissionError();
  return trip;
}

function secureTripRequestMaterial(operation: "start" | "past") {
  const storageKey = `${TRIP_REQUEST_PREFIX}${operation}`;
  const stored = window.localStorage.getItem(storageKey);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as Partial<TripRequestMaterial>;
      if (
        typeof parsed.id === "string" && /^trip_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(parsed.id) &&
        typeof parsed.token === "string" && /^[A-Za-z0-9_-]{43}$/.test(parsed.token)
      ) return { id: parsed.id, token: parsed.token };
    } catch {
      // Replace corrupt local request material with a new cryptographic identity.
    }
  }
  if (typeof window.crypto?.randomUUID !== "function" || typeof window.crypto?.getRandomValues !== "function") {
    throw new Error("This browser cannot create a secure trip recovery identity. Update the browser before submitting.");
  }
  const bytes = window.crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const material = {
    id: `trip_${window.crypto.randomUUID()}`,
    token: window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  };
  window.localStorage.setItem(storageKey, JSON.stringify(material));
  return material;
}

function tripPendingKey(operation: "start" | "past" | `complete.${string}`) {
  return `${TRIP_PENDING_PREFIX}${operation}`;
}

function markTripPending(operation: "start" | "past" | `complete.${string}`) {
  window.localStorage.setItem(tripPendingKey(operation), new Date().toISOString());
}

function clearTripPending(operation: "start" | "past" | `complete.${string}`) {
  window.localStorage.removeItem(tripPendingKey(operation));
}

function isAmbiguousSubmission(error: unknown) {
  return error instanceof TypeError || error instanceof AmbiguousTripSubmissionError;
}

function ambiguousSubmissionMessage(operation: "start" | "complete" | "past") {
  if (operation === "start") {
    return "No exact server receipt arrived. This device kept the draft and recovery identity. Do not assume the trip started; retrying here is safe and cannot create a duplicate.";
  }
  return "No exact server receipt arrived. This device kept the draft and recovery identity. The server may already have accepted it, but retrying here is safe and cannot create a duplicate.";
}

function TripFormStatus({ state, message }: { state: SubmitState; message: string }) {
  return (
    <div
      className={`trip-form-status ${state}`}
      role={state === "error" || state === "ambiguous" ? "alert" : "status"}
      aria-live={state === "error" || state === "ambiguous" ? undefined : "polite"}
    >
      <span>{message}</span>
      {state === "submitting" ? <i aria-hidden="true" /> : null}
    </div>
  );
}

async function refreshSummary(
  setSummary: (summary: SummaryView) => void,
  setUnavailable: (unavailable: boolean) => void,
) {
  try {
    const response = await fetch("/api/trips/summary", { headers: { Accept: "application/json" } });
    setSummary(normalizeSummary(await responsePayload(response)));
    setUnavailable(false);
  } catch {
    setUnavailable(true);
  }
}

function validatePhoto(file: File | null) {
  if (!file) return;
  if (!ACCEPTED_PHOTO_TYPES.has(file.type)) throw new Error("Use a JPEG, PNG, or WebP photo.");
  if (file.size > MAX_PHOTO_BYTES) throw new Error("Photo must be 5 MB or smaller.");
}

function appendCompletionFields(
  formData: FormData,
  fields: FormFields,
  photo: File | null,
  includeClientTimes = true,
) {
  if (!fields.consent) throw new Error("Confirm the trip report before submitting.");
  if (!fields.primaryTargetConfirmed) {
    throw new Error("Confirm that California halibut was the primary target for the whole trip.");
  }
  if (!fields.completeAttempt) {
    throw new Error("Confirm that this report covers the whole fishing attempt.");
  }
  if (!fields.mode) throw new Error("Choose the fishing mode used for the whole trip.");
  if (fields.keeperCount > 25 || fields.shortReleasedCount > 25 || fields.keeperCount + fields.shortReleasedCount > 40) {
    throw new Error("Halibut counts must be 25 or fewer per field and 40 or fewer combined.");
  }
  validatePhoto(photo);

  if (includeClientTimes) {
    const startedAt = isoFromLocalInput(fields.startedAt);
    const endedAt = isoFromLocalInput(fields.endedAt);
    if (new Date(endedAt) <= new Date(startedAt)) throw new Error("End time must be after the start time.");
    formData.set("startedAt", startedAt);
    formData.set("endedAt", endedAt);
  }
  formData.set("keeperCount", String(fields.keeperCount));
  formData.set("shortReleasedCount", String(fields.shortReleasedCount));
  formData.set("gearProfileId", fields.gearProfileId);
  formData.set("rod", fields.rod.trim());
  formData.set("reel", fields.reel.trim());
  formData.set("baitLure", fields.baitLure.trim());
  formData.set("rig", fields.rig.trim());
  formData.set("otherCatchCount", String(fields.otherCatchCount));
  formData.set("otherSpecies", fields.otherSpecies.trim());
  formData.set("shorebreak", fields.shorebreak);
  formData.set("wadingDepth", fields.wadingDepth);
  formData.set("waterClarity", fields.waterClarity);
  formData.set("crowding", fields.crowding);
  formData.set("fishabilityRating", fields.fishabilityRating);
  formData.set("observedWaveHeightFeet", fields.observedWaveHeightFeet);
  formData.set("fishabilityNotes", fields.fishabilityNotes.trim());
  formData.set("notes", fields.notes.trim());
  formData.set("consent", "true");
  formData.set("primaryTargetConfirmed", "true");
  formData.set("completeAttempt", "true");
  formData.set("website", "");
  if (photo) formData.set("photo", photo);
}

function elapsedLabel(startedAt: string) {
  const start = new Date(startedAt);
  const minutes = Math.max(0, Math.round((Date.now() - start.getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m underway`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours}h ${remainder}m underway`;
}

export function TripReportFeature({ sites, snapshot, request, canSubmit, onRequireLogin }: TripReportFeatureProps) {
  const openerRef = useRef<HTMLElement | null>(null);
  const lastRequestKeyRef = useRef<number | null>(null);
  const handledInitialQueryRef = useRef(false);
  const restoredClientStateRef = useRef(false);
  const referralCodeRef = useRef<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [activeTrip, setActiveTrip] = useState<StoredActiveTrip | null>(null);
  const [selectedWindow, setSelectedWindow] = useState<OpportunityWindow | null>(null);
  const [fields, setFields] = useState<FormFields>(() => freshFields());
  const [formStep, setFormStep] = useState<1 | 2>(1);
  const [gearProfiles, setGearProfiles] = useState<GearProfile[]>([]);
  const [photo, setPhoto] = useState<File | null>(null);
  const [rejectedPhoto, setRejectedPhoto] = useState<RejectedPhoto | null>(null);
  const [photoTransferState, setPhotoTransferState] = useState<PhotoTransferState>("idle");
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [message, setMessage] = useState("");
  const [summary, setSummary] = useState<SummaryView | null>(null);
  const [summaryUnavailable, setSummaryUnavailable] = useState(false);
  const networkState = useClientNetworkState();

  const siteMap = useMemo(() => new Map(sites.map((site) => [site.id, site])), [sites]);
  const targetEncounters = fields.keeperCount + fields.shortReleasedCount;
  const anyFishEncounters = targetEncounters + fields.otherCatchCount;
  const currentStartWindow = panel === "start"
    ? findForecastWindow(snapshot, fields.siteId, new Date().toISOString())
    : null;
  const displayedSubmitState = submitState === "idle" && networkState === "offline" ? "error" : submitState;
  const displayedSubmitMessage = submitState === "idle" && networkState === "offline"
    ? "This device appears offline. Drafts stay on this device, and trip submissions are paused."
    : submitState === "idle" && networkState === "restored"
      ? "This device reports that its connection is back. Nothing was resubmitted automatically; review any earlier status before trying again."
      : message;

  const resetFeedback = useCallback(() => {
    setSubmitState("idle");
    setMessage("");
    setPhoto(null);
    setRejectedPhoto(null);
    setPhotoTransferState("idle");
    if (photoInputRef.current) photoInputRef.current.value = "";
  }, []);

  const openPanel = useCallback((nextPanel: Panel, siteId?: string, forecastWindow?: OpportunityWindow) => {
    if (!canSubmit) {
      onRequireLogin();
      return;
    }
    const activeElement = document.activeElement;
    openerRef.current = activeElement instanceof HTMLElement ? activeElement : null;
    resetFeedback();
    setFormStep(1);
    setSelectedWindow(forecastWindow ?? null);

    if (nextPanel === "complete" && activeTrip) {
      const fallback = {
        ...freshFields(activeTrip.siteId),
        startedAt: localDateTimeValue(new Date(activeTrip.startedAt)),
        endedAt: localDateTimeValue(new Date()),
        anglerCount: activeTrip.anglerCount,
        fishingMethod: activeTrip.fishingMethod,
        gearProfileId: activeTrip.gearProfileId,
        rod: activeTrip.rod,
        reel: activeTrip.reel,
        baitLure: activeTrip.baitLure,
        rig: activeTrip.rig,
        mode: activeTrip.mode,
        scoreInfluencedChoice: "" as const,
        primaryTargetConfirmed: false,
        completeAttempt: false,
      };
      setFields(parseFormDraft(window.localStorage.getItem(`${TRIP_DRAFT_PREFIX}complete.${activeTrip.id}`), fallback));
    } else if (nextPanel === "start") {
      const fallback = {
        ...freshFields(siteId ?? sites[0]?.id ?? ""),
        startedAt: localDateTimeValue(new Date()),
        endedAt: localDateTimeValue(new Date()),
      };
      setFields(parseFormDraft(window.localStorage.getItem(`${TRIP_DRAFT_PREFIX}start`), fallback));
    } else {
      const fallback = freshFields(siteId ?? sites[0]?.id ?? "");
      setFields(parseFormDraft(window.localStorage.getItem(`${TRIP_DRAFT_PREFIX}past`), fallback));
    }

    const pendingOperation = nextPanel === "complete"
      ? activeTrip ? `complete.${activeTrip.id}` as const : null
      : nextPanel;
    if (pendingOperation && window.localStorage.getItem(tripPendingKey(pendingOperation))) {
      setFormStep(2);
      setSubmitState("ambiguous");
      setMessage(ambiguousSubmissionMessage(nextPanel));
    }

    if (nextPanel === "past") {
      const url = new URL(window.location.href);
      url.searchParams.set("report", "trip");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
    setPanel(nextPanel);
  }, [activeTrip, canSubmit, onRequireLogin, resetFeedback, sites]);

  const closePanel = useCallback(() => {
    setPanel(null);
    resetFeedback();
    const url = new URL(window.location.href);
    if (url.searchParams.get("report") === "trip") {
      url.searchParams.delete("report");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
  }, [resetFeedback]);

  const dialogRef = useModalDialog<HTMLElement>({
    open: Boolean(panel),
    onClose: closePanel,
    openerRef,
  });

  useEffect(() => {
    if (restoredClientStateRef.current) return;
    restoredClientStateRef.current = true;
    const stored = parseStoredTrip(
      window.localStorage.getItem(ACTIVE_TRIP_KEY) ??
        window.localStorage.getItem(LEGACY_ACTIVE_TRIP_KEY),
    );
    const restoreFrame = window.requestAnimationFrame(() => setActiveTrip(stored));

    const query = new URL(window.location.href).searchParams;
    const referralCode = query.get("ref");
    referralCodeRef.current = referralCode && /^[a-z0-9_-]{1,64}$/i.test(referralCode) ? referralCode : null;
    if (!handledInitialQueryRef.current && query.get("report") === "trip") {
      handledInitialQueryRef.current = true;
      window.requestAnimationFrame(() => openPanel("past"));
    }
    return () => window.cancelAnimationFrame(restoreFrame);
  }, [openPanel]);

  useEffect(() => {
    if (!request || request.key === lastRequestKeyRef.current) return;
    lastRequestKeyRef.current = request.key;
    openPanel(request.mode, request.siteId, request.window);
  }, [openPanel, request]);

  useEffect(() => {
    let active = true;
    void refreshSummary(
      (nextSummary) => {
        if (active) setSummary(nextSummary);
      },
      (unavailable) => {
        if (active) setSummaryUnavailable(unavailable);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!canSubmit) return;
    let active = true;
    void fetch("/api/gear-profiles", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : { gearProfiles: [] })
      .then((body: { gearProfiles?: GearProfile[] }) => {
        if (active) setGearProfiles(body.gearProfiles ?? []);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [canSubmit, panel]);

  useEffect(() => {
    if (!panel) return;
    const suffix = panel === "complete" && activeTrip ? `complete.${activeTrip.id}` : panel;
    window.localStorage.setItem(`${TRIP_DRAFT_PREFIX}${suffix}`, JSON.stringify(fields));
  }, [activeTrip, fields, panel]);

  const handlePhoto = (event: ChangeEvent<HTMLInputElement>) => {
    const nextPhoto = event.target.files?.[0] ?? null;
    if (!nextPhoto) {
      setPhoto(null);
      setRejectedPhoto(null);
      setPhotoTransferState("idle");
      return;
    }
    try {
      validatePhoto(nextPhoto);
      setPhoto(nextPhoto);
      setRejectedPhoto(null);
      setPhotoTransferState("selected");
    } catch (error) {
      setPhoto(null);
      setRejectedPhoto({
        name: nextPhoto.name,
        type: nextPhoto.type,
        size: nextPhoto.size,
        message: error instanceof Error ? error.message : "That photo cannot be used.",
      });
      setPhotoTransferState("idle");
      event.target.value = "";
    }
  };

  const removePhoto = () => {
    setPhoto(null);
    setRejectedPhoto(null);
    setPhotoTransferState("idle");
    if (photoInputRef.current) photoInputRef.current.value = "";
  };

  const updateCount = (key: "anglerCount" | "keeperCount" | "shortReleasedCount" | "otherCatchCount", value: string) => {
    const parsed = integerValue(value);
    setFields((current) => ({ ...current, [key]: key === "anglerCount" ? Math.min(12, Math.max(1, parsed)) : parsed }));
  };

  const applyGearProfile = (profileId: string) => {
    const profile = gearProfiles.find((candidate) => candidate.id === profileId);
    setFields((current) => profile ? {
      ...current,
      gearProfileId: profile.id,
      rod: profile.rod ?? "",
      reel: profile.reel ?? "",
      baitLure: profile.bait_lure ?? "",
      rig: profile.rig ?? "",
    } : { ...current, gearProfileId: "" });
  };

  const updateSite = (siteId: string) => {
    setFields((current) => ({ ...current, siteId }));
    if (selectedWindow && selectedWindow.siteId !== siteId) setSelectedWindow(null);
  };

  const startTrip = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (networkState === "offline") {
      setSubmitState("error");
      setMessage("This device appears offline. The trip was not submitted; reconnect before starting it.");
      return;
    }
    const site = siteMap.get(fields.siteId);
    if (!site) {
      setSubmitState("error");
      setMessage("Choose a fishing location.");
      return;
    }
    if (!fields.consent) {
      setSubmitState("error");
      setMessage("Confirm the collection and evaluation consent before starting.");
      return;
    }
    if (!fields.primaryTargetConfirmed) {
      setSubmitState("error");
      setMessage("Confirm that California halibut is the primary target for this whole trip.");
      return;
    }
    if (!fields.mode) {
      setSubmitState("error");
      setMessage("Choose the fishing mode you will use for this trip.");
      return;
    }
    if (!fields.scoreInfluencedChoice) {
      setSubmitState("error");
      setMessage("Answer whether the CastingCompass score influenced this trip choice.");
      return;
    }
    setSubmitState("submitting");
    setMessage("Sending the trip start to the server. No trip is confirmed yet.");
    const slowNotice = window.setTimeout(() => {
      setMessage("Still waiting for the server. Keep this page open; no trip start has been confirmed yet.");
    }, SLOW_SUBMISSION_NOTICE_MS);
    try {
      const requestMaterial = secureTripRequestMaterial("start");
      const startedAt = new Date().toISOString();
      const forecastWindow = findForecastWindow(snapshot, site.id, startedAt);
      markTripPending("start");
      const response = await fetch("/api/trips/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          clientTripId: requestMaterial.id,
          requestToken: requestMaterial.token,
          siteId: site.id,
          startedAt,
          anglerCount: fields.anglerCount,
          mode: fields.mode,
          fishingMethod: fields.fishingMethod,
          method: fields.fishingMethod,
          gearProfileId: fields.gearProfileId,
          rod: fields.rod,
          reel: fields.reel,
          baitLure: fields.baitLure,
          rig: fields.rig,
          scoreInfluencedChoice: fields.scoreInfluencedChoice === "yes",
          primaryTargetConfirmed: fields.primaryTargetConfirmed,
          reporterKey: anonymousReporterKey(),
          consent: fields.consent,
          website: "",
          ...(referralCodeRef.current ? { referralCode: referralCodeRef.current } : {}),
          ...forecastFields(forecastWindow),
        }),
      });
      const payload = await tripSubmissionPayload(response);
      const trip = exactTripReceipt(payload, "start", requestMaterial.id, "active", "live");
      const id = requestMaterial.id;
      const token = typeof payload.token === "string" ? payload.token : null;
      if (token !== requestMaterial.token) throw new AmbiguousTripSubmissionError();
      const authoritativeStartedAt = typeof trip.startedAt === "string" ? trip.startedAt : startedAt;
      const stored: StoredActiveTrip = {
        id,
        token,
        siteId: site.id,
        siteName: site.name,
        startedAt: authoritativeStartedAt,
        anglerCount: fields.anglerCount,
        mode: fields.mode,
        opportunityWindowId: forecastWindow?.id,
        opportunityScore: forecastWindow?.score,
        modelVersion: forecastWindow?.modelVersion ?? snapshot.modelVersion,
        fishingMethod: fields.fishingMethod,
        gearProfileId: fields.gearProfileId,
        rod: fields.rod,
        reel: fields.reel,
        baitLure: fields.baitLure,
        rig: fields.rig,
        scoreInfluencedChoice: fields.scoreInfluencedChoice === "yes",
      };
      window.localStorage.setItem(ACTIVE_TRIP_KEY, JSON.stringify(stored));
      window.localStorage.removeItem(LEGACY_ACTIVE_TRIP_KEY);
      window.localStorage.removeItem(`${TRIP_DRAFT_PREFIX}start`);
      window.localStorage.removeItem(`${TRIP_REQUEST_PREFIX}start`);
      clearTripPending("start");
      setActiveTrip(stored);
      setSubmitState("success");
      setMessage("Trip started. Return here when you finish—even if the result is zero fish.");
    } catch (error) {
      const ambiguous = isAmbiguousSubmission(error);
      if (!ambiguous) {
        window.localStorage.removeItem(`${TRIP_REQUEST_PREFIX}start`);
        clearTripPending("start");
      }
      setSubmitState(ambiguous ? "ambiguous" : "error");
      setMessage(ambiguous
        ? ambiguousSubmissionMessage("start")
        : error instanceof Error ? error.message : "The trip could not be started.");
    } finally {
      window.clearTimeout(slowNotice);
    }
  };

  const completeTrip = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeTrip) return;
    if (networkState === "offline") {
      setSubmitState("error");
      setMessage("This device appears offline. The report was not submitted and its draft remains on this device.");
      return;
    }
    setSubmitState("submitting");
    setMessage("Saving the complete trip report. Keep this page open until the server confirms it.");
    const slowNotice = window.setTimeout(() => {
      setMessage("Still saving. The draft remains on this device, and no completed report is confirmed yet.");
    }, SLOW_SUBMISSION_NOTICE_MS);
    try {
      const formData = new FormData();
      appendCompletionFields(formData, fields, photo, false);
      formData.set("endedAt", new Date().toISOString());
      formData.set("token", activeTrip.token);
      formData.set("reporterKey", anonymousReporterKey());
      formData.set("anglerCount", String(fields.anglerCount));
      formData.set("mode", fields.mode);
      formData.set("fishingMethod", fields.fishingMethod);
      formData.set("method", fields.fishingMethod);
      if (photo) setPhotoTransferState("sending");
      markTripPending(`complete.${activeTrip.id}`);
      const response = await fetch(`/api/trips/${encodeURIComponent(activeTrip.id)}/complete`, {
        method: "POST",
        body: formData,
      });
      const payload = await tripSubmissionPayload(response);
      exactTripReceipt(payload, "complete", activeTrip.id, "completed", "live", Boolean(photo));
      window.localStorage.removeItem(ACTIVE_TRIP_KEY);
      window.localStorage.removeItem(LEGACY_ACTIVE_TRIP_KEY);
      window.localStorage.removeItem(`${TRIP_DRAFT_PREFIX}complete.${activeTrip.id}`);
      clearTripPending(`complete.${activeTrip.id}`);
      setActiveTrip(null);
      void refreshSummary(setSummary, setSummaryUnavailable);
      if (photo) setPhotoTransferState("confirmed");
      setSubmitState("success");
      const photoConfirmation = photo ? " The verification photo is stored privately with the trip." : "";
      setMessage((anyFishEncounters === 0
        ? "No-fish trip recorded. That result is essential for an honest evaluation backlog and is pending review."
        : targetEncounters === 0
          ? "Non-target fish recorded with zero California halibut. The complete result is pending review."
        : "Trip recorded and pending review. Thanks for helping build the evaluation backlog.") + photoConfirmation);
    } catch (error) {
      const ambiguous = isAmbiguousSubmission(error);
      if (!ambiguous) clearTripPending(`complete.${activeTrip.id}`);
      if (photo) setPhotoTransferState(ambiguous ? "ambiguous" : "failed");
      setSubmitState(ambiguous ? "ambiguous" : "error");
      setMessage(ambiguous
        ? ambiguousSubmissionMessage("complete")
        : error instanceof Error ? error.message : "The trip could not be completed.");
    } finally {
      window.clearTimeout(slowNotice);
    }
  };

  const reportPastTrip = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (networkState === "offline") {
      setSubmitState("error");
      setMessage("This device appears offline. The report was not submitted and its draft remains on this device.");
      return;
    }
    const site = siteMap.get(fields.siteId);
    if (!site) {
      setSubmitState("error");
      setMessage("Choose a fishing location.");
      return;
    }
    if (!fields.mode) {
      setSubmitState("error");
      setMessage("Choose the fishing mode used for this trip.");
      return;
    }
    if (!fields.scoreInfluencedChoice) {
      setSubmitState("error");
      setMessage("Answer whether the CastingCompass score influenced this trip choice.");
      return;
    }
    setSubmitState("submitting");
    setMessage("Saving the past trip report. Keep this page open until the server confirms it.");
    const slowNotice = window.setTimeout(() => {
      setMessage("Still saving. The draft remains on this device, and no report is confirmed yet.");
    }, SLOW_SUBMISSION_NOTICE_MS);
    try {
      const requestMaterial = secureTripRequestMaterial("past");
      const formData = new FormData();
      appendCompletionFields(formData, fields, photo);
      formData.set("clientTripId", requestMaterial.id);
      formData.set("requestToken", requestMaterial.token);
      formData.set("siteId", site.id);
      formData.set("anglerCount", String(fields.anglerCount));
      formData.set("mode", fields.mode);
      formData.set("fishingMethod", fields.fishingMethod);
      formData.set("method", fields.fishingMethod);
      formData.set("scoreInfluencedChoice", String(fields.scoreInfluencedChoice === "yes"));
      formData.set("reporterKey", anonymousReporterKey());
      if (referralCodeRef.current) formData.set("referralCode", referralCodeRef.current);
      if (photo) setPhotoTransferState("sending");
      markTripPending("past");
      const response = await fetch("/api/trips/report", { method: "POST", body: formData });
      const payload = await tripSubmissionPayload(response);
      exactTripReceipt(payload, "past", requestMaterial.id, "completed", "past_report", Boolean(photo));
      window.localStorage.removeItem(`${TRIP_DRAFT_PREFIX}past`);
      window.localStorage.removeItem(`${TRIP_REQUEST_PREFIX}past`);
      clearTripPending("past");
      void refreshSummary(setSummary, setSummaryUnavailable);
      if (photo) setPhotoTransferState("confirmed");
      setSubmitState("success");
      const photoConfirmation = photo ? " The verification photo is stored privately with the trip." : "";
      setMessage((anyFishEncounters === 0
        ? "No-fish trip recorded and pending review. Past reports provide descriptive context and stay outside prospective evidence."
        : targetEncounters === 0
          ? "Non-target fish recorded with zero California halibut. The complete result is pending review."
        : "Past trip recorded and pending review. Thank you.") + photoConfirmation);
    } catch (error) {
      const ambiguous = isAmbiguousSubmission(error);
      if (!ambiguous) {
        window.localStorage.removeItem(`${TRIP_REQUEST_PREFIX}past`);
        clearTripPending("past");
      }
      if (photo) setPhotoTransferState(ambiguous ? "ambiguous" : "failed");
      setSubmitState(ambiguous ? "ambiguous" : "error");
      setMessage(ambiguous
        ? ambiguousSubmissionMessage("past")
        : error instanceof Error ? error.message : "The trip could not be reported.");
    } finally {
      window.clearTimeout(slowNotice);
    }
  };

  const openShareableReport = () => openPanel("past");

  return (
    <>
      {activeTrip ? (
        <aside className="active-trip-banner" aria-label="Active fishing trip">
          <div>
            <span><i /> Active trip</span>
            <strong>{activeTrip.siteName}</strong>
            <small><ClockIcon /> {elapsedLabel(activeTrip.startedAt)}</small>
          </div>
          <button type="button" onClick={() => openPanel("complete")}>Finish trip <ArrowIcon /></button>
        </aside>
      ) : null}

      <section className="validation-section" id="validation">
        <div className="validation-copy">
          <span className="eyebrow"><span /> Community trip log beta</span>
          <h2>The skunks<br />count, too.</h2>
          <p>
            Any complete trip helps build a structured backlog for future evaluation. Location,
            time, effort, method, catches, whether it’s a skunk or not are useful and genuinely appreciated.
          </p>
          <div className="validation-actions">
            <button type="button" onClick={() => openPanel("start", sites[0]?.id)}>Start a trip <ArrowIcon /></button>
            <button type="button" onClick={openShareableReport}>Log a past trip</button>
          </div>
          <small>
            Beta · a separate validation protocol decides whether a report can become model evidence; nothing enters training automatically. This public ledger shows aggregate totals only;
            any separate discussion summary requires human approval and additional safety checks.
          </small>
        </div>
        <div className="validation-ledger" aria-label="Community trip summary">
          <div className="ledger-heading">
            <span>Community trip log</span>
            <em>Totals only</em>
          </div>
          {summary ? (
            <div className="ledger-grid">
              <div><strong>{summary.completedTrips}</strong><span>Completed trips</span><RecentDelta value={summary.past24Hours.completedTrips} /></div>
              <div><strong>{summary.anglerHours.toFixed(summary.anglerHours % 1 === 0 ? 0 : 1)}</strong><span>Angler-hours</span><RecentDelta value={summary.past24Hours.anglerHours} decimals={summary.past24Hours.anglerHours % 1 === 0 ? 0 : 1} /></div>
              <div><strong>{summary.halibutEncounters}</strong><span>Halibut encounters</span><RecentDelta value={summary.past24Hours.halibutEncounters} /></div>
              <div><strong>{summary.sitesCovered}</strong><span>Sites covered</span><RecentDelta value={summary.past24Hours.sitesCovered} /></div>
            </div>
          ) : (
            <div className="ledger-empty">
              <strong>{summaryUnavailable ? "Trip totals coming online" : "Loading trip totals…"}</strong>
              <p>Community totals appear here. Trip reports do not change the current score; any future model use requires the separate validation protocol.</p>
            </div>
          )}
          <p className="ledger-method">
            The future accuracy measure compares catch per angler-hour in highly ranked windows against lower-ranked windows—not anecdotes alone.
          </p>
        </div>
      </section>

      {panel ? (
        <div className="trip-modal-layer" role="presentation" onClick={(event) => {
          if (event.target === event.currentTarget) closePanel();
        }}>
          <section
            ref={dialogRef}
            className="trip-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="trip-modal-title"
            tabIndex={-1}
          >
            <button className="sheet-close" type="button" onClick={closePanel} aria-label="Close trip report"><CloseIcon /></button>
            <span className="eyebrow"><span /> Evaluation trip log</span>

            {panel === "start" ? (
              <form onSubmit={formStep === 1 ? (event) => { event.preventDefault(); setFormStep(2); } : startTrip}>
                <fieldset className="trip-write-fields" disabled={submitState === "submitting" || submitState === "ambiguous"}>
                <header className="trip-form-heading">
                  <h2 id="trip-modal-title">Start fishing.</h2>
                  <p>We save the chosen forecast now, then ask for the full result when you finish.</p>
                </header>
                <div className="trip-step-indicator"><span className={formStep === 1 ? "active" : ""}>1 · Trip</span><span className={formStep === 2 ? "active" : ""}>2 · Gear</span></div>
                {formStep === 1 ? <div className="trip-field-grid">
                  <SiteCombobox className="trip-field wide" sites={sites} value={fields.siteId} onChange={updateSite} />
                  <div className="trip-field">
                    <span>Start time</span>
                    <strong>Starts when you tap Start trip</strong>
                    <small>The server records the exact start; use Log a past trip for an earlier attempt.</small>
                  </div>
                  <label className="trip-field">
                    <span>Anglers</span>
                    <input type="number" min="1" max="12" inputMode="numeric" value={fields.anglerCount} onChange={(event) => updateCount("anglerCount", event.target.value)} required />
                  </label>
                  <label className="trip-field">
                    <span>Fishing method</span>
                    <select value={fields.fishingMethod} onChange={(event) => setFields((current) => ({ ...current, fishingMethod: event.target.value }))} required>
                      <option value="bait">Bait</option>
                      <option value="artificial-lure">Artificial lure</option>
                      <option value="both">Bait + lure</option>
                      <option value="other">Other</option>
                    </select>
                  </label>
                  <label className="trip-field">
                    <span>Fishing mode for the whole trip</span>
                    <select value={fields.mode} onChange={(event) => setFields((current) => ({ ...current, mode: event.target.value }))} required>
                      <option value="">Choose mode</option>
                      <option value="shore">Shore</option>
                      <option value="beach">Beach</option>
                      <option value="pier">Pier</option>
                      <option value="jetty">Jetty</option>
                      <option value="kayak">Kayak</option>
                      <option value="boat">Boat</option>
                      <option value="other">Other</option>
                    </select>
                  </label>
                  <label className="trip-field">
                    <span>Did the score influence this trip?</span>
                    <select value={fields.scoreInfluencedChoice} onChange={(event) => setFields((current) => ({ ...current, scoreInfluencedChoice: event.target.value as FormFields["scoreInfluencedChoice"] }))} required>
                      <option value="">Choose an answer</option>
                      <option value="yes">Yes</option>
                      <option value="no">No — I had already chosen this trip</option>
                    </select>
                    <small>This answer is preserved, but it does not make a score-visible trip random or independent.</small>
                  </label>
                  <label className="consent-field wide">
                    <input type="checkbox" checked={fields.primaryTargetConfirmed} onChange={(event) => setFields((current) => ({ ...current, primaryTargetConfirmed: event.target.checked }))} required />
                    <span>I confirm California halibut is my primary target for this whole fishing attempt.</span>
                  </label>
                </div> : <>
                <TripGearFields fields={fields} setFields={setFields} gearProfiles={gearProfiles} applyGearProfile={applyGearProfile} />
                {currentStartWindow ? (
                  <div className="captured-forecast">
                    <span>Forecast captured</span>
                    <strong>{Math.round(currentStartWindow.score)}</strong>
                    <p>The server verifies the published window and stores its authoritative score identity with this trip when they match.</p>
                  </div>
                ) : null}
                <div className="trip-privacy-note">
                  <strong>What is stored</strong>
                  <p>Curated site, time, forecast metadata, angler count, and your eventual outcome. No live GPS or social profile is collected. A random recovery key and unfinished-trip token stay in this browser for continuity.</p>
                </div>
                <label className="consent-field">
                  <input type="checkbox" checked={fields.consent} onChange={(event) => setFields((current) => ({ ...current, consent: event.target.checked }))} required />
                  <span>I own anything I submit and consent to the private use described in the <Link href="/terms" target="_blank">Terms</Link> and <Link href="/privacy" target="_blank">Privacy Policy</Link>, including storage in a structured evaluation backlog. Organic score-visible trips are observational secondary or context only—not an active primary validation cohort.</span>
                </label>
                </>}
                {formStep === 2 ? <button className="trip-back-button" type="button" onClick={() => setFormStep(1)}>← Back to trip details</button> : null}
                </fieldset>
                <button className="trip-submit" type="submit" disabled={submitState === "submitting" || Boolean(activeTrip) || (formStep === 2 && networkState === "offline")}>
                  {activeTrip ? "Finish the active trip first" : submitState === "ambiguous" ? "Retry start safely" : formStep === 1 ? "Continue to gear" : submitState === "submitting" ? "Starting…" : networkState === "offline" ? "Reconnect to start trip" : "Start trip"}
                  {!activeTrip && submitState !== "submitting" ? <ArrowIcon /> : null}
                </button>
                <TripFormStatus state={displayedSubmitState} message={displayedSubmitMessage} />
              </form>
            ) : null}

            {panel === "complete" && activeTrip ? (
              <form onSubmit={completeTrip}>
                <fieldset className="trip-write-fields" disabled={submitState === "submitting" || submitState === "ambiguous"}>
                <header className="trip-form-heading">
                  <h2 id="trip-modal-title">Finish the trip.</h2>
                  <p>{activeTrip.siteName} · Finish time is recorded when you submit. California halibut is the fixed target. Zero in every fish-count field records a no-fish trip.</p>
                </header>
                <label className="trip-field wide">
                  <span>Fishing mode for the whole trip</span>
                  <select value={fields.mode} onChange={(event) => setFields((current) => ({ ...current, mode: event.target.value }))} required>
                    <option value="shore">Shore</option>
                    <option value="beach">Beach</option>
                    <option value="pier">Pier</option>
                    <option value="jetty">Jetty</option>
                    <option value="kayak">Kayak</option>
                    <option value="boat">Boat</option>
                    <option value="other">Other</option>
                  </select>
                  <small>If the mode changed after you started, choose the mode that best describes the whole attempt. The report will stay useful as context.</small>
                </label>
                <TripGearFields fields={fields} setFields={setFields} gearProfiles={gearProfiles} applyGearProfile={applyGearProfile} includeObservations />
                <TripCompletionFields fields={fields} setFields={setFields} updateCount={updateCount} photo={photo} rejectedPhoto={rejectedPhoto} photoTransferState={photoTransferState} photoInputRef={photoInputRef} onPhoto={handlePhoto} onRemovePhoto={removePhoto} hideTimes />
                </fieldset>
                <button className="trip-submit" type="submit" disabled={submitState === "submitting" || submitState === "success" || networkState === "offline"}>
                  {submitState === "submitting"
                    ? "Saving…"
                    : networkState === "offline"
                      ? "Reconnect to save report"
                    : submitState === "success"
                      ? "Report saved"
                    : submitState === "ambiguous"
                      ? "Retry safely"
                      : anyFishEncounters === 0
                        ? "Record no-fish trip"
                        : targetEncounters > 0
                          ? `Record ${targetEncounters} halibut`
                          : `Record ${fields.otherCatchCount} non-target fish`}
                  {submitState === "idle" || submitState === "error" || submitState === "ambiguous" ? <ArrowIcon /> : null}
                </button>
                <TripFormStatus state={displayedSubmitState} message={displayedSubmitMessage} />
              </form>
            ) : null}

            {panel === "complete" && !activeTrip && submitState === "success" ? (
              <div className="trip-success-panel">
                <h2 id="trip-modal-title">Trip recorded.</h2>
                <p>{message}</p>
                <button className="trip-submit" type="button" onClick={closePanel}>Done</button>
              </div>
            ) : null}

            {panel === "past" ? (
              <form onSubmit={formStep === 1 ? (event) => { event.preventDefault(); setFormStep(2); } : reportPastTrip}>
                <fieldset className="trip-write-fields" disabled={submitState === "submitting" || submitState === "ambiguous"}>
                <header className="trip-form-heading">
                  <h2 id="trip-modal-title">Log a past trip.</h2>
                  <p>Complete past results—including zero fish—provide exploratory context. They cannot enter prospective primary evidence.</p>
                </header>
                <div className="trip-step-indicator"><span className={formStep === 1 ? "active" : ""}>1 · Trip</span><span className={formStep === 2 ? "active" : ""}>2 · Gear + result</span></div>
                {formStep === 1 ? <div className="trip-field-grid">
                  <SiteCombobox className="trip-field wide" sites={sites} value={fields.siteId} onChange={updateSite} />
                  <label className="trip-field">
                    <span>Start</span>
                    <input type="datetime-local" value={fields.startedAt} onChange={(event) => setFields((current) => ({ ...current, startedAt: event.target.value }))} required />
                  </label>
                  <label className="trip-field">
                    <span>Finish</span>
                    <input type="datetime-local" value={fields.endedAt} onChange={(event) => setFields((current) => ({ ...current, endedAt: event.target.value }))} required />
                  </label>
                  <label className="trip-field">
                    <span>Anglers</span>
                    <input type="number" min="1" max="12" inputMode="numeric" value={fields.anglerCount} onChange={(event) => updateCount("anglerCount", event.target.value)} required />
                  </label>
                  <label className="trip-field">
                    <span>Fishing method</span>
                    <select value={fields.fishingMethod} onChange={(event) => setFields((current) => ({ ...current, fishingMethod: event.target.value }))} required>
                      <option value="bait">Bait</option>
                      <option value="artificial-lure">Artificial lure</option>
                      <option value="both">Bait + lure</option>
                      <option value="other">Other</option>
                    </select>
                  </label>
                  <label className="trip-field">
                    <span>Fishing mode for the whole trip</span>
                    <select value={fields.mode} onChange={(event) => setFields((current) => ({ ...current, mode: event.target.value }))} required>
                      <option value="">Choose mode</option>
                      <option value="shore">Shore</option>
                      <option value="beach">Beach</option>
                      <option value="pier">Pier</option>
                      <option value="jetty">Jetty</option>
                      <option value="kayak">Kayak</option>
                      <option value="boat">Boat</option>
                      <option value="other">Other</option>
                    </select>
                  </label>
                  <label className="trip-field">
                    <span>Did the score influence this trip?</span>
                    <select value={fields.scoreInfluencedChoice} onChange={(event) => setFields((current) => ({ ...current, scoreInfluencedChoice: event.target.value as FormFields["scoreInfluencedChoice"] }))} required>
                      <option value="">Choose an answer</option>
                      <option value="yes">Yes</option>
                      <option value="no">No — I had already chosen this trip</option>
                    </select>
                    <small>This self-report does not make a past trip random, independent, or prospective.</small>
                  </label>
                </div> : <>
                <TripGearFields fields={fields} setFields={setFields} gearProfiles={gearProfiles} applyGearProfile={applyGearProfile} includeObservations />
                <TripCompletionFields fields={fields} setFields={setFields} updateCount={updateCount} photo={photo} rejectedPhoto={rejectedPhoto} photoTransferState={photoTransferState} photoInputRef={photoInputRef} onPhoto={handlePhoto} onRemovePhoto={removePhoto} hideTimes />
                </>}
                {formStep === 2 ? <button className="trip-back-button" type="button" onClick={() => setFormStep(1)}>← Back to trip details</button> : null}
                </fieldset>
                <button className="trip-submit" type="submit" disabled={submitState === "submitting" || submitState === "success" || (formStep === 2 && networkState === "offline")}>
                  {submitState === "ambiguous" ? "Retry safely" : formStep === 1 ? "Continue to gear + result" : submitState === "submitting" ? "Saving…" : networkState === "offline" ? "Reconnect to save report" : submitState === "success" ? "Report saved" : anyFishEncounters === 0 ? "Record no-fish trip" : "Submit trip report"}
                  {submitState === "idle" || submitState === "error" || submitState === "ambiguous" ? <ArrowIcon /> : null}
                </button>
                <TripFormStatus state={displayedSubmitState} message={displayedSubmitMessage} />
              </form>
            ) : null}

            <p className="trip-beta-note">Beta · trip data is saved immediately. Automated review may prepare a private draft, but no discussion summary is posted automatically; human approval is required.</p>
            <p className="trip-draft-note">Draft saved on this device as you type.</p>
          </section>
        </div>
      ) : null}
    </>
  );
}

interface TripCompletionFieldsProps {
  fields: FormFields;
  setFields: (updater: (current: FormFields) => FormFields) => void;
  updateCount: (key: "anglerCount" | "keeperCount" | "shortReleasedCount" | "otherCatchCount", value: string) => void;
  photo: File | null;
  rejectedPhoto: RejectedPhoto | null;
  photoTransferState: PhotoTransferState;
  photoInputRef: React.RefObject<HTMLInputElement | null>;
  onPhoto: (event: ChangeEvent<HTMLInputElement>) => void;
  onRemovePhoto: () => void;
  hideTimes?: boolean;
}

function TripGearFields({
  fields,
  setFields,
  gearProfiles,
  applyGearProfile,
  includeObservations = false,
}: {
  fields: FormFields;
  setFields: (updater: (current: FormFields) => FormFields) => void;
  gearProfiles: GearProfile[];
  applyGearProfile(profileId: string): void;
  includeObservations?: boolean;
}) {
  return (
    <section className="trip-gear-section">
      <div className="trip-subsection-heading"><strong>What did you fish?</strong><span>Optional, but useful for comparing methods fairly.</span></div>
      {gearProfiles.length ? (
        <label className="trip-field wide"><span>Saved gear preset</span>
          <select value={fields.gearProfileId} onChange={(event) => applyGearProfile(event.target.value)}>
            <option value="">Enter gear manually</option>
            {gearProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </select>
        </label>
      ) : null}
      <GearCatalogFields
        values={{ rod: fields.rod, reel: fields.reel, baitLure: fields.baitLure, rig: fields.rig }}
        onChange={(gear) => setFields((current) => ({ ...current, ...gear, gearProfileId: "" }))}
      />
      {includeObservations ? <>
        <div className="trip-subsection-heading"><strong>Could you fish it effectively?</strong><span>Observed conditions help separate fish presence from practical fishability.</span></div>
        <div className="trip-field-grid">
          <label className="trip-field"><span>Shorebreak</span><select value={fields.shorebreak} onChange={(event) => setFields((current) => ({ ...current, shorebreak: event.target.value }))}><option value="">Not noted</option><option value="calm">Calm</option><option value="manageable">Manageable</option><option value="difficult">Difficult</option><option value="unfishable">Unfishable</option></select></label>
          <label className="trip-field"><span>Water reached</span><select value={fields.wadingDepth} onChange={(event) => setFields((current) => ({ ...current, wadingDepth: event.target.value }))}><option value="">Not noted</option><option value="ankle">Ankle</option><option value="knee">Knee</option><option value="thigh">Thigh</option><option value="waist-plus">Waist or higher</option><option value="did-not-wade">Did not wade</option></select></label>
          <label className="trip-field"><span>Water clarity</span><select value={fields.waterClarity} onChange={(event) => setFields((current) => ({ ...current, waterClarity: event.target.value }))}><option value="">Not noted</option><option value="clear">Clear</option><option value="light-stain">Light stain</option><option value="murky">Murky</option><option value="muddy">Muddy</option></select></label>
          <label className="trip-field"><span>Crowding</span><select value={fields.crowding} onChange={(event) => setFields((current) => ({ ...current, crowding: event.target.value }))}><option value="">Not noted</option><option value="empty">Empty</option><option value="light">Light</option><option value="moderate">Moderate</option><option value="packed">Packed</option></select></label>
          <label className="trip-field"><span>Overall fishability</span><select value={fields.fishabilityRating} onChange={(event) => setFields((current) => ({ ...current, fishabilityRating: event.target.value }))}><option value="">Not rated</option><option value="5">5 · Excellent</option><option value="4">4 · Good</option><option value="3">3 · Workable</option><option value="2">2 · Difficult</option><option value="1">1 · Unfishable</option></select></label>
          <label className="trip-field"><span>Observed waves, ft <em>optional</em></span><input type="number" min="0" max="30" step="0.5" value={fields.observedWaveHeightFeet} onChange={(event) => setFields((current) => ({ ...current, observedWaveHeightFeet: event.target.value }))} /></label>
        </div>
        <label className="trip-field wide"><span>Fishability notes <em>optional</em></span><textarea maxLength={500} rows={3} value={fields.fishabilityNotes} onChange={(event) => setFields((current) => ({ ...current, fishabilityNotes: event.target.value }))} placeholder="Steep beach, heavy shorebreak, weeds, snags, room to cast…" /></label>
      </> : null}
    </section>
  );
}

function TripCompletionFields({
  fields,
  setFields,
  updateCount,
  photo,
  rejectedPhoto,
  photoTransferState,
  photoInputRef,
  onPhoto,
  onRemovePhoto,
  hideTimes = false,
}: TripCompletionFieldsProps) {
  return (
    <>
      {!hideTimes ? (
        <div className="trip-field-grid">
          <label className="trip-field">
            <span>Finish time</span>
            <input type="datetime-local" value={fields.endedAt} onChange={(event) => setFields((current) => ({ ...current, endedAt: event.target.value }))} required />
          </label>
        </div>
      ) : null}
      <fieldset className="catch-fieldset">
        <legend>California halibut result</legend>
        <p>California halibut is the fixed observation target. Leave both at zero when none were encountered.</p>
        <div>
          <label className="trip-field count-field">
            <span>Kept</span>
            <input type="number" min="0" max="25" inputMode="numeric" value={fields.keeperCount} onChange={(event) => updateCount("keeperCount", event.target.value)} required />
          </label>
          <label className="trip-field count-field">
            <span>Short / released</span>
            <input type="number" min="0" max="25" inputMode="numeric" value={fields.shortReleasedCount} onChange={(event) => updateCount("shortReleasedCount", event.target.value)} required />
          </label>
        </div>
        <small className="regulation-reminder">
          Only count a kept fish if it was legal. California halibut must be at least 22 inches total length;
          always confirm the <a href="https://wildlife.ca.gov/Fishing/Ocean/Regulations/Fishing-Map/San-Francisco" target="_blank" rel="noreferrer">current CDFW regulations ↗</a>.
        </small>
      </fieldset>
      <fieldset className="catch-fieldset">
        <legend>Other catch</legend>
        <p>Non-halibut catch helps distinguish no fish from a target-specific miss. The count is stored as unresolved non-target fish; an optional species label remains an unverified angler report.</p>
        <div>
          <label className="trip-field count-field"><span>Other fish</span><input type="number" min="0" max="100" inputMode="numeric" value={fields.otherCatchCount} onChange={(event) => updateCount("otherCatchCount", event.target.value)} /></label>
          <label className="trip-field"><span>Species <em>optional</em></span><input maxLength={200} value={fields.otherSpecies} onChange={(event) => setFields((current) => ({ ...current, otherSpecies: event.target.value }))} placeholder="Surf smelt, striped bass…" /></label>
        </div>
      </fieldset>
      <label className="trip-field wide">
        <span>Notes <em>optional</em></span>
        <textarea maxLength={1000} rows={4} value={fields.notes} onChange={(event) => setFields((current) => ({ ...current, notes: event.target.value }))} placeholder="Conditions, technique, approximate size, or anything that affected the trip…" />
        <small>{fields.notes.length}/1000</small>
        <small>Do not include names, contact details, precise locations, access codes, or other private information.</small>
        <small className="discussion-publish-notice">Automated review may prepare a shortened discussion draft. It is not posted automatically and must be approved by a human moderator before it can appear publicly.</small>
      </label>
      {PHOTO_UPLOADS_ENABLED ? (
        <TripPhotoField
          photo={photo}
          rejectedPhoto={rejectedPhoto}
          transferState={photoTransferState}
          inputRef={photoInputRef}
          onPhoto={onPhoto}
          onRemove={onRemovePhoto}
        />
      ) : null}
      <label className="consent-field">
        <input type="checkbox" checked={fields.primaryTargetConfirmed} onChange={(event) => setFields((current) => ({ ...current, primaryTargetConfirmed: event.target.checked }))} required />
        <span>I confirm California halibut was the primary target for this whole fishing attempt.</span>
      </label>
      <label className="consent-field">
        <input type="checkbox" checked={fields.completeAttempt} onChange={(event) => setFields((current) => ({ ...current, completeAttempt: event.target.checked }))} required />
        <span>I confirm this report covers the whole attempt, including all zero-catch time—not just the best part.</span>
      </label>
      <label className="consent-field">
        <input type="checkbox" checked={fields.consent} onChange={(event) => setFields((current) => ({ ...current, consent: event.target.checked }))} required />
        <span>I own anything I submit and consent to the uses described in the <Link href="/terms" target="_blank">Terms</Link> and <Link href="/privacy" target="_blank">Privacy Policy</Link>, including structured evaluation and preparation of a possible public summary. Model use requires separate protocol activation, and a summary cannot appear unless a human moderator approves it.</span>
      </label>
    </>
  );
}

function formatPhotoSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function photoTypeLabel(type: string) {
  if (type === "image/jpeg") return "JPEG";
  if (type === "image/png") return "PNG";
  if (type === "image/webp") return "WebP";
  return type || "Unknown type";
}

function TripPhotoField({
  photo,
  rejectedPhoto,
  transferState,
  inputRef,
  onPhoto,
  onRemove,
}: {
  photo: File | null;
  rejectedPhoto: RejectedPhoto | null;
  transferState: PhotoTransferState;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onPhoto: (event: ChangeEvent<HTMLInputElement>) => void;
  onRemove: () => void;
}) {
  const [preview, setPreview] = useState<{ file: File; url: string } | null>(null);

  useEffect(() => {
    if (!photo) return;
    const reader = new FileReader();
    const handleLoad = () => {
      if (typeof reader.result === "string") setPreview({ file: photo, url: reader.result });
    };
    reader.addEventListener("load", handleLoad);
    reader.readAsDataURL(photo);
    return () => {
      reader.removeEventListener("load", handleLoad);
      if (reader.readyState === FileReader.LOADING) reader.abort();
    };
  }, [photo]);

  const previewUrl = preview?.file === photo ? preview.url : null;

  const displayedFile = photo ?? rejectedPhoto;
  const state = rejectedPhoto ? "invalid" : transferState;
  const statusCopy = rejectedPhoto
    ? rejectedPhoto.message
    : transferState === "selected"
      ? "Browser checks passed. Selected only—nothing has uploaded yet."
      : transferState === "sending"
        ? "Sending with the trip report. No attachment is confirmed yet."
        : transferState === "confirmed"
          ? "The exact trip receipt confirms a private stored photo."
          : transferState === "failed"
            ? "Not confirmed. Correct any report error, then retry the whole report explicitly."
            : transferState === "ambiguous"
              ? "Outcome unknown. Keep this file selected and use the same safe report retry."
              : "Choose one private verification photo. Nothing uploads until the report is submitted.";
  const removable = state === "selected" || state === "failed" || state === "invalid";

  return (
    <section className={`photo-field photo-field-${state}`} aria-labelledby="trip-photo-label">
      <div className="photo-field-heading">
        <span id="trip-photo-label">Verification photo <em>optional</em></span>
        <small aria-live="polite">{statusCopy}</small>
      </div>
      {!displayedFile ? (
        <label className="photo-picker">
          <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={onPhoto} />
          <strong>Choose a photo</strong>
          <small>One JPEG, PNG, or WebP · 5 MB max</small>
        </label>
      ) : (
        <div className="photo-file-card" data-state={state}>
          {previewUrl && photo ? (
            // A local data URL is deliberately not routed through the image optimizer or a provider.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={previewUrl} alt="Selected verification photo preview" />
          ) : <span className="photo-file-placeholder" aria-hidden="true">IMG</span>}
          <div>
            <strong>{displayedFile.name}</strong>
            <span>{photoTypeLabel(displayedFile.type)} · {formatPhotoSize(displayedFile.size)}</span>
            <small>{statusCopy}</small>
          </div>
          {removable ? <button type="button" onClick={onRemove}>{state === "invalid" ? "Dismiss" : "Remove"}</button> : null}
          {state === "failed" ? <button type="submit">Retry report with this photo</button> : null}
        </div>
      )}
      {state === "sending" ? (
        <span
          className="photo-indeterminate-progress"
          role="progressbar"
          aria-label="Sending verification photo with trip report"
          aria-valuetext="Sending with the report; byte progress is unavailable"
        />
      ) : null}
      {state === "sending" || state === "ambiguous" ? (
        <small className="photo-no-cancel-note">A cancel control is intentionally unavailable after submission starts because the server may already have committed the report or photo.</small>
      ) : null}
      <small className="photo-contract-note">Current storage supports one private photo per trip. The server strips metadata and re-encodes accepted files before storage.</small>
    </section>
  );
}
