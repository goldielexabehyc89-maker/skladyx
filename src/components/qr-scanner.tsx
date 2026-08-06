"use client";

import { useEffect, useRef, useState } from "react";
import { BarcodeDetector } from "barcode-detector/ponyfill";

// Камера + распознавание кодов. Ponyfill стандартного BarcodeDetector (zxing-wasm): работает и на
// iOS Safari, и на Android Chrome. Требует HTTPS (secure context). Компонент технически способен
// распознавать qr_code / code_128 / ean_8 / ean_13; конкретный набор задаётся пропом `formats`.
// По умолчанию — только QR (существующие потоки Пакетов 4–8 сканируют QR групп/заказов и не должны
// внезапно ловить EAN и мисроутить его). EAN-контексты (номенклатура) подключают форматы явно.

// Пакет 9A: форматы, которые сканер умеет распознавать.
export type ScanFormat = "qr_code" | "code_128" | "ean_8" | "ean_13";

export function QrScanner({
  onScan,
  paused = false,
  formats = ["qr_code"],
}: {
  onScan: (rawValue: string) => void;
  paused?: boolean;
  formats?: ScanFormat[];
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const pausedRef = useRef(paused);
  const onScanRef = useRef(onScan);
  const formatsRef = useRef(formats);
  pausedRef.current = paused;
  onScanRef.current = onScan;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let stream: MediaStream | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const lastSeen = { value: "", at: 0 };
    const detector = new BarcodeDetector({ formats: formatsRef.current });

    async function tick() {
      if (stopped) return;
      if (!pausedRef.current && video && video.readyState >= 2) {
        try {
          const codes = await detector.detect(video);
          if (codes.length > 0) {
            const raw = codes[0].rawValue;
            const now = Date.now();
            // дебаунс: тот же код не чаще раза в 2.5 секунды
            if (raw && (raw !== lastSeen.value || now - lastSeen.at > 2500)) {
              lastSeen.value = raw;
              lastSeen.at = now;
              try {
                navigator.vibrate?.(80);
              } catch {}
              onScanRef.current(raw);
            }
          }
        } catch {
          // кадр не распознался — продолжаем
        }
      }
      timer = setTimeout(tick, 180);
    }

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        video.srcObject = stream;
        await video.play();
        tick();
      } catch {
        setError(
          "Нет доступа к камере. Разрешите доступ в настройках браузера (камера работает только по HTTPS).",
        );
      }
    })();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className="relative overflow-hidden rounded-2xl bg-black">
      {error ? (
        <div className="flex aspect-[3/4] items-center justify-center p-6 text-center text-sm text-white">
          {error}
        </div>
      ) : (
        <>
          <video ref={videoRef} playsInline muted className="aspect-[3/4] w-full object-cover" />
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-56 w-56 rounded-2xl border-2 border-white/70" />
          </div>
        </>
      )}
    </div>
  );
}
