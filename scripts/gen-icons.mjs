// Генерация PNG-иконок PWA без внешних зависимостей (чистый zlib + PNG).
// Рисует оранжевый квадрат с белым «коробом» — простая узнаваемая иконка склада.
import zlib from "node:zlib";
import fs from "node:fs";

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256).map((_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c;
    });
  }
  let crc = -1;
  for (const b of buf) crc = (crc >>> 8) ^ table[(crc ^ b) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function png(size, draw) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = draw(x / size, y / size);
      const off = y * (size * 4 + 1) + 1 + x * 4;
      raw[off] = r;
      raw[off + 1] = g;
      raw[off + 2] = b;
      raw[off + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const ORANGE = [234, 88, 12, 255];
const WHITE = [255, 255, 255, 255];

// u,v в [0..1]. maskable: без скругления (система сама маскирует), обычная — со скруглением.
function drawIcon(rounded) {
  return (u, v) => {
    if (rounded) {
      // скругление углов радиусом 0.18
      const r = 0.18;
      const cx = Math.min(Math.max(u, r), 1 - r);
      const cy = Math.min(Math.max(v, r), 1 - r);
      if ((u - cx) ** 2 + (v - cy) ** 2 > r * r) return [0, 0, 0, 0];
    }
    // белый «короб»: контур квадрата 0.26..0.74 толщиной 0.055 + «скотч» по центру
    const inBox = u > 0.26 && u < 0.74 && v > 0.3 && v < 0.78;
    const t = 0.055;
    const border =
      inBox &&
      (u < 0.26 + t || u > 0.74 - t || v < 0.3 + t || v > 0.78 - t);
    const tape = inBox && Math.abs(u - 0.5) < t / 2;
    const lid = u > 0.22 && u < 0.78 && v > 0.2 && v < 0.3 && (Math.abs(v - 0.25) < t / 2 || u < 0.22 + t || u > 0.78 - t);
    return border || tape || lid ? WHITE : ORANGE;
  };
}

fs.writeFileSync("public/icon-192.png", png(192, drawIcon(true)));
fs.writeFileSync("public/icon-512.png", png(512, drawIcon(true)));
fs.writeFileSync("public/icon-512-maskable.png", png(512, drawIcon(false)));
fs.writeFileSync("public/apple-touch-icon.png", png(180, drawIcon(false)));
console.log("Иконки сгенерированы: icon-192, icon-512, icon-512-maskable, apple-touch-icon");
