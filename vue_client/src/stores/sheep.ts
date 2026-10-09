// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import {
  SHEEP_COLORS,
  isSheepScale,
  type SheepColor,
  type SheepScale,
} from '../lib/sheep/colors.js';
import {
  describeSheep,
  formatFlock,
  newFlockId,
  parseFlock,
  type FlockEntry,
} from '../lib/sheep/flock.js';
import { PetModel, type PetGraph } from '../lib/sheep/model.js';
import type { Pet, PetView } from '../lib/sheep/pet.js';
import { DomStage, SheepWorld } from '../lib/sheep/world.js';
import { useSettingsStore } from './settings.js';

// The flock behind the undocumented /sheep command — a port of the 1995
// eSheep screen mate, running the gSheep pets from desktopPet (see
// public/sheep/README.md). The flock is a synced setting (`sheep.flock`, one
// "<id>:<color>" entry per sheep) so the same sheep walk every desktop
// client: every write goes through the settings store and every client,
// this one included, reconciles its running pets to the list when it
// changes. Nothing loads until there is a sheep to show: the graph, sprite
// sheets and sounds all sit in public/sheep/.

const GRAPH_URL = '/sheep/gsheep.json';
const VOLUME = 0.5;
const FLOCK_KEY = 'sheep.flock';
const SOUNDS_KEY = 'sheep.sounds';
const SCALE_KEY = 'sheep.scale';

/** What the overlay draws: the pet's view plus what it needs to pick a sprite sheet. */
export interface SheepSprite extends PetView {
  id: number;
  /** The flock entry this sheep (or its parent) belongs to. */
  key: string;
  color: SheepColor;
  name: string;
  isChild: boolean;
}

function playSoundFile(file: string, loop: number): void {
  try {
    const el = new Audio(`/sheep/sounds/${file}`);
    el.volume = VOLUME;
    let replays = Math.max(0, loop);
    el.addEventListener('ended', () => {
      if (replays-- > 0) void el.play().catch(() => {});
    });
    void el.play().catch(() => {});
  } catch {
    // no Audio (tests, odd embeds)
  }
}

// The world holds timers and pets; it is deliberately outside the reactive
// state (the overlay reads the `sprites` snapshots instead).
let world: SheepWorld | null = null;
let loading: Promise<SheepWorld> | null = null;
let listening = false;
/** Running top-level pets by flock entry id. */
const petByKey = new Map<string, Pet>();
/**
 * Flock writes are read-modify-write against a settings store that is not
 * optimistic, so two overlapping writes would each start from the same stale
 * list and the later one would drop the earlier. They queue up instead, each
 * reading the flock afresh when its turn comes.
 */
let writes: Promise<unknown> = Promise.resolve();
/** Each running pet's entry as last seen in the flock — a shooed sheep keeps its color through its fade. */
const entryByPet = new Map<number, FlockEntry>();
/** Bumped by reset(): a flock write queued under an earlier session must not run. */
let generation = 0;
/** The phone layout has no room for a flock: nothing runs while parked. */
let parked = false;

/** Close every running pet and forget which flock entries they were. */
function closeFlock(): void {
  for (const p of world?.pets.values() ?? []) p.close();
  petByKey.clear();
  entryByPet.clear();
}

// A hot reload of this module (dev server) would otherwise leave the old
// world's pets running on their timers, drawing into the new sprites — and
// Pinia keeps the store instance, so the entries must go too or a reconcile
// would find its closed pets and spawn nothing.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    closeFlock();
    world = null;
    loading = null;
  });
}

export function resetSheepWorldForTests(): void {
  world = null;
  loading = null;
  listening = false;
  generation = 0;
  parked = false;
  petByKey.clear();
  entryByPet.clear();
  writes = Promise.resolve();
}

export const useSheepStore = defineStore('sheep', {
  state: () => ({
    /** The sprite sheet's geometry, once the pet file has loaded. The graph itself stays with the engine. */
    frame: null as { w: number; h: number; tilesX: number; tilesY: number } | null,
    /** The pet file's name for each color (Rick is the red sheep), once it has loaded. */
    petNames: {} as Record<string, string>,
    sprites: {} as Record<number, SheepSprite>,
  }),
  getters: {
    /** The flock as the synced setting has it. */
    flock(): FlockEntry[] {
      return parseFlock(useSettingsStore().effective(FLOCK_KEY));
    },
    sounds(): boolean {
      return useSettingsStore().effective(SOUNDS_KEY) === true;
    },
    scale(): SheepScale {
      const n = Number(useSettingsStore().effective(SCALE_KEY));
      return isSheepScale(n) ? n : 1;
    },
    frameWidth: (state) => state.frame?.w ?? 40,
    frameHeight: (state) => state.frame?.h ?? 40,
    tilesX: (state) => state.frame?.tilesX ?? 16,
    tilesY: (state) => state.frame?.tilesY ?? 19,
    colors: () => SHEEP_COLORS,
    /** How a sheep is referred to: its pet name, or "the blue sheep" before the pet file loads. */
    describe:
      (state) =>
      (e: FlockEntry): string =>
        describeSheep({ color: e.color, name: state.petNames[e.color] ?? '' }),
  },
  actions: {
    async ensureWorld(): Promise<SheepWorld> {
      if (world) return world;
      if (!loading) {
        loading = (async () => {
          const res = await fetch(GRAPH_URL);
          if (!res.ok) throw new Error(`the sheep didn't load (${res.status})`);
          const graph = (await res.json()) as PetGraph;
          this.frame = {
            w: graph.frameWidth,
            h: graph.frameHeight,
            tilesX: graph.tilesX,
            tilesY: graph.tilesY,
          };
          this.petNames = Object.fromEntries(
            Object.entries(graph.colors).map(([color, c]) => [color, c.petName]),
          );
          const w = new SheepWorld(new PetModel(graph), new DomStage(), {
            scale: () => this.scale,
            soundsEnabled: () => this.sounds,
            playSound: playSoundFile,
            onView: (pet) => this.publish(pet),
            onClosed: (pet) => this.retire(pet),
          });
          world = w;
          this.listen();
          return w;
        })().catch((err) => {
          loading = null;
          throw err;
        });
      }
      return loading;
    },

    /**
     * Make the running pets match the flock setting: spawn the sheep we don't
     * have, shoo the ones no longer listed, recolor the rest. Runs on every
     * change of the setting, from this client's own writes and from others'.
     */
    async reconcile(): Promise<void> {
      if (parked) return;
      if (this.flock.length === 0 && !world) return; // nothing to show: don't load the assets
      const w = await this.ensureWorld();
      // Read the flock after the await: it may have changed while the pet
      // file loaded, and a reconcile queued behind this one sees the same list.
      if (parked) return;
      const entries = this.flock;
      const wanted = new Set(entries.map((e) => e.id));
      for (const [key, pet] of petByKey) {
        if (wanted.has(key)) continue;
        petByKey.delete(key);
        pet.kill();
      }
      for (const entry of entries) {
        let pet = petByKey.get(entry.id);
        if (!pet) {
          pet = w.spawn();
          petByKey.set(entry.id, pet);
        }
        entryByPet.set(pet.id, entry);
      }
      // Colors live on the entries, so a recolor is just a republish.
      for (const pet of w.pets.values()) if (!pet.isClosed) this.publish(pet);
    },

    /** The flock entry a pet (or its parent) belongs to — or belonged to, while it fades out. */
    entryOf(pet: Pet): FlockEntry | undefined {
      return entryByPet.get(pet.root.id);
    },

    publish(pet: Pet): void {
      const entry = this.entryOf(pet);
      // A pet spawns (and draws) before reconcile records its entry; the
      // republish right after shows it. Nothing draws as a nameless red sheep.
      if (!entry) return;
      this.sprites[pet.id] = {
        id: pet.id,
        key: entry.id,
        color: entry.color,
        name: this.petNames[entry.color] ?? '',
        isChild: pet.isChild,
        ...pet.view,
      };
    },

    retire(pet: Pet): void {
      delete this.sprites[pet.id];
      entryByPet.delete(pet.id);
    },

    /** Close every running pet; the flock setting is untouched. */
    closeAll(): void {
      closeFlock();
      this.sprites = {};
    },

    /**
     * The phone layout has no room for sheep (and a sprite would take the
     * touches): park the flock there, and let it back out on a desktop
     * layout — the overlay reconciles when the switch flips.
     */
    park(on: boolean): void {
      parked = on;
      if (on) this.closeAll();
    },

    /**
     * The session ended (sign-out, invite redemption): the flock is the
     * account's, so it leaves with it instead of walking the login page. The
     * next account's flock spawns when its settings load.
     */
    reset(): void {
      generation++;
      this.closeAll();
      writes = Promise.resolve();
    },

    /**
     * Change the flock: `change` gets the current list when its turn in the
     * write queue comes and returns the new one (or null for no change).
     */
    async changeFlock<T>(
      change: (flock: FlockEntry[]) => { next: FlockEntry[] | null; result: T },
    ): Promise<T> {
      const gen = generation;
      const run = async () => {
        if (gen !== generation) throw new Error('signed out');
        const { next, result } = change(this.flock);
        if (next) await useSettingsStore().setValue(FLOCK_KEY, formatFlock(next));
        return result;
      };
      const turn = writes.then(run, run);
      writes = turn.catch(() => {});
      return turn;
    },

    /** One more sheep. Resolves to the newcomer. */
    async spawn(color: SheepColor | 'random'): Promise<FlockEntry> {
      // The pet file first: if it can't load, say so instead of writing a
      // sheep into the flock that nothing can show.
      const gen = generation;
      await this.ensureWorld();
      if (gen !== generation) throw new Error('signed out');
      const chosen =
        color === 'random' ? SHEEP_COLORS[Math.floor(Math.random() * SHEEP_COLORS.length)] : color;
      const entry = { id: newFlockId(), color: chosen };
      return this.changeFlock((flock) => ({ next: [...flock, entry], result: entry }));
    },

    /** Shoo one sheep. Resolves to its entry, or null if it was already gone. */
    shoo(id: string): Promise<FlockEntry | null> {
      return this.changeFlock((flock) => {
        const entry = flock.find((e) => e.id === id) ?? null;
        return { next: entry ? flock.filter((e) => e.id !== id) : null, result: entry };
      });
    },

    /** Shoo the newest sheep. */
    shooLast(): Promise<FlockEntry | null> {
      return this.changeFlock((flock) => {
        const last = flock[flock.length - 1] ?? null;
        return { next: last ? flock.slice(0, -1) : null, result: last };
      });
    },

    /** Shoo every sheep. Resolves to how many there were. */
    shooAll(): Promise<number> {
      return this.changeFlock((flock) => ({
        next: flock.length ? [] : null,
        result: flock.length,
      }));
    },

    recolor(id: string, color: SheepColor): Promise<void> {
      return this.changeFlock((flock) => ({
        // A sheep already shooed elsewhere (still fading here) is no write.
        next: flock.some((e) => e.id === id)
          ? flock.map((e) => (e.id === id ? { ...e, color } : e))
          : null,
        result: undefined,
      }));
    },

    async setSounds(on: boolean): Promise<void> {
      await useSettingsStore().setValue(SOUNDS_KEY, on);
    },

    async setScale(scale: SheepScale): Promise<void> {
      await useSettingsStore().setValue(SCALE_KEY, scale);
    },

    /**
     * What every running pet is doing right now, then the last few things any
     * of them did — for /sheep debug, so a glitch can be reported after the
     * fact instead of caught in the act.
     */
    status(): string[] {
      if (!world) return [];
      const w = world;
      const who = new Map<number, string>();
      const lines: string[] = [];
      const drawn = (id: number): string => {
        const r = w.drawRate(id);
        if (!r) return '';
        return ` · drawn ${r.perSecond.toFixed(1)}/s`;
      };
      for (const pet of w.pets.values()) {
        const entry = this.entryOf(pet);
        const name = entry ? this.describe(entry) : '?';
        const label = pet.isChild ? `child of ${name}` : name;
        who.set(pet.id, label);
        const a = pet.currentAnimation;
        const p = pet.position;
        lines.push(
          `${pet.isChild ? '  ' : ''}${label} (${entry?.color ?? '?'}) #${pet.id}: #${a.id} ${a.name} at ${Math.round(p.x)},${Math.round(p.y)}` +
            `${pet.movingLeft ? ' ←' : ' →'}${pet.isPaused ? ' paused' : ''}${pet.isDying ? ' fading' : ''}` +
            drawn(pet.id),
        );
      }
      // A sprite with no pet behind it is a ghost: something else is drawing it.
      const ghosts = Object.keys(this.sprites).filter((id) => !w.pets.has(Number(id)));
      if (ghosts.length) lines.push(`ghost sprites: #${ghosts.join(', #')}`);
      if (w.traces.length) {
        const now = w.now();
        lines.push('recently:');
        for (const t of w.traces) {
          const ago = ((now - t.at) / 1000).toFixed(1);
          lines.push(`  -${ago}s ${who.get(t.petId) ?? `#${t.petId}`}: ${t.event}`);
        }
      }
      return lines;
    },

    /** The scale setting changed (here or elsewhere): resize the running pets. */
    applyScale(): void {
      world?.setScale(this.scale);
    },

    // Pointer handling from the overlay.
    dragStart(id: number, x: number, y: number): void {
      world?.petById(id)?.dragStart(x, y);
    },
    dragMove(id: number, x: number, y: number): void {
      world?.petById(id)?.dragMove(x, y);
    },
    dragEnd(id: number, x: number, y: number): void {
      world?.petById(id)?.dragEnd(x, y);
    },
    dragCancel(id: number): void {
      world?.petById(id)?.dragCancel();
    },

    /** Page Visibility pauses the flock (a hidden tab's timers are throttled anyway); resize pulls strays back. */
    listen(): void {
      if (listening || typeof document === 'undefined') return;
      listening = true;
      document.addEventListener('visibilitychange', () => {
        if (!world) return;
        if (document.visibilityState === 'hidden') world.pauseAll();
        else world.resumeAll();
      });
      window.addEventListener('resize', () => world?.recoverLayout());
    },
  },
});
