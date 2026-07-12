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
import type { FishingSite, OpportunitySnapshot, OpportunityWindow, TripReportRequest } from "../types";
import { ArrowIcon, ClockIcon, CloseIcon } from "./icons";

const ACTIVE_TRIP_KEY = "contourcast.active-trip.v1";
const REPORTER_KEY = "contourcast.reporter-key.v1";
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const ACCEPTED_PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

type Panel = "start" | "complete" | "past";
type SubmitState = "idle" | "submitting" | "success" | "error";

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
  contourCastInfluenced: boolean;
}

interface SummaryView {
  completedTrips: number;
  anglerHours: number;
  halibutEncounters: number;
  sitesCovered: number;
}

interface TripReportFeatureProps {
  sites: FishingSite[];
  snapshot: OpportunitySnapshot;
  request: TripReportRequest | null;
}

interface FormFields {
  siteId: string;
  startedAt: string;
  endedAt: string;
  anglerCount: number;
  keeperCount: number;
  shortReleasedCount: number;
  fishingMethod: string;
  contourCastInfluenced: boolean;
  notes: string;
  consent: boolean;
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
    contourCastInfluenced: true,
    notes: "",
    consent: false,
  };
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
      contourCastInfluenced: typeof value.contourCastInfluenced === "boolean" ? value.contourCastInfluenced : true,
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
  return {
    completedTrips: readCount(source, ["completedTrips", "completed_trips", "totalTrips", "total_trips"]),
    anglerHours: readCount(source, ["anglerHours", "angler_hours"]),
    halibutEncounters: readCount(source, ["halibutEncounters", "halibut_encounters", "totalHalibut", "total_halibut"]),
    sitesCovered: readCount(source, ["sitesCovered", "sites_covered"]),
  };
}

function anonymousReporterKey() {
  const existing = window.localStorage.getItem(REPORTER_KEY);
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

function appendCompletionFields(formData: FormData, fields: FormFields, photo: File | null) {
  const startedAt = isoFromLocalInput(fields.startedAt);
  const endedAt = isoFromLocalInput(fields.endedAt);
  if (new Date(endedAt) <= new Date(startedAt)) throw new Error("End time must be after the start time.");
  if (!fields.consent) throw new Error("Confirm the trip report before submitting.");
  if (fields.keeperCount > 25 || fields.shortReleasedCount > 25 || fields.keeperCount + fields.shortReleasedCount > 40) {
    throw new Error("Halibut counts must be 25 or fewer per field and 40 or fewer combined.");
  }
  validatePhoto(photo);

  formData.set("startedAt", startedAt);
  formData.set("endedAt", endedAt);
  formData.set("keeperCount", String(fields.keeperCount));
  formData.set("shortReleasedCount", String(fields.shortReleasedCount));
  formData.set("notes", fields.notes.trim());
  formData.set("consent", "true");
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

export function TripReportFeature({ sites, snapshot, request }: TripReportFeatureProps) {
  const dialogRef = useRef<HTMLElement>(null);
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
  const [photo, setPhoto] = useState<File | null>(null);
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [message, setMessage] = useState("");
  const [summary, setSummary] = useState<SummaryView | null>(null);
  const [summaryUnavailable, setSummaryUnavailable] = useState(false);

  const siteMap = useMemo(() => new Map(sites.map((site) => [site.id, site])), [sites]);
  const totalFish = fields.keeperCount + fields.shortReleasedCount;

  const resetFeedback = useCallback(() => {
    setSubmitState("idle");
    setMessage("");
    setPhoto(null);
    if (photoInputRef.current) photoInputRef.current.value = "";
  }, []);

  const openPanel = useCallback((nextPanel: Panel, siteId?: string, forecastWindow?: OpportunityWindow) => {
    const activeElement = document.activeElement;
    openerRef.current = activeElement instanceof HTMLElement ? activeElement : null;
    resetFeedback();
    setSelectedWindow(forecastWindow ?? null);

    if (nextPanel === "complete" && activeTrip) {
      setFields({
        ...freshFields(activeTrip.siteId),
        startedAt: localDateTimeValue(new Date(activeTrip.startedAt)),
        endedAt: localDateTimeValue(new Date()),
        anglerCount: activeTrip.anglerCount,
        fishingMethod: activeTrip.fishingMethod,
        contourCastInfluenced: activeTrip.contourCastInfluenced,
      });
    } else if (nextPanel === "start") {
      setFields({
        ...freshFields(siteId ?? sites[0]?.id ?? ""),
        startedAt: localDateTimeValue(new Date()),
        endedAt: localDateTimeValue(new Date()),
      });
    } else {
      setFields(freshFields(siteId ?? sites[0]?.id ?? ""));
    }

    if (nextPanel === "past") {
      const url = new URL(window.location.href);
      url.searchParams.set("report", "trip");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
    setPanel(nextPanel);
  }, [activeTrip, resetFeedback, sites]);

  const closePanel = useCallback(() => {
    setPanel(null);
    resetFeedback();
    const url = new URL(window.location.href);
    if (url.searchParams.get("report") === "trip") {
      url.searchParams.delete("report");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
  }, [resetFeedback]);

  useEffect(() => {
    if (restoredClientStateRef.current) return;
    restoredClientStateRef.current = true;
    const stored = parseStoredTrip(window.localStorage.getItem(ACTIVE_TRIP_KEY));
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
    if (!panel || !dialogRef.current) return;
    const dialog = dialogRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => dialog.focus({ preventScroll: true }));

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePanel();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ));
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      window.requestAnimationFrame(() => openerRef.current?.focus({ preventScroll: true }));
    };
  }, [closePanel, panel]);

  const handlePhoto = (event: ChangeEvent<HTMLInputElement>) => {
    const nextPhoto = event.target.files?.[0] ?? null;
    try {
      validatePhoto(nextPhoto);
      setPhoto(nextPhoto);
      if (submitState === "error") {
        setSubmitState("idle");
        setMessage("");
      }
    } catch (error) {
      setPhoto(null);
      event.target.value = "";
      setSubmitState("error");
      setMessage(error instanceof Error ? error.message : "That photo cannot be used.");
    }
  };

  const updateCount = (key: "anglerCount" | "keeperCount" | "shortReleasedCount", value: string) => {
    const parsed = integerValue(value);
    setFields((current) => ({ ...current, [key]: key === "anglerCount" ? Math.min(12, Math.max(1, parsed)) : parsed }));
  };

  const updateSite = (siteId: string) => {
    setFields((current) => ({ ...current, siteId }));
    if (selectedWindow && selectedWindow.siteId !== siteId) setSelectedWindow(null);
  };

  const startTrip = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const site = siteMap.get(fields.siteId);
    if (!site) {
      setSubmitState("error");
      setMessage("Choose a fishing location.");
      return;
    }
    if (!fields.consent) {
      setSubmitState("error");
      setMessage("Confirm the validation consent before starting.");
      return;
    }
    setSubmitState("submitting");
    setMessage("");
    try {
      const startedAt = isoFromLocalInput(fields.startedAt);
      const response = await fetch("/api/trips/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          siteId: site.id,
          startedAt,
          anglerCount: fields.anglerCount,
          mode: site.type.toLowerCase(),
          fishingMethod: fields.fishingMethod,
          method: fields.fishingMethod,
          contourCastInfluenced: fields.contourCastInfluenced,
          reporterKey: anonymousReporterKey(),
          consent: fields.consent,
          website: "",
          opportunityWindowId: selectedWindow?.id,
          opportunityScore: selectedWindow?.score,
          habitatScore: selectedWindow?.habitatScore,
          seasonalityScore: selectedWindow?.seasonalityScore,
          conditionsScore: selectedWindow?.dynamicScore,
          modelVersion: selectedWindow?.modelVersion ?? snapshot.modelVersion,
        }),
      });
      const payload = await responsePayload(response);
      const trip = payload.trip && typeof payload.trip === "object" ? payload.trip as Record<string, unknown> : {};
      const id = typeof trip.id === "string" ? trip.id : typeof payload.tripId === "string" ? payload.tripId : null;
      const token = typeof payload.token === "string" ? payload.token : null;
      if (!id || !token) throw new Error("The trip started, but this browser did not receive a recovery token.");
      const stored: StoredActiveTrip = {
        id,
        token,
        siteId: site.id,
        siteName: site.name,
        startedAt,
        anglerCount: fields.anglerCount,
        mode: site.type.toLowerCase(),
        opportunityWindowId: selectedWindow?.id,
        opportunityScore: selectedWindow?.score,
        modelVersion: selectedWindow?.modelVersion ?? snapshot.modelVersion,
        fishingMethod: fields.fishingMethod,
        contourCastInfluenced: fields.contourCastInfluenced,
      };
      window.localStorage.setItem(ACTIVE_TRIP_KEY, JSON.stringify(stored));
      setActiveTrip(stored);
      setSubmitState("success");
      setMessage("Trip started. Return here when you finish—even if the result is zero fish.");
    } catch (error) {
      setSubmitState("error");
      setMessage(error instanceof Error ? error.message : "The trip could not be started.");
    }
  };

  const completeTrip = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeTrip) return;
    setSubmitState("submitting");
    setMessage("");
    try {
      const formData = new FormData();
      appendCompletionFields(formData, fields, photo);
      formData.set("token", activeTrip.token);
      formData.set("reporterKey", anonymousReporterKey());
      formData.set("anglerCount", String(fields.anglerCount));
      formData.set("mode", activeTrip.mode);
      formData.set("fishingMethod", fields.fishingMethod);
      formData.set("method", fields.fishingMethod);
      formData.set("contourCastInfluenced", String(fields.contourCastInfluenced));
      const response = await fetch(`/api/trips/${encodeURIComponent(activeTrip.id)}/complete`, {
        method: "POST",
        body: formData,
      });
      await responsePayload(response);
      window.localStorage.removeItem(ACTIVE_TRIP_KEY);
      setActiveTrip(null);
      void refreshSummary(setSummary, setSummaryUnavailable);
      setSubmitState("success");
      setMessage(totalFish === 0
        ? "No-catch trip recorded. That result is essential for honest validation and is pending review."
        : "Trip recorded and pending review. Thanks for helping validate the ranking.");
    } catch (error) {
      setSubmitState("error");
      setMessage(error instanceof Error ? error.message : "The trip could not be completed.");
    }
  };

  const reportPastTrip = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const site = siteMap.get(fields.siteId);
    if (!site) {
      setSubmitState("error");
      setMessage("Choose a fishing location.");
      return;
    }
    setSubmitState("submitting");
    setMessage("");
    try {
      const formData = new FormData();
      appendCompletionFields(formData, fields, photo);
      formData.set("siteId", site.id);
      formData.set("anglerCount", String(fields.anglerCount));
      formData.set("mode", site.type.toLowerCase());
      formData.set("fishingMethod", fields.fishingMethod);
      formData.set("method", fields.fishingMethod);
      formData.set("contourCastInfluenced", String(fields.contourCastInfluenced));
      formData.set("reporterKey", anonymousReporterKey());
      if (referralCodeRef.current) formData.set("referralCode", referralCodeRef.current);
      if (selectedWindow) {
        formData.set("opportunityWindowId", selectedWindow.id);
        formData.set("opportunityScore", String(selectedWindow.score));
        formData.set("modelVersion", selectedWindow.modelVersion ?? snapshot.modelVersion);
      }
      const response = await fetch("/api/trips/report", { method: "POST", body: formData });
      await responsePayload(response);
      void refreshSummary(setSummary, setSummaryUnavailable);
      setSubmitState("success");
      setMessage(totalFish === 0
        ? "No-catch trip recorded and pending review. It carries the same validation value as a catch."
        : "Past trip recorded and pending review. Thank you.");
    } catch (error) {
      setSubmitState("error");
      setMessage(error instanceof Error ? error.message : "The trip could not be reported.");
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
            Any complete trip helps build the dataset for future model training and evaluation. Location,
            time, effort, method, catches, whether it’s a skunk or not are useful and genuinely appreciated.
          </p>
          <div className="validation-actions">
            <button type="button" onClick={() => openPanel("start", sites[0]?.id)}>Start a trip <ArrowIcon /></button>
            <button type="button" onClick={openShareableReport}>Log a past trip</button>
          </div>
          <div className="stewardship-reminder">
            <strong>Respect the water.</strong>
            <p>
              Pack out line and trash, avoid disturbing wildlife and habitat, and follow current regulations.
              California halibut must be at least <strong>22 inches total length</strong> to keep.
              {" "}<a href="https://wildlife.ca.gov/Fishing/Ocean/Regulations/Fishing-Map/San-Francisco" target="_blank" rel="noreferrer">Check CDFW rules ↗</a>
            </p>
          </div>
          <small>
            Beta · reports are reviewed before model use. Public results never expose exact coordinates,
            notes, photos, or identity.
          </small>
        </div>
        <div className="validation-ledger" aria-label="Community trip summary">
          <div className="ledger-heading">
            <span>Community trip log</span>
            <em>Totals only</em>
          </div>
          {summary ? (
            <div className="ledger-grid">
              <div><strong>{summary.completedTrips}</strong><span>Completed trips</span></div>
              <div><strong>{summary.anglerHours.toFixed(summary.anglerHours % 1 === 0 ? 0 : 1)}</strong><span>Angler-hours</span></div>
              <div><strong>{summary.halibutEncounters}</strong><span>Halibut encounters</span></div>
              <div><strong>{summary.sitesCovered}</strong><span>Sites covered</span></div>
            </div>
          ) : (
            <div className="ledger-empty">
              <strong>{summaryUnavailable ? "Trip totals coming online" : "Loading trip totals…"}</strong>
              <p>Community totals appear here. A trip never changes the score before it is reviewed.</p>
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
            <span className="eyebrow"><span /> Validation beta</span>

            {panel === "start" ? (
              <form onSubmit={startTrip}>
                <header className="trip-form-heading">
                  <h2 id="trip-modal-title">Start fishing.</h2>
                  <p>We save the chosen forecast now, then ask for the full result when you finish.</p>
                </header>
                <div className="trip-field-grid">
                  <label className="trip-field wide">
                    <span>Fishing location</span>
                    <select value={fields.siteId} onChange={(event) => updateSite(event.target.value)} required>
                      <option value="" disabled>Choose a location</option>
                      {sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
                    </select>
                  </label>
                  <label className="trip-field">
                    <span>Start time</span>
                    <input type="datetime-local" value={fields.startedAt} onChange={(event) => setFields((current) => ({ ...current, startedAt: event.target.value }))} required />
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
                    <span>Did the score influence this trip?</span>
                    <select value={fields.contourCastInfluenced ? "yes" : "no"} onChange={(event) => setFields((current) => ({ ...current, contourCastInfluenced: event.target.value === "yes" }))} required>
                      <option value="yes">Yes</option>
                      <option value="no">No — independent trip</option>
                    </select>
                  </label>
                </div>
                {selectedWindow ? (
                  <div className="captured-forecast">
                    <span>Forecast captured</span>
                    <strong>{Math.round(selectedWindow.score)}</strong>
                    <p>Window {new Date(selectedWindow.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}–{new Date(selectedWindow.end).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</p>
                  </div>
                ) : null}
                <div className="trip-privacy-note">
                  <strong>What is stored</strong>
                  <p>Curated site, time, forecast metadata, angler count, and your eventual outcome. No live GPS or social profile is collected. A random recovery key and unfinished-trip token stay in this browser for continuity.</p>
                </div>
                <label className="consent-field">
                  <input type="checkbox" checked={fields.consent} onChange={(event) => setFields((current) => ({ ...current, consent: event.target.checked }))} required />
                  <span>I own anything I submit and consent to private use of this trip, its result, and any later photo for ContourCast model training and validation.</span>
                </label>
                <button className="trip-submit" type="submit" disabled={submitState === "submitting" || Boolean(activeTrip)}>
                  {activeTrip ? "Finish the active trip first" : submitState === "submitting" ? "Starting…" : "Start trip"}
                  {!activeTrip && submitState !== "submitting" ? <ArrowIcon /> : null}
                </button>
                <div className={`trip-form-status ${submitState}`} aria-live="polite">{message}</div>
              </form>
            ) : null}

            {panel === "complete" && activeTrip ? (
              <form onSubmit={completeTrip}>
                <header className="trip-form-heading">
                  <h2 id="trip-modal-title">Finish the trip.</h2>
                  <p>{activeTrip.siteName} · zero in both catch fields records a complete no-catch trip.</p>
                </header>
                <TripCompletionFields fields={fields} setFields={setFields} updateCount={updateCount} photo={photo} photoInputRef={photoInputRef} onPhoto={handlePhoto} />
                <button className="trip-submit" type="submit" disabled={submitState === "submitting" || submitState === "success"}>
                  {submitState === "submitting" ? "Saving…" : submitState === "success" ? "Report saved" : totalFish === 0 ? "Record no-catch trip" : `Record ${totalFish} halibut`}
                  {submitState === "idle" || submitState === "error" ? <ArrowIcon /> : null}
                </button>
                <div className={`trip-form-status ${submitState}`} aria-live="polite">{message}</div>
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
              <form onSubmit={reportPastTrip}>
                <header className="trip-form-heading">
                  <h2 id="trip-modal-title">Log a past trip.</h2>
                  <p>Complete results—including zero fish—help test whether the ranking separates stronger windows from weaker ones.</p>
                </header>
                <div className="trip-field-grid">
                  <label className="trip-field wide">
                    <span>Fishing location</span>
                    <select value={fields.siteId} onChange={(event) => updateSite(event.target.value)} required>
                      <option value="" disabled>Choose a location</option>
                      {sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
                    </select>
                  </label>
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
                    <span>Did the score influence this trip?</span>
                    <select value={fields.contourCastInfluenced ? "yes" : "no"} onChange={(event) => setFields((current) => ({ ...current, contourCastInfluenced: event.target.value === "yes" }))} required>
                      <option value="yes">Yes</option>
                      <option value="no">No — independent trip</option>
                    </select>
                  </label>
                </div>
                <TripCompletionFields fields={fields} setFields={setFields} updateCount={updateCount} photo={photo} photoInputRef={photoInputRef} onPhoto={handlePhoto} hideTimes />
                <button className="trip-submit" type="submit" disabled={submitState === "submitting" || submitState === "success"}>
                  {submitState === "submitting" ? "Saving…" : submitState === "success" ? "Report saved" : totalFish === 0 ? "Record no-catch trip" : "Submit trip report"}
                  {submitState === "idle" || submitState === "error" ? <ArrowIcon /> : null}
                </button>
                <div className={`trip-form-status ${submitState}`} aria-live="polite">{message}</div>
              </form>
            ) : null}

            <p className="trip-beta-note">Beta · submitted reports remain pending review. Public output is aggregate only and cannot reveal a contributor or exact fishing position.</p>
          </section>
        </div>
      ) : null}
    </>
  );
}

interface TripCompletionFieldsProps {
  fields: FormFields;
  setFields: (updater: (current: FormFields) => FormFields) => void;
  updateCount: (key: "anglerCount" | "keeperCount" | "shortReleasedCount", value: string) => void;
  photo: File | null;
  photoInputRef: React.RefObject<HTMLInputElement | null>;
  onPhoto: (event: ChangeEvent<HTMLInputElement>) => void;
  hideTimes?: boolean;
}

function TripCompletionFields({
  fields,
  setFields,
  updateCount,
  photo,
  photoInputRef,
  onPhoto,
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
        <p>Leave both at zero when no halibut were caught.</p>
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
      <label className="trip-field wide">
        <span>Notes <em>optional</em></span>
        <textarea maxLength={1000} rows={4} value={fields.notes} onChange={(event) => setFields((current) => ({ ...current, notes: event.target.value }))} placeholder="Conditions, technique, approximate size, or anything that affected the trip…" />
        <small>{fields.notes.length}/1000</small>
      </label>
      <label className="photo-field">
        <span>Verification photo <em>optional</em></span>
        <input ref={photoInputRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={onPhoto} />
        <strong>{photo ? photo.name : "JPEG, PNG, or WebP · 5 MB max"}</strong>
      </label>
      <label className="consent-field">
        <input type="checkbox" checked={fields.consent} onChange={(event) => setFields((current) => ({ ...current, consent: event.target.checked }))} required />
        <span>I confirm this reflects the whole trip, own anything I upload, and consent to private use of the report and photo for ContourCast model training and validation.</span>
      </label>
    </>
  );
}
