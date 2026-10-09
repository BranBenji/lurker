// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Regenerates vue_client/public/sheep/ — the assets behind the undocumented
// /sheep command — from the gSheep pet files of Adriano Petrucci's desktopPet
// (the eSheep revival, https://github.com/Adrianotiger/desktopPet).
//
//   node tools/import-sheep.mjs <path/to/desktopPet/Pets>
//
// Each pet is one animations.xml with the sprite sheet, the sounds and the
// animation graph embedded as base64. The seven gSheep colors share one graph
// and one sound set — only the sprite sheet differs — so this emits:
//
//   sheep/gsheep.json       the animation graph (expressions kept verbatim,
//                           the client engine evaluates them)
//   sheep/<color>.png       one sprite sheet per color
//   sheep/sounds/<hash>.mp3 the sounds, deduplicated by content
//
// It refuses to run if the colors disagree on the graph, so a future pet
// update that forks them is noticed rather than silently flattened.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const COLORS = ['red', 'blue', 'green', 'orange', 'pink', 'purple', 'yellow'];

const petsDir = process.argv[2];
if (!petsDir) {
  console.error('usage: node tools/import-sheep.mjs <path/to/desktopPet/Pets>');
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'vue_client', 'public', 'sheep');

// ---- A small XML reader --------------------------------------------------
// The pet files are plain, well-formed XML (elements, attributes, text and
// CDATA; no processing beyond the prolog), so a tokenizer-level reader is
// enough and keeps this script dependency-free.

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

/** @returns {{name: string, attrs: Record<string,string>, text: string, children: any[]}} */
function parseXml(src) {
  const root = { name: '#root', attrs: {}, text: '', children: [] };
  const stack = [root];
  const re =
    /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=]+="[^"]*")*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) {
      top.text += m[1];
    } else if (m[2] !== undefined) {
      if (top.name !== m[2].replace(/^.*:/, '')) throw new Error(`mismatched </${m[2]}>`);
      stack.pop();
    } else if (m[3] !== undefined) {
      const attrs = {};
      for (const a of m[4].matchAll(/([^\s=]+)="([^"]*)"/g)) attrs[a[1]] = decodeEntities(a[2]);
      const node = { name: m[3].replace(/^.*:/, ''), attrs, text: '', children: [] };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] !== undefined) {
      top.text += decodeEntities(m[6]);
    }
  }
  if (stack.length !== 1) throw new Error('unclosed element');
  return root.children[0];
}

const child = (n, name) => n.children.find((c) => c.name === name);
const all = (n, name) => n.children.filter((c) => c.name === name);
const text = (n, name) => (child(n, name)?.text ?? '').trim();
const num = (s, def = 0) => {
  const v = Number(String(s ?? '').trim());
  return Number.isFinite(v) ? v : def;
};
const b64 = (s) => {
  let t = s.replace(/\s+/g, '');
  const i = t.indexOf(';base64,');
  if (i !== -1) t = t.slice(i + 8);
  return Buffer.from(t, 'base64');
};

// ---- Graph extraction (mirrors PetXML in the Mac port) -------------------

function parseNext(n) {
  // A missing probability is 0 in the original's deserializer, not 100.
  const next = { id: num(n.text, 1), probability: num(n.attrs.probability, 0) };
  if (n.attrs.only && n.attrs.only !== 'none') next.only = n.attrs.only;
  return next;
}

function parseMovement(n) {
  return {
    x: text(n, 'x') || '0',
    y: text(n, 'y') || '0',
    interval: text(n, 'interval') || '1000',
    offsetY: num(text(n, 'offsety')),
    opacity: num(text(n, 'opacity'), 1),
  };
}

function extractGraph(doc) {
  const header = child(doc, 'header');
  const animations = {};
  for (const n of all(child(doc, 'animations'), 'animation')) {
    const id = num(n.attrs.id);
    const seq = child(n, 'sequence');
    const a = {
      id,
      name: text(n, 'name') || String(id),
      start: parseMovement(child(n, 'start') ?? { children: [] }),
      end: parseMovement(child(n, 'end') ?? { children: [] }),
      sequence: {
        repeat: seq?.attrs.repeat ?? '0',
        repeatFrom: num(seq?.attrs.repeatfrom),
        frames: seq ? all(seq, 'frame').map((f) => num(f.text)) : [],
        action: seq ? text(seq, 'action') : '',
      },
      next: seq ? all(seq, 'next').map(parseNext) : [],
    };
    if (a.sequence.frames.length === 0) a.sequence.frames = [0];
    const border = child(n, 'border');
    if (border) a.border = all(border, 'next').map(parseNext);
    const gravity = child(n, 'gravity');
    if (gravity) a.gravity = all(gravity, 'next').map(parseNext);
    animations[id] = a;
  }

  const spawns = all(child(doc, 'spawns') ?? { children: [] }, 'spawn').map((n) => ({
    id: num(n.attrs.id),
    probability: num(n.attrs.probability, 0),
    x: text(n, 'x') || '0',
    y: text(n, 'y') || '0',
    next: num(text(n, 'next'), 1),
  }));

  const children = {};
  for (const n of all(child(doc, 'childs') ?? { children: [] }, 'child')) {
    const aid = num(n.attrs.animationid);
    (children[aid] ??= []).push({
      x: text(n, 'x') || '0',
      y: text(n, 'y') || '0',
      next: num(text(n, 'next'), 1),
    });
  }

  const sounds = [];
  for (const n of all(child(doc, 'sounds') ?? { children: [] }, 'sound')) {
    sounds.push({
      animationId: num(n.attrs.animationid),
      probability: num(text(n, 'probability'), 0),
      loop: num(text(n, 'loop'), 0),
      data: b64(text(n, 'base64')),
    });
  }

  const image = child(doc, 'image');
  const png = b64(text(image, 'png'));
  if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
    throw new Error('image is not a PNG');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const tilesX = Math.max(1, num(text(image, 'tilesx'), 1));
  const tilesY = Math.max(1, num(text(image, 'tilesy'), 1));

  return {
    header: {
      title: text(header, 'title'),
      petName: text(header, 'petname'),
      author: text(header, 'author'),
      version: text(header, 'version'),
    },
    sheet: { width, height, tilesX, tilesY, png },
    animations,
    spawns,
    children,
    sounds,
  };
}

// ---- Checks ----------------------------------------------------------------

/** Every id the graph points at must exist: the engine cannot play a missing animation. */
function checkReferences(g) {
  const missing = (id, from) => {
    if (!(id in g.animations)) throw new Error(`${from} points at missing animation ${id}`);
  };
  for (const a of Object.values(g.animations)) {
    for (const n of a.next) missing(n.id, `animation ${a.id} next`);
    for (const n of a.border ?? []) missing(n.id, `animation ${a.id} border`);
    for (const n of a.gravity ?? []) missing(n.id, `animation ${a.id} gravity`);
  }
  for (const s of g.spawns) missing(s.next, `spawn ${s.id}`);
  for (const [aid, list] of Object.entries(g.children)) {
    missing(Number(aid), 'child entry');
    for (const c of list) missing(c.next, `child of ${aid}`);
  }
}

// ---- Run -------------------------------------------------------------------

const pets = COLORS.map((color) => {
  const file = join(petsDir, `${color}_sheep`, 'animations.xml');
  const g = extractGraph(parseXml(readFileSync(file, 'utf8')));
  return { color, ...g };
});

// Everything except the sprite sheet and the pet's own name must agree.
const shared = (p) =>
  JSON.stringify({
    frame: [
      p.sheet.width / p.sheet.tilesX,
      p.sheet.height / p.sheet.tilesY,
      p.sheet.tilesX,
      p.sheet.tilesY,
    ],
    animations: p.animations,
    spawns: p.spawns,
    children: p.children,
    sounds: p.sounds.map((s) => [
      s.animationId,
      s.probability,
      createHash('sha1').update(s.data).digest('hex'),
    ]),
  });
for (const p of pets.slice(1)) {
  if (shared(p) !== shared(pets[0])) {
    throw new Error(
      `${p.color}_sheep differs from red_sheep beyond the sprite sheet — not flattening`,
    );
  }
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'sounds'), { recursive: true });

const base = pets[0];
checkReferences(base);
const soundFiles = {};
for (const s of base.sounds) {
  const hash = createHash('sha1').update(s.data).digest('hex').slice(0, 10);
  writeFileSync(join(OUT, 'sounds', `${hash}.mp3`), s.data);
  soundFiles[s.animationId] = {
    probability: s.probability,
    file: `${hash}.mp3`,
    ...(s.loop ? { loop: s.loop } : {}),
  };
}

const colors = {};
for (const p of pets) {
  writeFileSync(join(OUT, `${p.color}.png`), p.sheet.png);
  colors[p.color] = { petName: p.header.petName, title: p.header.title };
}

const graph = {
  author: base.header.author,
  version: base.header.version,
  frameWidth: base.sheet.width / base.sheet.tilesX,
  frameHeight: base.sheet.height / base.sheet.tilesY,
  tilesX: base.sheet.tilesX,
  tilesY: base.sheet.tilesY,
  colors,
  spawns: base.spawns,
  animations: base.animations,
  children: base.children,
  sounds: soundFiles,
};
writeFileSync(join(OUT, 'gsheep.json'), JSON.stringify(graph) + '\n');

writeFileSync(
  join(OUT, 'README.md'),
  `# gSheep assets

Generated by \`tools/import-sheep.mjs\` from the \`*_sheep\` pets of
[desktopPet](https://github.com/Adrianotiger/desktopPet) (Adriano Petrucci's
revival of the 1995 eSheep screen mate). They back the undocumented \`/sheep\`
command; nothing here loads until someone runs it.

- \`gsheep.json\` — the animation graph shared by every color (version
  ${base.header.version} of the gSheep pets by ${base.header.author})
- \`<color>.png\` — the sprite sheets (${base.sheet.tilesX}×${base.sheet.tilesY} tiles of ${graph.frameWidth}×${graph.frameHeight})
- \`sounds/\` — the pets' sounds, deduplicated by content

The pets are the work of ${base.header.author}; the eSheep sprites they build on
are Tatsutoshi Nomura's. The desktopPet application code is MIT-licensed. Do
not edit these files by hand — rerun the importer.
`,
);

console.log(
  `wrote ${pets.length} sheets, ${Object.keys(soundFiles).length} sound links (${new Set(Object.values(soundFiles).map((s) => s.file)).size} files), ` +
    `${Object.keys(graph.animations).length} animations, ${graph.spawns.length} spawns, ` +
    `${Object.values(graph.children).flat().length} child spawns → ${OUT}`,
);
