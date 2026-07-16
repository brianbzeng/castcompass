import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Manrope } from "next/font/google";
import { RegisterServiceWorker } from "./register-service-worker";
import "./globals.css";

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://castingcompass.com"),
  title: {
    default: "CastingCompass",
    template: "%s · CastingCompass",
  },
  description:
    "An explainable California halibut opportunity planner for public shore, beach, jetty, and pier access around the San Francisco Bay Area.",
  alternates: { canonical: "https://castingcompass.com" },
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
      { url: "/castingcompass-icon.png", type: "image/png", sizes: "512x512" },
    ],
    shortcut: "/castingcompass-icon.png",
    apple: [{ url: "/icons/icon-192.png", type: "image/png", sizes: "192x192" }],
  },
  openGraph: {
    title: "CastingCompass",
    description:
      "Find the strongest upcoming California halibut opportunity windows around the Bay.",
    type: "website",
    url: "https://castingcompass.com",
    images: [{ url: "/og.png", width: 1200, height: 630 }],
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
      <body className={`${manrope.variable} ${plexMono.variable}`}>
        {children}
        <RegisterServiceWorker />
      </body>
    </html>
  );
}
