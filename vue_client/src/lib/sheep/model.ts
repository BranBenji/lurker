// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The pet definition behind /sheep: the shape of public/sheep/gsheep.json (as
// tools/import-sheep.mjs writes it from a desktopPet animations.xml) and the
// compiled form the engine walks — expressions pre-classified, sequence
// lengths pre-computed, the special animations resolved by name. Mirrors
// PetModel.swift / Animations.cs; the selection rules are the originals'.

import {
  emptyContext,
  evaluate,
  isDynamic,
  isScreen,
  type ExpressionContext,
} from './expression.js';

// ---- gsheep.json ---------------------------------------------------------

export type PetOnly = 'taskbar' | 'window' | 'horizontal' | 'horizontal+' | 'vertical';

export interface PetNextSpec {
  id: number;
  probability: number;
  /** Where the pet must be for this choice to be eligible; absent = anywhere. */
  only?: PetOnly;
}

export interface PetMovementSpec {
  x: string;
  y: string;
  interval: string;
  offsetY: number;
  opacity: number;
}

export interface PetSequenceSpec {
  repeat: string;
  repeatFrom: number;
  frames: number[];
  action: string;
}

export interface PetAnimationSpec {
  id: number;
  name: string;
  start: PetMovementSpec;
  end: PetMovementSpec;
  sequence: PetSequenceSpec;
  next: PetNextSpec[];
  border?: PetNextSpec[];
  gravity?: PetNextSpec[];
}

export interface PetSpawnSpec {
  id: number;
  probability: number;
  x: string;
  y: string;
  next: number;
}

export interface PetChildSpec {
  x: string;
  y: string;
  next: number;
}

export interface PetSoundSpec {
  probability: number;
  file: string;
  /** Extra replays after the first (the XML's <loop>); 0 = play once. */
  loop?: number;
}

export interface PetGraph {
  author: string;
  version: string;
  frameWidth: number;
  frameHeight: number;
  tilesX: number;
  tilesY: number;
  colors: Record<string, { petName: string; title: string }>;
  spawns: PetSpawnSpec[];
  animations: Record<string, PetAnimationSpec>;
  children: Record<string, PetChildSpec[]>;
  sounds: Record<string, PetSoundSpec>;
}

// ---- Compiled model ------------------------------------------------------

/** A value that may be a constant or an expression (C# TValue). */
export class PetValue {
  readonly compute: string;
  readonly isDynamic: boolean;
  readonly isScreen: boolean;
  /** A plain integer literal: nothing to re-evaluate, ever. */
  readonly isConstant: boolean;
  /** Placed relative to the pet's own position (imageX / imageY). */
  readonly isRelative: boolean;
  value: number;

  constructor(text: string | undefined, ctx: ExpressionContext = emptyContext()) {
    const t = (text ?? '0').trim();
    this.compute = t || '0';
    this.isDynamic = isDynamic(this.compute);
    this.isScreen = isScreen(this.compute);
    this.isConstant = /^-?\d+$/.test(this.compute);
    this.isRelative = /image[XY]/.test(this.compute);
    this.value = evaluate(this.compute, ctx);
  }

  /**
   * Evaluates against `ctx` unless the text is a plain number. Spawn and
   * child positions are compiled before any screen exists, and an expression
   * like `0-imageW` depends on neither the screen nor anything "dynamic", so
   * a cached value would be the one from the empty context.
   */
  get(ctx: ExpressionContext): number {
    if (this.isConstant) return this.value;
    return evaluate(this.compute, ctx);
  }
}

export interface PetMovement {
  x: PetValue;
  y: PetValue;
  interval: PetValue;
  offsetY: number;
  opacity: number;
}

export interface PetSequence {
  repeatCount: PetValue;
  repeatFrom: number;
  frames: number[];
  totalSteps: number;
  action: string;
}

/** Place bits a `<next only="…">` is matched against (C# TOnly). */
export const PLACE = {
  taskbar: 0x01,
  window: 0x02,
  horizontal: 0x04,
  'horizontal+': 0x06,
  vertical: 0x08,
  anywhere: 0x7f,
} as const;
export type Place = (typeof PLACE)[keyof typeof PLACE];

export interface PetNext {
  id: number;
  probability: number;
  only: number;
}

export interface PetAnimation {
  id: number;
  name: string;
  start: PetMovement;
  end: PetMovement;
  sequence: PetSequence;
  endAnimation: PetNext[];
  endBorder: PetNext[];
  endGravity: PetNext[];
  hasGravity: boolean;
  hasBorder: boolean;
}

export interface PetSpawn {
  id: number;
  probability: number;
  x: PetValue;
  y: PetValue;
  next: number;
}

export interface PetChild {
  x: PetValue;
  y: PetValue;
  next: number;
}

function compileMovement(m: PetMovementSpec | undefined, ctx: ExpressionContext): PetMovement {
  return {
    x: new PetValue(m?.x, ctx),
    y: new PetValue(m?.y, ctx),
    interval: new PetValue(m?.interval ?? '1000', ctx),
    offsetY: m?.offsetY ?? 0,
    opacity: m?.opacity ?? 1,
  };
}

function compileNext(list: PetNextSpec[] | undefined): PetNext[] {
  // An unknown place name is "none" in the original (eligible everywhere).
  return (list ?? []).map((n) => ({
    id: n.id,
    probability: n.probability,
    only: n.only && n.only in PLACE ? PLACE[n.only] : PLACE.anywhere,
  }));
}

/**
 * A fresh, mutable copy of an animation for one pet: updateValues() rewrites
 * the cached values in place (the original mutates its TAnimation too).
 * `ctx` must carry the real screen and sprite sizes: the original parses
 * every value against them at load time and never re-evaluates a value that
 * depends only on the screen (`screenW/32` repeats, `-imageW*0.45` hops).
 */
export function compileAnimation(
  spec: PetAnimationSpec,
  ctx: ExpressionContext = emptyContext(),
): PetAnimation {
  const seq = spec.sequence;
  const frames = seq.frames.length ? [...seq.frames] : [0];
  const repeatCount = new PetValue(seq.repeat ?? '0', ctx);
  const n = frames.length;
  const rep = repeatCount.value;
  const totalSteps = Math.max(
    1,
    seq.repeatFrom > 0 ? n + (n - seq.repeatFrom - 1) * rep : n + n * rep,
  );
  return {
    id: spec.id,
    name: spec.name,
    start: compileMovement(spec.start, ctx),
    end: compileMovement(spec.end, ctx),
    sequence: {
      repeatCount,
      repeatFrom: seq.repeatFrom,
      frames,
      totalSteps,
      action: seq.action ?? '',
    },
    endAnimation: compileNext(spec.next),
    endBorder: compileNext(spec.border),
    endGravity: compileNext(spec.gravity),
    hasGravity: spec.gravity !== undefined,
    hasBorder: spec.border !== undefined,
  };
}

/** Port of TAnimation.UpdateValues(): re-evaluate dynamic values, apply the pixel scale. */
export function updateAnimationValues(a: PetAnimation, ctx: ExpressionContext): void {
  const seq = a.sequence;
  if (seq.repeatCount.isDynamic) {
    const n = seq.frames.length;
    seq.totalSteps = n + (n - seq.repeatFrom) * seq.repeatCount.get(ctx);
  }
  for (const m of [a.start, a.end]) {
    if (m.interval.isDynamic || m.x.isDynamic || m.y.isDynamic || m.x.isScreen || m.y.isScreen) {
      m.interval.value = m.interval.get(ctx);
      m.x.value = m.x.get(ctx);
      m.y.value = m.y.get(ctx);
    }
  }
  if (ctx.scale > 1) {
    const s = ctx.scale;
    a.start.x.value *= s;
    a.start.y.value *= s;
    a.end.x.value *= s;
    a.end.y.value *= s;
    a.start.offsetY *= s;
    a.end.offsetY *= s;
  }
}

/** The null animation the original hands out for an unknown id. */
export function nullAnimation(): PetAnimation {
  const a = compileAnimation({
    id: 0,
    name: 'NULL',
    start: { x: '0', y: '0', interval: '1000', offsetY: 0, opacity: 1 },
    end: { x: '0', y: '0', interval: '1000', offsetY: 0, opacity: 1 },
    sequence: { repeat: '0', repeatFrom: 0, frames: [0], action: '' },
    next: [],
  });
  return a;
}

/** The compiled pet definition: everything an engine instance reads but never writes. */
export class PetModel {
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly tilesX: number;
  readonly tilesY: number;
  readonly spawns: PetSpawn[];
  readonly children = new Map<number, PetChild[]>();
  readonly sounds = new Map<number, PetSoundSpec>();
  readonly firstAnimation: number;
  /**
   * `randS` in expressions: 10…89, drawn ONCE per pet definition and shared by
   * every pet running it, parents and children alike (C# Xml.iRandomSpawn).
   * The pets rely on that: gSheep's bath spawns the tub where a dive from the
   * randS-dependent spawn height will land. The Mac port drew one per window,
   * which is why its sheep missed the tub.
   */
  readonly randS: number;

  // Special animations, resolved by name like the original.
  animationDrag = 1;
  animationFall = 1;
  animationKill = -1;
  animationSync = 1;
  animationToss = -1;
  animationFallSoft = 1;
  animationFallHard = 1;

  private readonly specs = new Map<number, PetAnimationSpec>();

  constructor(
    readonly graph: PetGraph,
    /** Uniform random in [0, 1). */
    readonly rng: () => number = Math.random,
  ) {
    this.frameWidth = graph.frameWidth;
    this.frameHeight = graph.frameHeight;
    this.tilesX = graph.tilesX;
    this.tilesY = graph.tilesY;
    this.randS = this.randomInt(10, 89);
    const ctx = emptyContext();
    let first = -1;
    for (const spec of Object.values(graph.animations)) {
      if (first < 0) first = spec.id;
      this.specs.set(spec.id, spec);
      switch (spec.name) {
        case 'fall':
          this.animationFall = spec.id;
          break;
        case 'drag':
          this.animationDrag = spec.id;
          break;
        case 'kill':
          this.animationKill = spec.id;
          break;
        case 'sync':
          this.animationSync = spec.id;
          break;
        case 'toss':
          this.animationToss = spec.id;
          break;
        case 'fall soft':
          this.animationFallSoft = spec.id;
          break;
        case 'fall hard':
          this.animationFallHard = spec.id;
          break;
        default:
          break;
      }
    }
    this.firstAnimation = first < 0 ? 1 : first;
    this.spawns = graph.spawns.map((s) => ({
      id: s.id,
      probability: s.probability,
      x: new PetValue(s.x, ctx),
      y: new PetValue(s.y, ctx),
      next: s.next,
    }));
    for (const [aid, list] of Object.entries(graph.children)) {
      this.children.set(
        Number(aid),
        list.map((c) => ({ x: new PetValue(c.x, ctx), y: new PetValue(c.y, ctx), next: c.next })),
      );
    }
    for (const [aid, s] of Object.entries(graph.sounds)) this.sounds.set(Number(aid), s);
  }

  /** A fresh mutable animation for a pet to run (or the null animation), compiled against `ctx`. */
  animation(id: number, ctx: ExpressionContext = emptyContext()): PetAnimation {
    const spec = this.specs.get(id);
    return spec ? compileAnimation(spec, ctx) : nullAnimation();
  }

  has(id: number): boolean {
    return this.specs.has(id);
  }

  name(id: number): string {
    return this.specs.get(id)?.name ?? `#${id}`;
  }

  /** Integer in [lo, hi], like Int.random(in: lo...hi). */
  randomInt(lo: number, hi: number): number {
    return lo + Math.floor(this.rng() * (hi - lo + 1));
  }

  /** Weighted choice among the `<next>` entries eligible at `place` (C# SetNextGeneralAnimation). */
  pick(list: PetNext[], place: number): number {
    if (list.length === 0) return -1;
    let total = 0;
    for (const n of list) {
      if (n.only !== PLACE.anywhere && (n.only & place) === 0) continue;
      total += n.probability;
    }
    if (total <= 0) return -1;
    const r = this.randomInt(1, total);
    let sum = 0;
    for (const n of list) {
      if (n.only !== PLACE.anywhere && (n.only & place) === 0) continue;
      sum += n.probability;
      if (sum >= r) return n.id;
    }
    return -1;
  }

  randomSpawn(): PetSpawn {
    if (this.spawns.length === 0) {
      const ctx = emptyContext();
      return {
        id: 0,
        probability: 100,
        x: new PetValue('0', ctx),
        y: new PetValue('0', ctx),
        next: this.firstAnimation,
      };
    }
    const total = this.spawns.reduce((acc, s) => acc + s.probability, 0);
    const r = total > 0 ? this.randomInt(0, total - 1) : 0;
    let sum = 0;
    for (const s of this.spawns) {
      sum += s.probability;
      if (sum >= r) return s;
    }
    return this.spawns[0];
  }

  /** The sound to play when animation `id` starts, after its probability roll. */
  soundFor(id: number): PetSoundSpec | null {
    const snd = this.sounds.get(id);
    if (!snd) return null;
    return this.randomInt(0, 99) < snd.probability ? snd : null;
  }
}
