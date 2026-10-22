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
    ><img v-if="src" :src="src" alt="" draggable="false" @error="onError"
  /></span>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useAvatarSetsStore } from '../stores/avatarSets.js';
import { useNickColors } from '../composables/useNickColors.js';

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

onMounted(() => {
  void avatarSets.ensureDefault();
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
</style>
