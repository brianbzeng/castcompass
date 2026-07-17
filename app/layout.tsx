import type { Metadata, Viewport } from "next";
import { RegisterServiceWorker } from "./register-service-worker";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://castingcompass.com"),
  title: {
    default: "CastingCompass",
    template: "%s · CastingCompass",
  },
  description:
    "An explainable California halibut opportunity planner for public shore, beach, jetty, and pier access around the San Francisco Bay Area.",
  applicationName: "CastingCompass",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "CastingCompass",
  },
  formatDetection: { telephone: false },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/icons/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    shortcut: "/icons/icon-192.png",
    apple: [{ url: "/icons/icon-192.png", type: "image/png", sizes: "192x192" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#061b2b",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        {children}
        <RegisterServiceWorker />
      </body>
    </html>
  );
}
