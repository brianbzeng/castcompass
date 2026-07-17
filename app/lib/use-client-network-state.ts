"use client";

import { useEffect, useState } from "react";

export type ClientNetworkState = "unknown" | "online" | "offline" | "restored";

export function useClientNetworkState() {
  const [networkState, setNetworkState] = useState<ClientNetworkState>("unknown");

  useEffect(() => {
    const initialSyncFrame = window.requestAnimationFrame(() => {
      setNetworkState(window.navigator.onLine ? "online" : "offline");
    });
    const handleOffline = () => setNetworkState("offline");
    const handleOnline = () => setNetworkState((current) => current === "offline" ? "restored" : "online");
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    return () => {
      window.cancelAnimationFrame(initialSyncFrame);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, []);

  return networkState;
}
