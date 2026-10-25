<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  The reply thread panel (#1225): on desktop it takes the member column, on
  mobile it is a screen over the buffer. Two modes, by route (useThreadRoute):

    thread — the line that started it, a rule with the count, then every reply
             flat and in order, each with the channel's time and `<nick>`, its
             reactions, and the quote when it answers something other than the
             first line. Lines have the message list's actions (Reply, React,
             Bookmark, …; Reply here picks the line the panel's composer
             answers). The composer is at the bottom.
    list   — the buffer's threads by last activity (ThreadList).

  With the thread on screen, replies the user hasn't seen are read as they are
  shown (threads.markViewRead); the channel's own lines are untouched.
-->

<template>
  <div class="thread-panel" :class="{ 'is-list': mode === 'list' }">
    <header class="panel-head">
      <button
        v-if="mode === 'thread'"
        type="button"
        class="link"
        title="All threads here"
        aria-label="All threads here"
        @click="showList"
      >
        <ListTreeIcon />
      </button>
      <span class="panel-title">{{ mode === 'list' ? 'Threads' : 'Thread' }}</span>
      <button type="button" class="link close" title="Close" aria-label="Close" @click="close">
        <XIcon />
      </button>
    </header>

    <ThreadList v-if="mode === 'list' && bufferId != null" :buffer-id="bufferId" />

    <template v-else>
      <div ref="scroller" class="lines" @scroll.passive="onScroll">
        <div
          v-if="!view || (view.loading && !view.root && view.replies.length === 0)"
          class="notice"
        >
          loading thread…
        </div>
        <template v-else>
          <template v-for="row in rows" :key="row.key">
            <div v-if="row.rule" class="rule">
              <span>{{ row.rule }}</span>
            </div>
            <div v-else-if="row.missing" class="t-line missing" :class="{ root: row.root }">
              <span class="t-body missing">original message unavailable</span>
            </div>
            <div
              v-else-if="row.line"
              class="t-line"
              :class="lineClass(row)"
              :data-msg-id="row.line.id"
              @click="onLineClick($event, row.line)"
            >
              <ReplyQuote
                v-if="row.quote !== undefined"
                class="t-quote"
                :parent="row.quote"
                :network-id="view?.networkId ?? null"
                @jump="scrollToParent"
              />
              <div class="t-row">
                <span class="time" :title="fullTime(row.line)">{{ time(row.line) }}</span>
                <span v-if="hidden(row.line)" class="t-body missing">(ignored)</span>
                <span
                  v-else
                  class="t-body"
                  :class="{ italic: row.line.type === 'action' && actionItalic }"
                  ><span class="t-nick"
                    >{{ marks(row.line)[0] }}<NickRef :nick="String(row.line.nick ?? '')" />{{
                      marks(row.line)[1]
                    }}</span
                  >{{ ' '
                  }}<RenderSegments
                    :segments="segments(row.line, row.text)"
                    :self-color="selfColor"
                    :network-id="view?.networkId ?? null"
                    blockquotes /><ReactionRow
                    v-if="view"
                    :message="{ ...row.line, networkId: view.networkId }"
                    :interactive="row.line.type !== 'notice' && !row.line.e2e"
                /></span>
              </div>
              <div
                v-if="hoverActions && eligible(row.line)"
                class="row-actions"
                role="group"
                aria-label="Message actions"
              >
                <button
                  v-for="a in actionsFor(row.line)"
                  :key="a.key"
                  type="button"
                  class="row-action"
                  :class="{ active: a.active }"
                  :title="a.label"
                  :aria-label="a.label"
                  @click.stop="runAction(a.key, row.line)"
                >
                  <component :is="a.icon" />
                </button>
              </div>
            </div>
          </template>
          <div v-if="view.truncated" class="notice">
            this thread is longer than can be shown at once — its oldest replies aren’t shown
          </div>
        </template>
      </div>
      <ThreadComposer ref="composerRef" />
    </template>
  </div>
  <IgnoreModal
    v-if="ignoreTarget"
    :nick="ignoreTarget.nick"
    :user="ignoreTarget.user"
    :host="ignoreTarget.host"
    :network-id="ignoreTarget.networkId"
    @close="ignoreTarget = null"
  />
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { ListTreeIcon, XIcon } from '@lucide/vue';
import NickRef from './NickRef.vue';
import RenderSegments from './RenderSegments.vue';
import ReactionRow from './ReactionRow.vue';
import ReplyQuote from './ReplyQuote.vue';
import IgnoreModal from './IgnoreModal.vue';
import ThreadList from './ThreadList.vue';
import ThreadComposer from './ThreadComposer.vue';
import { useThreadsStore } from '../stores/threads.js';
import type { ThreadMessage } from '../stores/threads.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useNetworksStore } from '../stores/networks.js';
import { useSettingsStore } from '../stores/settings.js';
import { useIgnoresStore } from '../stores/ignores.js';
import { useNickColors } from '../composables/useNickColors.js';
import { useViewport } from '../composables/useViewport.js';
import { useReplyQuote } from '../composables/useReplyQuote.js';
import { useThreadRoute, requestThreadNav } from '../composables/useThreadNav.js';
import { useMessageActions } from '../composables/useMessageActions.js';
import { useContextMenu } from '../composables/useContextMenu.js';
import type {
  MessageActionKey,
  MessageAction,
  MessageContext,
  MessageLike,
} from '../composables/useMessageActions.js';
import { onSocketOpen } from '../composables/useSocket.js';
import { formatTimestamp } from '../utils/timestamp.js';
import { parseUserHost } from '../utils/userhost.js';
import { stripReplyAddress } from '../utils/replyText.js';
import type { RenderSegment } from '../utils/nickColor.js';
import type { QuotedLine, ReplyParent } from '../../../shared/replies.js';
import { REPLY_LINE_TYPES, quoteMarks } from '../../../shared/replies.js';

const threads = useThreadsStore();
const buffers = useBuffersStore();
const networks = useNetworksStore();
const settings = useSettingsStore();
const ignores = useIgnoresStore();
const nicks = useNickColors();
const { canHover } = useViewport();
const replyQuote = useReplyQuote();
const threadRoute = useThreadRoute();
const messageActions = useMessageActions();
const contextMenu = useContextMenu();

const scroller = ref<HTMLElement | null>(null);
const composerRef = ref<{ focus: () => void } | null>(null);
const ignoreTarget = ref<{
  nick: string;
  user: string | null;
  host: string | null;
  networkId: number | null;
} | null>(null);

const mode = computed(() => threadRoute.value?.mode ?? 'thread');
const bufferId = computed(() => threadRoute.value?.bufferId ?? null);
const view = computed(() => threads.view);
const buffer = computed(() => (view.value ? buffers.byId(view.value.bufferId) : null));
const pending = computed(() => threads.pending);

const hoverActions = computed(
  () => canHover.value && !!settings.effective('look.message.hover_actions'),
);
const actionItalic = computed(() => !!settings.effective('look.action.italic'));
const selfColor = computed<string | null>(
  () => (settings.effective('look.nick.self_color') as string | undefined) ?? null,
);
const tsFormat = computed(() => settings.effective('look.buffer.time_format') as string);

// ─── Route → store ───────────────────────────────────────────────────────

// Open whatever the route names; a new thread (or the same one re-entered)
// reloads. The buffer arrives over the socket after a cold deep link, so this
// also waits on it.
watch(
  () => {
    const r = threadRoute.value;
    if (!r) return null;
    const ready = buffers.byId(r.bufferId) != null;
    return r.mode === 'list'
      ? `list|${r.bufferId}|${ready}`
      : `${r.bufferId}|${r.rootMsgid}|${ready}`;
  },
  () => {
    const r = threadRoute.value;
    if (!r || !buffers.byId(r.bufferId)) return;
    // One mode at a time: the other's state goes, so a thread left behind
    // isn't read as replies land while the list is up.
    if (r.mode === 'list') {
      threads.close();
      threads.openList(r.bufferId);
    } else {
      threads.closeList();
      threads.open(r.bufferId, r.rootMsgid);
    }
  },
  { immediate: true },
);

// A dropped socket's gap-fill reaches the channel, not this view: ask again.
const offOpen = onSocketOpen(() => {
  const v = threads.view;
  if (v) threads.open(v.bufferId, v.rootMsgid);
  const l = threads.list;
  if (l) threads.openList(l.bufferId);
});

onBeforeUnmount(() => {
  offOpen();
  threads.close();
  threads.closeList();
});

function close(): void {
  const id = bufferId.value;
  if (id != null) requestThreadNav({ kind: 'close', bufferId: id });
}

function showList(): void {
  const id = bufferId.value;
  if (id != null) requestThreadNav({ kind: 'list', bufferId: id });
}

// ─── Rows ────────────────────────────────────────────────────────────────

interface Row {
  key: string;
  line?: ThreadMessage;
  // The line's text as shown: without the `nick: ` its quote makes redundant.
  text?: string;
  // Set (even to null) when the line answers something other than the first
  // line: the quote to draw above it. Undefined: no quote.
  quote?: QuotedLine | null;
  root?: boolean;
  missing?: boolean;
  rule?: string;
}

const rows = computed((): Row[] => {
  const v = view.value;
  if (!v) return [];
  const out: Row[] = [];
  if (v.root) {
    out.push({ key: 'root', line: v.root, text: String(v.root.text ?? ''), root: true });
  } else {
    out.push({ key: 'root', missing: true, root: true });
  }
  const n = v.replies.length;
  out.push({
    key: 'rule',
    rule: n === 0 ? 'no replies yet' : `${n} ${n === 1 ? 'reply' : 'replies'}`,
  });
  for (const r of v.replies) {
    let text = String(r.text ?? '');
    let quote: QuotedLine | null | undefined;
    if (r.replyTo) {
      const shown = replyQuote.shownReply(r.replyTo, r, v.networkId, v.target);
      text = shown.text;
      // Answering the first line is the thread's default; only another parent
      // gets a quote. The first line is on screen above, so the address naming
      // its author is redundant here even when the quote's lookup had nothing.
      if (r.replyTo.msgid !== v.rootMsgid) quote = shown.parent;
      else if (v.root?.nick && r.type === 'message') {
        text = stripReplyAddress(text, String(v.root.nick));
      }
    }
    out.push({ key: String(r.id), line: r, text, quote });
  }
  return out;
});

function time(m: ThreadMessage): string {
  return m.time ? formatTimestamp(m.time, tsFormat.value ?? '') : '';
}

function fullTime(m: ThreadMessage): string | undefined {
  return m.time ? new Date(m.time).toLocaleString() : undefined;
}

function marks(m: ThreadMessage): [string, string] {
  return quoteMarks(m.type);
}

function lineClass(row: Row) {
  const m = row.line;
  return {
    root: !!row.root,
    self: !!m?.self,
    highlight: !!m && !m.self && (!!m.matched || !!m.replyToSelf),
    replying: !!m && pending.value?.messageId === m.id,
  };
}

// Someone ignored — when it arrived (the server's stamp) or since. The line
// keeps its place so the thread reads whole.
function hidden(m: ThreadMessage): boolean {
  if (m.fromIgnored) return true;
  if (m.self || !m.nick || view.value == null) return false;
  return ignores.evaluate(view.value.networkId, {
    nick: String(m.nick),
    userhost: (m.userhost as string | null | undefined) ?? null,
    target: view.value.target,
    text: String(m.text ?? ''),
    type: m.type,
    isDm: buffer.value?.kind === 'dm',
  }).hide;
}

const selfLower = computed(() => {
  const n = view.value ? networks.states[view.value.networkId]?.nick : null;
  return n ? n.toLowerCase() : null;
});

const nickSet = computed((): Set<string> => {
  const set = new Set<string>();
  for (const mem of buffer.value?.members || []) if (mem.nick) set.add(mem.nick);
  const v = view.value;
  if (v) {
    if (v.root?.nick) set.add(String(v.root.nick));
    for (const r of v.replies) if (r.nick) set.add(String(r.nick));
  }
  return set;
});

function segments(m: ThreadMessage, text: string | undefined): RenderSegment[] {
  const body = text ?? String(m.text ?? '');
  return nicks.splitText(body, nickSet.value, selfLower.value) as RenderSegment[];
}

// ─── Scrolling and read state ────────────────────────────────────────────

const atBottom = ref(true);
function onScroll(): void {
  const el = scroller.value;
  if (!el) return;
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
}

function scrollToBottom(): void {
  const el = scroller.value;
  if (el) el.scrollTop = el.scrollHeight;
}

function scrollToId(id: number, pulse: boolean): boolean {
  const el = scroller.value?.querySelector(`[data-msg-id="${id}"]`);
  if (!(el instanceof HTMLElement)) return false;
  el.scrollIntoView({ block: 'center' });
  if (pulse) {
    el.classList.add('scroll-target');
    setTimeout(() => el.classList.remove('scroll-target'), 1500);
  }
  return true;
}

// The quote above a reply: its parent is in this thread, so bring it into view.
function scrollToParent(parent: ReplyParent): void {
  scrollToId(parent.id, true);
}

// Loaded: the newest replies, or the reply the route names (`?focus=`) — also
// when a jump names another reply in the thread already open.
watch(
  () =>
    [
      view.value?.loading,
      view.value?.rootMsgid,
      threadRoute.value?.mode === 'thread' ? threadRoute.value.focusId : null,
    ] as const,
  async ([loading]) => {
    if (loading !== false) return;
    await nextTick();
    const focusId = threadRoute.value?.mode === 'thread' ? threadRoute.value.focusId : null;
    if (!focusId || !scrollToId(focusId, true)) scrollToBottom();
    atBottom.value = !focusId;
  },
  { immediate: true },
);

// A reply arriving while the user reads the end follows it down, as the
// message list does.
watch(
  () => view.value?.replies.length,
  async () => {
    if (!atBottom.value) return;
    await nextTick();
    scrollToBottom();
  },
);

// Read as it's shown: on load, as replies arrive while it's open — and when
// the server's count for it moves, since a reply's `irc` frame lands before
// the `threads-changed` that counts it.
watch(
  () => [
    view.value?.loading,
    view.value?.replies.length,
    view.value && threads.unreadFor(view.value.bufferId, view.value.rootMsgid),
  ],
  () => threads.markViewRead(),
);

// ─── Actions ─────────────────────────────────────────────────────────────

function eligible(m: ThreadMessage): boolean {
  return REPLY_LINE_TYPES.includes(m.type);
}

function asLike(m: ThreadMessage): MessageLike {
  return { ...m, networkId: view.value?.networkId } as unknown as MessageLike;
}

// Reply in the panel picks the line the composer answers (marked here, named
// above the composer). The composer adds the `nick: ` at send.
function startReply(m: ThreadMessage): void {
  if (!m.msgid || !m.nick) return;
  threads.setPending({
    messageId: m.id,
    nick: String(m.nick),
    type: m.type,
    text: String(m.text ?? ''),
    self: !!m.self,
  });
  composerRef.value?.focus();
}

const actionContext: MessageContext = {
  get networkId() {
    return view.value?.networkId ?? 0;
  },
  onReply: (msg: MessageLike) => startReply(msg as ThreadMessage),
  // Quote isn't offered here (every send from the panel already carries a reply
  // tag, and a quote line would take it): the actions below leave it out.
  onQuote: () => {},
  onIgnore: (msg: MessageLike) => {
    const { user, host } = parseUserHost(msg.userhost);
    ignoreTarget.value = {
      nick: msg.nick ?? '',
      user,
      host,
      networkId: view.value?.networkId ?? null,
    };
  },
};

function actionsFor(m: ThreadMessage): MessageAction[] {
  return messageActions.buildActions(asLike(m)).filter((a) => a.key !== 'quote');
}

function runAction(key: MessageActionKey, m: ThreadMessage): void {
  messageActions.run(key, asLike(m), actionContext);
}

// No hover bar (touch, or turned off): a tap opens the same actions as a menu.
function onLineClick(e: MouseEvent, m: ThreadMessage): void {
  if (!eligible(m) || hoverActions.value) return;
  if ((e.target as Element | null)?.closest('a, button')) return;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return;
  const items = messageActions
    .buildItems(asLike(m), actionContext)
    .filter((i) => !i.label?.startsWith('Quote '));
  if (items.length === 0) return;
  contextMenu.open(items, e.clientX, e.clientY, e.currentTarget as Element);
}
</script>

<style scoped>
.thread-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  min-width: 0;
}
.panel-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
}
.panel-head .link {
  display: inline-flex;
  align-items: center;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  font: inherit;
  color: var(--fg-muted);
}
.panel-head .link:hover {
  color: var(--fg);
}
.panel-head .close {
  margin-left: auto;
}
.panel-title {
  color: var(--accent);
  font-weight: bold;
}

.lines {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-2) 0;
  line-height: 1.55;
}
.notice {
  color: var(--fg-muted);
  font-style: italic;
  padding: var(--space-2) var(--space-4);
}
.rule {
  display: flex;
  align-items: center;
  gap: 1ch;
  color: var(--fg-muted);
  padding: var(--space-2) var(--space-4);
}
.rule::before,
.rule::after {
  content: '';
  flex: 1;
  border-top: 1px solid var(--border);
}

.t-line {
  position: relative;
  padding: var(--space-1) var(--space-4);
}
.t-line:hover {
  background: var(--bg-soft);
}
.t-line.highlight {
  background: color-mix(in srgb, var(--warn) 12%, transparent);
}
/* The line the composer is answering: the accent bar the active buffer row
   wears, over the hover shade. */
.t-line.replying {
  background: var(--bg-soft);
  box-shadow: inset 2px 0 var(--accent);
}
.t-line.scroll-target {
  animation: thread-scroll-target 1.5s ease-out;
}
@keyframes thread-scroll-target {
  0% {
    background: color-mix(in srgb, var(--accent) 30%, transparent);
  }
  100% {
    background: transparent;
  }
}
.t-quote {
  display: block;
}
.t-row {
  display: flex;
  align-items: baseline;
  min-width: 0;
}
.time {
  color: var(--fg-muted);
  padding-right: 1ch;
  white-space: nowrap;
}
.t-body {
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.t-body.italic {
  font-style: italic;
}
.t-body.missing,
.t-line.missing .t-body {
  color: var(--fg-muted);
  font-style: italic;
}
.t-nick {
  white-space: nowrap;
}

/* The message list's hover bar. */
.row-actions {
  position: absolute;
  top: var(--space-2);
  right: var(--space-3);
  transform: translateY(-100%);
  display: flex;
  align-items: center;
  gap: var(--space-1);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-popover);
  padding: var(--space-1);
  opacity: 0;
  pointer-events: none;
  z-index: var(--z-base);
}
/* The first line sits at the top of the scroller, where a bar floated above
   it would be clipped: hang it below instead. */
.t-line.root .row-actions {
  top: auto;
  bottom: var(--space-2);
  transform: translateY(100%);
}
.row-actions:focus-within,
.t-line:hover .row-actions {
  opacity: 1;
  pointer-events: auto;
}
.row-action {
  background: none;
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border-radius: var(--radius-sm);
}
.row-action:hover {
  color: var(--fg);
}
.row-action.active {
  color: var(--accent);
}
</style>
