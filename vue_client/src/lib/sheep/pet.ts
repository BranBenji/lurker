// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// One running pet: the animation state machine of desktopPet's FormPet.cs, as
// the Mac port's PetWindow.swift carries it, with the windowing stripped out.
// Positions are viewport pixels, origin top-left. The pet knows nothing about
// the DOM: it reads the world through a Stage (viewport, surfaces it can land
// on), tells its Host when something needs rendering, and schedules itself
// with setTimeout. Names follow the original so the two can be read side by
// side.

import type { ExpressionContext } from './expression.js';
import {
  PLACE,
  updateAnimationValues,
  type PetAnimation,
  type PetChild,
  type PetModel,
} from './model.js';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A surface the pet can fall onto and walk along — a "window" in the original. */
export interface StageWindow {
  id: string;
  rect: Rect;
}

export interface Stage {
  /** The screen: the viewport. */
  screen(): Rect;
  /** The working area (the screen minus any taskbar); the viewport too, in a browser. */
  area(): Rect;
  /** Surfaces in stacking order, the topmost last. */
  windows(): StageWindow[];
  /** A surface's current rect, or null once it is gone. */
  windowRect(id: string): Rect | null;
}

export interface PetHost {
  /** Something about the pet's view changed. */
  render(pet: Pet): void;
  /** A sound attached to an animation (already through its probability roll); `loop` extra replays. */
  playSound(file: string, loop: number): void;
  /** The current animation spawns a child pet. */
  spawnChild(parent: Pet, child: PetChild): void;
  petClosed(pet: Pet): void;
  /** Something worth a line in /sheep debug happened (an animation change, a respawn, a pause). */
  trace?(pet: Pet, event: string): void;
  /** requestAnimationFrame for the toss physics (tests drive it by hand). */
  requestFrame(cb: (now: number) => void): void;
  now(): number;
}

/** What the renderer needs: where the pet is and what it shows. */
export interface PetView {
  x: number;
  y: number;
  frame: number;
  flipped: boolean;
  opacity: number;
}

interface DragSample {
  time: number;
  x: number;
  y: number;
}

/** Release velocity from recent timestamped drag samples (upstream DragVelocity). Force = px/ms × 10. */
export class DragVelocity {
  private samples: DragSample[] = [];

  reset(x: number, y: number, now: number): void {
    this.samples = [];
    this.add(x, y, now);
  }

  add(x: number, y: number, now: number): void {
    const last = this.samples[this.samples.length - 1];
    if (last && now <= last.time) return;
    this.samples.push({ time: now, x, y });
    while (this.samples.length > 2 && this.samples[1].time <= now - 80) this.samples.shift();
  }

  tossForce(now: number): { dx: number; dy: number } {
    if (this.samples.length < 2) return { dx: 0, dy: 0 };
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const elapsed = last.time - first.time;
    // Too short to measure, or the mouse stopped before release: no toss.
    if (elapsed < 8 || now - last.time > 80) return { dx: 0, dy: 0 };
    return { dx: ((last.x - first.x) / elapsed) * 10, dy: ((last.y - first.y) / elapsed) * 10 };
  }
}

// Ids are keys for sprites and maps. They start from a per-load base so a
// pet from a hot-reloaded copy of this module can never collide with one
// still running from the previous copy.
let nextPetId = Math.floor(Math.random() * 1_000_000) * 1000 + 1;

/**
 * How far past a surface's edge the pet may hang before the edge counts:
 * half its width, i.e. the edge is reached when its centre reaches it. The
 * original used the whole bounding box, which on a web page (no invisible
 * window borders) made the sheep fall, peek or cling with its body still
 * entirely over the surface. Screen edges are walls and keep the full box.
 */
const EDGE_OVERHANG = 0.5;

/**
 * Two surfaces whose tops are within this many pixels continue one another
 * (rounding between adjacent boxes); any larger difference is an edge. The
 * boxes are platforms, never walls: the pet walks on top of them or in
 * front of them, and gets from one to another by jumping or falling.
 */
const SEAM_PX = 2;

export class Pet {
  readonly id = nextPetId++;
  readonly isChild: boolean;
  readonly childDepth: number;
  readonly view: PetView = { x: 0, y: 0, frame: 0, flipped: false, opacity: 0 };

  // Engine state (names follow the original).
  private animationStep = 0;
  private current: PetAnimation;
  private currentWindow: string | null = null;
  private currentWindowFrame: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private isMovingLeft = true;
  private isDragging = false;
  private isTossing = false;
  private isLeaving = false;
  private offsetY = 0;
  private positionX = 0;
  private positionY = 0;
  private dragAnchor = { x: 0, y: 0 };
  private dragVelocity = new DragVelocity();
  private tossForce = { dx: 0, dy: 0 };
  private tossVertVel = 0;
  private tossUpdatedAt = 0;
  private tossFrameQueued = false;
  private killOpacity = 1;
  private closed = false;
  private intervalMs = 200;
  private parentX = -1;
  private parentY = -1;
  private parentFlipped = false;
  /**
   * True while the spawn animation starts: a pet facing right spawns at the
   * mirror image of the spawn point, so a child placed on the screen by that
   * animation (the bathtub a dive aims for) is mirrored with it. The original
   * mirrors the pet but not the child, and its dive misses whenever the sheep
   * happens to face right.
   */
  private spawnMirrored = false;
  private readonly children: Pet[] = [];
  private readonly parent: Pet | null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private paused = false;

  constructor(
    readonly model: PetModel,
    private readonly stage: Stage,
    private readonly host: PetHost,
    public scale: number = 1,
    parent: Pet | null = null,
  ) {
    this.scale = Math.max(1, scale);
    this.isChild = parent !== null;
    this.parent = parent;
    this.childDepth = parent ? parent.childDepth + 1 : 0;
    this.current = model.animation(model.firstAnimation, this.context());
    if (parent) {
      this.parentX = Math.trunc(parent.positionX);
      this.parentY = Math.trunc(parent.positionY);
      this.parentFlipped = !parent.isMovingLeft;
      this.isMovingLeft = parent.isMovingLeft;
      parent.children.push(this);
    }
    this.view.flipped = !this.isMovingLeft;
  }

  get currentAnimation(): PetAnimation {
    return this.current;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** In the kill fade: still on screen, but no longer part of the flock. */
  get isDying(): boolean {
    const kill = this.model.animationKill;
    return kill > 0 && this.current.id === kill;
  }

  get movingLeft(): boolean {
    return this.isMovingLeft;
  }

  get position(): { x: number; y: number } {
    return { x: this.positionX, y: this.positionY + this.offsetY };
  }

  get childPets(): readonly Pet[] {
    return this.children;
  }

  /** The top-level pet this one descends from (itself for a top-level pet). */
  get root(): Pet {
    return this.parent ? this.parent.root : this;
  }

  // ---- Screen helpers ----

  get petWidth(): number {
    return this.model.frameWidth * this.scale;
  }

  get petHeight(): number {
    return this.model.frameHeight * this.scale;
  }

  /** Bottom limit for the pet (the working area's floor). */
  private floorY(): number {
    const a = this.stage.area();
    return a.y + a.h - this.petHeight;
  }

  private context(): ExpressionContext {
    const b = this.stage.screen();
    const a = this.stage.area();
    return {
      screenW: Math.trunc(b.w),
      screenH: Math.trunc(b.h),
      areaW: Math.trunc(a.w),
      areaH: Math.trunc(a.y - b.y + a.h),
      imageW: this.petWidth,
      imageH: this.petHeight,
      imageX: this.parentX,
      imageY: this.parentY,
      random: this.model.randomInt(0, 99),
      randS: this.model.randS,
      scale: this.scale,
      parentFlipped: this.parentFlipped,
    };
  }

  // ---- Public control ----

  /** Port of FormPet.Play(): choose a spawn point and start. */
  play(forceSpawn = -1): void {
    this.stopTimer();
    this.animationStep = 0;
    this.currentWindow = null;
    const spawn =
      forceSpawn >= 0 && forceSpawn < this.model.spawns.length
        ? this.model.spawns[forceSpawn]
        : this.model.randomSpawn();
    const ctx = this.context();
    const b = this.stage.screen();
    const sx = spawn.x.get(ctx);
    const sy = spawn.y.get(ctx);
    this.positionY = b.y + sy;
    this.positionX = this.isMovingLeft ? b.x + sx : b.x - (sx - b.w) - this.petWidth;
    this.offsetY = 0;
    this.isLeaving = false;
    this.host.trace?.(
      this,
      `respawn at ${Math.round(this.positionX)},${Math.round(this.positionY)}`,
    );
    this.spawnMirrored = !this.isMovingLeft;
    this.setNewAnimation(spawn.next);
    this.spawnMirrored = false;
    this.view.opacity = 0;
    this.applyPosition();
    this.scheduleTimer(this.intervalMs);
  }

  /** Port of FormPet.PlayChild(). */
  playChild(child: PetChild): void {
    this.stopTimer();
    this.animationStep = 0;
    this.currentWindow = null;
    const ctx = this.context();
    const b = this.stage.screen();
    const cx = child.x.get(ctx);
    // A screen-placed child of a mirrored spawn mirrors like the spawn point
    // did; one placed by the parent's own position is already where it should be.
    const mirrored = this.parent?.spawnMirrored === true && !child.x.isRelative;
    this.positionX = mirrored ? b.x + b.w - cx - this.petWidth : b.x + cx;
    this.positionY = b.y + child.y.get(ctx);
    this.offsetY = 0;
    this.isLeaving = false;
    this.setNewAnimation(child.next);
    // The original shows a child at full opacity until its first tick, which
    // flashes a child that fades in (the UFOs); start where its animation starts.
    this.view.opacity = this.current.start.opacity;
    this.applyPosition();
    this.scheduleTimer(this.intervalMs);
  }

  /** Port of FormPet.Kill(): play the kill animation if there is one, otherwise close. */
  kill(): void {
    for (const c of this.children.slice()) c.close(); // close() splices itself out
    this.children.length = 0;
    // A shoo from another client can land mid-drag or mid-toss: the fade must
    // not wait for the gesture to end, and the toss frames must stop.
    this.isDragging = false;
    this.isTossing = false;
    if (this.model.animationKill > 1) {
      this.setNewAnimation(this.model.animationKill);
      this.restartTimer();
    } else {
      this.close();
    }
  }

  /** Jump to an animation by id (the debug menu's "jump"). */
  jumpTo(id: number): void {
    if (this.model.has(id)) {
      this.setNewAnimation(id);
      this.restartTimer();
    }
  }

  /**
   * An animation set from outside a tick starts on its own interval: the
   * original's timer restarts when its interval is assigned, so a kill or a
   * drag never waits out the rest of a long sleep step.
   */
  private restartTimer(): void {
    if (this.closed || this.paused || this.isTossing) return;
    this.scheduleTimer(this.intervalMs);
  }

  /**
   * The viewport changed: bring a pet that ended up outside back onto it
   * (port of upstream RecoverDisplayLayout).
   */
  recoverLayout(): void {
    if (this.closed) return;
    const area = this.stage.area();
    const fx = this.positionX;
    const fy = this.positionY + this.offsetY;
    const inside =
      fx + this.petWidth > area.x &&
      fx < area.x + area.w &&
      fy + this.petHeight > area.y &&
      fy < area.y + area.h;
    // A child is anchored by its parent (a saucer descending from above the
    // viewport is on its way in), and a pet leaving the screen is on its way
    // out: neither is a stray to pull back.
    if (this.isDragging || this.isChild || this.isLeaving || inside) return;
    this.currentWindow = null;
    const x = Math.min(Math.max(fx, area.x), area.x + area.w - this.petWidth);
    const y = Math.min(Math.max(fy, area.y), area.y + area.h - this.petHeight);
    this.positionX = x;
    this.positionY = y - this.offsetY;
    this.applyPosition();
  }

  /** Resize the pet. Its moves pick up the new scale from the next animation on. */
  setScale(s: number): void {
    const oldHeight = this.petHeight;
    this.scale = Math.max(1, s);
    // A bigger sheep standing on the floor or at the right edge would otherwise
    // grow past them and sit half outside until something pulls it back.
    const area = this.stage.area();
    this.positionX = Math.min(this.positionX, area.x + area.w - this.petWidth);
    if (this.currentWindow === null) {
      this.positionY = Math.min(this.positionY, this.floorY());
    } else {
      // On a surface: keep the feet where they are and grow (or shrink) upward.
      this.positionY += oldHeight - this.petHeight;
    }
    this.applyPosition();
  }

  /** Stop the clock while the page is hidden; resume() picks up where it left off. */
  pause(): void {
    if (this.closed || this.paused) return;
    this.paused = true;
    this.host.trace?.(this, 'paused');
    this.stopTimer();
    for (const c of this.children) c.pause();
  }

  resume(): void {
    if (this.closed || !this.paused) return;
    this.paused = false;
    this.host.trace?.(this, 'resumed');
    if (!this.isDragging && !this.isTossing) this.scheduleTimer(this.intervalMs);
    for (const c of this.children) c.resume();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopTimer();
    for (const c of this.children.slice()) c.close(); // close() splices itself out
    this.children.length = 0;
    if (this.parent) {
      const i = this.parent.children.indexOf(this);
      if (i >= 0) this.parent.children.splice(i, 1);
    }
    this.host.petClosed(this);
  }

  // ---- Timer ----

  private scheduleTimer(ms: number): void {
    this.stopTimer();
    if (this.paused) return;
    this.timer = setTimeout(() => this.tick(), Math.max(1, ms));
  }

  private stopTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private tick(): void {
    this.timer = null;
    if (this.closed) return;
    if (this.animationStep < 0) this.animationStep = 0;
    this.nextStep();
    if (this.closed) return;
    this.animationStep += 1;
    this.scheduleTimer(this.intervalMs);
  }

  // ---- Animation switching ----

  private setNewAnimation(id: number): void {
    if (this.closed) return;
    const kill = this.model.animationKill;
    if (kill > 0 && this.current.id === kill) return;
    if (id < 0) {
      this.play();
      return;
    }
    this.animationStep = -1;
    this.current = this.model.animation(id, this.context());
    updateAnimationValues(this.current, this.context());
    this.host.trace?.(
      this,
      `#${id} ${this.current.name} at ${Math.round(this.positionX)},${Math.round(this.positionY + this.offsetY)}` +
        (this.currentWindow !== null ? ` on surface ${this.currentWindow}` : ''),
    );
    const sound = this.model.soundFor(id);
    if (sound) this.host.playSound(sound.file, sound.loop ?? 0);

    // Child pets spawned by this animation (max 5 levels deep).
    const infos = this.model.children.get(id);
    if (infos && this.childDepth < 5) {
      for (const info of infos) this.host.spawnChild(this, info);
    }
    this.intervalMs = this.current.start.interval.value;
    this.showFrame(0);
  }

  private showFrame(index: number): void {
    const frames = this.current.sequence.frames;
    if (frames.length === 0) return;
    const i = Math.min(Math.max(index, 0), frames.length - 1);
    this.view.frame = frames[i];
  }

  private flipImages(): void {
    this.isMovingLeft = !this.isMovingLeft;
    this.view.flipped = !this.isMovingLeft;
  }

  /**
   * Places the pet at the engine position. Every step ends here: the pet
   * moves in discrete steps, as the original's window did — no interpolation
   * between them.
   */
  private applyPosition(): void {
    this.view.x = this.positionX;
    this.view.y = this.positionY + this.offsetY;
    this.host.render(this);
  }

  // ---- Toss physics (upstream AdvanceToss; runs per animation frame, not per tick) ----

  private queueTossFrame(): void {
    if (this.tossFrameQueued || this.closed) return;
    this.tossFrameQueued = true;
    this.host.requestFrame((now) => {
      this.tossFrameQueued = false;
      if (this.closed || !this.isTossing) return;
      this.advanceToss(now);
      if (this.isTossing) this.queueTossFrame();
    });
  }

  /** Force units stay "pixels per 30 ms"; pauses are capped so a stalled tab cannot teleport the pet. */
  advanceToss(now: number): void {
    const dt = Math.max(0, Math.min(50, now - this.tossUpdatedAt)) / 30;
    this.tossUpdatedAt = now;
    if (dt === 0) return;
    const area = this.stage.area();
    let nextX = this.positionX + this.tossForce.dx * dt;
    const left = area.x;
    const right = area.x + area.w - this.petWidth;
    if (nextX < left || nextX > right) {
      // Bounce, and use up the remaining travel instead of pausing a frame.
      const edge = nextX < left ? left : right;
      nextX = edge - (nextX - edge) * 0.3;
      this.tossForce.dx *= -0.3;
    }
    this.positionX = Math.max(left, Math.min(right, nextX));
    const dy = this.tossVertVel * dt + 0.75 * dt * dt;
    this.tossVertVel += 1.5 * dt;
    let ground = this.floorY();
    let land = this.positionY + dy >= ground;
    const windowTop = dy > 0 ? this.fallDetect(Math.ceil(dy)) : -1;
    if (windowTop !== -1 && windowTop - this.petHeight <= ground) {
      ground = windowTop - this.petHeight;
      land = true;
    } else {
      this.currentWindow = null;
    }
    this.positionY = land ? ground : this.positionY + dy;
    this.offsetY = 0;
    this.applyPosition();
    if (land) {
      if (
        (this.tossForce.dx < 0 && !this.isMovingLeft) ||
        (this.tossForce.dx > 0 && this.isMovingLeft)
      ) {
        this.flipImages();
      }
      this.isTossing = false;
      this.setNewAnimation(
        this.tossVertVel < 40 ? this.model.animationFallSoft : this.model.animationFallHard,
      );
      this.showFrame(0);
      this.scheduleTimer(this.intervalMs);
    }
  }

  // ---- The step function (port of NextStep) ----

  private nextStep(): void {
    const seq = this.current.sequence;
    const frameCount = seq.frames.length;
    if (frameCount === 0) return;

    // Which frame to show.
    if (this.animationStep < frameCount) {
      this.showFrame(this.animationStep);
    } else {
      const span = Math.max(1, frameCount - seq.repeatFrom);
      const index = ((this.animationStep - frameCount + seq.repeatFrom) % span) + seq.repeatFrom;
      this.showFrame(index);
    }

    const total = Math.max(1, seq.totalSteps);
    const cur = this.current;
    if (!this.isTossing) {
      this.intervalMs =
        cur.start.interval.value +
        Math.trunc(
          ((cur.end.interval.value - cur.start.interval.value) * this.animationStep) / total,
        );
    }
    this.view.opacity =
      cur.start.opacity + ((cur.end.opacity - cur.start.opacity) * this.animationStep) / total;
    this.offsetY =
      cur.start.offsetY +
      Math.trunc(((cur.end.offsetY - cur.start.offsetY) * this.animationStep) / total);

    // Dragging: the position follows pointer events, not animation frames.
    if (this.isDragging) {
      this.offsetY = 0;
      this.host.render(this);
      return;
    }

    const area = this.stage.area();

    // Toss physics run on animation frames (advanceToss), not on ticks.
    if (this.isTossing) return;

    // The surface we stand on moved or resized (the composer grew, a dialog
    // re-laid out): follow it on every step, whatever the animation. The
    // original did this on its motion timer; the gravity branch below still
    // handles the surface vanishing or getting covered.
    if (this.currentWindow !== null && !this.isLeaving) {
      const rct = this.stage.windowRect(this.currentWindow);
      if (rct && !sameRect(rct, this.currentWindowFrame)) this.followWindow(rct);
    }
    let x = cur.start.x.value;
    let y = cur.start.y.value;
    if (total > 1) {
      x += ((cur.end.x.value - cur.start.x.value) * this.animationStep) / (total - 1);
      y += ((cur.end.y.value - cur.start.y.value) * this.animationStep) / (total - 1);
    }

    let newAnimation = false;
    let leavingScreen = false;

    if (!this.isMovingLeft) x = -x;

    // The floor rose under us (the viewport shrank): stand on it again. Not
    // while moving down — an exit through the floor is how some pets leave.
    if (this.currentWindow === null && y <= 0 && this.positionY > this.floorY()) {
      this.positionY = this.floorY();
    }

    // ---- Horizontal borders ----
    if (x < 0) {
      if (this.currentWindow === null) {
        if (this.positionX + x < area.x) {
          const next = this.model.pick(cur.endBorder, PLACE.vertical);
          if (next >= 0) {
            this.positionX = area.x;
            x = 0;
            this.setNewAnimation(next);
            newAnimation = true;
          } else {
            leavingScreen = true;
          }
        }
      } else {
        const rct = this.stage.windowRect(this.currentWindow);
        if (rct) {
          const hang = this.petWidth * EDGE_OVERHANG;
          if (this.positionX + x < area.x) {
            // The surface runs to the screen edge: that edge is a wall, not a drop.
            const next = this.model.pick(cur.endBorder, PLACE.vertical);
            if (next >= 0) {
              this.positionX = area.x;
              x = 0;
              this.setNewAnimation(next);
              newAnimation = true;
            } else {
              leavingScreen = true;
            }
          } else if (this.positionX + x + hang < rct.x && !this.stepOntoNeighbour(rct, x)) {
            const next = this.model.pick(cur.endBorder, PLACE.window);
            if (next >= 0) {
              this.positionX = rct.x - hang;
              x = 0;
              this.setNewAnimation(next);
              newAnimation = true;
            } else {
              this.currentWindow = null;
            }
          }
        } else {
          this.currentWindow = null;
        }
      }
    } else if (x > 0) {
      if (this.currentWindow === null) {
        if (this.positionX + x + this.petWidth > area.x + area.w) {
          const next = this.model.pick(cur.endBorder, PLACE.vertical);
          if (next >= 0) {
            this.positionX = area.x + area.w - this.petWidth;
            x = 0;
            this.setNewAnimation(next);
            newAnimation = true;
          } else {
            leavingScreen = true;
          }
        }
      } else {
        const rct = this.stage.windowRect(this.currentWindow);
        if (rct) {
          const hang = this.petWidth * EDGE_OVERHANG;
          if (this.positionX + x + this.petWidth > area.x + area.w) {
            const next = this.model.pick(cur.endBorder, PLACE.vertical);
            if (next >= 0) {
              this.positionX = area.x + area.w - this.petWidth;
              x = 0;
              this.setNewAnimation(next);
              newAnimation = true;
            } else {
              leavingScreen = true;
            }
          } else if (
            this.positionX + x + this.petWidth - hang > rct.x + rct.w &&
            !this.stepOntoNeighbour(rct, x)
          ) {
            const next = this.model.pick(cur.endBorder, PLACE.window);
            if (next >= 0) {
              this.positionX = rct.x + rct.w - this.petWidth + hang;
              x = 0;
              this.setNewAnimation(next);
              newAnimation = true;
            } else {
              this.currentWindow = null;
            }
          }
        } else {
          this.currentWindow = null;
        }
      }
    }

    // ---- Vertical borders ----
    if (newAnimation || leavingScreen) {
      // nothing more to check
    } else if (y > 0) {
      const floor = this.floorY();
      if (this.positionY + y > floor) {
        const next = this.model.pick(cur.endBorder, PLACE.taskbar);
        if (next >= 0) {
          this.positionY = floor;
          this.offsetY = 0;
          y = 0;
          // A jump keeps the surface it left through the air; landing on the
          // floor ends that, or the floor walk would use the surface's edges.
          this.currentWindow = null;
          this.setNewAnimation(next);
          newAnimation = true;
        }
      } else {
        const was = this.currentWindow;
        const windowTop = this.fallDetect(Math.trunc(y));
        if (windowTop > 0) {
          const next = this.model.pick(cur.endBorder, PLACE.window);
          if (next >= 0) {
            this.positionY = windowTop - this.petHeight;
            this.offsetY = 0;
            y = 0;
            this.setNewAnimation(next);
            newAnimation = true;
            if (this.current.start.y.value !== 0) this.currentWindow = null;
          } else {
            // fallDetect took the surface, as the original's does; an
            // animation with nowhere to land (a dive aimed at the floor)
            // passes through it and must not come out standing on it.
            this.currentWindow = was;
          }
        }
      }
    } else if (y < 0) {
      // Going up: once the pet is a body height above the surface it stood on
      // (a jump, a climb), it is no longer on it. The original keeps the
      // window through a jump; with surfaces near the top of the page that
      // let a ceiling walk hit the surface's side edge in mid-air.
      if (this.currentWindow !== null) {
        const rct = this.stage.windowRect(this.currentWindow);
        if (!rct || this.positionY + y + this.petHeight < rct.y - this.petHeight) {
          this.currentWindow = null;
        }
      }
      if (this.positionY + y < area.y) {
        this.currentWindow = null;
        const next = this.model.pick(cur.endBorder, PLACE.horizontal);
        if (next >= 0) {
          this.positionY = area.y;
          y = 0;
          this.setNewAnimation(next);
          newAnimation = true;
        } else {
          leavingScreen = true;
        }
      }
    }

    // ---- End of sequence ----
    if (this.animationStep >= seq.totalSteps) {
      let nextAni: number;
      if (seq.action === 'flip') this.flipImages();

      if (this.currentWindow !== null) {
        nextAni = this.model.pick(cur.endAnimation, PLACE.window);
      } else {
        const b = this.stage.screen();
        if (this.positionX < b.x - this.petWidth || this.positionX > b.x + b.w) {
          nextAni = -1;
        } else if (this.positionY < b.y - this.petHeight || this.positionY > b.y + b.h) {
          nextAni = -1;
        } else {
          const onTaskbar = this.positionY + y >= this.floorY() - 2;
          nextAni = this.model.pick(cur.endAnimation, onTaskbar ? PLACE.taskbar : PLACE.anywhere);
        }
      }

      const kill = this.model.animationKill;
      if (kill > 0 && cur.id === kill) {
        // 1.0, 0.9 … 0.1, then gone: ten ticks, like the original.
        this.view.opacity = Math.max(0, this.killOpacity);
        this.killOpacity -= 0.1;
        if (this.killOpacity < 0.05) {
          this.close();
          return;
        }
      } else if (nextAni >= 0) {
        this.setNewAnimation(nextAni);
        newAnimation = true;
      } else if (this.isChild) {
        this.close();
        return;
      } else {
        this.play();
        return;
      }
    }
    // ---- Gravity ----
    else if (cur.hasGravity) {
      if (this.currentWindow === null) {
        const floor = this.floorY();
        if (this.positionY + y < floor) {
          if (this.positionY + y + 3 >= floor) {
            y = floor - this.positionY;
          } else {
            this.setNewAnimation(this.model.pick(cur.endGravity, PLACE.anywhere));
            newAnimation = true;
          }
        }
      } else if (this.animationStep > 0) {
        const rct = this.stage.windowRect(this.currentWindow);
        if (rct) {
          const feet = this.positionY + this.petHeight;
          if (!sameRect(rct, this.currentWindowFrame)) {
            // The surface we stand on moved or resized: follow it.
            this.followWindow(rct);
          } else if (this.coveringSurface(this.currentWindow) !== null) {
            this.currentWindow = null;
            this.setNewAnimation(this.model.pick(cur.endGravity, PLACE.window));
            newAnimation = true;
          } else if (feet < rct.y - 3) {
            // Standing on a surface means feet on its top edge, as it means
            // feet on the floor below. A jump that keeps meeting the surface's
            // side edge restarts mid-air and leaves the pet "on" it well above
            // it (the original checks only the window, never the pet): it is
            // in the air, so it falls.
            this.currentWindow = null;
            this.setNewAnimation(this.model.pick(cur.endGravity, PLACE.window));
            newAnimation = true;
          } else if (feet > rct.y + 3) {
            // Below the top edge: in front of the box, not on it.
            this.currentWindow = null;
          }
        } else {
          // Surface disappeared.
          this.currentWindow = null;
          this.setNewAnimation(this.model.pick(cur.endGravity, PLACE.window));
          newAnimation = true;
        }
      }
    }

    if (newAnimation) {
      this.intervalMs = 1;
      this.showFrame(0);
    } else if (y > 0) {
      x += this.slipOffEdge(x, y);
    }

    this.positionX += x;
    this.positionY += y;
    // A pet with no sideways motion of its own is never left partly outside
    // the screen: only a pet in motion can be crossing its edge, on its way in
    // or out. The ceiling corner leans the sheep a few pixels into the wall
    // before the wall walk starts; the original leaves it clipped there, with
    // its hooves off the edge.
    if (x === 0 && !leavingScreen) {
      const left = area.x;
      const right = area.x + area.w - this.petWidth;
      if (this.positionX < left) this.positionX = left;
      else if (this.positionX > right) this.positionX = right;
    }
    this.isLeaving = leavingScreen;
    this.applyPosition();
  }

  // ---- Surfaces (ports of FallDetect / FollowWindow) ----

  /** Top edge of a surface the pet would land on while moving down by `dy`, or -1. */
  private fallDetect(dy: number): number {
    const area = this.stage.area();
    const bottom = this.positionY + this.petHeight;
    const windows = this.stage.windows();
    // Topmost first, so overlapping surfaces resolve to the one that's visible.
    for (const w of [...windows].reverse()) {
      const rct = w.rect;
      // The original refused any window whose top edge was within 20px of
      // the screen top (the pet would stand above the screen). Here the
      // surfaces near the top are the point — a sheep standing on the message
      // list fills the topic bar — so the rule is only that the sheep fits.
      if (
        bottom < rct.y &&
        bottom + dy >= rct.y &&
        this.positionX >= rct.x - this.petWidth / 2 &&
        this.positionX + this.petWidth <= rct.x + rct.w + this.petWidth / 2 &&
        rct.y - this.petHeight >= area.y - 2
      ) {
        if (this.coveringSurface(w.id, windows) === null) {
          this.currentWindow = w.id;
          this.currentWindowFrame = { ...rct };
          return rct.y;
        }
      }
    }
    return -1;
  }

  /**
   * The surface above `id` that hides its top edge where the pet stands, if
   * any: one reaching above the edge with the pet well inside it (a dialog
   * that opened around it). A taller box merely beside the ledge is not a
   * cover: the pet reaches the ledge's edge and jumps or falls off it there.
   */
  private coveringSurface(id: string, windows = this.stage.windows()): StageWindow | null {
    const idx = windows.findIndex((w) => w.id === id);
    if (idx < 0) return null;
    const top = windows[idx].rect.y;
    const cx = this.positionX + this.petWidth / 2;
    const inset = this.petWidth / 2;
    for (const above of windows.slice(idx + 1)) {
      const r = above.rect;
      if (r.x + inset <= cx && cx < r.x + r.w - inset && r.y < top - SEAM_PX && r.y + r.h > top) {
        return above;
      }
    }
    return null;
  }

  /**
   * Walking off the surface we stand on: if another surface's top edge
   * continues the same line under where the pet is heading (the member list
   * beside the message list, the icon bar beside the status bar), step onto
   * it and keep walking instead of treating the seam as an edge.
   */
  private stepOntoNeighbour(rct: Rect, dx: number): boolean {
    // The edge of the pet that is leaving the surface.
    const lead = dx < 0 ? this.positionX + dx : this.positionX + dx + this.petWidth;
    for (const w of [...this.stage.windows()].reverse()) {
      if (w.id === this.currentWindow) continue;
      const r = w.rect;
      if (Math.abs(r.y - rct.y) <= SEAM_PX && r.x <= lead && lead <= r.x + r.w) {
        this.currentWindow = w.id;
        this.currentWindowFrame = { ...r };
        this.positionY = r.y - this.petHeight; // the rounding difference
        return true;
      }
    }
    return false;
  }

  /**
   * Dropping past a surface's top edge while still partly over it (the
   * fall-off animations move straight down from the half-overhang position):
   * slip sideways to clear the edge, so the sheep falls beside the surface
   * rather than through its face. Only for an overlap of up to one body
   * width; anything deeper is a fall through the middle and is left alone.
   */
  private slipOffEdge(dx: number, dy: number): number {
    const bottom = this.positionY + this.petHeight;
    const nx0 = this.positionX + dx;
    const nx1 = nx0 + this.petWidth;
    for (const w of this.stage.windows()) {
      const r = w.rect;
      if (bottom > r.y + 1 || bottom + dy <= r.y) continue; // not crossing its top edge
      if (nx1 <= r.x || nx0 >= r.x + r.w) continue; // not over it
      const area = this.stage.area();
      // Only to a side that keeps the sheep on screen.
      const toLeft = r.x - this.petWidth >= area.x ? r.x - nx1 : null; // ≤ 0
      const toRight = r.x + r.w + this.petWidth <= area.x + area.w ? r.x + r.w - nx0 : null; // ≥ 0
      const fits = (v: number | null) => v !== null && Math.abs(v) <= this.petWidth;
      if (fits(toLeft) && fits(toRight)) {
        const goLeft = this.isMovingLeft ? -toLeft! <= toRight! : -toLeft! < toRight!;
        return goLeft ? toLeft! : toRight!;
      }
      if (fits(toLeft)) return toLeft!;
      if (fits(toRight)) return toRight!;
      continue;
    }
    return 0;
  }

  private followWindow(rct: Rect): void {
    const old = this.currentWindowFrame;
    const ratio = old.w > 0 ? rct.w / old.w : 1;
    const dy = rct.y - old.y;
    this.host.trace?.(
      this,
      `surface ${this.currentWindow} moved: ${Math.round(old.x)},${Math.round(old.y)} ${Math.round(old.w)}×${Math.round(old.h)}` +
        ` → ${Math.round(rct.x)},${Math.round(rct.y)} ${Math.round(rct.w)}×${Math.round(rct.h)}`,
    );
    this.positionX = rct.x + (this.positionX - old.x) * ratio;
    this.positionY += dy;
    this.currentWindowFrame = { ...rct };
    this.applyPosition();
  }

  // ---- Pointer (called by the overlay) ----

  dragStart(px: number, py: number, now = this.host.now()): void {
    if (this.isChild || this.closed || this.isDying) return;
    this.currentWindow = null;
    this.isDragging = true;
    this.isTossing = false;
    // Keep the exact grab point, like dragging a normal window.
    this.positionY += this.offsetY;
    this.offsetY = 0;
    this.dragAnchor = { x: px - this.positionX, y: py - this.positionY };
    this.dragVelocity.reset(this.positionX, this.positionY, now);
    this.setNewAnimation(this.model.animationDrag);
    this.applyPosition();
    this.restartTimer();
  }

  dragMove(px: number, py: number, now = this.host.now()): void {
    if (!this.isDragging) return;
    this.updateDragPosition(px, py, now);
  }

  private updateDragPosition(px: number, py: number, now: number): void {
    this.positionX = px - this.dragAnchor.x;
    this.positionY = py - this.dragAnchor.y;
    this.offsetY = 0;
    this.dragVelocity.add(this.positionX, this.positionY, now);
    this.applyPosition();
  }

  /** The browser took the pointer away (palm rejection, a system gesture): drop the pet where it is, no toss. */
  dragCancel(): void {
    if (!this.isDragging) return;
    this.isDragging = false;
    this.setNewAnimation(this.model.animationFall);
    this.restartTimer();
  }

  dragEnd(px: number, py: number, now = this.host.now()): void {
    if (this.isChild || !this.isDragging) return;
    this.updateDragPosition(px, py, now);
    this.tossForce = this.dragVelocity.tossForce(now);
    const { dx, dy } = this.tossForce;
    this.isDragging = false;
    if (Math.hypot(dx, dy) > 5) {
      if (this.model.animationToss !== -1) this.setNewAnimation(this.model.animationToss);
      this.isTossing = true;
      this.tossVertVel = dy;
      this.tossUpdatedAt = now;
      this.intervalMs = 30;
      this.queueTossFrame();
    } else {
      this.setNewAnimation(this.model.animationFall);
      this.restartTimer();
    }
  }
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}
