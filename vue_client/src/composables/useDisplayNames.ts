// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Display names from IRCv3 metadata (#607), behind look.nick.display_names.
// The nick stays the identity everywhere: colours are keyed on it, the roster
// sorts on it, mentions match it. This only answers "what do we print for this
// nick here". Surfaces that render formatted text (the message head) take the
// raw name and draw its mIRC codes; plain surfaces (the roster, the sidebar)
// take the stripped one.

import { computed } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useSettingsStore } from '../stores/settings.js';
import { stripFormatting } from '../../../shared/textMatch.js';

export function useDisplayNames() {
  const networks = useNetworksStore();
  const settings = useSettingsStore();

  const enabled = computed(() => settings.effective('look.nick.display_names') !== false);

  // The name as set, formatting codes and all, or null when there is none
  // (or the setting is off). Never the nick itself: callers fall back.
  function displayNameFor(
    networkId: number | string | null | undefined,
    nick: string,
  ): string | null {
    if (!enabled.value) return null;
    const name = networks.metadataFor(networkId, nick)?.displayName;
    // The server refuses a name that strips to nothing; an older one may not.
    return name && stripFormatting(name).trim() ? name : null;
  }

  // Plain text for surfaces that can't draw formatting.
  function plainDisplayNameFor(
    networkId: number | string | null | undefined,
    nick: string,
  ): string | null {
    const name = displayNameFor(networkId, nick);
    if (!name) return null;
    const plain = stripFormatting(name).trim();
    return plain ? plain : null;
  }

  // What a plain surface prints: the stripped display name, else the nick.
  function labelFor(networkId: number | string | null | undefined, nick: string): string {
    return plainDisplayNameFor(networkId, nick) ?? nick;
  }

  return { enabled, displayNameFor, plainDisplayNameFor, labelFor };
}
