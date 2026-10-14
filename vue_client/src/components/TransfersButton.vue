<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  The DCC Transfers button, in the desktop rail and the mobile top bar; each
  view gives it its own button class. Self-revealing: DCC is off for almost
  everyone, so it only appears while the account has a transfer or a file (or
  the panel is open), and goes again once both lists are empty.
  Color-as-signal (house style, no count badge): the glyph turns warn-colored
  while an unsolicited offer awaits a decision.
-->

<template>
  <button
    v-if="dcc.hasAny || dcc.panelOpen"
    class="dcc-btn"
    :class="{ pending: dcc.pendingCount > 0 }"
    :title="title"
    @click="dcc.open()"
  >
    <i class="fa-solid fa-folder-open"></i>
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useDccStore } from '../stores/dcc.js';

const dcc = useDccStore();
const title = computed(() =>
  dcc.pendingCount > 0 ? `DCC transfers — ${dcc.pendingCount} awaiting approval` : 'DCC transfers',
);
</script>

<style scoped>
/* The :hover arm outranks the view's own button:hover, whichever sheet loads
   last, so the signal holds under the pointer. */
.dcc-btn.pending,
.dcc-btn.pending:hover {
  color: var(--warn);
}
</style>
