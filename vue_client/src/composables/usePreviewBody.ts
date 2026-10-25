// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { computed } from 'vue';
import { useConfigStore } from '../stores/config.js';
import { useSettingsStore } from '../stores/settings.js';

/**
 * Which lines' bodies go through MessageBody (text + inline media + link
 * previews) rather than straight to RenderSegments. The message list and the
 * thread panel (#1225) both ask; one gate, so the two never disagree about
 * which lines unfurl.
 */
export function usePreviewBody() {
  const config = useConfigStore();
  const settings = useSettingsStore();

  /**
   * Whether an attachment could render at all right now.
   *
   * ⚠ Checked at the mount site, rather than only inside MessageAttachments. The component
   * was mounted once per message row regardless — 500 instances, each building a computed and
   * running the URL regex — so every user of a default-off feature paid for it on every buffer
   * switch. Hoisting the gate up also means an unrelated settings write can't invalidate a
   * per-row computed 500 times over.
   */
  const previewsActive = computed(
    () =>
      config.linkPreviews &&
      (settings.effective('chat.inline_media.enabled') === true ||
        settings.effective('chat.link_previews.enabled') === true),
  );

  /**
   * Whether this line's body goes through MessageBody.
   *
   * ⚠ The gate is unchanged from when it guarded MessageAttachments alone — the cost it exists to
   * avoid is the same one. MessageBody builds a computed and runs the URL regex per instance, and
   * mounting it on all 500 rows made every user of a default-off feature pay for it on every
   * buffer switch. Everything that fails this test renders exactly the component it always did.
   *
   * ⚠ `notice` is excluded even though `hasInlineText` accepts it, matching what the attachments
   * mount did: a notice is a service message, and unfurling links in one means unfurling whatever
   * NickServ or a bot happens to send.
   */
  function previewBody(m: { type?: string; text?: string | null } | null | undefined): boolean {
    return (
      (m?.type === 'message' || m?.type === 'action') &&
      previewsActive.value &&
      mightHaveLink(m?.text)
    );
  }

  return { previewBody, previewsActive };
}

/** Cheap pre-filter: no scheme, no possible attachment. Skips the regex for most rows. */
function mightHaveLink(text: string | null | undefined): boolean {
  return !!text && text.includes('://');
}
