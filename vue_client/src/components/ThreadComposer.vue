<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  The thread panel's own composer (#1225). Every line sent from here is a
  reply in the thread: to the line picked with Reply in the panel, else to the
  thread's first line (threads.replyTarget). Plain on purpose — a textarea that
  sends on Enter, breaks on Shift+Enter and Tab-completes nicks from the
  channel's members. No uploads, emoji picker, drafts or slash commands: the
  channel's composer has those, and a /command typed here is refused rather
  than sent as text.

  The `nick: ` address goes on at send, as the channel's Reply puts it in the
  draft: it is what a client without reply tags sees. Never for your own line
  or in a DM (privateTarget), and the panel strips it on display.
-->

<template>
  <div class="thread-composer">
    <div class="replying">
      <template v-if="pending">
        <span class="label">Replying to</span>
        <NickRef :nick="pending.nick" />
        <button
          type="button"
          class="link clear"
          title="Reply to the thread instead"
          @click="clearPending"
        >
          <XIcon />
        </button>
      </template>
      <span v-else class="label">Replying in thread</span>
    </div>
    <textarea
      ref="inputEl"
      v-model="text"
      class="input"
      rows="1"
      :placeholder="placeholder"
      :disabled="!canSend"
      @keydown="onKeydown"
      @input="onInput"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { XIcon } from '@lucide/vue';
import NickRef from './NickRef.vue';
import { useThreadsStore } from '../stores/threads.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useNetworksStore } from '../stores/networks.js';
import { useToastsStore } from '../stores/toasts.js';
import { socketSendWithAck } from '../composables/useSocket.js';
import { privateTarget, replyTagsGoOut } from '../composables/useMessageActions.js';
import { applySpoilerMarkup } from '../utils/spoilerMarkup.js';

const threads = useThreadsStore();
const buffers = useBuffersStore();
const networks = useNetworksStore();
const toasts = useToastsStore();

const inputEl = ref<HTMLTextAreaElement | null>(null);
const text = ref('');

const view = computed(() => threads.view);
const pending = computed(() => threads.pending);
const buffer = computed(() => (view.value ? buffers.byId(view.value.bufferId) : null));

// A send needs the network up and carrying reply tags: a line sent without
// one would land in the channel as a plain line, outside the thread.
const canSend = computed(() => {
  const v = view.value;
  if (!v || v.loading) return false;
  return replyTagsGoOut(v.networkId) && threads.replyTarget() != null;
});

const placeholder = computed(() => {
  if (!view.value) return '';
  if (!canSend.value) return 'Can’t reply here right now';
  return 'Reply…';
});

function clearPending(): void {
  threads.setPending(null);
  focus();
}

function focus(): void {
  inputEl.value?.focus();
}

defineExpose({ focus });

onMounted(() => autosize());

// Picking a line to answer brings the caret here.
watch(pending, (p) => {
  if (p) void nextTick(focus);
});

// Anything typed (or pasted) ends a Tab cycle: the word under the caret is
// the user's again.
function onInput(): void {
  cycle = null;
  autosize();
}

function autosize(): void {
  const el = inputEl.value;
  if (!el) return;
  el.style.height = 'auto';
  // Up to ~6 lines, then it scrolls.
  const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
  el.style.height = `${Math.min(el.scrollHeight, line * 6 + 12)}px`;
}

// ─── Tab completion ───────────────────────────────────────────────────────
// The word before the caret, matched against the channel's members (then the
// thread's speakers, for a DM or a line from someone who left). Tab cycles;
// any other key ends the cycle.
let cycle: { prefix: string; start: number; matches: string[]; index: number } | null = null;

function candidates(prefix: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (nick: string | undefined) => {
    if (!nick) return;
    const lc = nick.toLowerCase();
    if (seen.has(lc) || !lc.startsWith(prefix.toLowerCase())) return;
    seen.add(lc);
    out.push(nick);
  };
  for (const m of buffer.value?.members ?? []) add(m.nick);
  const v = view.value;
  if (v) {
    if (v.root) add(String(v.root.nick ?? ''));
    for (const r of v.replies) add(String(r.nick ?? ''));
  }
  return out;
}

function completeNick(): void {
  const el = inputEl.value;
  if (!el) return;
  const caret = el.selectionStart ?? text.value.length;
  if (!cycle) {
    const before = text.value.slice(0, caret);
    const start = Math.max(before.lastIndexOf(' '), before.lastIndexOf('\n')) + 1;
    const prefix = before.slice(start);
    if (!prefix) return;
    const matches = candidates(prefix);
    if (matches.length === 0) return;
    cycle = { prefix, start, matches, index: 0 };
  } else {
    cycle.index = (cycle.index + 1) % cycle.matches.length;
  }
  const nick = cycle.matches[cycle.index];
  const atLineStart = cycle.start === 0 || text.value[cycle.start - 1] === '\n';
  const insert = atLineStart ? `${nick}: ` : `${nick} `;
  const after = text.value.slice(caret);
  text.value = text.value.slice(0, cycle.start) + insert + after;
  const pos = cycle.start + insert.length;
  void nextTick(() => {
    el.setSelectionRange(pos, pos);
    autosize();
  });
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    completeNick();
    return;
  }
  cycle = null;
  if (e.key === 'Escape' && pending.value) {
    e.preventDefault();
    clearPending();
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void submit();
  }
}

// ─── Sending ──────────────────────────────────────────────────────────────

async function submit(): Promise<void> {
  const v = view.value;
  const raw = text.value;
  const body = raw.trim();
  if (!v || !body || !canSend.value) return;
  // A /command would go out as a line in the thread (`/msg bob password`
  // included). The channel's composer runs commands; this one doesn't.
  if (body.startsWith('/') && !body.startsWith('//')) {
    toasts.push({
      title: 'Commands don’t run in a thread',
      body: 'Type it in the channel’s composer instead.',
      kind: 'warn',
      ttlMs: 5000,
    });
    return;
  }
  const target = threads.replyTarget();
  if (!target) return;
  const line = body.startsWith('//') ? body.slice(1) : body;
  // The address a client without reply tags reads the reply by — unless the
  // line is ours (nobody to address) or the thread is in a DM.
  const own = target.self || networks.isOwnNick(v.networkId, target.nick);
  const addressed =
    own || !target.nick || privateTarget(v.target) ? line : `${target.nick}: ${line}`;
  const sent = socketSendWithAck({
    type: 'send',
    networkId: v.networkId,
    target: v.target,
    text: applySpoilerMarkup(addressed),
    replyTo: target.messageId,
  });
  if (!sent) {
    toasts.push({
      title: 'Not connected',
      body: 'Your reply wasn’t sent. Try again once Lurker reconnects.',
      kind: 'error',
      ttlMs: 6000,
    });
    return;
  }
  text.value = '';
  threads.setPending(null);
  await nextTick();
  autosize();
  const result = await sent;
  if (!result.ok) {
    toasts.push({
      title: 'Reply not sent',
      body: result.error ?? 'The server refused it.',
      kind: 'error',
      ttlMs: 6000,
    });
    // Give the words back if nothing new was typed meanwhile.
    if (!text.value) text.value = raw;
  }
}
</script>

<style scoped>
.thread-composer {
  flex: 0 0 auto;
  border-top: 1px solid var(--border);
  padding: var(--space-3) var(--space-4) var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.replying {
  display: flex;
  align-items: center;
  gap: 1ch;
  color: var(--fg-muted);
  min-height: 1lh;
}
.replying .clear {
  display: inline-flex;
  align-items: center;
  background: none;
  border: none;
  padding: 0;
  margin-left: auto;
  cursor: pointer;
  color: var(--fg-muted);
}
.replying .clear:hover {
  color: var(--fg);
}
.input {
  width: 100%;
  resize: none;
  box-sizing: border-box;
  background: var(--bg-soft);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--space-3) var(--space-4);
  font: inherit;
  line-height: 1.4;
  overflow-y: auto;
}
.input:focus {
  outline: none;
  border-color: var(--accent);
}
.input:disabled {
  opacity: 0.6;
}
</style>
