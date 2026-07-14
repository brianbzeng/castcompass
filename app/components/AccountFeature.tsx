"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { CloseIcon } from "./icons";
import { GearCatalogFields } from "./GearCatalogFields";
import { SiteCombobox } from "./SiteCombobox";
import type { FishingSite } from "../types";

export interface AccountUser {
  id: string;
  email: string;
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
  other_catch_count: number | null;
  other_species: string | null;
  observations_json: string | null;
}

interface ProfileData {
  savedSites: Array<{ site_id: string; created_at: string }>;
  trips: ProfileTrip[];
  gearProfiles: GearProfile[];
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

const PROFILE_TRIP_DRAFT_PREFIX = "castcompass.profile-trip-draft.v1.";

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
      if (!nextUser) {
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

type AccountMode = "login" | "signup" | "verify" | "recover" | "reset";

export function AccountModal({
  account,
  sites,
  onOpenSite,
}: {
  account: AccountController;
  sites: FishingSite[];
  onOpenSite?(siteId: string): void;
}) {
  const [mode, setMode] = useState<AccountMode>("login");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [resendCooldown, setResendCooldown] = useState(0);
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [editingTrip, setEditingTrip] = useState<ProfileTrip | null>(null);
  const [editFields, setEditFields] = useState<ProfileTripEditFields | null>(null);
  const [profileActionBusy, setProfileActionBusy] = useState(false);
  const [profileActionError, setProfileActionError] = useState("");
  const [gearDraft, setGearDraft] = useState(EMPTY_GEAR);

  const loadProfile = useCallback(async () => {
    setProfileLoading(true);
    try {
      const response = await fetch("/api/profile", { cache: "no-store" });
      if (!response.ok) throw new Error("Profile could not be loaded.");
      setProfile(await response.json() as ProfileData);
    } catch {
      setProfile({ savedSites: [], trips: [], gearProfiles: [] });
    } finally {
      setProfileLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!account.modalOpen || !account.user) {
      return;
    }
    const timer = window.setTimeout(() => {
      void loadProfile();
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [account.modalOpen, account.user, loadProfile]);

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

  if (!account.modalOpen) return null;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    const form = new FormData(event.currentTarget);
    try {
      const endpoint = mode === "signup"
        ? "/api/auth/signup/request"
        : mode === "verify"
          ? "/api/auth/signup/verify"
          : mode === "recover"
            ? "/api/auth/password/request"
            : mode === "reset"
              ? "/api/auth/password/reset"
              : "/api/auth/login";
      const payload = mode === "verify"
        ? { challengeId, code: form.get("code") }
        : mode === "reset"
          ? { challengeId, code: form.get("code"), password: form.get("password") }
          : { email: form.get("email"), password: form.get("password") };
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json() as { challengeId?: string; error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "The account request failed.");
      if ((mode === "signup" || mode === "recover") && body.challengeId) {
        setChallengeId(body.challengeId);
        setResendCooldown(60);
        setMode(mode === "signup" ? "verify" : "reset");
        return;
      }
      await account.refresh();
      account.closeAccount();
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "The account request failed.");
    } finally {
      setBusy(false);
    }
  };

  const resendCode = async () => {
    if (!challengeId || resendCooldown > 0 || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/challenge/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId }),
      });
      const body = await response.json() as { retryAfterSeconds?: number; error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "A new code could not be sent.");
      setResendCooldown(body.retryAfterSeconds ?? 60);
      setNotice("A new code was requested. Check spam, promotions, and All Mail too.");
    } catch (resendError) {
      setError(resendError instanceof Error ? resendError.message : "A new code could not be sent.");
    } finally {
      setBusy(false);
    }
  };

  const beginTripEdit = (trip: ProfileTrip) => {
    const draftKey = `${PROFILE_TRIP_DRAFT_PREFIX}${trip.id}`;
    let nextFields = editFieldsForTrip(trip);
    try {
      const savedDraft = window.localStorage.getItem(draftKey);
      if (savedDraft) nextFields = { ...nextFields, ...JSON.parse(savedDraft) as Partial<ProfileTripEditFields> };
    } catch {
      window.localStorage.removeItem(draftKey);
    }
    setProfileActionError("");
    setEditingTrip(trip);
    setEditFields(nextFields);
  };

  const closeTripEdit = () => {
    setEditingTrip(null);
    setEditFields(null);
    setProfileActionError("");
  };

  const saveTripEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingTrip || !editFields) return;
    if (!sites.some((site) => site.id === editFields.siteId)) {
      setProfileActionError("Choose a fishing location from the matching results.");
      return;
    }
    setProfileActionBusy(true);
    setProfileActionError("");
    try {
      const response = await fetch(`/api/profile/trips/${encodeURIComponent(editingTrip.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...editFields,
          startedAt: new Date(editFields.startedAt).toISOString(),
          endedAt: new Date(editFields.endedAt).toISOString(),
        }),
      });
      const body = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "The trip log could not be updated.");
      window.localStorage.removeItem(`${PROFILE_TRIP_DRAFT_PREFIX}${editingTrip.id}`);
      closeTripEdit();
      await loadProfile();
    } catch (editError) {
      setProfileActionError(editError instanceof Error ? editError.message : "The trip log could not be updated.");
    } finally {
      setProfileActionBusy(false);
    }
  };

  const deleteTrip = async (trip: ProfileTrip) => {
    if (!window.confirm("Remove this pending trip log? This cannot be undone.")) return;
    setProfileActionBusy(true);
    setProfileActionError("");
    try {
      const response = await fetch(`/api/profile/trips/${encodeURIComponent(trip.id)}`, { method: "DELETE" });
      const body = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "The trip log could not be removed.");
      window.localStorage.removeItem(`${PROFILE_TRIP_DRAFT_PREFIX}${trip.id}`);
      await loadProfile();
    } catch (deleteError) {
      setProfileActionError(deleteError instanceof Error ? deleteError.message : "The trip log could not be removed.");
    } finally {
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
      await loadProfile();
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
      await loadProfile();
    } catch (gearError) {
      setProfileActionError(gearError instanceof Error ? gearError.message : "The gear preset could not be removed.");
    } finally {
      setProfileActionBusy(false);
    }
  };

  return (
    <div className="account-modal-layer" role="presentation" onClick={(event) => {
      if (event.target === event.currentTarget) account.closeAccount();
    }}>
      <section className="account-modal" role="dialog" aria-modal="true" aria-labelledby="account-title">
        <button className="sheet-close" type="button" onClick={account.closeAccount} aria-label="Close account"><CloseIcon /></button>
        {account.user ? (
          <>
            <span className="eyebrow"><span /> Your account</span>
            <h2 id="account-title">Your fishing<br />profile.</h2>
            <p className="account-email">Signed in as <strong>{account.user.email}</strong></p>
            <div className="profile-summary" aria-live="polite">
              <div><strong>{profile?.savedSites.length ?? 0}</strong><span>Saved locations</span></div>
              <div><strong>{profile?.trips.length ?? 0}</strong><span>Completed trips</span></div>
            </div>
            <section className="profile-section">
              <h3>Saved locations</h3>
              {profileLoading ? <p>Loading your saved water…</p> : profile?.savedSites.length ? (
                <div className="profile-list">
                  {profile.savedSites.map((saved) => {
                    const site = sites.find((candidate) => candidate.id === saved.site_id);
                    return (
                      <button
                        className="profile-row profile-site-link"
                        type="button"
                        key={saved.site_id}
                        onClick={() => {
                          account.closeAccount();
                          onOpenSite?.(saved.site_id);
                        }}
                      >
                        <span><strong>{site?.name ?? saved.site_id}</strong><small>{site?.region ?? "Bay Area"}</small></span>
                        <b aria-hidden="true">View forecast →</b>
                      </button>
                    );
                  })}
                </div>
              ) : <p>No saved locations yet. Open a forecast and tap “Save location.”</p>}
            </section>
            <section className="profile-section profile-gear-section">
              <h3>Gear presets</h3>
              {profile?.gearProfiles.length ? <div className="profile-list">
                {profile.gearProfiles.map((gear) => <article className="profile-gear-row" key={gear.id}>
                  <div><strong>{gear.name}</strong><small>{[gear.rod, gear.reel, gear.bait_lure, gear.rig].filter(Boolean).join(" · ") || "Empty preset"}</small></div>
                  <button type="button" disabled={profileActionBusy} onClick={() => void deleteGearProfile(gear.id)}>Remove</button>
                </article>)}
              </div> : <p>No gear presets yet.</p>}
              <form className="profile-gear-form" onSubmit={saveGearProfile}>
                <input aria-label="Preset name" placeholder="Preset name" maxLength={60} value={gearDraft.name} onChange={(event) => setGearDraft((current) => ({ ...current, name: event.target.value }))} required />
                <GearCatalogFields values={gearDraft} onChange={(gear) => setGearDraft((current) => ({ ...current, ...gear }))} className="profile-gear-catalog" />
                <button type="submit" disabled={profileActionBusy}>{profileActionBusy ? "Saving…" : "Save gear preset"}</button>
              </form>
            </section>
            <section className="profile-section">
              <h3>Past trip logs</h3>
              {profileLoading ? <p>Loading trip history…</p> : profile?.trips.length ? (
                <div className="profile-list">
                  {profile.trips.map((trip) => {
                    const site = sites.find((candidate) => candidate.id === trip.site_id);
                    const encounters = Number(trip.halibut_encounters ?? 0);
                    return (
                      <article className="profile-trip" key={trip.id}>
                        <div><strong>{site?.name ?? trip.site_id}</strong><span>{new Date(trip.started_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span></div>
                        <p>{encounters > 0 ? `${encounters} halibut encounter${encounters === 1 ? "" : "s"}` : "Skunk logged"} · {Number(trip.angler_hours ?? 0).toFixed(1)} angler-hours</p>
                        <small>{trip.moderation_status === "pending" ? "Awaiting dataset review" : trip.moderation_status}</small>
                        {trip.moderation_status === "pending" ? (
                          <div className="profile-trip-actions">
                            <button type="button" onClick={() => beginTripEdit(trip)}>Edit</button>
                            <button type="button" disabled={profileActionBusy} onClick={() => void deleteTrip(trip)}>Remove</button>
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              ) : <p>No completed trip logs are attached to this account yet.</p>}
              <small className="profile-review-note">Pending reports can be edited or removed. Those controls close once dataset review is complete.</small>
              {profileActionError && !editingTrip ? <p className="account-error" role="alert">{profileActionError}</p> : null}
            </section>
            {editingTrip && editFields ? (
              <div className="profile-trip-editor-layer" role="presentation" onClick={(event) => {
                if (event.target === event.currentTarget) closeTripEdit();
              }}>
              <form className="profile-trip-editor profile-trip-editor-modal" role="dialog" aria-modal="true" aria-labelledby="profile-trip-editor-title" onSubmit={saveTripEdit}>
                <div className="profile-trip-editor-heading">
                  <div><span>Pending trip</span><h3 id="profile-trip-editor-title">Edit trip log</h3></div>
                  <button type="button" onClick={closeTripEdit}>Close</button>
                </div>
                <p className="profile-trip-editor-note">Your saved report is loaded below. Any unfinished edits on this device are restored automatically.</p>
                <SiteCombobox
                  sites={sites}
                  value={editFields.siteId}
                  onChange={(siteId) => setEditFields((current) => current ? { ...current, siteId } : current)}
                />
                <div className="profile-trip-editor-grid">
                  <label>Start<input type="datetime-local" value={editFields.startedAt} onChange={(event) => setEditFields((current) => current ? { ...current, startedAt: event.target.value } : current)} required /></label>
                  <label>Finish<input type="datetime-local" value={editFields.endedAt} onChange={(event) => setEditFields((current) => current ? { ...current, endedAt: event.target.value } : current)} required /></label>
                  <label>Anglers<input type="number" min="1" max="12" value={editFields.anglerCount} onChange={(event) => setEditFields((current) => current ? { ...current, anglerCount: Number(event.target.value) } : current)} required /></label>
                  <label>Fishing method
                    <select value={editFields.fishingMethod} onChange={(event) => setEditFields((current) => current ? { ...current, fishingMethod: event.target.value } : current)}>
                      <option value="bait">Bait</option><option value="artificial-lure">Artificial lure</option><option value="both">Bait + lure</option><option value="other">Other</option>
                    </select>
                  </label>
                  <label>Kept<input type="number" min="0" max="25" value={editFields.keeperCount} onChange={(event) => setEditFields((current) => current ? { ...current, keeperCount: Number(event.target.value) } : current)} required /></label>
                  <label>Short / released<input type="number" min="0" max="25" value={editFields.shortReleasedCount} onChange={(event) => setEditFields((current) => current ? { ...current, shortReleasedCount: Number(event.target.value) } : current)} required /></label>
                </div>
                <fieldset className="profile-trip-editor-section">
                  <legend>Gear used</legend>
                  <p>Add what you remember. Partial setups are still useful.</p>
                  <GearCatalogFields
                    values={{ rod: editFields.rod, reel: editFields.reel, baitLure: editFields.baitLure, rig: editFields.rig }}
                    onChange={(gear) => setEditFields((current) => current ? { ...current, ...gear } : current)}
                  />
                </fieldset>
                <fieldset className="profile-trip-editor-section">
                  <legend>What the water was actually like</legend>
                  <p>These observations let the forecast learn when theoretically good water is difficult to fish.</p>
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
                <small>MiMo re-reviews changed notes. A safe anonymous summary may update the location discussion; raw notes and identity stay private.</small>
                <small>Your edits are saved in this browser as you type.</small>
                {profileActionError ? <p className="account-error" role="alert">{profileActionError}</p> : null}
                <button className="account-primary" type="submit" disabled={profileActionBusy}>{profileActionBusy ? "Saving…" : "Save trip changes"}</button>
              </form>
              </div>
            ) : null}
            <button className="account-primary account-signout" type="button" onClick={() => void account.signOut()}>Sign out</button>
          </>
        ) : (
          <>
            <span className="eyebrow"><span /> CastCompass beta</span>
            <h2 id="account-title">{
              mode === "login" ? "Welcome back."
                : mode === "signup" ? "Create an account."
                  : mode === "verify" ? "Check your email."
                    : mode === "recover" ? "Reset your password."
                      : "Enter your reset code."
            }</h2>
            <p>{account.modalMessage || "Save locations and contribute trip reports to improve the forecast."}</p>
            {mode === "login" || mode === "signup" ? (
              <div className="account-tabs" role="tablist" aria-label="Account action">
                <button type="button" className={mode === "login" ? "active" : ""} onClick={() => { setMode("login"); setError(""); }}>Sign in</button>
                <button type="button" className={mode === "signup" ? "active" : ""} onClick={() => { setMode("signup"); setError(""); }}>Create account</button>
              </div>
            ) : null}
            <form onSubmit={submit}>
              {mode !== "verify" && mode !== "reset" ? <label>Email<input name="email" type="email" autoComplete="email" required maxLength={254} /></label> : null}
              {mode === "login" || mode === "signup" || mode === "reset" ? <label>{mode === "reset" ? "New password" : "Password"}<input name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={10} maxLength={128} /></label> : null}
              {mode === "verify" || mode === "reset" ? <label>Six-digit email code<input name="code" type="text" inputMode="numeric" autoComplete="one-time-code" required minLength={6} maxLength={6} pattern="[0-9]{6}" /></label> : null}
              {mode === "signup" ? <small>Use at least 10 characters. We’ll email a six-digit code before creating the account.</small> : null}
              {mode === "verify" || mode === "reset" ? <small>The code expires after 15 minutes and can be tried six times.</small> : null}
              {error ? <p className="account-error" role="alert">{error}</p> : null}
              {notice ? <p className="account-notice" role="status">{notice}</p> : null}
              <button className="account-primary" type="submit" disabled={busy}>{busy ? "Please wait…" : mode === "login" ? "Sign in" : mode === "signup" ? "Email verification code" : mode === "verify" ? "Verify and create account" : mode === "recover" ? "Email reset code" : "Set new password"}</button>
            </form>
            {mode === "verify" || mode === "reset" ? (
              <button className="account-text-button" type="button" disabled={busy || resendCooldown > 0} onClick={() => void resendCode()}>
                {resendCooldown > 0 ? `Send another code in ${resendCooldown}s` : "Send another code"}
              </button>
            ) : null}
            {mode === "login" ? <button className="account-text-button" type="button" onClick={() => { setMode("recover"); setError(""); }}>Forgot password?</button> : null}
            {mode === "recover" || mode === "verify" || mode === "reset" ? <button className="account-text-button" type="button" onClick={() => { setMode("login"); setError(""); setChallengeId(""); }}>Back to sign in</button> : null}
          </>
        )}
      </section>
    </div>
  );
}
