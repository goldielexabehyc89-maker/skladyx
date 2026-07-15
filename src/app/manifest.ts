import type { MetadataRoute } from "next";

// PWA-манифест: делает приложение устанавливаемым («На экран Домой»).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "SkladyX · Склад",
    short_name: "Склад",
    description: "Складской учёт",
    start_url: "/warehouse",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#eef0f8",
    theme_color: "#667eea",
    lang: "ru",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
