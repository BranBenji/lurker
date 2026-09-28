<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  An IRCv3 reply's quote (#993): the line it answers, as the first line of the
  reply's own body — the counterpart of ReactionRow under the text. Part of the
  message, so a reply doesn't break its author's run of lines.

  Written the way IRC writes the line — `<alice> text`, `* bob waves`,
  `-ChanServ- text` — after a box-drawing arm (the list's other markers are
  plain text, and the square corner matches the buffer list's lines), so it
  reads as what was said, not as a sentence starting with a name. One clipped
  line, italic, faded with opacity so the quoted nick keeps its own colour.
  Clicking (or Enter/Space) jumps to the line; with no parent to show it says
  so and does nothing. Out of the buffer (search, activity, bookmarks — #998)
  it's `static`: part of the row, whose click jumps to the reply, where this
  quote is live again.
-->

<template>
  <span
    class="reply-quote"
    :class="{ missing: !parent, static: $props.static }"
    :title="live ? 'Jump to this message' : undefined"
    :role="live ? 'button' : undefined"
    :tabindex="live ? 0 : undefined"
    @click="onClick"
    @keydown.enter.space="onKey"
    ><span class="reply-mark" role="img" aria-label="In reply to">╭─</span
    ><span class="reply-text"
      ><template v-if="parent"
        >{{ marks[0]
        }}<NickRef :nick="parent.nick" :self="parent.relayBot ? undefined : parent.self" />{{
          marks[1]
        }}
        <span
          v-if="parent.relaySource"
          class="reply-relay"
          :title="`Relayed via ${parent.relayBot}`"
          >[{{ parent.relaySource }}] </span
        >{{ replyExcerpt(parent.text) }}</template
      ><template v-else>original message unavailable</template></span
    ></span
  >
</template>

<script setup lang="ts">
import { computed } from 'vue';
import NickRef from './NickRef.vue';
import { replyExcerpt } from '../utils/replyText.js';
import type { QuotedLine, ReplyParent } from '../../../shared/replies.js';

const props = defineProps<{
  // The answered line as it should show — null for "unavailable" (gone, never
  // held, or from someone ignored; useReplyQuote decides).
  // A relayed line comes unwrapped (QuotedLine): its colour is guessed from the
  // nick as the timeline row's is, since `self` describes the bot's line.
  parent: QuotedLine | null;
  // Not a control of its own: clicks fall through to what it sits in.
  static?: boolean;
}>();

const emit = defineEmits<{ jump: [parent: ReplyParent] }>();

const live = computed(() => !!props.parent && !props.static);

// What goes either side of the nick, by the quoted line's type.
const marks = computed((): [string, string] => {
  const type = props.parent?.type;
  if (type === 'action') return ['* ', ''];
  if (type === 'notice') return ['-', '-'];
  return ['<', '>'];
});

// In the timeline the quote keeps its clicks, even with nothing to jump to;
// static, they're the row's.
function onClick(e: MouseEvent): void {
  if (props.static) return;
  e.stopPropagation();
  if (props.parent) emit('jump', props.parent);
}

function onKey(e: KeyboardEvent): void {
  if (props.static) return;
  e.preventDefault();
  e.stopPropagation();
  if (props.parent) emit('jump', props.parent);
}
</script>

<style scoped>
.reply-quote {
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--fg);
  font-style: italic;
  opacity: 0.45;
  cursor: pointer;
}
.reply-quote:not(.missing):not(.static):hover {
  opacity: 0.8;
}
.reply-quote.missing {
  cursor: default;
}
/* Part of the row it sits in: the row's cursor, and no hover of its own. */
.reply-quote.static {
  cursor: inherit;
}
.reply-mark {
  margin-right: 1ch;
  /* Upright in the italic line: a slanted corner stops lining up. */
  font-style: normal;
  /* Nudged up off the baseline, so the arm sits level with the text's middle.
     Relative, so the line's height doesn't change. */
  position: relative;
  top: -3px;
}
</style>
