<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  A secondary line of facts — "from Bot | libera | 4.0 KB | 2h ago" — with the
  separators drawn in the border colour, the way the status bar draws its pipes,
  so the facts stand out from what divides them. Parts that aren't there are
  dropped; a part may carry a tone (good / bad) or a class of its own.

  The separator keeps its spaces as text so a copied line reads the same as
  the rendered one. Everything sits on one template line: Vue condenses the
  whitespace between elements, so a line break here would show up as a gap.
-->

<template>
  <span class="meta-line"
    ><template v-for="(p, i) in items" :key="i"
      ><span v-if="i > 0" class="sep">{{ ` ${META_SEPARATOR} ` }}</span
      ><span :class="[p.class, p.tone]"
        ><span v-if="p.prefix" class="prefix">{{ p.prefix }}</span
        >{{ p.text }}</span
      ></template
    ></span
  >
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { META_SEPARATOR, metaParts, type MetaPart } from '../utils/metaLine.js';

const props = defineProps<{ parts: MetaPart[] }>();
const items = computed(() => metaParts(props.parts));
</script>

<style scoped>
.sep {
  color: var(--border);
}
.prefix {
  color: var(--fg-muted);
  font-weight: 400;
}
.good {
  color: var(--good);
}
.bad {
  color: var(--bad);
}
</style>
