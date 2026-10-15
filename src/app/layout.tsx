import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import "./globals.css";

export const metadata: Metadata = {
  title: "SE7ENX Smart Light Experience",
  description:
    "Control a real KNX light with hand gestures, voice and manual controls — or try it instantly in simulation. Camera processing stays on your device.",
  applicationName: "SE7ENX Smart Light",
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#050608",
  width: "device-width",
  initialScale: 1,
  colorScheme: "dark",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable} dark`}>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
