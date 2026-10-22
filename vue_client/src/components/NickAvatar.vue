<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  A nick's avatar (#607): a square in the nick's colour with one image of the
  active tile set over it, or the avatar the user set through IRCv3 metadata
  (served by the media proxy, never the origin) when there is one. An image
  that fails to load falls back to the tile, so a dead URL never leaves a
  blank. Sized by the --avatar-size custom property the surface sets.
-->

<template>
  <span
    class="nick-avatar"
    :class="{ interactive, metadata: fromMetadata }"
    :style="{ background: color ?? undefined }"
    :title="nick"
    role="img"
    :aria-label="nick"
    ><img v-if="src" :src="src" alt="" draggable="false" @error="onError" /><span
      v-else-if="initial"
      class="initial"
      :class="initial.ink"
      aria-hidden="true"
      >{{ initial.letter }}</span
    ></span
  >
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useAvatarSetsStore } from '../stores/avatarSets.js';
import { useNickColors } from '../composables/useNickColors.js';
import { useDisplayNames } from '../composables/useDisplayNames.js';

const props = withDefaults(
  defineProps<{
    nick: string;
    // The network the nick is on, for its metadata avatar and self colour.
    networkId?: number | null;
    // Pointer affordance; the click handler is the consumer's (attribute fallthrough).
    interactive?: boolean;
    // No metadata avatar: the nick is a relay bot's envelope (someone on
    // another network); the generated tile still shows.
    plain?: boolean;
  }>(),
  { networkId: null, interactive: false, plain: false },
);

const networks = useNetworksStore();
const avatarSets = useAvatarSetsStore();
const nicks = useNickColors();
const displayNames = useDisplayNames();

onMounted(() => {
  void avatarSets.ensureBuiltins();
});

const meta = computed(() =>
  props.plain ? null : networks.metadataFor(props.networkId, props.nick),
);
const failed = ref(false);
// A new URL gets its own chance.
watch(
  () => meta.value?.avatarUrl,
  () => {
    failed.value = false;
  },
);
const fromMetadata = computed(() => !!meta.value?.avatarUrl && !failed.value);
const src = computed(() => {
  if (fromMetadata.value) return meta.value!.avatarUrl as string;
  return props.nick ? avatarSets.tileFor(props.nick) : null;
});
// An Initial set: the first letter of what the head prints — the display
// name where there is one, else the nick — in the set's ink.
const initial = computed(() => {
  const ink = avatarSets.activeSet?.initialInk;
  if (!ink || !props.nick) return null;
  const shown = props.plain ? null : displayNames.plainDisplayNameFor(props.networkId, props.nick);
  const first = Array.from(shown ?? props.nick)[0];
  return first ? { ink, letter: first.toUpperCase() } : null;
});

const isSelf = computed(() => {
  const own = props.networkId != null ? networks.states[props.networkId]?.nick : null;
  return !!own && !!props.nick && own.toLowerCase() === props.nick.toLowerCase();
});
const color = computed(() => {
  if (isSelf.value) return nicks.selfColor.value;
  return props.nick ? nicks.color(props.nick) : null;
});

function onError(): void {
  if (fromMetadata.value) failed.value = true;
}
</script>

<style scoped>
.nick-avatar {
  display: inline-block;
  width: var(--avatar-size, 2.25em);
  height: var(--avatar-size, 2.25em);
  border-radius: var(--radius-md);
  overflow: hidden;
  flex-shrink: 0;
  background: var(--bg-soft);
  vertical-align: middle;
}
.nick-avatar img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.nick-avatar.interactive {
  cursor: pointer;
}
/* The Initial sets: one letter, centred, faded the way the silhouettes are
   so the colour shows through. A deliberate exception to the one-font-size
   rule, with the icon tokens: the letter is a glyph standing in for an
   image, so it scales with the tile (half its height), not with the text. */
.nick-avatar .initial {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-size: calc(var(--avatar-size, 2.25em) * 0.5);
  font-weight: 600;
  line-height: 1;
  user-select: none;
}
.nick-avatar .initial.light {
  color: rgba(255, 255, 255, 0.85);
}
.nick-avatar .initial.dark {
  color: rgba(28, 26, 30, 0.85);
}
</style>
