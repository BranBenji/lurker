<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  The colour picker shell. Desktop: a floating card anchored under the swatch
  that opened it (teleported to body, viewport-clamped, re-placed on scroll and
  resize). Mobile: the standard AppModal sheet. Both wrap ColorPickerBody.

  Commit semantics mirror the text field it sits beside, whose blur commits:
  clicking away, Enter, the sheet's close button and "done" all commit the
  draft if it changed. Escape is the one way out WITHOUT committing; "revert"
  puts the opening value back without closing. Nothing is written while the
  user drags — Settings is a full page with no chat behind it, so there is
  nothing to preview live, and the theme editor that will have a live view
  gets its own shell over the same body.
-->

<template>
  <Teleport to="body">
    <AppModal v-if="isMobile" size="sm" title="color" word="color" @close="finish">
      <template #actions>
        <button class="link" type="button" :disabled="!dirty" @click="revert">revert</button>
      </template>
      <ColorPickerBody v-model="draft" :initial="value" />
    </AppModal>
    <div
      v-else
      ref="cardEl"
      class="picker-card"
      :style="{ left: `${pos.x}px`, top: `${pos.y}px` }"
      tabindex="-1"
      role="dialog"
      aria-label="color picker"
      @keydown.esc.stop.prevent="cancel"
      @keydown.enter="onEnter"
    >
      <ColorPickerBody v-model="draft" :initial="value" />
      <footer class="foot">
        <button class="link" type="button" :disabled="!dirty" @click="revert">revert</button>
        <button class="link done" type="button" @click="finish">done</button>
      </footer>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, onUpdated, ref } from 'vue';
import AppModal from './AppModal.vue';
import ColorPickerBody from './ColorPickerBody.vue';
import { useViewport } from '../composables/useViewport.js';

const props = defineProps<{
  /** The setting's current stored value, as the row shows it. */
  value: string;
  /** The swatch button that opened the picker; the desktop card hangs off it. */
  anchor: HTMLElement | null;
}>();

const emit = defineEmits<{
  commit: [value: string];
  close: [];
}>();

const { isMobile } = useViewport();
const draft = ref(props.value);
const dirty = computed(() => draft.value.trim() !== props.value.trim());

function finish(): void {
  if (dirty.value) emit('commit', draft.value.trim());
  emit('close');
}
function cancel(): void {
  emit('close');
}
function revert(): void {
  draft.value = props.value;
}
// Enter commits from the text field only. On a swatch or the star it is the
// button's own activation: finishing on keydown would unmount the picker
// before the click it triggers ever fires, so the pick would be lost.
function onEnter(e: KeyboardEvent): void {
  const t = e.target as HTMLElement | null;
  if (!(t instanceof HTMLInputElement) || t.type !== 'text') return;
  e.preventDefault();
  finish();
}

// ─── desktop placement ───────────────────────────────────────────────────

const cardEl = ref<HTMLElement | null>(null);
const pos = ref({ x: 0, y: 0 });

// Under the anchor, left-aligned; above it when the bottom would clip; then
// clamped into the viewport the way ContextMenu does. Rows that appear as the
// draft changes (favourites, harmony) change the card's height, so onUpdated
// re-places too.
function place(): void {
  const a = props.anchor;
  const el = cardEl.value;
  if (!a || !el) return;
  const r = a.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const pad = 4;
  const gap = 6;
  let x = r.left;
  let y = r.bottom + gap;
  if (y + h + pad > window.innerHeight) {
    const above = r.top - gap - h;
    y = above >= pad ? above : Math.max(pad, window.innerHeight - h - pad);
  }
  if (x + w + pad > window.innerWidth) x = window.innerWidth - w - pad;
  if (x < pad) x = pad;
  pos.value = { x, y };
}

function onWindowPointerDown(e: PointerEvent): void {
  const t = e.target;
  if (!(t instanceof Node)) return;
  if (cardEl.value?.contains(t)) return;
  // The swatch's own click toggles the picker; closing here too would reopen it.
  if (props.anchor?.contains(t)) return;
  finish();
}

onMounted(async () => {
  if (isMobile.value) return;
  await nextTick();
  place();
  cardEl.value?.focus();
  window.addEventListener('pointerdown', onWindowPointerDown);
  window.addEventListener('resize', place);
  // Capture: the settings pane scrolls, not the window, and scroll doesn't bubble.
  window.addEventListener('scroll', place, { capture: true, passive: true });
});
onUpdated(() => {
  if (!isMobile.value) place();
});
onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onWindowPointerDown);
  window.removeEventListener('resize', place);
  window.removeEventListener('scroll', place, { capture: true });
});
</script>

<style scoped>
.picker-card {
  position: fixed;
  width: 300px;
  max-width: calc(100vw - 8px);
  max-height: calc(100dvh - 8px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-6);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-popover);
  z-index: var(--z-popover);
  outline: none;
}
.foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-6);
  padding-top: var(--space-2);
  border-top: 1px solid var(--border);
}
.foot .link {
  background: none;
  border: none;
  padding: var(--space-2) 0;
  color: var(--fg-muted);
  cursor: pointer;
  font: inherit;
}
.foot .link:hover:not(:disabled),
.foot .done {
  color: var(--accent);
}
.foot .link:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
