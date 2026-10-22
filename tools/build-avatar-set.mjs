#!/usr/bin/env node
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Builds an avatar tile set (#607): the bundled one in vue_client/public/
// avatars/default, or any folder of square images into the layout the client
// and the apps read — `000.<ext>` … `NNN.<ext>` in file-name order, plus a
// manifest.json with the count.
//
//   node tools/build-avatar-set.mjs <input-dir> <out-dir>
//     Every image in <input-dir> (png, webp, jpg, gif, avif), sorted by name,
//     resized to 256×256 (cover) and written as WebP with alpha kept.
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
    'usage: build-avatar-set.mjs <input-dir> <out-dir>\n' +
      '       build-avatar-set.mjs --placeholder <out-dir> [count]',
  );
  process.exit(2);
}

async function writeTile(outDir, index, input) {
  const file = path.join(outDir, `${String(index).padStart(3, '0')}.${EXT}`);
  await sharp(input)
    .resize(SIZE, SIZE, { fit: 'cover' })
    .webp({ quality: 82, alphaQuality: 90 })
    .toFile(file);
  return file;
}

function writeManifest(outDir, count) {
  fs.writeFileSync(
    path.join(outDir, 'manifest.json'),
    JSON.stringify({ count, ext: EXT }, null, 2) + '\n',
  );
}

async function fromFolder(inputDir, outDir) {
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
    await writeTile(outDir, i, path.join(inputDir, name));
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
if (args[0] === '--placeholder') {
  if (!args[1]) usage();
  const count = Number(args[2] ?? 32);
  if (!Number.isInteger(count) || count < 1 || count > 999) usage();
  await placeholder(args[1], count);
} else if (args.length === 2) {
  await fromFolder(args[0], args[1]);
} else {
  usage();
}
