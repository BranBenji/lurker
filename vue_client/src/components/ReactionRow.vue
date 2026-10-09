<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  A line's reactions as a row of chips under its text, one per value with its
  count. Outlined faintly on the soft background; ours tinted in the
  accent. Clicking or tapping a chip adds our reaction or takes it back;
  hovering names who reacted. The trailing
  add chip (always shown while there are reactions, as Slack does) opens the
  picker, which is also where a touch screen sees who gave what.
  Renders nothing when no reactions stand on the line, so an ordinary line
  keeps its height.
-->

<template>
  <div v-if="groups.length" class="reaction-row">
    <button
      v-for="g in groups"
      :key="g.value"
      type="button"
      class="chip"
      :class="{ mine: g.mine }"
      :disabled="!chipWorks(g)"
      :title="chipTitle(g)"
      :aria-label="`${g.value}, ${g.nicks.length} (${g.nicks.join(', ')})`"
      :aria-pressed="g.mine"
      @click.stop="onChipClick(g)"
      @contextmenu.stop
    >
      <span class="value" dir="auto">{{ g.value }}</span
      ><span class="count">{{ g.nicks.length }}</span>
    </button>
    <button
      v-if="interactive"
      type="button"
      class="chip add"
      title="React / see who reacted"
      aria-label="React / see who reacted"
      @click.stop="reactions.openPicker(message)"
    >
      <i class="fa-solid fa-heart-circle-plus" aria-hidden="true"></i>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, watch } from 'vue';
import { useReactionsStore } from '../stores/reactions.js';
import { useNetworksStore } from '../stores/networks.js';

const props = withDefaults(
  defineProps<{
    message: {
      id?: number | null;
      networkId: number;
      nick?: string;
      text?: string;
    };
    // False on lines we can show reactions on but not send to — a notice
    // someone else's client reacted to, an encrypted line. The server refuses
    // both (reactionSendTarget), so the chips must not pretend otherwise.
    interactive?: boolean;
  }>(),
  { interactive: true },
);

const emit = defineEmits<{ measured: [] }>();

const reactions = useReactionsStore();
const networks = useNetworksStore();

const groups = computed(() => reactions.groupsFor(props.message.id));

// A reaction landing live can add the row, or wrap it onto another line — the
// line grows under a reader following the live tail. Same contract as
// MessageBody's `measured`: say so once the DOM has it, and the list re-pins.
// Only on change; a line that arrives with its reactions is measured with them.
watch(
  () => groups.value.map((g) => `${g.value}:${g.nicks.length}`).join('|'),
  async () => {
    await nextTick();
    emit('measured');
  },
);
// A chip of ours takes the reaction back, which the network may not allow even
// where it takes a new one (+draft/unreact denied, #1101); anyone else's adds
// ours. The store decides (canToggle).
function chipWorks(g: { value: string }): boolean {
  if (!props.interactive || props.message.id == null) return false;
  return reactions.canToggle(props.message.id, g.value, props.message.networkId);
}

function chipTitle(g: { value: string; nicks: string[]; mine: boolean }): string {
  const who = `${g.nicks.join(', ')} reacted ${g.value}`;
  // Only where the rest of the row still works: a down network greys every chip.
  return g.mine && !chipWorks(g) && networks.states[props.message.networkId]?.state === 'connected'
    ? `${who} — this network can't take a reaction back`
    : who;
}

function onChipClick(g: { value: string }) {
  if (!chipWorks(g) || props.message.id == null) return;
  reactions.toggle(props.message.id, g.value, props.message.networkId);
}
</script>

<style scoped>
.reaction-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  /* Room below as well as above: a highlighted line's background ends at the
     line's edge, and chips flush against it looked cut off. */
  margin: var(--space-2) 0;
  white-space: normal;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: var(--radius-reaction);
  color: var(--fg-muted);
  font: inherit;
  /* Real vertical padding rather than a tall line box: an emoji's glyph sits
     low in the line, so with none its bottom met the chip's edge while its
     top floated. One extra pixel below centres it by eye. */
  line-height: 1.2;
  padding: var(--space-2) var(--space-4) calc(var(--space-2) + 1px);
  cursor: pointer;
}
/* A value can be up to 64 graphemes of text. The chip shows the start of a long
   one and the tooltip the whole (#1014), as halloy does; the picker shows it
   all. Cut by the browser, so an emoji or a combining mark is never split.
   Clipped sideways only, as ReactModal's quick row is: `overflow: hidden` clips
   every edge, and shaved the bottom off an emoji sitting low in the line. */
.value {
  max-width: 12ch;
  overflow-x: clip;
  overflow-y: visible;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chip:hover:not(:disabled) {
  background: color-mix(in srgb, var(--fg) 8%, var(--bg-soft));
  color: var(--fg);
}
/* Offline, the reactions still read normally — just not clickable. (The
   global button:disabled would fade them to half opacity.) */
.chip:disabled {
  opacity: 1;
  color: var(--fg-muted);
  cursor: default;
}
/* Ours: an accent tint and accent text. */
.chip.mine {
  background: color-mix(in srgb, var(--accent) 15%, transparent);
  border-color: color-mix(in srgb, var(--accent) 30%, transparent);
  color: var(--accent);
}
.chip.mine:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent) 25%, transparent);
}
/* The add chip is a placeholder, not a reaction, so its heart is faded toward
   the background — further than main.css's `::placeholder` (55%), which still
   read as a reaction next to real ones. Mixing toward --bg keeps it dim in both
   themes, and its outline with it. It comes up to full strength on hover. */
.chip.add {
  color: color-mix(in srgb, var(--fg-muted) 35%, var(--bg));
  border-color: color-mix(in srgb, var(--border) 35%, var(--bg));
}
.chip.add:hover {
  color: var(--fg);
  border-color: var(--border);
}
</style>
