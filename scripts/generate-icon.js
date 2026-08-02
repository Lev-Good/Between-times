'use strict';
/**
 * מחולל אייקון טהור ב-Node (ללא תלות חיצונית).
 * מצייר מגן/מנעול על רקע מעוגל, ומפיק PNG + ICO (עם PNG מוטבע).
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

/* ---------- PNG encoder ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const si = (y * width + x) * 4;
      const di = y * (width * 4 + 1) + 1 + x * 4;
      raw[di] = rgba[si];
      raw[di + 1] = rgba[si + 1];
      raw[di + 2] = rgba[si + 2];
      raw[di + 3] = rgba[si + 3];
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------- ICO encoder (PNG entries) ---------- */
function encodeICO(pngs /* [{size, png}] */) {
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);   // type icon
  header.writeUInt16LE(count, 4);

  let offset = 6 + count * 16;
  const entries = [];
  const blobs = [];
  for (const { size, png } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4);   // planes
    e.writeUInt16LE(32, 6);  // bit count
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    blobs.push(png);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...blobs]);
}

/* ---------- ציור ---------- */
function makeIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 4; // supersampling

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  // צורה: ריבוע מעוגל
  function inRoundRect(px, py, x0, y0, x1, y1, r) {
    const cx = clamp(px, x0 + r, x1 - r);
    const cy = clamp(py, y0 + r, y1 - r);
    const dx = px - cx, dy = py - cy;
    return dx * dx + dy * dy <= r * r;
  }

  // מנעול: גוף + קשת + חור מפתח
  function lockColor(px, py) {
    // קואורדינטות ב-256
    const bx0 = 56, by0 = 116, bx1 = 200, by1 = 214; // גוף
    const s0 = 88, s1 = 168, sy0 = 56, sy1 = 132;     // קשת (ריבוע עם חור)
    const body = inRoundRect(px, py, bx0, by0, bx1, by1, 18);
    const shackle = inRoundRect(px, py, s0, sy0, s1, sy1, 22) && !inRoundRect(px, py, s0 + 16, sy0 + 16, s1 - 16, sy1 + 34, 12);
    const keyX = 128, keyY = 160;
    const keyHole = (px - keyX) * (px - keyX) + (py - keyY) * (py - keyY) <= 11 * 11;

    if (shackle) return [168, 178, 255, 255];        // קשת כחולה בהירה
    if (body && !keyHole) return [108, 108, 255, 255]; // גוף
    if (body && keyHole) return [13, 13, 24, 255];     // חור מפתח
    return null;
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = ((x + (sx + 0.5) / SS) / size) * 256;
          const py = ((y + (sy + 0.5) / SS) / size) * 256;

          let col = null;
          if (inRoundRect(px, py, 2, 2, 254, 254, 52)) {
            // רקע: גרדיאנט סגול-כהה
            const t = py / 256;
            col = [lerp(30, 16, t), lerp(26, 16, t), lerp(60, 42, t), 255];
          }
          const lc = lockColor(px, py);
          if (lc) col = lc;

          if (col) { r += col[0]; g += col[1]; b += col[2]; a += col[3]; }
          else a += 0;
        }
      }
      const n = SS * SS;
      const si = (y * size + x) * 4;
      rgba[si] = Math.round(r / n);
      rgba[si + 1] = Math.round(g / n);
      rgba[si + 2] = Math.round(b / n);
      rgba[si + 3] = Math.round(a / n);
    }
  }
  return rgba;
}

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });

const png256 = encodePNG(256, 256, makeIcon(256));
fs.writeFileSync(path.join(outDir, 'icon.png'), png256);

const icoSizes = [256, 64, 48, 32, 16];
const ico = encodeICO(icoSizes.map((s) => ({ size: s, png: encodePNG(s, s, makeIcon(s)) })));
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);

console.log('✓ assets/icon.png (256x256)');
console.log('✓ assets/icon.ico (' + icoSizes.join(',') + 'px)');
