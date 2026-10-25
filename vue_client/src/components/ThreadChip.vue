<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  Under a line that started a reply thread (#1225), with reply threads on:
  `╰─ 3 replies · 4m`, which opens the thread panel. The last line of the
  message body, like ReactionRow, and in the reply quote's voice — the same
  arm, faded the same way — since it's the other end of the same link. Accent
  when the thread has replies the user hasn't seen (a thread they're in).
-->

<template>
  <button
    type="button"
    class="thread-chip"
    :class="{ unread: unread > 0 }"
    :title="unread > 0 ? `Open thread — ${unread} new` : 'Open thread'"
    @click.stop="emit('open')"
  >
    <span class="arm" aria-hidden="true">╰─</span>{{ count }} {{ count === 1 ? 'reply' : 'replies'
    }}<template v-if="when"
      ><span class="sep">{{ ` ${META_SEPARATOR} ` }}</span
      ><span class="when">{{ when }}</span></template
    >
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { formatRelative } from '../utils/timestamp.js';
import { META_SEPARATOR } from '../utils/metaLine.js';

const props = withDefaults(
  defineProps<{
    count: number;
    lastReplyTime?: string | null;
    // Replies the user hasn't seen in it, per the server (threads.unreadFor).
    unread?: number;
  }>(),
  { lastReplyTime: null, unread: 0 },
);
const emit = defineEmits<{ open: [] }>();

const when = computed(() => (props.lastReplyTime ? formatRelative(props.lastReplyTime) : ''));
</script>

<style scoped>
.thread-chip {
  display: block;
  background: none;
  border: none;
  padding: 0;
  margin: 0;
  font: inherit;
  color: var(--fg);
  opacity: var(--quote-fade, 0.45);
  cursor: pointer;
  text-align: left;
}
.thread-chip:hover,
.thread-chip:focus-visible {
  opacity: 0.8;
}
.thread-chip.unread {
  color: var(--accent);
  opacity: 1;
}
.arm {
  margin-right: 1ch;
}
/* The separator as MetaLine draws it: in the border colour, so the facts
   stand out from what divides them. */
.sep {
  color: var(--border);
}
.when {
  color: var(--fg-muted);
}
</style>
