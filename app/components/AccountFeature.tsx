"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { CloseIcon } from "./icons";

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

export function AccountModal({ account }: { account: AccountController }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!account.modalOpen) return null;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
      });
      const body = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "The account request failed.");
      await account.refresh();
      account.closeAccount();
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "The account request failed.");
    } finally {
      setBusy(false);
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
            <h2 id="account-title">Saved water,<br />one place.</h2>
            <p className="account-email">Signed in as <strong>{account.user.email}</strong></p>
            <p>Your saved locations stay attached to this account. Trip reports are accepted only while you are signed in.</p>
            <button className="account-primary" type="button" onClick={() => void account.signOut()}>Sign out</button>
          </>
        ) : (
          <>
            <span className="eyebrow"><span /> CastCompass beta</span>
            <h2 id="account-title">{mode === "login" ? "Welcome back." : "Create an account."}</h2>
            <p>{account.modalMessage || "Save locations and contribute trip reports to improve the forecast."}</p>
            <div className="account-tabs" role="tablist" aria-label="Account action">
              <button type="button" className={mode === "login" ? "active" : ""} onClick={() => { setMode("login"); setError(""); }}>Sign in</button>
              <button type="button" className={mode === "signup" ? "active" : ""} onClick={() => { setMode("signup"); setError(""); }}>Create account</button>
            </div>
            <form onSubmit={submit}>
              <label>Email<input name="email" type="email" autoComplete="email" required maxLength={254} /></label>
              <label>Password<input name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={10} maxLength={128} /></label>
              {mode === "signup" ? <small>Use at least 10 characters. Password recovery and email verification are coming after the friends-and-family beta.</small> : null}
              {error ? <p className="account-error" role="alert">{error}</p> : null}
              <button className="account-primary" type="submit" disabled={busy}>{busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}</button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
