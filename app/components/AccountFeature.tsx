"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { CloseIcon } from "./icons";
import { GearCatalogFields } from "./GearCatalogFields";
import { SiteCombobox } from "./SiteCombobox";
import {
  TurnstileChallenge,
  type TurnstileAction,
  type TurnstileChallengeState,
} from "./TurnstileChallenge";
import type { FishingSite } from "../types";
import { useClientNetworkState } from "../lib/use-client-network-state";

// A privileged write may commit before its response is lost. Never abort or replay it
// client-side; keep the in-flight state explicitly unconfirmed until the server answers.
const SLOW_MUTATION_NOTICE_MS = 4_000;

export interface AccountUser {
  id: string;
  email: string;
  ageEligible: boolean;
  legalAccepted: boolean;
}

export interface AccountController {
  user: AccountUser | null;
  loading: boolean;
  savedSiteIds: Set<string>;
  modalOpen: boolean;
  modalMessage: string;
  openAccount(message?: string): void;
  closeAccount(): void;
  signOut(): Promise<void>;
  toggleSavedSite(siteId: string): Promise<boolean>;
  refresh(): Promise<void>;
}

interface ProfileTrip {
  id: string;
  source: "live" | "past_report";
  site_id: string;
  started_at: string;
  ended_at: string | null;
  mode: string;
  fishing_method: string | null;
  angler_hours: number | null;
  keeper_count: number | null;
  short_released_count: number | null;
  halibut_encounters: number | null;
  no_catch: number | null;
  moderation_status: string;
  opportunity_score: number | null;
  angler_count: number;
  notes: string | null;
  rod: string | null;
  reel: string | null;
  bait_lure: string | null;
  rig: string | null;
  gear_profile_id: string | null;
  other_catch_count: number | null;
  other_species: string | null;
  observations_json: string | null;
  observation_contract_version: string | null;
  taxon_catalog_version: string | null;
  target_taxon_id: string;
  contract_status: "valid" | "legacy_unverified" | "rejected" | null;
  taxon_observations_json: string | null;
  outcome_class: "target_encountered" | "non_target_only" | "no_fish" | null;
  target_encounter_count: number | null;
  any_fish_encounter_count: number | null;
  target_identification_confidence: string | null;
  ai_review_status: string | null;
  ai_review_json: string | null;
  ai_review_model: string | null;
  ai_reviewed_at: string | null;
}

interface ProfileData {
  savedSites: Array<{ site_id: string; created_at: string }>;
  trips: ProfileTrip[];
  gearProfiles: GearProfile[];
}

type MutationRequestState = "idle" | "submitting" | "ambiguous" | "error";

class AmbiguousMutationError extends Error {}

function isConnectionFailure(error: unknown) {
  return error instanceof TypeError;
}

function MutationRequestStatus({ state, message }: { state: MutationRequestState; message: string }) {
  if (state === "idle" && !message) return null;
  const isAlert = state === "ambiguous" || state === "error";
  return (
    <div
      className={`mutation-request-status ${state}`}
      role={isAlert ? "alert" : "status"}
      aria-live={isAlert ? undefined : "polite"}
    >
      <span>{message}</span>
      {state === "submitting" ? <i aria-hidden="true" /> : null}
    </div>
  );
}

function isProfileData(value: unknown): value is ProfileData {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const isRecord = (entry: unknown): entry is Record<string, unknown> =>
    Boolean(entry) && typeof entry === "object" && !Array.isArray(entry);
  return Array.isArray(candidate.savedSites) && candidate.savedSites.every((entry) =>
    isRecord(entry) && typeof entry.site_id === "string" && typeof entry.created_at === "string") &&
    Array.isArray(candidate.trips) && candidate.trips.every((entry) =>
      isRecord(entry) &&
      typeof entry.id === "string" &&
      (entry.source === "live" || entry.source === "past_report") &&
      typeof entry.site_id === "string" &&
      typeof entry.started_at === "string") &&
    Array.isArray(candidate.gearProfiles) && candidate.gearProfiles.every((entry) =>
      isRecord(entry) && typeof entry.id === "string" && typeof entry.name === "string");
}

interface GearProfile {
  id: string;
  name: string;
  rod: string | null;
  reel: string | null;
  bait_lure: string | null;
  rig: string | null;
}

const EMPTY_GEAR = { name: "", rod: "", reel: "", baitLure: "", rig: "" };

interface ProfileTripEditFields {
  siteId: string;
  mode: string;
  gearProfileId: string;
  startedAt: string;
  endedAt: string;
  anglerCount: number;
  keeperCount: number;
  shortReleasedCount: number;
  fishingMethod: string;
  rod: string;
  reel: string;
  baitLure: string;
  rig: string;
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
}

const PROFILE_TRIP_DRAFT_PREFIX = "castingcompass.profile-trip-draft.v1.";
const ACCOUNT_STORAGE_KEYS = new Set([
  "castingcompass.active-trip.v1",
  "castingcompass.reporter-key.v1",
  "contourcast.active-trip.v1",
  "contourcast.reporter-key.v1",
]);
const ACCOUNT_STORAGE_PREFIXES = [
  "castingcompass.trip-draft.v1.",
  "castingcompass.profile-trip-draft.v1.",
  "contourcast.trip-draft.v1.",
  "contourcast.profile-trip-draft.v1.",
];

type DeletionStatus = "completed" | "processing" | "needs_attention";

interface DeletionDetails {
  status: DeletionStatus;
  scope: "account" | "trip";
  requestedAt?: string;
  completedAt?: string;
  objectsTotal: number;
  objectsDeleted: number;
}

function clearCastingCompassAccountStorage() {
  let cleared = true;
  for (const storageName of ["localStorage", "sessionStorage"] as const) {
    try {
      const storage = window[storageName];
      const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => Boolean(key));
      for (const key of keys) {
        if (ACCOUNT_STORAGE_KEYS.has(key) || ACCOUNT_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
          storage.removeItem(key);
        }
      }
    } catch {
      // A browser can block storage access; server-side deletion must still remain accepted.
      cleared = false;
    }
  }
  return cleared;
}

function deletionDetailsFromResponse(body: Record<string, unknown>): DeletionDetails {
  const nested = body.deletion && typeof body.deletion === "object"
    ? body.deletion as Record<string, unknown>
    : body;
  const reportedStatus = nested.status;
  if (reportedStatus !== "completed" && reportedStatus !== "processing" && reportedStatus !== "needs_attention") {
    throw new Error("Deletion status could not be verified.");
  }
  if (nested.scope !== "account" && nested.scope !== "trip") {
    throw new Error("Deletion scope could not be verified.");
  }
  const status: DeletionStatus = reportedStatus;
  return {
    status,
    scope: nested.scope,
    requestedAt: typeof nested.requestedAt === "string" ? nested.requestedAt : undefined,
    completedAt: typeof nested.completedAt === "string" ? nested.completedAt : undefined,
    objectsTotal: Number.isFinite(Number(nested.objectsTotal)) ? Math.max(0, Number(nested.objectsTotal)) : 0,
    objectsDeleted: Number.isFinite(Number(nested.objectsDeleted)) ? Math.max(0, Number(nested.objectsDeleted)) : 0,
  };
}

function localDateTimeValue(value: string | null) {
  const date = value ? new Date(value) : new Date();
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function editFieldsForTrip(trip: ProfileTrip): ProfileTripEditFields {
  let observations: Record<string, string | number | null> = {};
  try {
    observations = trip.observations_json ? JSON.parse(trip.observations_json) as Record<string, string | number | null> : {};
  } catch {
    observations = {};
  }
  return {
    siteId: trip.site_id,
    mode: trip.mode,
    gearProfileId: trip.gear_profile_id ?? "",
    startedAt: localDateTimeValue(trip.started_at),
    endedAt: localDateTimeValue(trip.ended_at),
    anglerCount: Number(trip.angler_count ?? 1),
    keeperCount: Number(trip.keeper_count ?? 0),
    shortReleasedCount: Number(trip.short_released_count ?? 0),
    fishingMethod: trip.fishing_method ?? "bait",
    rod: trip.rod ?? "",
    reel: trip.reel ?? "",
    baitLure: trip.bait_lure ?? "",
    rig: trip.rig ?? "",
    otherCatchCount: Number(trip.other_catch_count ?? 0),
    otherSpecies: trip.other_species ?? "",
    shorebreak: String(observations.shorebreak ?? ""),
    wadingDepth: String(observations.wadingDepth ?? ""),
    waterClarity: String(observations.waterClarity ?? ""),
    crowding: String(observations.crowding ?? ""),
    fishabilityRating: String(observations.fishabilityRating ?? ""),
    observedWaveHeightFeet: String(observations.observedWaveHeightFeet ?? ""),
    fishabilityNotes: String(observations.fishabilityNotes ?? ""),
    notes: trip.notes ?? "",
  };
}

function tripReviewLabel(trip: ProfileTrip) {
  if (trip.ai_review_status === "reviewed") {
    try {
      const review = trip.ai_review_json ? JSON.parse(trip.ai_review_json) as { discussion?: { publish?: boolean } } : null;
      return review?.discussion?.publish
        ? "Discussion draft prepared · public summaries require separate human approval"
        : "Automated review complete · no public draft proposed";
    } catch {
      return "Privacy review complete";
    }
  }
  if (trip.ai_review_status === "processing") return "Checking note privacy and relevance…";
  if (trip.ai_review_status === "queued") return "Note review queued";
  if (trip.ai_review_status === "retry") return "Note review will retry automatically";
  return "Note review pending";
}

function ProfileSectionLoading({ label }: { label: string }) {
  return (
    <div className="profile-section-loading" role="status" aria-label={label}>
      <span>{label}…</span>
      <div aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}

export function useAccount(): AccountController {
  const [user, setUser] = useState<AccountUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [savedSiteIds, setSavedSiteIds] = useState<Set<string>>(new Set());
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMessage, setModalMessage] = useState("");

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/auth/session", { cache: "no-store" });
      const body = await response.json() as { user?: AccountUser | null };
      const nextUser = response.ok ? body.user ?? null : null;
      setUser(nextUser);
      if (!nextUser || !nextUser.legalAccepted) {
        setSavedSiteIds(new Set());
        return;
      }
      const savedResponse = await fetch("/api/saved-sites", { cache: "no-store" });
      const savedBody = await savedResponse.json() as { siteIds?: string[] };
      setSavedSiteIds(new Set(savedResponse.ok ? savedBody.siteIds ?? [] : []));
    } catch {
      setUser(null);
      setSavedSiteIds(new Set());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const openAccount = useCallback((message = "") => {
    setModalMessage(message);
    setModalOpen(true);
  }, []);

  const closeAccount = useCallback(() => {
    setModalOpen(false);
    setModalMessage("");
  }, []);

  const signOut = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    setUser(null);
    setSavedSiteIds(new Set());
    closeAccount();
  }, [closeAccount]);

  const toggleSavedSite = useCallback(async (siteId: string) => {
    if (!user) {
      openAccount("Sign in to save fishing locations across devices.");
      return false;
    }
    if (!user.legalAccepted) {
      openAccount(user.ageEligible
        ? "Accept the current legal documents before saving locations."
        : "Account features are paused. Open your account for privacy support or deletion options.");
      return false;
    }
    const wasSaved = savedSiteIds.has(siteId);
    const response = await fetch(`/api/saved-sites/${encodeURIComponent(siteId)}`, {
      method: wasSaved ? "DELETE" : "POST",
    });
    if (!response.ok) return false;
    setSavedSiteIds((current) => {
      const next = new Set(current);
      if (wasSaved) next.delete(siteId);
      else next.add(siteId);
      return next;
    });
    return true;
  }, [openAccount, savedSiteIds, user]);

  return {
    user,
    loading,
    savedSiteIds,
    modalOpen,
    modalMessage,
    openAccount,
    closeAccount,
    signOut,
    toggleSavedSite,
    refresh,
  };
}

type AccountMode = "login" | "signup" | "signupDetails" | "verify" | "recover" | "reset";

function turnstileActionForMode(mode: AccountMode): TurnstileAction {
  if (mode === "signup") return "signup_eligibility";
  if (mode === "signupDetails") return "signup_request";
  if (mode === "verify") return "signup_verify";
  if (mode === "recover") return "password_request";
  if (mode === "reset") return "password_reset";
  return "login";
}

export function AccountModal({
  account,
  sites,
  onOpenSite,
  standalone = false,
}: {
  account: AccountController;
  sites: FishingSite[];
  onOpenSite?(siteId: string): void;
  standalone?: boolean;
}) {
  const [mode, setMode] = useState<AccountMode>("login");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [eligibilityProof, setEligibilityProof] = useState("");
  const [signupAvailable, setSignupAvailable] = useState<boolean | null>(null);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileState, setTurnstileState] = useState<TurnstileChallengeState>("loading");
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const [resendTurnstileToken, setResendTurnstileToken] = useState("");
  const [resendTurnstileState, setResendTurnstileState] = useState<TurnstileChallengeState>("loading");
  const [resendTurnstileResetKey, setResendTurnstileResetKey] = useState(0);
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileLoadError, setProfileLoadError] = useState("");
  const [editingTrip, setEditingTrip] = useState<ProfileTrip | null>(null);
  const [editFields, setEditFields] = useState<ProfileTripEditFields | null>(null);
  const [profileActionBusy, setProfileActionBusy] = useState(false);
  const [profileActionError, setProfileActionError] = useState("");
  const [profileActionNotice, setProfileActionNotice] = useState("");
  const [accountDeletionState, setAccountDeletionState] = useState<MutationRequestState>("idle");
  const [accountDeletionMessage, setAccountDeletionMessage] = useState("");
  const [tripDeletionRequest, setTripDeletionRequest] = useState<{
    tripId: string;
    state: MutationRequestState;
    message: string;
  } | null>(null);
  const [tripEditRequest, setTripEditRequest] = useState<{
    tripId: string;
    state: MutationRequestState;
    message: string;
  } | null>(null);
  const [deletionDetails, setDeletionDetails] = useState<DeletionDetails | null>(null);
  const [browserAccountStorageCleared, setBrowserAccountStorageCleared] = useState<boolean | null>(null);
  const [deletionStatusAction, setDeletionStatusAction] = useState<"checking" | "dismissing" | null>(null);
  const [deletionStatusError, setDeletionStatusError] = useState("");
  const [gearDraft, setGearDraft] = useState(EMPTY_GEAR);
  const reviewRetryRequestedRef = useRef(false);
  const deletionStatusCheckedRef = useRef(false);
  const networkState = useClientNetworkState();
  const displayedAccountDeletionState = accountDeletionState === "idle" && networkState === "offline"
    ? "error"
    : accountDeletionState;
  const displayedAccountDeletionMessage = accountDeletionState === "idle" && networkState === "offline"
    ? "This device appears offline. Account deletion has not been submitted."
    : accountDeletionState === "idle" && networkState === "restored"
      ? "This device reports that its connection is back. No deletion request was submitted automatically."
      : accountDeletionMessage;
  const accountDeletionDisabled = profileActionBusy || networkState === "offline" || accountDeletionState === "ambiguous";
  const accountDeletionButtonLabel = accountDeletionState === "submitting"
    ? "Deleting…"
    : accountDeletionState === "ambiguous"
      ? "Verify deletion status before retrying"
    : networkState === "offline"
      ? "Reconnect to delete account"
      : profileActionBusy
        ? "Account action in progress…"
        : "Permanently delete account";
  const tripDeletionAmbiguous = tripDeletionRequest?.state === "ambiguous";
  const tripEditAmbiguous = tripEditRequest?.state === "ambiguous";
  const activeTripEditRequest = editingTrip && tripEditRequest?.tripId === editingTrip.id
    ? tripEditRequest
    : null;
  const displayedTripEditState: MutationRequestState = activeTripEditRequest?.state ?? (
    networkState === "offline" ? "error" : "idle"
  );
  const displayedTripEditMessage = activeTripEditRequest?.message ?? (
    networkState === "offline"
      ? "This device appears offline. Trip changes cannot be submitted, and your draft remains on this device."
      : networkState === "restored"
        ? "This device reports that its connection is back. No trip edit was submitted automatically."
        : ""
  );
  const tripEditSubmitDisabled = profileActionBusy || networkState === "offline" || tripEditAmbiguous || tripDeletionAmbiguous;
  const tripEditSubmitLabel = activeTripEditRequest?.state === "submitting"
    ? "Saving…"
    : activeTripEditRequest?.state === "ambiguous"
      ? "Verify saved trip before retrying"
      : networkState === "offline"
        ? "Reconnect to save changes"
        : tripDeletionAmbiguous
          ? "Deletion status unresolved"
          : profileActionBusy
            ? "Account action in progress…"
            : "Save trip changes";

  const resetTurnstile = useCallback(() => {
    setTurnstileToken("");
    setTurnstileState("loading");
    setTurnstileResetKey((value) => value + 1);
  }, []);
  const resetResendTurnstile = useCallback(() => {
    setResendTurnstileToken("");
    setResendTurnstileState("loading");
    setResendTurnstileResetKey((value) => value + 1);
  }, []);
  const changeMode = useCallback((nextMode: AccountMode) => {
    resetTurnstile();
    resetResendTurnstile();
    setMode(nextMode);
  }, [resetResendTurnstile, resetTurnstile]);
  const closeAccount = useCallback(() => {
    resetTurnstile();
    resetResendTurnstile();
    account.closeAccount();
  }, [account, resetResendTurnstile, resetTurnstile]);
  const turnstileCanSubmit = turnstileState === "disabled" ||
    (turnstileState === "verified" && Boolean(turnstileToken));
  const resendTurnstileCanSubmit = resendTurnstileState === "disabled" ||
    (resendTurnstileState === "verified" && Boolean(resendTurnstileToken));

  const loadProfile = useCallback(async ({ background = false }: { background?: boolean } = {}) => {
    if (!background) setProfileLoading(true);
    setProfileLoadError("");
    try {
      const response = await fetch("/api/profile", { cache: "no-store" });
      if (!response.ok) throw new Error("Profile could not be loaded.");
      const body = await response.json() as unknown;
      if (!isProfileData(body)) throw new Error("Profile response was malformed.");
      setProfile(body);
    } catch {
      setProfileLoadError("Profile data could not be loaded.");
    } finally {
      if (!background) setProfileLoading(false);
    }
  }, []);

  useEffect(() => {
    if ((!account.modalOpen && !standalone) || !account.user?.legalAccepted) {
      return;
    }
    const timer = window.setTimeout(() => {
      void loadProfile();
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [account.modalOpen, account.user, loadProfile, standalone]);

  useEffect(() => {
    const surfaceVisible = standalone || account.modalOpen;
    if (!surfaceVisible || account.user || mode !== "signup") return;
    const controller = new AbortController();
    fetch("/api/auth/signup/eligibility", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => ({})) as { available?: boolean };
        setSignupAvailable(response.ok && body.available === true);
      })
      .catch(() => setSignupAvailable(false));
    return () => controller.abort();
  }, [account.modalOpen, account.user, mode, standalone]);

  useEffect(() => {
    if (!account.user?.legalAccepted || reviewRetryRequestedRef.current || !profile?.trips.some((trip) => !trip.ai_review_status || trip.ai_review_status === "retry")) return;
    reviewRetryRequestedRef.current = true;
    fetch("/api/profile/reviews/retry", { method: "POST" })
      .then(() => window.setTimeout(() => void loadProfile({ background: true }), 2500))
      .catch(() => { reviewRetryRequestedRef.current = false; });
  }, [account.user, loadProfile, profile]);

  useEffect(() => {
    if (!profile?.trips.some((trip) => trip.ai_review_status === "queued" || trip.ai_review_status === "processing")) return;
    const timer = window.setInterval(() => void loadProfile({ background: true }), 3000);
    return () => window.clearInterval(timer);
  }, [loadProfile, profile]);

  useEffect(() => {
    if (!editingTrip || !editFields) return;
    window.localStorage.setItem(
      `${PROFILE_TRIP_DRAFT_PREFIX}${editingTrip.id}`,
      JSON.stringify(editFields),
    );
  }, [editFields, editingTrip]);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = window.setInterval(() => {
      setResendCooldown((seconds) => Math.max(0, seconds - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resendCooldown]);

  useEffect(() => {
    const surfaceVisible = standalone || account.modalOpen;
    if (!surfaceVisible || account.loading || deletionDetails || deletionStatusCheckedRef.current) return;
    deletionStatusCheckedRef.current = true;
    const controller = new AbortController();
    fetch("/api/privacy/deletion-status", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const body = await response.json().catch(() => ({})) as Record<string, unknown>;
        const resumedDeletionDetails = deletionDetailsFromResponse(body);
        if (resumedDeletionDetails.scope === "account") {
          setBrowserAccountStorageCleared(clearCastingCompassAccountStorage());
        }
        setDeletionDetails(resumedDeletionDetails);
      })
      .catch(() => {
        // No receipt, an expired receipt, or a transient error should leave the ordinary sign-in screen unchanged.
      });
    return () => controller.abort();
  }, [account.loading, account.modalOpen, account.user, deletionDetails, standalone]);

  if (!account.modalOpen && !standalone) return null;
  if (standalone && account.loading) {
    return <main className="profile-page-shell"><p className="profile-page-loading">Loading your fishing profile…</p></main>;
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!turnstileCanSubmit) {
      setError("Complete the security verification before continuing.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    const form = new FormData(event.currentTarget);
    try {
      const endpoint = mode === "signupDetails"
        ? "/api/auth/signup/request"
        : mode === "verify"
          ? "/api/auth/signup/verify"
          : mode === "recover"
            ? "/api/auth/password/request"
            : mode === "reset"
              ? "/api/auth/password/reset"
              : "/api/auth/login";
      const payload = mode === "verify"
        ? { challengeId, code: form.get("code"), turnstileToken }
        : mode === "reset"
          ? { challengeId, code: form.get("code"), password: form.get("password"), turnstileToken }
          : mode === "signupDetails"
            ? {
                eligibilityProof,
                email: form.get("email"),
                password: form.get("password"),
                termsAccepted: form.get("termsAccepted") === "on",
                privacyAccepted: form.get("privacyAccepted") === "on",
                turnstileToken,
              }
            : mode === "recover"
              ? { email: form.get("email"), turnstileToken }
              : { email: form.get("email"), password: form.get("password"), turnstileToken };
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json() as { challengeId?: string; error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "The account request failed.");
      if ((mode === "signupDetails" || mode === "recover") && body.challengeId) {
        setChallengeId(body.challengeId);
        setResendCooldown(60);
        changeMode(mode === "signupDetails" ? "verify" : "reset");
        return;
      }
      await account.refresh();
      closeAccount();
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "The account request failed.");
    } finally {
      resetTurnstile();
      setBusy(false);
    }
  };

  const submitSignupEligibility = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!turnstileCanSubmit) {
      setError("Complete the security verification before continuing.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/signup/eligibility", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ birthDate: form.get("birthDate"), turnstileToken }),
      });
      const body = await response.json().catch(() => ({})) as { eligibilityProof?: string };
      if (!response.ok || !body.eligibilityProof) {
        if (response.status === 403) setSignupAvailable(false);
        if (response.status === 503) {
          throw new Error("Security verification is temporarily unavailable. Try again shortly.");
        }
        throw new Error("Account signup is not available with the information provided.");
      }
      setEligibilityProof(body.eligibilityProof);
      changeMode("signupDetails");
    } catch (eligibilityError) {
      setEligibilityProof("");
      setError(eligibilityError instanceof Error
        ? eligibilityError.message
        : "Account signup is not available with the information provided.");
    } finally {
      resetTurnstile();
      setBusy(false);
    }
  };

  const resendCode = async () => {
    if (!challengeId || resendCooldown > 0 || busy) return;
    if (!resendTurnstileCanSubmit) {
      setError("Complete the resend security verification before requesting another code.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/challenge/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId, turnstileToken: resendTurnstileToken }),
      });
      const body = await response.json() as { retryAfterSeconds?: number; error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "A new code could not be sent.");
      setResendCooldown(body.retryAfterSeconds ?? 60);
      setNotice("A new code was requested. Check spam, promotions, and All Mail too.");
    } catch (resendError) {
      setError(resendError instanceof Error ? resendError.message : "A new code could not be sent.");
    } finally {
      resetResendTurnstile();
      setBusy(false);
    }
  };

  const submitLegalAcceptance = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/eligibility", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          termsAccepted: form.get("termsAccepted") === "on",
          privacyAccepted: form.get("privacyAccepted") === "on",
        }),
      });
      const body = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "Legal acceptance could not be saved.");
      await account.refresh();
    } catch (acceptanceError) {
      setError(acceptanceError instanceof Error ? acceptanceError.message : "Legal acceptance could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const deleteAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (networkState === "offline") {
      setAccountDeletionState("error");
      setAccountDeletionMessage("This device appears offline. Account deletion was not submitted.");
      return;
    }
    if (!window.confirm("Permanently delete your account, saved locations, trip reports, photos, and public discussion summaries?")) return;
    setProfileActionBusy(true);
    setProfileActionError("");
    setAccountDeletionState("submitting");
    setAccountDeletionMessage("Removing account access and active-service records. No deletion is confirmed yet.");
    const slowNotice = window.setTimeout(() => {
      setAccountDeletionMessage("Still waiting for the server. Keep this page open; account removal has not been confirmed yet.");
    }, SLOW_MUTATION_NOTICE_MS);
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/profile", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: form.get("password"), confirmation: form.get("confirmation") }),
      });
      const body = await response.json().catch(() => null) as (Record<string, unknown> & { error?: { message?: string } }) | null;
      if (!response.ok) {
        if (response.status >= 500) {
          throw new AmbiguousMutationError("The server could not confirm whether account deletion completed.");
        }
        throw new Error(body?.error?.message ?? "The account could not be deleted.");
      }
      if (!body) {
        throw new AmbiguousMutationError("The deletion response could not be read.");
      }
      const nextDeletionDetails = deletionDetailsFromResponse(body);
      const responseMatchesStatus = response.status === 200
        ? nextDeletionDetails.status === "completed"
        : response.status === 202 && nextDeletionDetails.status !== "completed";
      if (body.deleted !== true || nextDeletionDetails.scope !== "account" || !responseMatchesStatus) {
        throw new AmbiguousMutationError("The deletion response could not be verified.");
      }
      setBrowserAccountStorageCleared(clearCastingCompassAccountStorage());
      setDeletionDetails(nextDeletionDetails);
      await account.refresh();
    } catch (deleteError) {
      const ambiguous = isConnectionFailure(deleteError) || deleteError instanceof AmbiguousMutationError;
      setAccountDeletionState(ambiguous ? "ambiguous" : "error");
      setAccountDeletionMessage(ambiguous
        ? "No server confirmation arrived. Account access may already be removed. Do not submit again; reconnect, refresh, and use the deletion-status receipt or contact support."
        : deleteError instanceof Error ? deleteError.message : "The account could not be deleted.");
    } finally {
      window.clearTimeout(slowNotice);
      setProfileActionBusy(false);
    }
  };

  const checkDeletionStatus = async () => {
    setDeletionStatusAction("checking");
    setDeletionStatusError("");
    try {
      const response = await fetch("/api/privacy/deletion-status", { cache: "no-store" });
      const body = await response.json().catch(() => ({})) as Record<string, unknown> & { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "Deletion status is temporarily unavailable.");
      const nextDeletionDetails = deletionDetailsFromResponse(body);
      if (deletionDetails && nextDeletionDetails.scope !== deletionDetails.scope) {
        throw new Error("This receipt does not match the deletion currently shown.");
      }
      setDeletionDetails(nextDeletionDetails);
    } catch (statusError) {
      setDeletionStatusError(statusError instanceof Error ? statusError.message : "Deletion status is temporarily unavailable.");
    } finally {
      setDeletionStatusAction(null);
    }
  };

  const dismissDeletionStatus = async () => {
    setDeletionStatusAction("dismissing");
    setDeletionStatusError("");
    try {
      const response = await fetch("/api/privacy/deletion-status", { method: "DELETE" });
      if (!response.ok) throw new Error("The deletion-status receipt could not be dismissed.");
      deletionStatusCheckedRef.current = true;
      setDeletionDetails(null);
      setBrowserAccountStorageCleared(null);
    } catch (statusError) {
      setDeletionStatusError(statusError instanceof Error ? statusError.message : "The deletion-status receipt could not be dismissed.");
    } finally {
      setDeletionStatusAction(null);
    }
  };

  const beginTripEdit = (trip: ProfileTrip) => {
    if (tripEditAmbiguous || tripDeletionAmbiguous) return;
    const draftKey = `${PROFILE_TRIP_DRAFT_PREFIX}${trip.id}`;
    let nextFields = editFieldsForTrip(trip);
    try {
      const savedDraft = window.localStorage.getItem(draftKey);
      if (savedDraft) nextFields = { ...nextFields, ...JSON.parse(savedDraft) as Partial<ProfileTripEditFields> };
    } catch {
      window.localStorage.removeItem(draftKey);
    }
    setProfileActionError("");
    setProfileActionNotice("");
    setTripEditRequest(null);
    setEditingTrip(trip);
    setEditFields(nextFields);
  };

  const closeTripEdit = () => {
    setEditingTrip(null);
    setEditFields(null);
    setProfileActionError("");
    setTripEditRequest((current) => current?.state === "ambiguous" ? current : null);
  };

  const saveTripEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingTrip || !editFields) return;
    if (networkState === "offline") {
      setTripEditRequest({
        tripId: editingTrip.id,
        state: "error",
        message: "This device appears offline. The trip edit was not submitted, and your draft remains on this device.",
      });
      return;
    }
    if (tripEditAmbiguous || tripDeletionAmbiguous) return;
    if (!sites.some((site) => site.id === editFields.siteId)) {
      setTripEditRequest({
        tripId: editingTrip.id,
        state: "error",
        message: "Choose a fishing location from the matching results.",
      });
      return;
    }
    const submittedTripId = editingTrip.id;
    const submittedFields = editFields;
    setProfileActionBusy(true);
    setProfileActionError("");
    setProfileActionNotice("");
    setTripEditRequest({
      tripId: submittedTripId,
      state: "submitting",
      message: "Saving these trip changes. No update is confirmed yet.",
    });
    const slowNotice = window.setTimeout(() => {
      setTripEditRequest((current) => current?.tripId === submittedTripId && current.state === "submitting"
        ? { ...current, message: "Still waiting for the server. Keep this page open; the trip update has not been confirmed yet." }
        : current);
    }, SLOW_MUTATION_NOTICE_MS);
    try {
      const response = await fetch(`/api/profile/trips/${encodeURIComponent(submittedTripId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...submittedFields,
          startedAt: new Date(submittedFields.startedAt).toISOString(),
          endedAt: new Date(submittedFields.endedAt).toISOString(),
        }),
      });
      const body = await response.json().catch(() => null) as {
        updated?: boolean;
        tripId?: string;
        error?: { message?: string };
        validationEvidenceExcluded?: boolean;
      } | null;
      if (!response.ok) {
        if (response.status >= 500) {
          throw new AmbiguousMutationError("The server could not confirm whether the trip update completed.");
        }
        throw new Error(body?.error?.message ?? "The trip log could not be updated.");
      }
      if (!body) {
        throw new AmbiguousMutationError("The trip-update response could not be read.");
      }
      if (body.updated !== true || body.tripId !== submittedTripId || body.validationEvidenceExcluded !== true) {
        throw new AmbiguousMutationError("The trip-update response could not be verified.");
      }
      window.localStorage.removeItem(`${PROFILE_TRIP_DRAFT_PREFIX}${submittedTripId}`);
      setTripEditRequest(null);
      closeTripEdit();
      await loadProfile({ background: true });
      setProfileActionNotice("Saved. Because this completed report was edited, it remains context-only and cannot enter prospective validation evidence.");
    } catch (editError) {
      const ambiguous = isConnectionFailure(editError) || editError instanceof AmbiguousMutationError;
      setTripEditRequest({
        tripId: submittedTripId,
        state: ambiguous ? "ambiguous" : "error",
        message: ambiguous
          ? "No server confirmation arrived. These trip changes may already be saved. Do not submit again; keep this draft, reconnect if needed, refresh the profile, and compare the server copy before editing again."
          : editError instanceof Error ? editError.message : "The trip log could not be updated.",
      });
    } finally {
      window.clearTimeout(slowNotice);
      setProfileActionBusy(false);
    }
  };

  const deleteTrip = async (trip: ProfileTrip) => {
    if (tripEditAmbiguous) return;
    if (networkState === "offline") {
      setTripDeletionRequest({
        tripId: trip.id,
        state: "error",
        message: "This device appears offline. Trip deletion was not submitted.",
      });
      return;
    }
    if (!window.confirm("Remove this pending trip log? This cannot be undone.")) return;
    setProfileActionBusy(true);
    setProfileActionError("");
    setProfileActionNotice("");
    setTripDeletionRequest({
      tripId: trip.id,
      state: "submitting",
      message: "Removing this trip log. No deletion is confirmed yet.",
    });
    const slowNotice = window.setTimeout(() => {
      setTripDeletionRequest((current) => current?.tripId === trip.id
        ? { ...current, message: "Still waiting for the server. Keep this page open; trip deletion has not been confirmed yet." }
        : current);
    }, SLOW_MUTATION_NOTICE_MS);
    try {
      const response = await fetch(`/api/profile/trips/${encodeURIComponent(trip.id)}`, { method: "DELETE" });
      const body = await response.json().catch(() => null) as (Record<string, unknown> & { error?: { message?: string } }) | null;
      if (!response.ok) {
        if (response.status >= 500) {
          throw new AmbiguousMutationError("The server could not confirm whether trip deletion completed.");
        }
        throw new Error(body?.error?.message ?? "The trip log could not be removed.");
      }
      if (!body) {
        throw new AmbiguousMutationError("The trip-deletion response could not be read.");
      }
      const nextDeletionDetails = deletionDetailsFromResponse(body);
      const responseMatchesStatus = response.status === 200
        ? nextDeletionDetails.status === "completed"
        : response.status === 202 && nextDeletionDetails.status !== "completed";
      if (body.deleted !== true || nextDeletionDetails.scope !== "trip" || !responseMatchesStatus) {
        throw new AmbiguousMutationError("The trip-deletion response could not be verified.");
      }
      window.localStorage.removeItem(`${PROFILE_TRIP_DRAFT_PREFIX}${trip.id}`);
      await loadProfile({ background: true });
      setDeletionDetails(nextDeletionDetails);
    } catch (deleteError) {
      const ambiguous = isConnectionFailure(deleteError) || deleteError instanceof AmbiguousMutationError;
      setTripDeletionRequest({
        tripId: trip.id,
        state: ambiguous ? "ambiguous" : "error",
        message: ambiguous
          ? "No server confirmation arrived. This trip may already be removed. Do not submit again; reconnect, refresh, and use the deletion-status receipt or contact support."
          : deleteError instanceof Error ? deleteError.message : "The trip log could not be removed.",
      });
    } finally {
      window.clearTimeout(slowNotice);
      setProfileActionBusy(false);
    }
  };

  const saveGearProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setProfileActionBusy(true);
    setProfileActionError("");
    try {
      const response = await fetch("/api/gear-profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(gearDraft),
      });
      const body = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "The gear preset could not be saved.");
      setGearDraft(EMPTY_GEAR);
      await loadProfile({ background: true });
    } catch (gearError) {
      setProfileActionError(gearError instanceof Error ? gearError.message : "The gear preset could not be saved.");
    } finally {
      setProfileActionBusy(false);
    }
  };

  const deleteGearProfile = async (id: string) => {
    setProfileActionBusy(true);
    setProfileActionError("");
    try {
      const response = await fetch(`/api/gear-profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("The gear preset could not be removed.");
      await loadProfile({ background: true });
    } catch (gearError) {
      setProfileActionError(gearError instanceof Error ? gearError.message : "The gear preset could not be removed.");
    } finally {
      setProfileActionBusy(false);
    }
  };

  return (
    <div className={standalone ? "profile-page-shell" : "account-modal-layer"} role="presentation" onClick={(event) => {
      if (!standalone && event.target === event.currentTarget) closeAccount();
    }}>
      <section className={`account-modal${standalone ? " account-profile-page" : ""}`} role={standalone ? "main" : "dialog"} aria-modal={standalone ? undefined : "true"} aria-labelledby="account-title">
        {standalone ? (
          <Link className="sheet-close" href="/" aria-label="Back to forecast"><CloseIcon /></Link>
        ) : (
          <button className="sheet-close" type="button" onClick={closeAccount} aria-label="Close account"><CloseIcon /></button>
        )}
        {deletionDetails ? (
          <>
            <span className="eyebrow"><span /> Privacy request</span>
            <h2 id="account-title">{deletionDetails.scope === "account"
              ? <>Account access<br />removed.</>
              : <>Trip log<br />removed.</>}</h2>
            <div aria-live="polite">
              {deletionDetails.status === "completed" ? (
                <p>{deletionDetails.scope === "account"
                  ? "Your account records and any stored trip-photo objects have been removed from the active service."
                  : "The trip log and any stored photo object have been removed from the active service."}</p>
              ) : deletionDetails.status === "needs_attention" ? (
                <p>{deletionDetails.scope === "account"
                  ? "Your account records have been removed from the active service. Stored trip-photo cleanup is delayed and has been flagged for operator attention."
                  : "The trip log has been removed. Stored-photo cleanup is delayed and has been flagged for operator attention."}</p>
              ) : (
                <p>{deletionDetails.scope === "account"
                  ? "Your account records have been removed from the active service. Stored trip-photo cleanup is continuing in the background."
                  : "The trip log has been removed. Stored-photo cleanup is continuing in the background."}</p>
              )}
              {deletionDetails.objectsTotal > 0 ? (
                <p>{Math.min(deletionDetails.objectsDeleted, deletionDetails.objectsTotal)} of {deletionDetails.objectsTotal} stored photo objects removed.</p>
              ) : null}
            </div>
            {deletionDetails.status !== "completed" ? (
              <button className="account-secondary" type="button" disabled={deletionStatusAction !== null} onClick={() => void checkDeletionStatus()}>
                {deletionStatusAction === "checking" ? "Checking…" : "Check deletion status"}
              </button>
            ) : null}
            {deletionStatusError ? <p className="account-error" role="alert">{deletionStatusError}</p> : null}
            {deletionDetails.scope === "account" ? <p><small>{browserAccountStorageCleared === false
              ? "This browser blocked access to local storage, so CastingCompass could not verify removal of its stored trip drafts and anonymous reporting identifier. Clear site data in your browser settings."
              : "CastingCompass cleared its browser-stored trip drafts and anonymous reporting identifier. A short-lived, secure status receipt lets this page check any remaining cleanup without restoring account access."}</small></p> : null}
            <button className="account-primary" type="button" disabled={deletionStatusAction !== null} onClick={() => deletionDetails.scope === "account" ? window.location.assign("/") : void dismissDeletionStatus()}>{deletionDetails.scope === "account" ? "Return to forecast" : deletionStatusAction === "dismissing" ? "Returning…" : "Return to profile"}</button>
            {deletionDetails.scope === "account" ? <button className="account-text-button" type="button" disabled={deletionStatusAction !== null} onClick={() => void dismissDeletionStatus()}>{deletionStatusAction === "dismissing" ? "Dismissing…" : "Dismiss status and continue"}</button> : null}
            <small>Dismissing clears this browser’s status receipt. It does not cancel any remaining cleanup or remove the server-side deletion record.</small>
          </>
        ) : account.user && !account.user.ageEligible ? (
          <>
            <span className="eyebrow"><span /> Account update</span>
            <h2 id="account-title">Account features<br />paused.</h2>
            <p>This older account has no retained age-eligibility confirmation. CastingCompass will not ask for a birth date alongside an existing account or silently mark it eligible.</p>
            <p>Email <a href="mailto:bzeng0000@gmail.com">bzeng0000@gmail.com</a> for privacy support. You can also permanently delete the account below with its password.</p>
            <a className="account-secondary" href="/api/profile/export" download>Download my account records (JSON)</a>
            <details className="account-delete-details">
              <summary>Delete account</summary>
              <form onSubmit={deleteAccount}>
                <label>Password<input name="password" type="password" autoComplete="current-password" minLength={10} maxLength={128} required /></label>
                <label>Type DELETE<input name="confirmation" type="text" autoComplete="off" pattern="DELETE" required /></label>
                <button type="submit" className="account-danger" disabled={accountDeletionDisabled}>{accountDeletionButtonLabel}</button>
                <MutationRequestStatus state={displayedAccountDeletionState} message={displayedAccountDeletionMessage} />
              </form>
            </details>
            {profileActionError ? <p className="account-error" role="alert">{profileActionError}</p> : null}
            <button className="account-text-button" type="button" onClick={() => void account.signOut()}>Sign out</button>
          </>
        ) : account.user && !account.user.legalAccepted ? (
          <>
            <span className="eyebrow"><span /> Account update</span>
            <h2 id="account-title">Review the<br />current terms.</h2>
            <p>Your existing age-eligibility confirmation remains in place. Review and accept the current legal documents to resume account features; no birth date is requested again.</p>
            <form onSubmit={submitLegalAcceptance}>
              <label className="account-consent"><input name="termsAccepted" type="checkbox" required /><span>I agree to the <Link href="/terms" target="_blank">Terms of Service</Link>.</span></label>
              <label className="account-consent"><input name="privacyAccepted" type="checkbox" required /><span>I acknowledge the <Link href="/privacy" target="_blank">Privacy Policy</Link>, including the use of service providers and automated review.</span></label>
              {error ? <p className="account-error" role="alert">{error}</p> : null}
              <button className="account-primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Accept and continue"}</button>
            </form>
            <a className="account-secondary" href="/api/profile/export" download>Download my account records (JSON)</a>
            <details className="account-delete-details">
              <summary>Delete account</summary>
              <form onSubmit={deleteAccount}>
                <label>Password<input name="password" type="password" autoComplete="current-password" minLength={10} maxLength={128} required /></label>
                <label>Type DELETE<input name="confirmation" type="text" autoComplete="off" pattern="DELETE" required /></label>
                <button type="submit" className="account-danger" disabled={accountDeletionDisabled}>{accountDeletionButtonLabel}</button>
                <MutationRequestStatus state={displayedAccountDeletionState} message={displayedAccountDeletionMessage} />
              </form>
            </details>
            {profileActionError ? <p className="account-error" role="alert">{profileActionError}</p> : null}
            <button className="account-text-button" type="button" onClick={() => void account.signOut()}>Sign out</button>
          </>
        ) : account.user ? (
          <>
            <span className="eyebrow"><span /> Your account</span>
            <h2 id="account-title">Your fishing<br />profile.</h2>
            <p className="account-email">Signed in as <strong>{account.user.email}</strong></p>
            {profileLoadError ? (
              <div className="profile-load-error" role="alert">
                <p>{profile
                  ? "The latest profile refresh failed. The information below is the last successfully loaded copy."
                  : "Profile data could not be loaded. CastingCompass is not treating the account as empty."}</p>
                <button type="button" disabled={profileLoading} onClick={() => void loadProfile()}>
                  {profileLoading ? "Retrying…" : "Retry profile"}
                </button>
              </div>
            ) : profileLoading && profile ? (
              <p className="profile-load-status" role="status">Refreshing profile data…</p>
            ) : null}
            <div className="profile-summary" aria-live="polite" aria-busy={profileLoading && !profile}>
              <div><strong>{profile ? profile.savedSites.length : "—"}</strong><span>Saved locations</span></div>
              <div><strong>{profile ? profile.trips.length : "—"}</strong><span>Completed trips</span></div>
            </div>
            <section className="profile-section">
              <h3>Saved locations</h3>
              {profileLoading && !profile ? <ProfileSectionLoading label="Loading saved locations" /> : profile?.savedSites.length ? (
                <div className="profile-list">
                  {profile.savedSites.map((saved) => {
                    const site = sites.find((candidate) => candidate.id === saved.site_id);
                    return (
                      <button
                        className="profile-row profile-site-link"
                        type="button"
                        key={saved.site_id}
                        onClick={() => {
                          if (standalone) {
                            window.location.assign(`/?site=${encodeURIComponent(saved.site_id)}`);
                            return;
                          }
                          closeAccount();
                          onOpenSite?.(saved.site_id);
                        }}
                      >
                        <span><strong>{site?.name ?? saved.site_id}</strong><small>{site?.region ?? "Bay Area"}</small></span>
                        <b aria-hidden="true">View forecast →</b>
                      </button>
                    );
                  })}
                </div>
              ) : profile ? <p>No saved locations yet. Open a forecast and tap “Save location.”</p>
                : <p className="profile-data-unavailable">Saved locations are unavailable. Retry the profile above.</p>}
            </section>
            <section className="profile-section profile-gear-section">
              <h3>Gear presets</h3>
              {profileLoading && !profile ? <ProfileSectionLoading label="Loading gear presets" /> : profile?.gearProfiles.length ? <div className="profile-list">
                {profile.gearProfiles.map((gear) => <article className="profile-gear-row" key={gear.id}>
                  <div><strong>{gear.name}</strong><small>{[gear.rod, gear.reel, gear.bait_lure, gear.rig].filter(Boolean).join(" · ") || "Empty preset"}</small></div>
                  <button type="button" disabled={profileActionBusy} onClick={() => void deleteGearProfile(gear.id)}>Remove</button>
                </article>)}
              </div> : profile ? <p>No gear presets yet.</p>
                : <p className="profile-data-unavailable">Gear presets are unavailable. Retry the profile above.</p>}
              {profile ? <form className="profile-gear-form" onSubmit={saveGearProfile}>
                <input aria-label="Preset name" placeholder="Preset name" maxLength={60} value={gearDraft.name} onChange={(event) => setGearDraft((current) => ({ ...current, name: event.target.value }))} required />
                <GearCatalogFields values={gearDraft} onChange={(gear) => setGearDraft((current) => ({ ...current, ...gear }))} className="profile-gear-catalog" />
                <button type="submit" disabled={profileActionBusy}>{profileActionBusy ? "Saving…" : "Save gear preset"}</button>
              </form> : null}
            </section>
            <section className="profile-section">
              <h3>Past trip logs</h3>
              {networkState === "offline" ? (
                <p className="trip-deletion-network-status error" role="alert">
                  This device appears offline. Trip deletion is paused, and trip-edit submissions remain on this device. Nothing will be submitted automatically.
                </p>
              ) : networkState === "restored" ? (
                <p className="trip-deletion-network-status" role="status">
                  This device reports that its connection is back. No trip edit or deletion was submitted automatically.
                </p>
              ) : null}
              {profileLoading && !profile ? <ProfileSectionLoading label="Loading trip history" /> : profile?.trips.length ? (
                <div className="profile-list">
                  {profile.trips.map((trip) => {
                    const site = sites.find((candidate) => candidate.id === trip.site_id);
                    const targetEncounters = Number(trip.target_encounter_count ?? trip.halibut_encounters ?? 0);
                    const anyFishEncounters = Number(trip.any_fish_encounter_count ?? 0);
                    const nonTargetEncounters = Math.max(0, anyFishEncounters - targetEncounters);
                    const resultLabel = trip.contract_status !== "valid"
                      ? "Legacy report · not a structured v2 observation"
                      : trip.outcome_class === "target_encountered"
                        ? `${targetEncounters} California halibut encounter${targetEncounters === 1 ? "" : "s"}`
                        : trip.outcome_class === "non_target_only"
                          ? `0 California halibut · ${nonTargetEncounters} unresolved non-target fish`
                          : "No fish encountered";
                    const isTripDeletionTarget = tripDeletionRequest?.tripId === trip.id;
                    const isTripEditTarget = tripEditRequest?.tripId === trip.id;
                    const tripDeletionButtonLabel = isTripDeletionTarget && tripDeletionRequest.state === "submitting"
                      ? "Removing…"
                      : isTripDeletionTarget && tripDeletionRequest.state === "ambiguous"
                        ? "Deletion status unresolved"
                        : tripDeletionAmbiguous
                          ? "Deletion status unresolved"
                          : tripEditAmbiguous
                            ? "Trip update unresolved"
                            : networkState === "offline"
                              ? "Reconnect to remove"
                              : profileActionBusy
                                ? "Account action in progress…"
                                : "Remove";
                    const tripDeletionDisabled = profileActionBusy || networkState === "offline" || tripDeletionAmbiguous || tripEditAmbiguous;
                    const tripEditButtonLabel = tripEditAmbiguous ? "Update unresolved" : "Edit";
                    const tripEditDisabled = profileActionBusy || tripDeletionAmbiguous || tripEditAmbiguous;
                    return (
                      <article className="profile-trip" key={trip.id}>
                        <div><strong>{site?.name ?? trip.site_id}</strong><span>{new Date(trip.started_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span></div>
                        <p>{resultLabel} · {Number(trip.angler_hours ?? 0).toFixed(1)} angler-hours</p>
                        <small>{tripReviewLabel(trip)}</small>
                        {trip.moderation_status === "pending" ? (
                          <>
                            <div className="profile-trip-actions">
                              <button
                                type="button"
                                aria-label={isTripEditTarget && tripEditAmbiguous
                                  ? "Verify saved trip before editing again"
                                  : undefined}
                                disabled={tripEditDisabled}
                                onClick={() => beginTripEdit(trip)}
                              >{tripEditButtonLabel}</button>
                              <button
                                type="button"
                                aria-label={isTripDeletionTarget && tripDeletionRequest.state === "ambiguous"
                                  ? "Verify deletion status before retrying"
                                  : undefined}
                                disabled={tripDeletionDisabled}
                                onClick={() => void deleteTrip(trip)}
                              >{tripDeletionButtonLabel}</button>
                            </div>
                            {isTripDeletionTarget ? (
                              <MutationRequestStatus state={tripDeletionRequest.state} message={tripDeletionRequest.message} />
                            ) : null}
                            {isTripEditTarget && !editingTrip ? (
                              <MutationRequestStatus state={tripEditRequest.state} message={tripEditRequest.message} />
                            ) : null}
                          </>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              ) : profile ? <p>No completed trip logs are attached to this account yet.</p>
                : <p className="profile-data-unavailable">Trip history is unavailable. Retry the profile above.</p>}
              <small className="profile-review-note">Trip data is saved immediately. Automated review may prepare a discussion draft, but nothing is posted without human approval. Pending reports remain editable during the beta. After any edit, the revised report remains useful as descriptive context but cannot re-enter prospective validation evidence.</small>
              {profileActionNotice && !editingTrip ? <p role="status">{profileActionNotice}</p> : null}
              {profileActionError && !editingTrip ? <p className="account-error" role="alert">{profileActionError}</p> : null}
            </section>
            {editingTrip && editFields ? (
              <div className="profile-trip-editor-layer" role="presentation" onClick={(event) => {
                if (event.target === event.currentTarget && !profileActionBusy) closeTripEdit();
              }}>
              <form
                className="profile-trip-editor profile-trip-editor-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="profile-trip-editor-title"
                aria-busy={activeTripEditRequest?.state === "submitting"}
                onSubmit={saveTripEdit}
              >
                <div className="profile-trip-editor-heading">
                  <div><span>Pending trip</span><h3 id="profile-trip-editor-title">Edit trip log</h3></div>
                  <button type="button" disabled={profileActionBusy} onClick={closeTripEdit}>Close</button>
                </div>
                <p className="profile-trip-editor-note">Your saved report is loaded below. Any unfinished edits on this device are restored automatically. Saving any edit permanently keeps this report out of prospective validation evidence; the revised report remains usable as descriptive context.</p>
                <fieldset className="profile-trip-editor-controls" disabled={profileActionBusy || tripEditAmbiguous}>
                <SiteCombobox
                  sites={sites}
                  value={editFields.siteId}
                  onChange={(siteId) => setEditFields((current) => current ? { ...current, siteId } : current)}
                />
                <div className="profile-trip-editor-grid">
                  <label>Start<input type="datetime-local" value={editFields.startedAt} onChange={(event) => setEditFields((current) => current ? { ...current, startedAt: event.target.value } : current)} required /></label>
                  <label>Finish<input type="datetime-local" value={editFields.endedAt} onChange={(event) => setEditFields((current) => current ? { ...current, endedAt: event.target.value } : current)} required /></label>
                  <label>Anglers<input type="number" min="1" max="12" value={editFields.anglerCount} onChange={(event) => setEditFields((current) => current ? { ...current, anglerCount: Number(event.target.value) } : current)} required /></label>
                  <label>Fishing mode
                    <select value={editFields.mode} onChange={(event) => setEditFields((current) => current ? { ...current, mode: event.target.value } : current)}>
                      <option value="shore">Shore</option><option value="beach">Beach</option><option value="pier">Pier</option><option value="jetty">Jetty</option><option value="kayak">Kayak</option><option value="boat">Boat</option><option value="other">Other</option>
                    </select>
                  </label>
                  <label>Fishing method
                    <select value={editFields.fishingMethod} onChange={(event) => setEditFields((current) => current ? { ...current, fishingMethod: event.target.value } : current)}>
                      <option value="bait">Bait</option><option value="artificial-lure">Artificial lure</option><option value="both">Bait + lure</option><option value="other">Other</option>
                    </select>
                  </label>
                  <label>Kept<input type="number" min="0" max="25" value={editFields.keeperCount} onChange={(event) => setEditFields((current) => current ? { ...current, keeperCount: Number(event.target.value) } : current)} required /></label>
                  <label>Short / released<input type="number" min="0" max="25" value={editFields.shortReleasedCount} onChange={(event) => setEditFields((current) => current ? { ...current, shortReleasedCount: Number(event.target.value) } : current)} required /></label>
                </div>
                <small>{editingTrip.contract_status === "valid"
                  ? "California halibut is the fixed observation target. Saving recomputes the structured validation outcome; other-fish counts remain unresolved unless reviewed against stronger identification evidence. A valid contract does not by itself admit the report to model training."
                  : "This legacy report remains outside the structured v2 observation set after ordinary edits. CastingCompass does not silently convert older counts into a validated structured observation."}</small>
                <small>Changing the location, start, finish, or fishing mode clears the report’s saved forecast and model attribution instead of pairing the result with a forecast it no longer matches.</small>
                <fieldset className="profile-trip-editor-section">
                  <legend>Gear used</legend>
                  <p>Add what you remember. Partial setups are still useful.</p>
                  {profile?.gearProfiles.length ? (
                    <label className="profile-preset-picker">Use saved preset
                      <select
                        value={editFields.gearProfileId}
                        onChange={(event) => {
                          const gearProfileId = event.target.value;
                          const preset = profile.gearProfiles.find((candidate) => candidate.id === gearProfileId);
                          setEditFields((current) => current ? {
                            ...current,
                            gearProfileId,
                            ...(preset ? {
                              rod: preset.rod ?? "",
                              reel: preset.reel ?? "",
                              baitLure: preset.bait_lure ?? "",
                              rig: preset.rig ?? "",
                            } : {}),
                          } : current);
                        }}
                      >
                        <option value="">No preset</option>
                        {profile.gearProfiles.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
                      </select>
                    </label>
                  ) : null}
                  <GearCatalogFields
                    values={{ rod: editFields.rod, reel: editFields.reel, baitLure: editFields.baitLure, rig: editFields.rig }}
                    onChange={(gear) => setEditFields((current) => current ? { ...current, gearProfileId: "", ...gear } : current)}
                  />
                </fieldset>
                <fieldset className="profile-trip-editor-section">
                  <legend>What the water was actually like</legend>
                  <p>These observations document when theoretically good water was difficult to fish. Any later model use requires the separate validation protocol.</p>
                  <div className="profile-trip-editor-grid">
                    <label>Shorebreak<select value={editFields.shorebreak} onChange={(event) => setEditFields((current) => current ? { ...current, shorebreak: event.target.value } : current)}><option value="">Not noted</option><option value="calm">Calm</option><option value="manageable">Manageable</option><option value="difficult">Difficult</option><option value="unfishable">Unfishable</option></select></label>
                    <label>Water reached<select value={editFields.wadingDepth} onChange={(event) => setEditFields((current) => current ? { ...current, wadingDepth: event.target.value } : current)}><option value="">Not noted</option><option value="ankle">Ankle</option><option value="knee">Knee</option><option value="thigh">Thigh</option><option value="waist-plus">Waist or higher</option><option value="did-not-wade">Did not wade</option></select></label>
                    <label>Water clarity<select value={editFields.waterClarity} onChange={(event) => setEditFields((current) => current ? { ...current, waterClarity: event.target.value } : current)}><option value="">Not noted</option><option value="clear">Clear</option><option value="light-stain">Light stain</option><option value="murky">Murky</option><option value="muddy">Muddy</option></select></label>
                    <label>Crowding<select value={editFields.crowding} onChange={(event) => setEditFields((current) => current ? { ...current, crowding: event.target.value } : current)}><option value="">Not noted</option><option value="empty">Empty</option><option value="light">Light</option><option value="moderate">Moderate</option><option value="packed">Packed</option></select></label>
                    <label>Overall fishability<select value={editFields.fishabilityRating} onChange={(event) => setEditFields((current) => current ? { ...current, fishabilityRating: event.target.value } : current)}><option value="">Not rated</option><option value="5">5 · Excellent</option><option value="4">4 · Good</option><option value="3">3 · Workable</option><option value="2">2 · Difficult</option><option value="1">1 · Unfishable</option></select></label>
                    <label>Observed waves, ft<input type="number" min="0" max="30" step="0.5" value={editFields.observedWaveHeightFeet} onChange={(event) => setEditFields((current) => current ? { ...current, observedWaveHeightFeet: event.target.value } : current)} /></label>
                    <label>Other fish caught<input type="number" min="0" max="100" value={editFields.otherCatchCount} onChange={(event) => setEditFields((current) => current ? { ...current, otherCatchCount: Number(event.target.value) } : current)} /></label>
                    <label>Other species<input maxLength={240} value={editFields.otherSpecies} onChange={(event) => setEditFields((current) => current ? { ...current, otherSpecies: event.target.value } : current)} placeholder="Surf smelt, striped bass…" /></label>
                  </div>
                  <label>Fishability notes<textarea rows={3} maxLength={500} value={editFields.fishabilityNotes} onChange={(event) => setEditFields((current) => current ? { ...current, fishabilityNotes: event.target.value } : current)} placeholder="Steep beach, thigh-high wash, weeds, snags…" /></label>
                </fieldset>
                <label>Notes<textarea rows={4} maxLength={1000} value={editFields.notes} onChange={(event) => setEditFields((current) => current ? { ...current, notes: event.target.value } : current)} /></label>
                <small>Changed notes are checked again for privacy and relevance. A revised discussion draft still requires human approval before publication.</small>
                <small>Your edits are saved in this browser as you type.</small>
                {profileActionError ? <p className="account-error" role="alert">{profileActionError}</p> : null}
                <button className="account-primary" type="submit" disabled={tripEditSubmitDisabled}>{tripEditSubmitLabel}</button>
                </fieldset>
                <MutationRequestStatus state={displayedTripEditState} message={displayedTripEditMessage} />
              </form>
              </div>
            ) : null}
            <section className="profile-section profile-privacy-section">
              <h3>Privacy and account controls</h3>
              <p>Download a machine-readable copy of your account records, or permanently remove account access and linked data from the active service.</p>
              <div className="profile-privacy-links">
                <a className="account-secondary" href="/api/profile/export" download>Download my account records (JSON)</a>
                <Link href="/privacy">Privacy Policy</Link>
                <Link href="/terms">Terms of Service</Link>
                <Link href="/ai-disclosure">AI and forecast disclosure</Link>
              </div>
              <small>The JSON export includes account and consent records, saved locations, gear presets, full trip records, related discussion posts, and a photo manifest. A valid observation contract means a report is internally structured, not that it has been admitted to model training. Authenticated photo links appear only for files that are available; photo files are separate downloads and are not inside the JSON file.</small>
              <details className="account-delete-details">
                <summary>Delete account</summary>
                <p>Account access and database records are removed first. If stored photo objects need background cleanup, you will receive a secure receipt and can check progress here.</p>
                <form onSubmit={deleteAccount}>
                  <label>Password<input name="password" type="password" autoComplete="current-password" minLength={10} maxLength={128} required /></label>
                  <label>Type DELETE<input name="confirmation" type="text" autoComplete="off" pattern="DELETE" required /></label>
                  <button type="submit" className="account-danger" disabled={accountDeletionDisabled}>{accountDeletionButtonLabel}</button>
                  <MutationRequestStatus state={displayedAccountDeletionState} message={displayedAccountDeletionMessage} />
                </form>
              </details>
            </section>
            <button className="account-primary account-signout" type="button" onClick={() => void account.signOut()}>Sign out</button>
          </>
        ) : (
          <>
            <span className="eyebrow"><span /> CastingCompass beta</span>
            <h2 id="account-title">{
              mode === "login" ? "Welcome back."
                : mode === "signup" || mode === "signupDetails" ? "Create an account."
                  : mode === "verify" ? "Check your email."
                    : mode === "recover" ? "Reset your password."
                      : "Enter your reset code."
            }</h2>
            <p>{mode === "signup"
              ? "Before we collect account details, enter your birth date. It is used only to decide whether signup is available and is not stored."
              : mode === "signupDetails"
                ? "Eligibility confirmed. Now enter your account details and review the legal documents."
                : account.modalMessage || "Save locations and contribute trip reports to improve the forecast."}</p>
            {mode === "login" || mode === "signup" ? (
              <div className="account-tabs" role="tablist" aria-label="Account action">
                <button type="button" className={mode === "login" ? "active" : ""} onClick={() => { changeMode("login"); setEligibilityProof(""); setError(""); }}>Sign in</button>
                <button type="button" className={mode === "signup" ? "active" : ""} onClick={() => { changeMode("signup"); setSignupAvailable(null); setEligibilityProof(""); setError(""); }}>Create account</button>
              </div>
            ) : null}
            {mode === "signup" && signupAvailable === true ? (
              <form aria-label="Age eligibility" onSubmit={submitSignupEligibility}>
                <label>Birth date<input name="birthDate" type="date" autoComplete="bday" required /></label>
                <small>The entered date is not retained. The service keeps only a short-lived eligibility result without your birth date, email, or account details.</small>
                <TurnstileChallenge
                  action={turnstileActionForMode(mode)}
                  resetKey={turnstileResetKey}
                  onTokenChange={setTurnstileToken}
                  onStateChange={setTurnstileState}
                />
                {error ? <p className="account-error" role="alert">{error}</p> : null}
                <button className="account-primary" type="submit" disabled={busy || !turnstileCanSubmit}>{busy ? "Checking…" : "Continue"}</button>
              </form>
            ) : mode === "signup" ? (
              <p className={signupAvailable === false ? "account-error" : "account-notice"} role="status">
                {signupAvailable === false
                  ? "Account signup is not available from this browser right now."
                  : "Checking whether account signup is available…"}
              </p>
            ) : (
              <form onSubmit={submit}>
                {mode !== "verify" && mode !== "reset" ? <label>Email<input name="email" type="email" autoComplete="email" required maxLength={254} /></label> : null}
                {mode === "login" || mode === "signupDetails" || mode === "reset" ? <label>{mode === "reset" ? "New password" : "Password"}<input name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={mode === "login" ? 10 : 15} maxLength={128} /></label> : null}
                {mode === "signupDetails" ? <label className="account-consent"><input name="termsAccepted" type="checkbox" required /><span>I agree to the <Link href="/terms" target="_blank">Terms of Service</Link>.</span></label> : null}
                {mode === "signupDetails" ? <label className="account-consent"><input name="privacyAccepted" type="checkbox" required /><span>I acknowledge the <Link href="/privacy" target="_blank">Privacy Policy</Link> and <Link href="/ai-disclosure" target="_blank">AI disclosure</Link>.</span></label> : null}
                {mode === "verify" || mode === "reset" ? <label>Six-digit email code<input name="code" type="text" inputMode="numeric" autoComplete="one-time-code" required minLength={6} maxLength={6} pattern="[0-9]{6}" /></label> : null}
                {mode === "signupDetails" ? <small>Use at least 15 characters. Common, breached, email-based, and CastingCompass-based passwords are rejected. Password managers, paste, spaces, and passphrases are supported. We’ll email a six-digit code before creating the account.</small> : null}
                {mode === "reset" ? <small>Use at least 15 characters. Common, breached, email-based, and CastingCompass-based passwords are rejected.</small> : null}
                {mode === "verify" || mode === "reset" ? <small>The code expires after 15 minutes and can be tried six times.</small> : null}
                <TurnstileChallenge
                  action={turnstileActionForMode(mode)}
                  resetKey={turnstileResetKey}
                  onTokenChange={setTurnstileToken}
                  onStateChange={setTurnstileState}
                />
                {error ? <p className="account-error" role="alert">{error}</p> : null}
                {notice ? <p className="account-notice" role="status">{notice}</p> : null}
                <button className="account-primary" type="submit" disabled={busy || !turnstileCanSubmit}>{busy ? "Please wait…" : mode === "login" ? "Sign in" : mode === "signupDetails" ? "Email verification code" : mode === "verify" ? "Verify and create account" : mode === "recover" ? "Email reset code" : "Set new password"}</button>
              </form>
            )}
            {mode === "verify" || mode === "reset" ? (
              <div className="account-resend">
                {resendCooldown <= 0 ? (
                  <TurnstileChallenge
                    action="challenge_resend"
                    resetKey={resendTurnstileResetKey}
                    onTokenChange={setResendTurnstileToken}
                    onStateChange={setResendTurnstileState}
                  />
                ) : null}
                <button className="account-text-button" type="button" disabled={busy || resendCooldown > 0 || !resendTurnstileCanSubmit} onClick={() => void resendCode()}>
                  {resendCooldown > 0 ? `Send another code in ${resendCooldown}s` : "Send another code"}
                </button>
              </div>
            ) : null}
            {mode === "login" ? <button className="account-text-button" type="button" onClick={() => { changeMode("recover"); setError(""); }}>Forgot password?</button> : null}
            {mode === "signupDetails" ? <button className="account-text-button" type="button" onClick={() => { changeMode("signup"); setSignupAvailable(null); setEligibilityProof(""); setError(""); }}>Start age check again</button> : null}
            {mode === "recover" || mode === "verify" || mode === "reset" ? <button className="account-text-button" type="button" onClick={() => { changeMode("login"); setEligibilityProof(""); setError(""); setChallengeId(""); }}>Back to sign in</button> : null}
            <p className="account-legal-links"><Link href="/terms">Terms</Link><Link href="/privacy">Privacy</Link><Link href="/ai-disclosure">AI disclosure</Link></p>
          </>
        )}
      </section>
    </div>
  );
}
