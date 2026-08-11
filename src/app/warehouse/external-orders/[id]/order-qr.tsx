"use client";

import { useState } from "react";
import { Button } from "@/components/ui";

// ORDER-QR: изображение QR заказа + ручной код + действия «Открыть крупно» и «Скачать/распечатать».
// svg — для отображения (без <img>), png — data-URI для скачивания/печати. GET-страница QR не создаёт.
export function OrderQr({ svg, png, code, url }: { svg: string; png: string; code: string; url: string }) {
  const [big, setBig] = useState(false);
  return (
    <div className="flex flex-col items-start gap-2">
      <div className="rounded-xl border border-[#eee] bg-white p-2" style={{ width: 168, height: 168 }} dangerouslySetInnerHTML={{ __html: svg }} aria-label={`QR заказа ${code}`} />
      <div className="font-mono text-base font-semibold tracking-wider text-[#1a1a1a]">{code}</div>
      <div className="break-all text-xs text-neutral-400">{url}</div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="ghost" onClick={() => setBig(true)}>Открыть крупно</Button>
        <a href={png} download={`order-${code}.png`}>
          <Button type="button" variant="ghost">Скачать / распечатать</Button>
        </a>
      </div>
      {big && (
        <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-4 bg-black/70 p-6" role="dialog" onClick={() => setBig(false)}>
          <div className="rounded-2xl bg-white p-4" style={{ width: "min(80vw, 420px)", height: "min(80vw, 420px)" }} dangerouslySetInnerHTML={{ __html: svg }} />
          <div className="font-mono text-lg font-semibold tracking-wider text-white">{code}</div>
          <Button type="button" variant="primary" onClick={() => setBig(false)}>Закрыть</Button>
        </div>
      )}
    </div>
  );
}
