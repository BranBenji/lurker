<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  The Shares button, in the desktop rail and the mobile top bar; each view
  gives it its own button class. It opens the files window (#1085): shares,
  and DCC for an account that has it. Color-as-signal (house style, no count
  badge): the glyph turns warn-colored while a DCC offer waits for an answer,
  which is the one thing in there that needs you.
-->

<template>
  <button
    class="shares-btn"
    :class="{ pending: dcc.pendingCount > 0 }"
    :title="title"
    @click="dcc.open(dcc.pendingCount > 0 ? 'dcc' : 'shares')"
  >
    <ShareIcon />
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useDccStore } from '../stores/dcc.js';
import { ShareIcon } from '@lucide/vue';

const dcc = useDccStore();
const title = computed(() => {
  const n = dcc.pendingCount;
  if (n === 0) return 'Shares';
  return `Shares — ${n} DCC ${n === 1 ? 'offer' : 'offers'} waiting`;
});
</script>

<style scoped>
/* The :hover arm outranks the view's own button:hover, whichever sheet loads
   last, so the signal holds under the pointer. */
.shares-btn.pending,
.shares-btn.pending:hover {
  color: var(--warn);
}
</style>
