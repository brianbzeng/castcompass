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
  metadataBase: new URL("https://castcompass.brianbzeng.com"),
  title: {
    default: "CastCompass",
    template: "%s · CastCompass",
  },
  description:
    "An explainable California halibut opportunity planner for public shore, beach, jetty, and pier access around the San Francisco Bay Area.",
  applicationName: "CastCompass",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "CastCompass",
  },
  formatDetection: { telephone: false },
  icons: {
    icon: "/castcompass-icon.png",
    shortcut: "/castcompass-icon.png",
    apple: "/icons/icon-192.png",
  },
  openGraph: {
    title: "CastCompass",
    description:
      "Find the strongest upcoming California halibut opportunity windows around the Bay.",
    type: "website",
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
