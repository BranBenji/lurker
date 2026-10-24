<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  Avatars (#607): the second bespoke section of the Appearance pane, after
  Themes. The "Show avatars" switch (a registry row rendered here rather than
  with the message rows, so it sits with what it switches on), a preview of the
  active set over the nick palette, the list of sets (the bundled ones plus
  the user's uploads) with Use/Delete, and an upload box for a zip of square
  images. Everything here is also operable via /avatars (slash-command-first).
-->

<template>
  <h3 id="avatars" class="subhead" data-setting-group="avatars">Avatars</h3>
  <p v-if="config.linkPreviews" class="section-desc">
    A square in the nick's color with a tile from the active set, or the picture someone set through
    IRCv3 metadata where the network carries it. Also <code>/avatars</code> in any buffer.
  </p>
  <p v-else class="section-desc">
    A square in the nick's color with a tile from the active set. Also <code>/avatars</code> in any
    buffer.
  </p>
  <ul class="rows">
    <SettingsRow
      :opt="showAvatarsOption"
      :value="settings.effective(showAvatarsOption.key)"
      :modified="settings.isModified(showAvatarsOption.key)"
      :baseline="settings.baseline(showAvatarsOption.key)"
      @commit="(v) => onCommit(showAvatarsOption.key, v)"
      @reset="onReset(showAvatarsOption.key)"
    />
  </ul>
  <p v-if="error" class="error inline">{{ error }}</p>

  <div class="preview" aria-label="Preview of the active avatar set">
    <NickAvatar v-for="nick in SAMPLE_NICKS" :key="nick" :nick="nick" />
  </div>

  <ul class="device-list">
    <li v-for="s in avatarSets.all" :key="s.id" class="device">
      <span class="ua">
        <span class="name">{{ s.name }}</span>
        <span class="tag">{{ s.count }} {{ s.count === 1 ? 'tile' : 'tiles' }}</span>
        <span v-if="s.builtin" class="tag">built-in</span>
        <span v-if="s.id === avatarSets.activeSetId" class="tag active">active</span>
      </span>
      <div class="row-actions">
        <button
          v-if="s.id !== avatarSets.activeSetId"
          class="link"
          :disabled="busy"
          @click="use(s)"
        >
          Use
        </button>
        <button v-if="!s.builtin" class="link danger" :disabled="busy" @click="remove(s)">
          Delete
        </button>
      </div>
    </li>
  </ul>

  <div class="upload">
    <input
      :value="newName"
      type="text"
      :maxlength="AVATAR_SET_NAME_MAX"
      :disabled="busy"
      placeholder="Name for the new set"
      @input="onNameInput"
    />
    <input
      ref="fileEl"
      type="file"
      accept=".zip,application/zip"
      :disabled="busy"
      @change="onFile"
    />
    <button class="link" :disabled="busy || !newName.trim() || !file" @click="upload">
      {{ busy && progress > 0 ? `Uploading ${progress}%` : 'Upload set' }}
    </button>
  </div>
  <p class="muted small">
    A zip of {{ AVATAR_SET_MIN_TILES }}–{{ AVATAR_SET_MAX_TILES }} square images, resized to
    {{ AVATAR_TILE_SIZE }}px. Transparent areas show the nick color through. Up to
    {{ MAX_AVATAR_SETS_PER_USER }} sets.
  </p>
  <p v-if="lastSkipped.length" class="muted small">
    Skipped: {{ lastSkipped.map((s) => `${s.name} (${s.reason})`).join(', ') }}
  </p>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useAvatarSetsStore, type AvatarSetEntry } from '../../stores/avatarSets.js';
import { useSettingsStore } from '../../stores/settings.js';
import { useConfigStore } from '../../stores/config.js';
import { useImeSafeInput } from '../../composables/useImeSafeInput.js';
import { getOption } from '../../utils/settingsRegistry.js';
import type { SettingValue } from '../../../../shared/settingsRegistry.js';
import NickAvatar from '../NickAvatar.vue';
import SettingsRow from '../SettingsRow.vue';
import {
  AVATAR_SET_MAX_TILES,
  AVATAR_SET_MIN_TILES,
  AVATAR_SET_NAME_MAX,
  AVATAR_TILE_SIZE,
  MAX_AVATAR_SETS_PER_USER,
  avatarSetNameError,
} from '../../../../shared/avatarSets.js';

// Eight sample nicks: the palette's spread, and the tiles the hash hands them.
const SAMPLE_NICKS = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi'];

const avatarSets = useAvatarSetsStore();
const settings = useSettingsStore();
// A picture someone set is fetched only through the previews decoder; without
// one, everyone gets a tile, so the description doesn't promise pictures.
const config = useConfigStore();
// The switch, rendered here beside what it switches on (its category is the
// hidden `avatars`, so the registry pane leaves it to this section).
const showAvatarsOption = getOption('look.message.avatars')!;

const error = ref('');
const busy = ref(false);
const progress = ref(0);
const newName = ref('');
const onNameInput = useImeSafeInput(newName);
const file = ref<File | null>(null);
const fileEl = ref<HTMLInputElement | null>(null);
const lastSkipped = ref<Array<{ name: string; reason: string }>>([]);

onMounted(() => {
  void avatarSets.ensureBuiltins();
  if (!avatarSets.loaded) {
    avatarSets.fetchAll().catch(() => {
      /* the list renders what it has */
    });
  }
});

async function onCommit(key: string, value: SettingValue) {
  error.value = '';
  try {
    await settings.setValue(key, value);
  } catch (e: any) {
    error.value = e?.message || 'failed to save';
  }
}

async function onReset(key: string) {
  error.value = '';
  try {
    await settings.reset(key);
  } catch (e: any) {
    error.value = e?.message || 'failed to reset';
  }
}

async function run(fn: () => Promise<void>) {
  if (busy.value) return;
  error.value = '';
  busy.value = true;
  try {
    await fn();
  } catch (e: any) {
    error.value = e?.message || 'failed';
  } finally {
    busy.value = false;
    progress.value = 0;
  }
}

function onFile(e: Event) {
  const input = e.target as HTMLInputElement;
  file.value = input.files?.[0] ?? null;
}

function use(s: AvatarSetEntry) {
  void run(() => avatarSets.use(s.id));
}

function remove(s: AvatarSetEntry) {
  const active = s.id === avatarSets.activeSetId;
  if (
    !confirm(
      `Delete avatar set ${s.name}? This can't be undone.${active ? ' Avatars go back to the default set.' : ''}`,
    )
  ) {
    return;
  }
  void run(() => avatarSets.remove(Number(s.id)));
}

function upload() {
  const name = newName.value.trim();
  const zip = file.value;
  if (!name || !zip) return;
  const err = avatarSetNameError(name);
  if (err) {
    error.value = err;
    return;
  }
  void run(async () => {
    const result = await avatarSets.upload(name, zip, (p) => {
      progress.value = p;
    });
    lastSkipped.value = result.skipped;
    newName.value = '';
    file.value = null;
    if (fileEl.value) fileEl.value.value = '';
    await avatarSets.use(String(result.set.id));
  });
}
</script>

<style src="./panes.css"></style>
<style scoped>
.rows {
  list-style: none;
  margin: 0 0 var(--space-5);
  padding: 0;
}
.tag {
  color: var(--fg-muted);
}
.tag.active {
  color: var(--accent);
}
.preview {
  --avatar-size: 2.5em;
  display: flex;
  gap: var(--space-4);
  flex-wrap: wrap;
  margin: var(--space-4) 0 var(--space-6);
}
.upload {
  display: flex;
  gap: var(--space-4);
  align-items: center;
  flex-wrap: wrap;
  margin: var(--space-5) 0 0;
}
.upload input[type='text'] {
  flex: 0 1 24ch;
  font: inherit;
  color: var(--fg);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 4px);
  padding: var(--space-2) var(--space-4);
}
.upload input[type='file'] {
  font: inherit;
  color: var(--fg-muted);
  max-width: 100%;
}
</style>
