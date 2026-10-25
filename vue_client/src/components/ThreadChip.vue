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
    }}<span v-if="when" class="when">{{ when }}</span>
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { formatRelative } from '../utils/timestamp.js';

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
/* The time sits beside the count with a gap and nothing else, as the compact
   head sets its time beside the nick. */
.when {
  color: var(--fg-muted);
  margin-left: 0.75ch;
}
</style>
