<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  Compact icon-only action button (edit / remove / …) shared by the settings
  panes' row lists. Icon-only buttons need an accessible name, so `label` drives
  both the tooltip and aria-label; the glyph itself is aria-hidden. @click falls
  through to the underlying <button>.
-->
<template>
  <button
    type="button"
    class="icon-btn"
    :class="{ danger }"
    :disabled="disabled"
    :title="label"
    :aria-label="label"
  >
    <component :is="icon" />
  </button>
</template>

<script setup lang="ts">
import type { LucideIcon } from '@lucide/vue';

defineProps<{
  /** Lucide icon component, e.g. PenIcon. */
  icon: LucideIcon;
  /** Accessible name (tooltip + aria-label), e.g. 'edit'. */
  label: string;
  /** Render in the destructive color. */
  danger?: boolean;
  disabled?: boolean;
}>();
</script>

<style scoped>
.icon-btn {
  background: none;
  border: none;
  color: var(--accent);
  padding: var(--space-1) var(--space-2);
  cursor: pointer;
  font: inherit;
  line-height: 1;
}
.icon-btn:hover:not(:disabled) {
  color: var(--fg);
}
.icon-btn.danger {
  color: var(--bad);
}
.icon-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
