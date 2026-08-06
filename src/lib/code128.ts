import "server-only";
import bwipjs from "bwip-js";

// Этап 5/Пакет 9A (коррекция перед prod): Code 128 через проверенную библиотеку bwip-js —
// без собственной таблицы паттернов/checksum/кодирования. Тонкий adapter: только вызовы библиотеки.
// Кодирует внутренний 10-символьный код ячейки; добавляет quiet zones и текстовое значение под кодом.

// Общие опции: набор Code 128, белый фон (нужен для устойчивого декодирования), горизонтальные и
// вертикальные quiet zones. HRI-текст самой библиотеки не включаем — код выводится текстом рядом на
// этикетке (и на странице печати, и в PDF), поэтому текстовое значение под штрихкодом присутствует.
function opts(text: string, extra: Record<string, unknown> = {}) {
  return { bcid: "code128", text, includetext: false, backgroundcolor: "FFFFFF", paddingwidth: 10, paddingheight: 8, height: 12, ...extra };
}

// SVG для экранной печати (масштабируется CSS-контейнером). Векторный, с quiet zones и текстом.
export function code128Svg(text: string): string {
  return bwipjs.toSVG(opts(text));
}

// PNG для серверного PDF-роута (embedPng). Масштаб подобран так, чтобы штрихкод уверенно считывался.
export async function code128Png(text: string, scale = 3): Promise<Buffer> {
  return bwipjs.toBuffer(opts(text, { scale }));
}
