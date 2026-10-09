// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { emptyContext } from './expression.js';
import {
  compileAnimation,
  PetModel,
  PetValue,
  PLACE,
  updateAnimationValues,
  type PetAnimationSpec,
  type PetGraph,
} from './model.js';

/** mulberry32 — a deterministic stand-in for Math.random. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const spec = (over: Partial<PetAnimationSpec> & { id: number }): PetAnimationSpec => ({
  name: `a${over.id}`,
  start: { x: '0', y: '0', interval: '100', offsetY: 0, opacity: 1 },
  end: { x: '0', y: '0', interval: '100', offsetY: 0, opacity: 1 },
  sequence: { repeat: '0', repeatFrom: 0, frames: [0], action: '' },
  next: [],
  ...over,
});

const graph = (animations: PetAnimationSpec[], extra: Partial<PetGraph> = {}): PetGraph => ({
  author: 'test',
  version: '1',
  frameWidth: 40,
  frameHeight: 40,
  tilesX: 4,
  tilesY: 4,
  colors: {},
  spawns: [],
  animations: Object.fromEntries(animations.map((a) => [String(a.id), a])),
  children: {},
  sounds: {},
  ...extra,
});

const realGraph = (): PetGraph =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../../public/sheep/gsheep.json', import.meta.url)),
      'utf8',
    ),
  );

describe('compileAnimation', () => {
  it('computes the sequence length like the original (repeatfrom shortens the repeated span)', () => {
    const plain = compileAnimation(
      spec({ id: 1, sequence: { repeat: '3', repeatFrom: 0, frames: [0, 1], action: '' } }),
    );
    expect(plain.sequence.totalSteps).toBe(2 + 2 * 3);
    const from = compileAnimation(
      spec({ id: 2, sequence: { repeat: '3', repeatFrom: 1, frames: [0, 1, 2], action: '' } }),
    );
    expect(from.sequence.totalSteps).toBe(3 + (3 - 1 - 1) * 3);
    const empty = compileAnimation(
      spec({ id: 3, sequence: { repeat: '0', repeatFrom: 0, frames: [], action: '' } }),
    );
    expect(empty.sequence.frames).toEqual([0]);
    expect(empty.sequence.totalSteps).toBe(1);
  });

  it('re-evaluates a dynamic repeat and screen-dependent moves in updateAnimationValues', () => {
    const a = compileAnimation(
      spec({
        id: 1,
        start: { x: 'screenW/10', y: '0', interval: '100', offsetY: 2, opacity: 1 },
        sequence: { repeat: 'random/5', repeatFrom: 1, frames: [0, 1, 2], action: '' },
      }),
    );
    const ctx = { ...emptyContext(), screenW: 1000, random: 50, scale: 2 };
    updateAnimationValues(a, ctx);
    // Dynamic repeat uses the C# CalculateTotalSteps form: n + (n - repeatFrom) * rep.
    expect(a.sequence.totalSteps).toBe(3 + (3 - 1) * 10);
    // Screen-dependent x re-evaluated, then everything scaled.
    expect(a.start.x.value).toBe(100 * 2);
    expect(a.start.offsetY).toBe(4);
  });
});

describe('PetModel', () => {
  it('resolves the special animations by name and keeps the first as the default', () => {
    const m = new PetModel(
      graph([
        spec({ id: 7, name: 'walk' }),
        spec({ id: 8, name: 'drag' }),
        spec({ id: 9, name: 'fall' }),
        spec({ id: 10, name: 'kill' }),
        spec({ id: 11, name: 'fall soft' }),
        spec({ id: 12, name: 'fall hard' }),
        spec({ id: 13, name: 'toss' }),
        spec({ id: 14, name: 'sync' }),
      ]),
    );
    expect(m.firstAnimation).toBe(7);
    expect(m.animationDrag).toBe(8);
    expect(m.animationFall).toBe(9);
    expect(m.animationKill).toBe(10);
    expect(m.animationFallSoft).toBe(11);
    expect(m.animationFallHard).toBe(12);
    expect(m.animationToss).toBe(13);
    expect(m.animationSync).toBe(14);
    expect(m.animation(999).name).toBe('NULL');
    expect(m.has(999)).toBe(false);
  });

  it('pick honours the only= place of each choice and returns -1 when nothing is eligible', () => {
    const m = new PetModel(graph([spec({ id: 1 })]), seeded(1));
    const list = [
      { id: 10, probability: 50, only: PLACE.taskbar },
      { id: 20, probability: 50, only: PLACE.window },
      { id: 30, probability: 0, only: PLACE.anywhere },
    ];
    for (let i = 0; i < 20; i++) {
      expect(m.pick(list, PLACE.taskbar)).toBe(10);
      expect(m.pick(list, PLACE.window)).toBe(20);
    }
    expect(m.pick(list, PLACE.vertical)).toBe(-1);
    expect(m.pick([], PLACE.anywhere)).toBe(-1);
    // horizontal+ (0x06) is eligible from both window and horizontal.
    const plus = [{ id: 40, probability: 1, only: PLACE['horizontal+'] }];
    expect(m.pick(plus, PLACE.window)).toBe(40);
    expect(m.pick(plus, PLACE.horizontal)).toBe(40);
    expect(m.pick(plus, PLACE.taskbar)).toBe(-1);
  });

  it('pick is weighted by probability', () => {
    const m = new PetModel(graph([spec({ id: 1 })]), seeded(7));
    const list = [
      { id: 1, probability: 90, only: PLACE.anywhere },
      { id: 2, probability: 10, only: PLACE.anywhere },
    ];
    let ones = 0;
    for (let i = 0; i < 1000; i++) if (m.pick(list, PLACE.anywhere) === 1) ones++;
    expect(ones).toBeGreaterThan(850);
    expect(ones).toBeLessThan(950);
  });

  it('soundFor rolls the sound probability', () => {
    const m = new PetModel(
      graph([spec({ id: 1 })], {
        sounds: {
          '1': { probability: 100, file: 'a.mp3' },
          '2': { probability: 0, file: 'b.mp3' },
        },
      }),
      seeded(3),
    );
    expect(m.soundFor(1)).toMatchObject({ file: 'a.mp3' });
    expect(m.soundFor(2)).toBeNull();
    expect(m.soundFor(3)).toBeNull();
  });

  it('loads the shipped gSheep graph', () => {
    const m = new PetModel(realGraph());
    expect(m.frameWidth).toBe(40);
    expect(m.frameHeight).toBe(40);
    expect(m.tilesX * m.tilesY).toBe(16 * 19);
    expect(Object.keys(m.graph.colors).toSorted()).toEqual([
      'blue',
      'green',
      'orange',
      'pink',
      'purple',
      'red',
      'yellow',
    ]);
    expect(m.spawns).toHaveLength(11);
    expect(m.sounds.size).toBe(35);
    expect([...m.children.values()].flat()).toHaveLength(31);
    expect(m.name(m.animationDrag)).toBe('drag');
    expect(m.name(m.animationFall)).toBe('fall');
    expect(m.name(m.animationKill)).toBe('kill');
    expect(m.name(m.animationFallSoft)).toBe('fall soft');
    expect(m.name(m.animationFallHard)).toBe('fall hard');
    expect(m.name(m.animationSync)).toBe('sync');
    // Every edge points at an animation that exists, and every frame at a tile.
    const tiles = m.tilesX * m.tilesY;
    for (const a of Object.values(m.graph.animations)) {
      for (const n of [...a.next, ...(a.border ?? []), ...(a.gravity ?? [])]) {
        expect(m.has(n.id), `animation ${a.id} → ${n.id}`).toBe(true);
      }
      for (const f of a.sequence.frames) expect(f).toBeLessThan(tiles);
    }
    for (const s of m.spawns) expect(m.has(s.next)).toBe(true);
    for (const list of m.children.values()) for (const c of list) expect(m.has(c.next)).toBe(true);
  });
});

describe('PetValue', () => {
  it('re-evaluates anything but a plain number against the context it is asked with', () => {
    const ctx = { ...emptyContext(), imageW: 40, screenW: 800 };
    // Spawn and child positions are compiled before any screen exists.
    expect(new PetValue('0-imageW').get(ctx)).toBe(-40);
    expect(new PetValue('screenW+10').get(ctx)).toBe(810);
    expect(new PetValue('-2').get(ctx)).toBe(-2);
    expect(new PetValue('-2').isConstant).toBe(true);
    expect(new PetValue('0-imageW').isConstant).toBe(false);
  });
});
