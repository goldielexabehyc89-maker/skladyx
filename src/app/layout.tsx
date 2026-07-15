import type { Metadata, Viewport } from "next";
import { PwaRegister } from "@/components/pwa-register";
import { VersionWatcher } from "@/components/version-watcher";
import "./globals.css";

export const metadata: Metadata = {
  title: "SkladyX · Склад",
  description: "Складской учёт",
  icons: {
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#667eea",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>
        {children}
        <PwaRegister />
        <VersionWatcher />
      </body>
    </html>
  );
}
