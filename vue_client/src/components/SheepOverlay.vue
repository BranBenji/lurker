<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <div v-if="hasSheep" class="sheep-layer" aria-hidden="true">
    <div
      v-for="s in sheep.sprites"
      :key="s.id"
      class="sheep"
      :class="{ child: s.isChild }"
      :style="placeStyle(s)"
    >
      <div
        class="sprite"
        :style="spriteStyle(s)"
        @pointerdown="onDown(s, $event)"
        @pointermove="onMove(s, $event)"
        @pointerup="onUp(s, $event)"
        @pointercancel="onCancel(s, $event)"
        @contextmenu.prevent="onMenu(s, $event)"
      ></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue';
import { useSheepStore, type SheepSprite } from '../stores/sheep.js';
import { describeSheep } from '../lib/sheep/flock.js';
import { useSettingsStore } from '../stores/settings.js';
import { useContextMenu, type ContextMenuItem } from '../composables/useContextMenu.js';
import { useViewport } from '../composables/useViewport.js';

// The flock's render layer: one fixed, pointer-transparent sheet over the
// whole app, with a sprite per pet. The engine (lib/sheep) decides where each
// sheep is and which tile it shows; this maps that to CSS. A sheep moves in
// discrete steps, as the original's window did: no transition between two
// engine positions. Right-click a sheep for its menu: shoo it, or give it
// another color.

const sheep = useSheepStore();
const settings = useSettingsStore();
const menu = useContextMenu();
const { isMobile } = useViewport();

const hasSheep = computed(() => Object.keys(sheep.sprites).length > 0);

const px = (n: number) => `${Math.round(n)}px`;

function placeStyle(s: SheepSprite): Record<string, string> {
  const w = sheep.frameWidth * sheep.scale;
  const h = sheep.frameHeight * sheep.scale;
  return {
    width: px(w),
    height: px(h),
    transform: `translate(${px(s.x)}, ${px(s.y)})`,
    opacity: String(s.opacity),
  };
}

function spriteStyle(s: SheepSprite): Record<string, string> {
  const scale = sheep.scale;
  const w = sheep.frameWidth * scale;
  const h = sheep.frameHeight * scale;
  const col = s.frame % sheep.tilesX;
  const row = Math.floor(s.frame / sheep.tilesX);
  return {
    backgroundImage: `url(/sheep/${s.color}.png)`,
    backgroundSize: `${px(w * sheep.tilesX)} ${px(h * sheep.tilesY)}`,
    backgroundPosition: `${px(-col * w)} ${px(-row * h)}`,
    transform: s.flipped ? 'scaleX(-1)' : 'none',
  };
}

function onDown(s: SheepSprite, e: PointerEvent): void {
  if (s.isChild || e.button !== 0) return;
  e.preventDefault();
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  sheep.dragStart(s.id, e.clientX, e.clientY);
}

function onMove(s: SheepSprite, e: PointerEvent): void {
  if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return;
  sheep.dragMove(s.id, e.clientX, e.clientY);
}

function onUp(s: SheepSprite, e: PointerEvent): void {
  const el = e.currentTarget as HTMLElement;
  if (!el.hasPointerCapture(e.pointerId)) return;
  el.releasePointerCapture(e.pointerId);
  sheep.dragEnd(s.id, e.clientX, e.clientY);
}

// A cancel's coordinates aren't the pointer's last position in every browser:
// drop the sheep where it is rather than toss it from wherever they point.
function onCancel(s: SheepSprite, e: PointerEvent): void {
  const el = e.currentTarget as HTMLElement;
  if (!el.hasPointerCapture(e.pointerId)) return;
  el.releasePointerCapture(e.pointerId);
  sheep.dragCancel(s.id);
}

function onMenu(s: SheepSprite, e: MouseEvent): void {
  if (!s.key) return;
  const items: ContextMenuItem[] = [
    { heading: describeSheep(s) },
    {
      label: `Shoo ${s.name || 'this sheep'}`,
      icon: 'fa-solid fa-xmark',
      onClick: () => void sheep.shoo(s.key).catch(() => {}),
    },
    { divider: true },
    { heading: 'Color' },
    ...sheep.colors.map((color) => ({
      label: color,
      icon: color === s.color ? 'fa-solid fa-check' : undefined,
      disabled: color === s.color,
      onClick: () => void sheep.recolor(s.key, color).catch(() => {}),
    })),
  ];
  if (sheep.flock.length > 1) {
    items.push(
      { divider: true },
      {
        label: 'Shoo every sheep',
        onClick: () => void sheep.shooAll().catch(() => {}),
      },
    );
  }
  menu.open(items, e.clientX, e.clientY, e.currentTarget as Element);
}

// The flock setting is the source of truth: our own writes and other
// clients' both land there, and the running pets follow it. The flock is a
// desktop thing: the phone layout parks it (a /sheep typed there still adds
// to the flock every desktop shows).
watch(
  () => [settings.loaded, isMobile.value, settings.effective('sheep.flock')] as const,
  ([loaded, mobile]) => {
    sheep.park(mobile);
    // A failure here is another client's sheep (or a restore) this page can't
    // show; a /sheep typed here reports its own failure in the buffer.
    if (loaded && !mobile) void sheep.reconcile().catch((err) => console.warn('sheep:', err));
  },
  { immediate: true, deep: true },
);
watch(
  () => sheep.scale,
  () => sheep.applyScale(),
);
</script>

<style scoped>
.sheep-layer {
  position: fixed;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  /* Over the dialogs it walks on, under toasts and menus: a sheep's own menu
     opens on top of it, and the sprite must not take the menu's clicks. */
  z-index: var(--z-sheep);
}

.sheep {
  position: absolute;
  top: 0;
  left: 0;
  will-change: transform;
}

.sprite {
  width: 100%;
  height: 100%;
  background-repeat: no-repeat;
  image-rendering: pixelated;
  pointer-events: auto;
  touch-action: none;
  cursor: grab;
  user-select: none;
  -webkit-user-select: none;
}

.sprite:active {
  cursor: grabbing;
}

.child .sprite {
  pointer-events: none;
}
</style>
