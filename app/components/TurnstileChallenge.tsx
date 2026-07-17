"use client";

import { useEffect, useRef, useState } from "react";

export type TurnstileAction =
  | "signup_eligibility"
  | "signup_request"
  | "signup_verify"
  | "challenge_resend"
  | "password_request"
  | "password_reset"
  | "login";

export type TurnstileChallengeState =
  | "loading"
  | "disabled"
  | "waiting"
  | "verified"
  | "unavailable";

interface TurnstileRuntimeConfig {
  enabled: boolean;
  siteKey?: string;
}

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: Record<string, unknown>,
  ): string;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let runtimeConfigPromise: Promise<TurnstileRuntimeConfig> | null = null;
let turnstileScriptPromise: Promise<void> | null = null;
const RUNTIME_CONFIG_TIMEOUT_MS = 5_000;

export function TurnstileChallenge({
  action,
  resetKey,
  onTokenChange,
  onStateChange,
}: {
  action: TurnstileAction;
  resetKey: number;
  onTokenChange(token: string): void;
  onStateChange(state: TurnstileChallengeState): void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [state, setState] = useState<TurnstileChallengeState>("loading");
  const [retryKey, setRetryKey] = useState(0);
  const accessibleLabel = action === "challenge_resend"
    ? "Resend security verification"
    : "Security verification";

  useEffect(() => {
    let cancelled = false;
    let renderedContainer: HTMLDivElement | null = null;

    const update = (nextState: TurnstileChallengeState, token = "") => {
      if (cancelled) return;
      setState(nextState);
      onStateChange(nextState);
      onTokenChange(token);
    };

    update("loading");
    const prepare = async () => {
      try {
        const config = await loadRuntimeConfig();
        if (cancelled) return;
        if (!config.enabled) {
          update("disabled");
          return;
        }

        await withTimeout(loadTurnstileScript(), 10_000);
        const container = containerRef.current;
        if (cancelled || !container || !window.turnstile) return;
        renderedContainer = container;
        update("waiting");
        widgetIdRef.current = window.turnstile.render(container, {
          sitekey: config.siteKey,
          action,
          appearance: "always",
          execution: "render",
          theme: "dark",
          size: window.matchMedia("(max-width: 400px)").matches ? "compact" : "flexible",
          language: "auto",
          tabindex: 0,
          "response-field": false,
          retry: "never",
          "refresh-expired": "auto",
          "refresh-timeout": "auto",
          "feedback-enabled": false,
          callback: (token: string) => update("verified", token),
          "expired-callback": () => update("waiting"),
          "timeout-callback": () => update("waiting"),
          "error-callback": () => update("unavailable"),
          "unsupported-callback": () => update("unavailable"),
        });
      } catch {
        resetStalledTurnstileScript();
        update("unavailable");
      }
    };
    void prepare();

    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
      }
      widgetIdRef.current = null;
      renderedContainer?.replaceChildren();
    };
  }, [action, onStateChange, onTokenChange, resetKey, retryKey]);

  if (state === "disabled") return null;

  return (
    <div className="turnstile-challenge" role="group" aria-label={accessibleLabel}>
      <div ref={containerRef} className="turnstile-widget" />
      {state === "loading" ? <p role="status">Loading security verification…</p> : null}
      {state === "waiting" ? <p role="status">Complete the security check to continue.</p> : null}
      {state === "verified" ? <p role="status">Security verification complete.</p> : null}
      {state === "unavailable" ? (
        <div className="turnstile-unavailable">
          <p role="alert">Security verification could not load. Account actions are paused until it is available; no account information was submitted.</p>
          <button type="button" onClick={() => setRetryKey((value) => value + 1)}>Retry security verification</button>
        </div>
      ) : null}
    </div>
  );
}

async function loadRuntimeConfig(): Promise<TurnstileRuntimeConfig> {
  // Share only a request that is currently in flight. A resolved value must not
  // survive a false→true rollout, emergency disable, or site-key rotation in an
  // already-open tab/PWA. Parent resets therefore always re-read runtime state.
  const pending = runtimeConfigPromise ??= (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RUNTIME_CONFIG_TIMEOUT_MS);
    try {
      const response = await fetch("/api/auth/turnstile-config", {
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null) as {
        turnstile?: { enabled?: unknown; available?: unknown; siteKey?: unknown };
      } | null;
      if (!body?.turnstile || typeof body.turnstile.enabled !== "boolean") {
        throw new Error("Turnstile runtime configuration is unavailable");
      }
      if (!body.turnstile.enabled && response.ok) return { enabled: false };
      if (!response.ok || body.turnstile.available !== true ||
        typeof body.turnstile.siteKey !== "string" || !body.turnstile.siteKey) {
        throw new Error("Turnstile runtime configuration is unavailable");
      }
      return { enabled: true, siteKey: body.turnstile.siteKey };
    } finally {
      clearTimeout(timeout);
    }
  })();
  try {
    return await pending;
  } finally {
    if (runtimeConfigPromise === pending) runtimeConfigPromise = null;
  }
}

function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (turnstileScriptPromise) return turnstileScriptPromise;

  const pending = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>("script[data-castingcompass-turnstile]");
    const script = existing ?? document.createElement("script");
    const loaded = () => window.turnstile ? resolve() : reject(new Error("Turnstile did not initialize"));
    const failed = () => {
      script.remove();
      reject(new Error("Turnstile script could not load"));
    };
    script.addEventListener("load", loaded, { once: true });
    script.addEventListener("error", failed, { once: true });
    if (!existing) {
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      script.dataset.castingcompassTurnstile = "true";
      document.head.append(script);
    }
  });
  turnstileScriptPromise = pending.catch((error) => {
    resetStalledTurnstileScript();
    throw error;
  });
  return turnstileScriptPromise;
}

function resetStalledTurnstileScript() {
  if (typeof window !== "undefined" && window.turnstile) return;
  if (typeof document !== "undefined") {
    document.querySelector<HTMLScriptElement>("script[data-castingcompass-turnstile]")?.remove();
  }
  turnstileScriptPromise = null;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Turnstile load timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
