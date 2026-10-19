<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <RenderSegments :segments="segments" />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { splitTextByTokens } from '../utils/nickColor.js';
import { emojiFn } from '../composables/useEmoji.js';
import RenderSegments from './RenderSegments.vue';

// Renders a plain-text string with URLs auto-linked and IRC formatting
// (bold/italic/underline/strike + mIRC fg/bg colours + spoilers) applied.
// Used by every line type in MessageList that doesn't go through nick
// coloring (motd, errors, part reasons, etc.) and by the topic bar. Lines
// that DO get nick coloring (message/notice/action) build their segments
// with a real nickSet and hand them straight to RenderSegments — the actual
// segment rendering is shared, only the splitting differs.
const props = withDefaults(
  defineProps<{
    text?: string;
  }>(),
  { text: '' },
);

// emojiFn() makes this reactive to the emoji table loading, so a topic/motd
// containing a `:shortcode:` repaints with the glyph once it's ready.
const segments = computed(() => splitTextByTokens(props.text, null, null, null, emojiFn()));
</script>
