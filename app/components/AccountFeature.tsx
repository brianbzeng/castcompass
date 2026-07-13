"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { CloseIcon } from "./icons";
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
}

interface ProfileData {
  savedSites: Array<{ site_id: string; created_at: string }>;
  trips: ProfileTrip[];
}

interface ProfileTripEditFields {
  siteId: string;
  startedAt: string;
  endedAt: string;
  anglerCount: number;
  keeperCount: number;
  shortReleasedCount: number;
  fishingMethod: string;
  notes: string;
}

const PROFILE_TRIP_DRAFT_PREFIX = "castcompass.profile-trip-draft.v1.";

function localDateTimeValue(value: string | null) {
  const date = value ? new Date(value) : new Date();
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function editFieldsForTrip(trip: ProfileTrip): ProfileTripEditFields {
  return {
    siteId: trip.site_id,
    startedAt: localDateTimeValue(trip.started_at),
    endedAt: localDateTimeValue(trip.ended_at),
    anglerCount: Number(trip.angler_count ?? 1),
    keeperCount: Number(trip.keeper_count ?? 0),
    shortReleasedCount: Number(trip.short_released_count ?? 0),
    fishingMethod: trip.fishing_method ?? "bait",
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
  const [challengeId, setChallengeId] = useState("");
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [editingTrip, setEditingTrip] = useState<ProfileTrip | null>(null);
  const [editFields, setEditFields] = useState<ProfileTripEditFields | null>(null);
  const [editSiteSearch, setEditSiteSearch] = useState("");
  const [profileActionBusy, setProfileActionBusy] = useState(false);
  const [profileActionError, setProfileActionError] = useState("");

  const loadProfile = useCallback(async () => {
    setProfileLoading(true);
    try {
      const response = await fetch("/api/profile", { cache: "no-store" });
      if (!response.ok) throw new Error("Profile could not be loaded.");
      setProfile(await response.json() as ProfileData);
    } catch {
      setProfile({ savedSites: [], trips: [] });
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

  if (!account.modalOpen) return null;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
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
    setEditSiteSearch("");
    setEditingTrip(trip);
    setEditFields(nextFields);
  };

  const closeTripEdit = () => {
    setEditingTrip(null);
    setEditFields(null);
    setEditSiteSearch("");
    setProfileActionError("");
  };

  const saveTripEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingTrip || !editFields) return;
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

  const filteredEditSites = sites.filter((site) => {
    const query = editSiteSearch.trim().toLowerCase();
    return !query || `${site.name} ${site.region} ${site.type}`.toLowerCase().includes(query);
  });

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
              <form className="profile-trip-editor" onSubmit={saveTripEdit}>
                <div className="profile-trip-editor-heading">
                  <div><span>Pending trip</span><h3>Edit trip log</h3></div>
                  <button type="button" onClick={closeTripEdit}>Close</button>
                </div>
                <label>Search locations<input type="search" value={editSiteSearch} onChange={(event) => setEditSiteSearch(event.target.value)} placeholder="Pier, beach, city…" /></label>
                <label>Fishing location
                  <select value={editFields.siteId} onChange={(event) => setEditFields((current) => current ? { ...current, siteId: event.target.value } : current)} required>
                    {!filteredEditSites.some((site) => site.id === editFields.siteId) ? <option value={editFields.siteId}>{sites.find((site) => site.id === editFields.siteId)?.name ?? editFields.siteId}</option> : null}
                    {filteredEditSites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
                  </select>
                </label>
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
                <label>Notes<textarea rows={4} maxLength={1000} value={editFields.notes} onChange={(event) => setEditFields((current) => current ? { ...current, notes: event.target.value } : current)} /></label>
                <small>Your edits are saved in this browser as you type.</small>
                {profileActionError ? <p className="account-error" role="alert">{profileActionError}</p> : null}
                <button className="account-primary" type="submit" disabled={profileActionBusy}>{profileActionBusy ? "Saving…" : "Save trip changes"}</button>
              </form>
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
              <button className="account-primary" type="submit" disabled={busy}>{busy ? "Please wait…" : mode === "login" ? "Sign in" : mode === "signup" ? "Email verification code" : mode === "verify" ? "Verify and create account" : mode === "recover" ? "Email reset code" : "Set new password"}</button>
            </form>
            {mode === "login" ? <button className="account-text-button" type="button" onClick={() => { setMode("recover"); setError(""); }}>Forgot password?</button> : null}
            {mode === "recover" || mode === "verify" || mode === "reset" ? <button className="account-text-button" type="button" onClick={() => { setMode("login"); setError(""); setChallengeId(""); }}>Back to sign in</button> : null}
          </>
        )}
      </section>
    </div>
  );
}
