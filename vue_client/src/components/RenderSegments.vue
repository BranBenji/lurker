<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <!-- Block quotes (#1119): the message's `> …` lines drawn as blocks, each a
       bar and faded text, the lines between them rendered by this component
       again — the segment branches below run once, on the block's segments. -->
  <template v-if="blocks">
    <template v-for="(block, bi) in blocks" :key="bi"
      ><span v-if="block.quote" class="msg-quote"
        ><RenderSegments
          :segments="block.segments"
          :self-color="selfColor"
          :network-id="networkId"
          :interactive-nicks="interactiveNicks"
          @nick-click="(nick: string, ev: MouseEvent) => $emit('nickClick', nick, ev)"
      /></span>
      <RenderSegments
        v-else
        :segments="block.segments"
        :self-color="selfColor"
        :network-id="networkId"
        :interactive-nicks="interactiveNicks"
        @nick-click="(nick: string, ev: MouseEvent) => $emit('nickClick', nick, ev)"
    /></template>
  </template>
  <template v-for="(seg, i) in blocks ? [] : segments" v-else :key="i">
    <SpoilerText v-if="seg.spoiler" :seg="seg" />
    <!-- Links render inside clickable rows (a history
         row jumps to the message on click), and a link activation shouldn't
         also fire the row's handler. onLinkClick preserves that propagation
         guard, then optionally intercepts image URLs for the viewer. -->
    <a
      v-else-if="seg.url"
      class="msg-link"
      :href="seg.url"
      target="_blank"
      rel="noreferrer noopener"
      :style="styleFor(seg)"
      @click="onLinkClick($event, seg.url!)"
      >{{ seg.text }}</a
    >
    <!-- Channel name: clickable only when a network is in scope (the message
         list passes one). Without a network — topic bar, motd — it falls
         through to the plain-text branch. @click.stop for the same row-jump
         reason as links above. -->
    <span
      v-else-if="seg.channel && networkId != null"
      class="msg-channel"
      role="button"
      tabindex="0"
      :style="styleFor(seg)"
      @click.stop="openChannel(seg.channel)"
      @keydown.enter.prevent="openChannel(seg.channel)"
      @keydown.space.prevent="openChannel(seg.channel)"
      >{{ seg.text }}</span
    >
    <!-- A coloured nick mention (seg.color / seg.self are exclusive to the nick
         pass). Interactive only when the caller opts in (the message list),
         where a click opens the same member menu as the nicklist — Reply,
         whois, DM, etc. Elsewhere nick segments fall through to the styled-span
         branch below and render exactly as before. Kept selectable so message
         text stays copyable. -->
    <span
      v-else-if="interactiveNicks && (seg.color != null || seg.self)"
      class="msg-nick"
      :style="styleFor(seg)"
      @click.stop="$emit('nickClick', seg.text, $event)"
      >{{ seg.text }}</span
    >
    <span v-else-if="hasStyle(seg)" :style="styleFor(seg)">{{ seg.text }}</span>
    <template v-else>{{ seg.text }}</template>
  </template>
</template>

<script setup lang="ts">
import { computed, type CSSProperties } from 'vue';
import type { RenderSegment } from '../utils/nickColor.js';
import { segmentInlineStyle, segmentHasStyle } from '../utils/nickColor.js';
import { quoteBlocks } from '../utils/replyText.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useSettingsStore } from '../stores/settings.js';
import { useMircPalette } from '../composables/useNickColors.js';
import { useMediaViewer } from '../composables/useMediaViewer.js';
import { mediaKindForUrl } from '../utils/uploadHostMatch.js';
import SpoilerText from './SpoilerText.vue';

// The single renderer for an array of RenderSegments (the output of
// splitTextByTokens): URLs, mIRC fg/bg colour, bold/italic/underline/strike,
// nick coloring, channel names, and spoilers. Every message-list layout and
// LinkedText funnel their segments through here, so a new segment kind only
// has to be handled in one place — no render path can silently miss it.
//
// Branch order matters: spoiler is matched first because a spoiler segment
// must never fall through to the plain <span>/text branches, which would
// reveal the hidden content. `selfColor` tints segments belonging to the
// current user; pass null where there's no message context (topic bar,
// motd, part reasons, etc.). `networkId` scopes clickable channel names to
// the network the text belongs to — pass null and channels render as plain
// text.
const props = withDefaults(
  defineProps<{
    segments: RenderSegment[];
    selfColor?: string | null;
    networkId?: number | null;
    // Opt-in: render coloured nick mentions as clickable (emits `nickClick`).
    // Off everywhere except the message list, so other callers (topic bar,
    // motd, history rows) keep nick segments inert.
    interactiveNicks?: boolean;
    // Opt-in: draw lines that open with `> ` as block quotes (#1119) — what
    // the Quote action writes above an answer, and what IRC has always typed
    // by hand. For message text; a topic or a part reason isn't quoting.
    blockquotes?: boolean;
  }>(),
  { selfColor: null, networkId: null, interactiveNicks: false, blockquotes: false },
);

defineEmits<{
  nickClick: [nick: string, ev: MouseEvent];
}>();

const buffers = useBuffersStore();
const settings = useSettingsStore();
const viewer = useMediaViewer();
const mircPalette = useMircPalette();

// Null — the plain segment list below — unless asked to and the message
// quotes. The blocks' own renderers are never asked, so the recursion is one
// level deep.
const blocks = computed(() => (props.blockquotes ? quoteBlocks(props.segments) : null));

function styleFor(seg: RenderSegment): CSSProperties {
  return segmentInlineStyle(seg, props.selfColor ?? null, mircPalette.value) as CSSProperties;
}
function hasStyle(seg: RenderSegment): boolean {
  return segmentHasStyle(seg);
}

// Any kind the viewer can show, not just images (#563): a video, an audio file, or a
// .txt now open in-app too, rather than throwing the user out to a new tab.
//
// The setting KEY still says `image_modal` — deliberately. Renaming it would orphan the
// stored row of every user who has turned the viewer off, silently switching it back on
// for exactly the people who said they didn't want it. The label they read says "Media
// viewer"; the key is just an id.
function isViewableUrl(url: string): boolean {
  if (settings.effective('chat.image_modal.enabled') !== true) return false;

  return mediaKindForUrl(url) !== null;
}

function onLinkClick(event: MouseEvent, url: string): void {
  event.stopPropagation();

  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return;
  if (!isViewableUrl(url)) return;

  event.preventDefault();
  viewer.open(url);
}

// Clicking a channel name mirrors IRCCloud. IRC channel names are
// case-insensitive but a buffer is keyed by one canonical casing, so match
// the network's open buffers case-insensitively: if one already exists here,
// just switch to it. Otherwise hand off to the server (`open-buffer`), which
// reopens a since-closed buffer — re-seeding its history, no re-JOIN — or
// joins a never-visited channel, then replies `buffer-opened` with the
// canonical target for us to focus. We don't activate optimistically: the
// message's casing may differ from the canonical one, and a mis-cased
// activate would leave a stray empty buffer behind.
function openChannel(channel: string): void {
  const nid = props.networkId;
  if (nid == null) return;
  const lower = channel.toLowerCase();
  const existing = buffers.forNetwork(nid).find((b) => b.target.toLowerCase() === lower);
  if (existing) {
    buffers.activate(nid, existing.target);
    return;
  }
  buffers.openBuffer(nid, channel);
}
</script>
