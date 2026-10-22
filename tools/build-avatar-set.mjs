#!/usr/bin/env node
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Builds an avatar tile set (#607): the bundled one in vue_client/public/
// avatars/default, or any folder of square images into the layout the client
// and the apps read — `000.<ext>` … `NNN.<ext>` in file-name order, plus a
// manifest.json with the count.
//
//   node tools/build-avatar-set.mjs <input-dir> <out-dir> [--key <hex>] [--fuzz <deg>]
//     Every image in <input-dir> (png, webp, jpg, gif, avif), sorted by name,
//     resized to 256×256 (cover) and written as WebP with alpha kept.
//     --key knocks one colour out to transparency by HUE, so every shade of
//     it goes (a generated red is never one value): a pixel within --fuzz
//     degrees of the key's hue (default 18) with enough saturation is cleared,
//     with a soft edge over the last third of that window. The nick colour
//     shows through where it was.
//     --key any clears every pixel that isn't black, white or grey — by
//     chroma, the distance from grey, so a pink fringe goes with the red it
//     came from. --chroma <0-255> (default 48) is where a pixel counts as
//     coloured; the fade runs from half of it.
//
//   node tools/build-avatar-set.mjs --placeholder <out-dir> [count]
//     A stand-in set of geometric compositions, until the real art lands.
//     Deterministic: the same count gives the same tiles.
//
// The real set is Brad's: Ealain-style squares with the colour keyed out, so
// the tile shows the nick colour through the transparent parts. Any set
// author owns contrast against the nick palette — nothing in the theme
// corrects it.

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const SIZE = 256;
const EXT = 'webp';
const IMAGE_RE = /\.(png|webp|jpe?g|gif|avif)$/i;

function usage() {
  console.error(
    'usage: build-avatar-set.mjs <input-dir> <out-dir> [--key <hex> [--fuzz <deg>]]\n' +
      '       build-avatar-set.mjs <input-dir> <out-dir> --key any [--chroma <0-255>]\n' +
      '       build-avatar-set.mjs --placeholder <out-dir> [count]',
  );
  process.exit(2);
}

async function writeTile(outDir, index, input, key = null) {
  const file = path.join(outDir, `${String(index).padStart(3, '0')}.${EXT}`);
  const source = key ? await keyOut(input, key) : sharp(input);
  await source
    .resize(SIZE, SIZE, { fit: 'cover' })
    .webp({ quality: 82, alphaQuality: 90 })
    .toFile(file);
  return file;
}

// `#rrggbb` → its hue in degrees, or null for a grey (no hue to key on).
function hueOf(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const [h] = rgbToHsv((n >> 16) & 255, (n >> 8) & 255, n & 255);
  return h;
}

function rgbToHsv(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

// The image with every pixel near the key's hue made transparent. Done at the
// source size, before the resize, so the edge is judged on real pixels.
async function keyOut(input, { hue, fuzz, chroma }) {
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const soft = fuzz / 3;
  for (let p = 0; p < data.length; p += 4) {
    if (chroma !== undefined) {
      // Any colour at all: how far from grey, in 0–255.
      const c =
        Math.max(data[p], data[p + 1], data[p + 2]) - Math.min(data[p], data[p + 1], data[p + 2]);
      const lo = chroma / 2;
      if (c <= lo) continue;
      const keep = c >= chroma ? 0 : 1 - (c - lo) / (chroma - lo);
      data[p + 3] = Math.round(data[p + 3] * keep);
      continue;
    }
    const [h, s, v] = rgbToHsv(data[p], data[p + 1], data[p + 2]);
    // Greys and near-blacks have no hue worth keying.
    if (s < 0.35 || v < 0.12) continue;
    const dist = Math.min(Math.abs(h - hue), 360 - Math.abs(h - hue));
    if (dist > fuzz) continue;
    // Fully clear inside the window, fading out over its last third.
    const keep = dist > fuzz - soft ? (dist - (fuzz - soft)) / soft : 0;
    data[p + 3] = Math.round(data[p + 3] * keep);
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } });
}

function writeManifest(outDir, count) {
  fs.writeFileSync(
    path.join(outDir, 'manifest.json'),
    JSON.stringify({ count, ext: EXT }, null, 2) + '\n',
  );
}

async function fromFolder(inputDir, outDir, key) {
  const names = fs
    .readdirSync(inputDir)
    .filter((n) => IMAGE_RE.test(n))
    .sort((a, b) => a.localeCompare(b, 'en'));
  if (names.length === 0) {
    console.error(`no images in ${inputDir}`);
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });
  let i = 0;
  for (const name of names) {
    await writeTile(outDir, i, path.join(inputDir, name), key);
    i++;
  }
  writeManifest(outDir, i);
  console.log(`${i} tiles → ${outDir}`);
}

// A small deterministic PRNG (mulberry32), so a rebuild gives the same tiles.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Black and off-white shapes on nothing: the nick colour shows through.
function placeholderSvg(index) {
  const rand = prng(1000 + index * 7919);
  const inks = ['#141414', '#f3efe6'];
  const shapes = [];
  const n = 3 + Math.floor(rand() * 4);
  for (let i = 0; i < n; i++) {
    const ink = inks[Math.floor(rand() * inks.length)];
    const kind = Math.floor(rand() * 4);
    const x = Math.floor(rand() * SIZE);
    const y = Math.floor(rand() * SIZE);
    const s = 40 + Math.floor(rand() * 140);
    switch (kind) {
      case 0:
        shapes.push(
          `<rect x="${x - s / 2}" y="${y - s / 2}" width="${s}" height="${s * (0.3 + rand() * 0.9)}" fill="${ink}" transform="rotate(${Math.floor(rand() * 4) * 15} ${x} ${y})"/>`,
        );
        break;
      case 1:
        shapes.push(`<circle cx="${x}" cy="${y}" r="${s / 2}" fill="${ink}"/>`);
        break;
      case 2:
        shapes.push(
          `<polygon points="${x},${y - s / 2} ${x + s / 2},${y + s / 2} ${x - s / 2},${y + s / 2}" fill="${ink}" transform="rotate(${Math.floor(rand() * 12) * 30} ${x} ${y})"/>`,
        );
        break;
      default:
        shapes.push(
          `<path d="M ${x} ${y} a ${s / 2} ${s / 2} 0 0 1 ${s} 0 z" fill="${ink}" transform="rotate(${Math.floor(rand() * 4) * 90} ${x} ${y})"/>`,
        );
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${shapes.join('')}</svg>`;
}

async function placeholder(outDir, count) {
  fs.mkdirSync(outDir, { recursive: true });
  for (let i = 0; i < count; i++) {
    await writeTile(outDir, i, Buffer.from(placeholderSvg(i)));
  }
  writeManifest(outDir, count);
  console.log(`${count} placeholder tiles → ${outDir}`);
}

const args = process.argv.slice(2);
const positional = [];
let keyHex = null;
let fuzz = 18;
let chroma = 48;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--key') keyHex = args[++i];
  else if (args[i] === '--fuzz') fuzz = Number(args[++i]);
  else if (args[i] === '--chroma') chroma = Number(args[++i]);
  else positional.push(args[i]);
}
if (positional[0] === '--placeholder') {
  if (!positional[1]) usage();
  const count = Number(positional[2] ?? 32);
  if (!Number.isInteger(count) || count < 1 || count > 999) usage();
  await placeholder(positional[1], count);
} else if (positional.length === 2) {
  let key = null;
  if (keyHex === 'any') {
    if (!Number.isFinite(chroma) || chroma <= 0 || chroma > 255) usage();
    key = { chroma };
  } else if (keyHex) {
    const hue = hueOf(keyHex);
    if (hue === null || !Number.isFinite(fuzz) || fuzz <= 0 || fuzz > 90) usage();
    key = { hue, fuzz };
  }
  await fromFolder(positional[0], positional[1], key);
} else {
  usage();
}
