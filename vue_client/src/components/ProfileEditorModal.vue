<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  Your own IRCv3 metadata on one network (#1189): what Lurker saves and sets
  again after every connect. The slash commands (/displayname, /avatar,
  /metadata) write the same rows; this is the view of them. Saving sends only
  the fields that changed, and the server sets what it lacks now if the
  network is connected, else at the next connect.
-->

<template>
  <AppModal word="profile" :title="`profile on ${networkName}`" size="sm" @close="close">
    <form class="modal-form" @submit.prevent="save">
      <div class="profile-form">
        <p v-if="refusal" class="hint">Not here: {{ refusal }}.</p>
        <p v-else-if="!connected" class="hint">Not connected: saved now, set when it connects.</p>
        <div class="fields">
          <label>
            <span class="title">Display name</span>
            <input
              :disabled="locked"
              :value="form['display-name']"
              @input="form['display-name'] = imeSafeValue($event)"
              @keydown.enter="blockImeEnter"
              :maxlength="max('display-name')"
              autocomplete="off"
            />
            <small v-if="form['display-name']">
              Shows as <RenderSegments :segments="displayNameSegments" />
            </small>
          </label>
          <label>
            <span class="title">Avatar URL</span>
            <div class="avatar-row">
              <img v-if="avatarPreview" class="avatar" :src="avatarPreview" alt="" />
              <input
                :disabled="locked"
                :value="form.avatar"
                @input="form.avatar = imeSafeValue($event)"
                @keydown.enter="blockImeEnter"
                type="url"
                :maxlength="max('avatar')"
                placeholder="https://…/me.png"
                autocomplete="off"
              />
            </div>
          </label>
          <label>
            <span class="title">Pronouns</span>
            <input
              :disabled="locked"
              :value="form.pronouns"
              @input="form.pronouns = imeSafeValue($event)"
              @keydown.enter="blockImeEnter"
              :maxlength="max('pronouns')"
              autocomplete="off"
            />
          </label>
          <label>
            <span class="title">Homepage</span>
            <input
              :disabled="locked"
              :value="form.homepage"
              @input="form.homepage = imeSafeValue($event)"
              @keydown.enter="blockImeEnter"
              type="url"
              :maxlength="max('homepage')"
              placeholder="https://…"
              autocomplete="off"
            />
          </label>
          <label>
            <span class="title">Status</span>
            <input
              :disabled="locked"
              :value="form.status"
              @input="form.status = imeSafeValue($event)"
              @keydown.enter="blockImeEnter"
              :maxlength="max('status')"
              autocomplete="off"
            />
          </label>
          <label v-if="otherNetworks.length">
            <span class="title">Copy from</span>
            <select
              :disabled="locked"
              :value="''"
              @change="copyFrom(($event.target as HTMLSelectElement).value)"
            >
              <option value="" disabled>another network…</option>
              <option v-for="net in otherNetworks" :key="net.id" :value="String(net.id)">
                {{ net.name }}
              </option>
            </select>
          </label>
        </div>
        <p v-if="limitsText" class="meta">{{ limitsText }}</p>
        <p v-if="error" class="error">{{ error }}</p>
      </div>
      <footer class="modal-footer">
        <button type="button" class="btn-secondary" @click="close">Cancel</button>
        <button type="submit" class="btn-primary" :disabled="!dirty || !!refusal || saving">
          Save
        </button>
      </footer>
    </form>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import AppModal from './AppModal.vue';
import RenderSegments from './RenderSegments.vue';
import { useNetworksStore } from '../stores/networks.js';
import { useProfileEditor } from '../composables/useProfileEditor.js';
import { blockImeEnter, imeSafeValue } from '../composables/useImeSafeInput.js';
import { formattingSegments } from '../utils/nickColor.js';
import { ownMetadataRefusal } from '../lib/commands/metadata.js';
import { fetchOwnMetadata, saveOwnMetadata, type OwnMetadata } from '../utils/ownMetadata.js';
import {
  METADATA_EXTRA_VALUE_MAX_CHARS,
  METADATA_VALUE_MAX_CHARS,
} from '../../../shared/metadataKeys.js';

const props = defineProps<{ networkId: number }>();

const FIELDS = ['display-name', 'avatar', 'pronouns', 'homepage', 'status'] as const;
type Field = (typeof FIELDS)[number];

const networks = useNetworksStore();
const editor = useProfileEditor();

const form = reactive<Record<Field, string>>(blank());
const initial = ref<Record<Field, string>>(blank());
const avatarPreview = ref<string | null>(null);
const loading = ref(true);
const saving = ref(false);
const error = ref('');

const networkName = computed(
  () => networks.networks.find((n) => n.id === props.networkId)?.name ?? 'network',
);
const netState = computed(() => networks.states[props.networkId]);
const connected = computed(() => netState.value?.state === 'connected');
const refusal = computed(() => ownMetadataRefusal(netState.value));
const otherNetworks = computed(() => networks.networks.filter((n) => n.id !== props.networkId));
const displayNameSegments = computed(() => formattingSegments(form['display-name']));
const locked = computed(() => !!refusal.value || loading.value);
const dirty = computed(() => FIELDS.some((f) => form[f].trim() !== initial.value[f]));

const limitsText = computed(() => {
  const limits = netState.value?.metadataLimits;
  if (!connected.value || !limits || refusal.value) return '';
  const parts: string[] = [];
  if (limits.maxKeys) parts.push(`${limits.maxKeys} keys`);
  if (limits.maxValueBytes) parts.push(`${limits.maxValueBytes} bytes a value`);
  return parts.length ? `This server allows ${parts.join(', ')}.` : '';
});

function blank(): Record<Field, string> {
  return { 'display-name': '', avatar: '', pronouns: '', homepage: '', status: '' };
}

function max(field: Field): number {
  return METADATA_VALUE_MAX_CHARS[field] ?? METADATA_EXTRA_VALUE_MAX_CHARS;
}

// A saved key wins; one never saved shows what the server has now (set from
// another client), so saving untouched keeps it.
function fill(data: OwnMetadata): void {
  const next = blank();
  for (const f of FIELDS) next[f] = data.values[f] ?? data.live?.[f] ?? '';
  initial.value = next;
  Object.assign(form, next);
  avatarPreview.value = data.avatarPreview;
}

async function copyFrom(id: string): Promise<void> {
  error.value = '';
  try {
    const data = await fetchOwnMetadata(Number(id));
    for (const f of FIELDS) form[f] = data.values[f] ?? '';
  } catch (e) {
    error.value = `Couldn't read that network's profile: ${(e as Error).message}`;
  }
}

async function save(): Promise<void> {
  if (!dirty.value || refusal.value) return;
  const changed: Record<string, string | null> = {};
  for (const f of FIELDS) {
    const value = form[f].trim();
    if (value !== initial.value[f]) changed[f] = value || null;
  }
  saving.value = true;
  error.value = '';
  try {
    fill(await saveOwnMetadata(props.networkId, changed));
    close();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}

function close(): void {
  editor.close();
}

onMounted(async () => {
  try {
    fill(await fetchOwnMetadata(props.networkId));
  } catch (e) {
    error.value = `Couldn't load your profile: ${(e as Error).message}`;
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.profile-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin: 0 calc(-1 * var(--card-pad-x));
  padding: 0 var(--card-pad-x) var(--space-7);
}
.fields {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}
label {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  color: var(--fg-muted);
}
.title {
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
label input,
label select {
  color: var(--fg);
  width: 100%;
  box-sizing: border-box;
}
label small {
  color: var(--fg-muted);
}
.avatar-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.avatar {
  width: 2.5em;
  height: 2.5em;
  object-fit: cover;
  flex: none;
}
.hint {
  margin: 0;
  color: var(--fg-muted);
  border-left: 2px solid var(--accent);
  padding-left: var(--space-3);
}
.meta {
  margin: 0;
  color: var(--fg-muted);
}
.error {
  margin: 0;
  color: var(--bad);
}
</style>
