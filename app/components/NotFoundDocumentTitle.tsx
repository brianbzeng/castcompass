"use client";

import { useEffect } from "react";

const NOT_FOUND_TITLE = "Page not found · CastingCompass";

export function NotFoundDocumentTitle() {
  useEffect(() => {
    document.title = NOT_FOUND_TITLE;
  }, []);

  return null;
}
