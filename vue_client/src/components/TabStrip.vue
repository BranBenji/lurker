<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  A row of tabs at the top of a modal: the channel modal's lists, the DCC
  panel's transfers and files. v-model is the active tab's id.
-->

<template>
  <div class="tabs" role="tablist" :aria-label="label">
    <button
      v-for="tab in tabs"
      :key="tab.id"
      type="button"
      role="tab"
      :aria-selected="tab.id === modelValue"
      :class="{ active: tab.id === modelValue }"
      @click="emit('update:modelValue', tab.id)"
    >
      {{ tab.label }}
    </button>
  </div>
</template>

<script setup lang="ts" generic="T extends string">
defineProps<{ tabs: ReadonlyArray<{ id: T; label: string }>; modelValue: T; label: string }>();
const emit = defineEmits<{ 'update:modelValue': [id: T] }>();
</script>

<style scoped>
.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding-bottom: var(--space-4);
}
.tabs button {
  background: var(--bg-soft);
  color: var(--fg-muted);
  border: 1px solid var(--border);
  padding: var(--space-2) var(--space-4);
}
.tabs button.active {
  color: var(--fg);
  border-color: var(--accent);
  outline: 1px solid var(--accent);
}
</style>
