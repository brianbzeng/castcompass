"use client";

import { useEffect } from "react";

export function RegisterServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    // A newly installed worker should not reload a first-time visitor. When an
    // existing worker is replaced, reload once so every browser uses the new
    // app shell instead of keeping an older client open indefinitely.
    const hadController = navigator.serviceWorker.controller !== null;
    let hasReloaded = false;

    const handleControllerChange = () => {
      if (!hadController || hasReloaded) return;
      hasReloaded = true;
      window.location.reload();
    };

    navigator.serviceWorker.addEventListener("controllerchange", handleControllerChange);

    navigator.serviceWorker
      .register("/sw.js", { updateViaCache: "none" })
      .then((registration) => registration.update())
      .catch(() => {
        // The app remains usable online when registration or update checks fail.
      });

    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", handleControllerChange);
    };
  }, []);

  return null;
}
