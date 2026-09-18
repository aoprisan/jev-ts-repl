/**
 * The app icon: one SVG, and the PNGs a home screen asks for, rasterised here so the build needs
 * no image library. A rounded square in the accent blue with jev's prompt caret on it.
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../web/icons");

const BG = [11, 15, 20];
const TILE = [37, 99, 168];
const INK = [235, 241, 249];

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="jev">
  <rect width="512" height="512" rx="112" fill="#2563a8"/>
  <path d="M136 176 L208 256 L136 336" fill="none" stroke="#ebf1f9" stroke-width="40"
        stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M256 344 H392" fill="none" stroke="#ebf1f9" stroke-width="40" stroke-linecap="round"/>
</svg>
`;

/** A 32-bit PNG from raw RGBA rows, deflated — the format's minimum viable encoder. */
function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const chunk = (type, body) => {
    const out = Buffer.alloc(body.length + 12);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, "ascii");
    body.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Draw the same mark the SVG does, at `size`, with `inset` of padding for maskable icons. */
function draw(size, inset) {
  const rgba = Buffer.alloc(size * size * 4);
  const s = size - inset * 2;
  const radius = s * 0.22;
  const put = (x, y, [r, g, b]) => {
    const at = (y * size + x) * 4;
    rgba[at] = r;
    rgba[at + 1] = g;
    rgba[at + 2] = b;
    rgba[at + 3] = 255;
  };
  const inTile = (x, y) => {
    const dx = Math.max(inset + radius - x, 0, x - (inset + s - radius));
    const dy = Math.max(inset + radius - y, 0, y - (inset + s - radius));
    return (
      x >= inset &&
      x < inset + s &&
      y >= inset &&
      y < inset + s &&
      dx * dx + dy * dy <= radius * radius
    );
  };
  // The caret and the underscore, in the same proportions as the SVG (512-space, scaled).
  const k = s / 512;
  const near = (x, y, ax, ay, bx, by, width) => {
    const px = inset + ax * k;
    const py = inset + ay * k;
    const qx = inset + bx * k;
    const qy = inset + by * k;
    const vx = qx - px;
    const vy = qy - py;
    const len = vx * vx + vy * vy;
    const t = len === 0 ? 0 : Math.min(1, Math.max(0, ((x - px) * vx + (y - py) * vy) / len));
    const dx = x - (px + t * vx);
    const dy = y - (py + t * vy);
    return dx * dx + dy * dy <= ((width * k) / 2) ** 2;
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!inTile(x, y)) {
        put(x, y, BG);
        continue;
      }
      const ink =
        near(x, y, 136, 176, 208, 256, 40) ||
        near(x, y, 208, 256, 136, 336, 40) ||
        near(x, y, 256, 344, 392, 344, 40);
      put(x, y, ink ? INK : TILE);
    }
  }
  return rgba;
}

mkdirSync(OUT, { recursive: true });
writeFileSync(resolve(OUT, "icon.svg"), SVG);
writeFileSync(resolve(OUT, "icon-192.png"), png(192, 192, draw(192, 0)));
writeFileSync(resolve(OUT, "icon-512.png"), png(512, 512, draw(512, 0)));
writeFileSync(resolve(OUT, "icon-maskable-512.png"), png(512, 512, draw(512, 54)));
console.log(`icons written to ${OUT}`);
