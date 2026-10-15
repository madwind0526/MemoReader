// Generates the PWA icons as PNG files without any image dependency.
// Run with: npm run icons
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
const TEAL = [0x1f, 0x6f, 0x68];
const WHITE = [0xff, 0xff, 0xff];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

function encodePng(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = pixel(x, y);
      raw.set([r, g, b, a], row + 1 + x * 4);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Coverage of the unit square by a shape, estimated with a 4x4 sample grid for smooth edges.
function coverage(inside, x, y, size) {
  let hits = 0;
  for (let sy = 0; sy < 4; sy += 1) {
    for (let sx = 0; sx < 4; sx += 1) {
      if (inside((x + (sx + 0.5) / 4) / size, (y + (sy + 0.5) / 4) / size)) hits += 1;
    }
  }
  return hits / 16;
}

function roundedSquare(radius) {
  return (u, v) => {
    const dx = Math.max(radius - u, 0, u - (1 - radius));
    const dy = Math.max(radius - v, 0, v - (1 - radius));
    return dx * dx + dy * dy <= radius * radius;
  };
}

// A bookmark ribbon with a V notch, scaled around the center.
function bookmark(scale) {
  return (u, v) => {
    const x = (u - 0.5) / scale;
    const y = (v - 0.5) / scale;
    if (x < -0.22 || x > 0.22 || y < -0.3 || y > 0.32) return false;
    return y <= 0.32 - (0.22 - Math.abs(x)) * 0 - (Math.abs(x) < 0.22 ? 0.2 * (1 - Math.abs(x) / 0.22) : 0);
  };
}

function icon(size, { maskable }) {
  const background = maskable ? () => true : roundedSquare(0.22);
  const mark = bookmark(maskable ? 1.0 : 1.25);
  return encodePng(size, (x, y) => {
    const bg = coverage(background, x, y, size);
    if (bg === 0) return [0, 0, 0, 0];
    const fg = coverage(mark, x, y, size);
    const mix = (channel) => Math.round(TEAL[channel] * (1 - fg) + WHITE[channel] * fg);
    return [mix(0), mix(1), mix(2), Math.round(bg * 255)];
  });
}

mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, "icon-192.png"), icon(192, { maskable: false }));
writeFileSync(path.join(OUT, "icon-512.png"), icon(512, { maskable: false }));
writeFileSync(path.join(OUT, "icon-maskable-512.png"), icon(512, { maskable: true }));
writeFileSync(path.join(OUT, "apple-touch-icon.png"), icon(180, { maskable: true }));
console.log(`Icons written to ${OUT}`);
