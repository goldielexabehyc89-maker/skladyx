// Задача Q (ITEM-EAN-001): сканируемые EAN-8/EAN-13 в карточке товара — round-trip генерация→декод.
// Движок напрямую (tsx), БД не нужна: проверяем сам кодировщик/валидатор. Программное декодирование PNG
// проверенной библиотекой ZXing (zxing-wasm) — недостаточно сравнивать текст EAN в HTML.
// Запуск: npx tsx --tsconfig scripts/tsconfig.verify.json scripts/verify-ean-barcode.ts
/* eslint-disable no-console */
import { readBarcodesFromImageFile } from "zxing-wasm/reader";
import { eanBarcodePng, eanBarcodeSvg, eanFileName, EanBarcodeError } from "@/lib/ean-barcode";
import { parseEan } from "@/lib/ean";

let failures = 0;
const ok = (n: string, c: boolean, e = "") => (c ? console.log(`  ✓ ${n}`) : (failures++, console.error(`  ✗ ${n} ${e}`)));

// контрольная цифра EAN из тела (7 или 12 цифр), mod-10 веса 3/1 справа налево
function eanCheck(body: string): string {
  let sum = 0;
  for (let i = body.length - 1, k = 0; i >= 0; i--, k++) sum += Number(body[i]) * (k % 2 === 0 ? 3 : 1);
  return String((10 - (sum % 10)) % 10);
}
const mkEan13 = (b12: string) => b12 + eanCheck(b12);
const mkEan8 = (b7: string) => b7 + eanCheck(b7);

// Декод PNG в исходную строку через ZXing. Возвращает распознанный текст (или "").
async function decode(png: Buffer): Promise<string> {
  const res = await readBarcodesFromImageFile(new Blob([new Uint8Array(png)]), {
    formats: ["EAN-13", "EAN-8"],
    tryHarder: true,
  } as never);
  return res[0]?.text ?? "";
}

async function main() {
  console.log("verify-ean-barcode — генерация EAN-8/EAN-13 (bwip-js) + round-trip декод (ZXing)");

  // 1) EAN-13 round-trip (реальный товарный код РостАгро)
  const e13 = "4607750000012";
  ok("EAN-13 валиден (parseEan)", parseEan(e13)?.symbology === "EAN13");
  const p13 = await eanBarcodePng(e13);
  ok("EAN-13 PNG непустой", p13.length > 0, `len=${p13.length}`);
  ok("EAN-13 декодируется обратно в исходное значение", (await decode(p13)) === e13);

  // 2) EAN-8 round-trip (реальный товарный код)
  const e8 = "46012340";
  ok("EAN-8 валиден (parseEan)", parseEan(e8)?.symbology === "EAN8");
  const p8 = await eanBarcodePng(e8);
  ok("EAN-8 PNG непустой", p8.length > 0, `len=${p8.length}`);
  ok("EAN-8 декодируется обратно в исходное значение", (await decode(p8)) === e8);

  // 3) ведущие нули не теряются (EAN-13 и EAN-8 с ведущими нулями)
  const z13 = mkEan13("000000000000"); // "0000000000000"
  const z8 = mkEan8("0000000"); // "00000000"
  ok("EAN-13 с ведущими нулями валиден и 13 знаков", parseEan(z13)?.code === z13 && z13.length === 13, z13);
  ok("EAN-13 с ведущими нулями декодируется без потери нулей", (await decode(await eanBarcodePng(z13))) === z13, z13);
  ok("EAN-8 с ведущими нулями декодируется без потери нулей", (await decode(await eanBarcodePng(z8))) === z8, z8);

  // 4) неверная контрольная цифра отклоняется (не генерируется)
  const bad13 = "4607750000019"; // верное тело, неверная контрольная цифра
  ok("parseEan отклоняет неверный checksum", parseEan(bad13) === null);
  let threw = false;
  try { await eanBarcodePng(bad13); } catch (e) { threw = e instanceof EanBarcodeError; }
  ok("eanBarcodePng отклоняет неверный EAN (EanBarcodeError)", threw);
  let threwSvg = false;
  try { eanBarcodeSvg("123"); } catch (e) { threwSvg = e instanceof EanBarcodeError; }
  ok("eanBarcodeSvg отклоняет неверную длину", threwSvg);

  // 5) SVG непустой и векторный; имя файла безопасно и сохраняет кириллицу
  const svg = eanBarcodeSvg(e13);
  ok("EAN-13 SVG непустой и содержит <svg>", svg.includes("<svg") && svg.length > 200, `len=${svg.length}`);
  ok("eanFileName: кириллица сохранена, пробелы → дефис", eanFileName("Сырок молочный", e13) === `Сырок-молочный-EAN-${e13}.png`, eanFileName("Сырок молочный", e13));

  console.log(failures === 0 ? "\nVERIFY-EAN-BARCODE OK ✓" : `\nПРОВАЛЕНО: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
