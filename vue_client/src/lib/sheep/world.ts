// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The flock: owns every running Pet, is the PetHost they report to, and reads
// the page through a DOM-backed Stage. The sheep store wraps one of these;
// everything the overlay renders comes out of its callbacks. Framework-free
// so it can run under vitest with a fake stage.

import type { PetModel, PetChild } from './model.js';
import { Pet, type PetHost, type Rect, type Stage, type StageWindow } from './pet.js';

/**
 * The viewport as the screen, its bottom edge the floor. The page offers no
 * surfaces: the sheep walk the floor in front of all the chrome, so windows()
 * is always empty and the pet engine's window logic never engages.
 */
export class DomStage implements Stage {
  screen(): Rect {
    return { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
  }

  area(): Rect {
    return this.screen();
  }

  windows(): StageWindow[] {
    return [];
  }

  windowRect(_id: string): Rect | null {
    return null;
  }
}

export interface WorldOptions {
  /** Pixel scale for new pets. */
  scale: () => number;
  /** Whether to play the pets' sounds right now. */
  soundsEnabled: () => boolean;
  playSound: (file: string, loop: number) => void;
  /** A pet's view changed (position, frame, flip, opacity). */
  onView: (pet: Pet) => void;
  onClosed: (pet: Pet) => void;
  requestFrame?: (cb: (now: number) => void) => void;
  now?: () => number;
}

/** One line of the debug trace: what a pet did, and when. */
export interface TraceEntry {
  at: number;
  petId: number;
  event: string;
}

const TRACE_SIZE = 120;
/** No one pet may hold more of the trace than this: a busy sheep must not hide a quiet one's path. */
const TRACE_PER_PET = 15;

/** How often a pet was drawn over the last few seconds — a flicker is an abnormal rate. */
export interface DrawRate {
  /** Draws per second. */
  perSecond: number;
}

/** The window a draw rate is measured over. */
export const DRAW_WINDOW_MS = 5000;

export class SheepWorld implements PetHost {
  readonly pets = new Map<number, Pet>();
  /** The last few things any pet did, oldest first — for /sheep debug. */
  readonly traces: TraceEntry[] = [];
  private readonly draws = new Map<number, number[]>();

  constructor(
    readonly model: PetModel,
    readonly stage: Stage,
    private readonly opts: WorldOptions,
  ) {}

  /** Every top-level pet, including the ones fading out. */
  get topLevel(): Pet[] {
    return [...this.pets.values()].filter((p) => !p.isChild);
  }

  /** The flock the user sees as theirs: top-level pets not in their kill fade. */
  get flock(): Pet[] {
    return this.topLevel.filter((p) => !p.isDying);
  }

  spawn(): Pet {
    const pet = new Pet(this.model, this.stage, this, this.opts.scale());
    this.pets.set(pet.id, pet);
    pet.play();
    return pet;
  }

  setScale(scale: number): void {
    for (const p of this.pets.values()) p.setScale(scale);
  }

  pauseAll(): void {
    for (const p of this.topLevel) p.pause();
  }

  resumeAll(): void {
    for (const p of this.topLevel) p.resume();
  }

  /** The viewport changed: pull strays back in and let standing pets notice moved surfaces. */
  recoverLayout(): void {
    for (const p of this.pets.values()) p.recoverLayout();
  }

  petById(id: number): Pet | undefined {
    return this.pets.get(id);
  }

  // ---- PetHost ----

  render(pet: Pet): void {
    const now = this.now();
    let list = this.draws.get(pet.id);
    if (!list) this.draws.set(pet.id, (list = []));
    list.push(now);
    this.pruneDraws(list, now);
    this.opts.onView(pet);
  }

  private pruneDraws(list: number[], now: number): void {
    let drop = 0;
    while (drop < list.length && list[drop] < now - DRAW_WINDOW_MS) drop++;
    if (drop) list.splice(0, drop);
  }

  /** How often a pet was drawn over the last few seconds (less, for a younger pet). */
  drawRate(petId: number): DrawRate | null {
    const list = this.draws.get(petId);
    if (!list || list.length === 0) return null;
    const now = this.now();
    this.pruneDraws(list, now);
    if (list.length === 0) return null;
    const windowMs = Math.max(1000, Math.min(DRAW_WINDOW_MS, now - list[0]));
    return { perSecond: list.length / (windowMs / 1000) };
  }

  playSound(file: string, loop: number): void {
    if (this.opts.soundsEnabled()) this.opts.playSound(file, loop);
  }

  spawnChild(parent: Pet, child: PetChild): void {
    const pet = new Pet(this.model, this.stage, this, parent.scale, parent);
    this.pets.set(pet.id, pet);
    pet.playChild(child);
  }

  petClosed(pet: Pet): void {
    this.pets.delete(pet.id);
    this.draws.delete(pet.id);
    this.opts.onClosed(pet);
  }

  trace(pet: Pet, event: string): void {
    this.traces.push({ at: this.now(), petId: pet.id, event });
    let mine = 0;
    for (let i = this.traces.length - 1; i >= 0; i--) {
      if (this.traces[i].petId !== pet.id) continue;
      if (++mine > TRACE_PER_PET) {
        this.traces.splice(i, 1);
        break;
      }
    }
    if (this.traces.length > TRACE_SIZE) this.traces.splice(0, this.traces.length - TRACE_SIZE);
  }

  requestFrame(cb: (now: number) => void): void {
    if (this.opts.requestFrame) this.opts.requestFrame(cb);
    else requestAnimationFrame(cb);
  }

  now(): number {
    return this.opts.now ? this.opts.now() : performance.now();
  }
}
