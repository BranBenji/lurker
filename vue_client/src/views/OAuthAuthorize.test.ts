// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The OAuth approval page (#891). What matters here lives in what the page does
// with a response, which no server test can see: framed, it shows and asks for
// nothing; a rejected request stays on the page; only a click navigates; and the
// member is told when the page is done with, but never while a redirect is
// still leaving it. It also names the account approving, and offers a way to
// approve as someone else (#1054).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';

const h = vi.hoisted(() => ({
  api: vi.fn<(url: string, opts?: { method?: string; body?: unknown }) => Promise<any>>(),
  resetSession: vi.fn<() => void>(),
}));
vi.mock('../api.js', () => ({ api: h.api, clearAuthRecoveryGuard: () => {} }));
vi.mock('../composables/useSessionReset.js', () => ({ resetSession: h.resetSession }));

import OAuthAuthorize from './OAuthAuthorize.vue';
import { useAuthStore } from '../stores/auth.js';

const OOB = 'urn:ietf:wg:oauth:2.0:oob';
const PARAMS = {
  client_id: 'cid',
  redirect_uri: OOB,
  response_type: 'code',
  code_challenge: 'challenge',
  code_challenge_method: 'S256',
  state: 's1',
};
const QUERY = `?${new URLSearchParams(PARAMS)}`;

// The authorize GET answers with the approval details and the request it checked;
// its POST answers with `decision`. `edition` and `email` answer the config and
// control-plane lookups behind the account name; `username` is what the cell
// knows the account as.
function serve(
  destination: object,
  decision: object,
  { edition = 'standalone', email = null as string | null, username = 'alice' } = {},
) {
  h.api.mockImplementation(async (url, opts) => {
    if (url === '/api/config') return { edition };
    if (url === '/_cp/auth/me') {
      if (!email) throw new Error('not found');
      return { account: { email } };
    }
    if (url === '/api/auth/logout' || url === '/_cp/auth/logout') return { ok: true };
    return opts?.method === 'POST'
      ? decision
      : {
          app: { name: 'Ivory', website: 'ivory.example' },
          destination,
          request: PARAMS,
          account: { id: 1, username },
        };
  });
}

function button(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('button').find((b) => b.text() === label);
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

beforeEach(() => {
  setActivePinia(createPinia());
  useAuthStore().adoptSession({ id: 1, username: 'alice', role: 'user' });
  h.api.mockReset();
  h.resetSession.mockReset();
  window.history.replaceState(null, '', `/oauth/authorize${QUERY}`);
});
afterEach(() => vi.restoreAllMocks());

describe('OAuthAuthorize', () => {
  it('renders nothing and calls no API inside a frame', async () => {
    vi.spyOn(window, 'top', 'get').mockReturnValue({} as Window);
    serve({ kind: 'code' }, { code: 'the-code' });

    const wrapper = mount(OAuthAuthorize);
    await flushPromises();

    expect(wrapper.find('.card').exists()).toBe(false);
    expect(wrapper.findAll('button')).toHaveLength(0);
    expect(wrapper.text()).toBe('');
    expect(h.api).not.toHaveBeenCalled();
  });

  it('shows the code for an out-of-band approval, without navigating', async () => {
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    serve({ kind: 'code' }, { code: 'the-code' });

    const wrapper = mount(OAuthAuthorize);
    await flushPromises();
    // The query string reaches the server exactly as the app sent it.
    expect(h.api).toHaveBeenCalledWith(`/api/oauth/authorize${QUERY}`);
    expect(wrapper.text()).toContain('Ivory');
    expect(wrapper.text()).toContain("You'll get a code to paste into the app");

    await button(wrapper, 'Approve').trigger('click');
    await flushPromises();

    expect(h.api).toHaveBeenLastCalledWith('/api/oauth/authorize', {
      method: 'POST',
      body: { ...PARAMS, account_id: 1, decision: 'approve' },
    });
    expect(wrapper.find('code.code').text()).toBe('the-code');
    expect(wrapper.text()).toContain('You can close this page after pasting it.');
    expect(assign).not.toHaveBeenCalled();
  });

  // A query string padded past Express's 1000-key limit reads as one app on the
  // server and as another to URLSearchParams. The approval has to be for the app
  // the page showed, so the page posts the server's reading back, not its own.
  it('approves the request the server described, not its own reading of the URL', async () => {
    const smuggled = `&client_id=other&redirect_uri=${encodeURIComponent('https://evil.example/cb')}`;
    window.history.replaceState(null, '', `/oauth/authorize${QUERY}${smuggled}`);
    serve({ kind: 'code' }, { code: 'the-code' });

    const wrapper = mount(OAuthAuthorize);
    await flushPromises();
    await button(wrapper, 'Approve').trigger('click');
    await flushPromises();

    expect(h.api).toHaveBeenLastCalledWith('/api/oauth/authorize', {
      method: 'POST',
      body: { ...PARAMS, account_id: 1, decision: 'approve' },
    });
  });

  it('names the account approving', async () => {
    serve({ kind: 'code' }, { code: 'the-code' });

    const wrapper = mount(OAuthAuthorize);
    await flushPromises();

    expect(wrapper.text()).toContain('Signed in as alice');
    // Only a hosted cell has a control plane to ask.
    expect(h.api).not.toHaveBeenCalledWith('/_cp/auth/me');
  });

  // A hosted cell knows only acct-N; the member knows the email they signed in with.
  it('names a hosted account by its email', async () => {
    serve(
      { kind: 'code' },
      { code: 'the-code' },
      { edition: 'node', email: 'alice@example.com', username: 'acct-7' },
    );

    const wrapper = mount(OAuthAuthorize);
    await flushPromises();

    expect(wrapper.text()).toContain('Signed in as alice@example.com');
    expect(wrapper.text()).not.toContain('acct-7');
  });

  it("falls back to the cell's username when the control plane has no email", async () => {
    serve({ kind: 'code' }, { code: 'the-code' }, { edition: 'node', username: 'acct-7' });

    const wrapper = mount(OAuthAuthorize);
    await flushPromises();

    expect(wrapper.text()).toContain('Signed in as acct-7');
  });

  // On hosted, leaving cp_session behind would let the proxy mint a fresh cell
  // cookie and sign the browser straight back in as the same account.
  it.each([
    ['standalone', ['/api/auth/logout']],
    ['node', ['/api/auth/logout', '/_cp/auth/logout']],
  ])(
    '"Not you?" signs this browser out (%s) and reloads the same request',
    async (edition, logouts) => {
      const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
      const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
      serve({ kind: 'code' }, { code: 'the-code' }, { edition, email: 'alice@example.com' });

      const wrapper = mount(OAuthAuthorize);
      await flushPromises();
      await button(wrapper, 'Not you?').trigger('click');
      await flushPromises();

      // Every sign-out lands before the reload, or the reload comes back signed in.
      const reloadedAt = reload.mock.invocationCallOrder[0];
      for (const url of logouts) {
        const call = h.api.mock.calls.findIndex(([u, o]) => u === url && o?.method === 'POST');
        expect(call).toBeGreaterThanOrEqual(0);
        expect(h.api.mock.invocationCallOrder[call]).toBeLessThan(reloadedAt);
      }
      expect(useAuthStore().user).toBeNull();
      expect(reload).toHaveBeenCalledTimes(1);
      expect(window.location.pathname + window.location.search).toBe(`/oauth/authorize${QUERY}`);
      // Nothing was decided on the signed-out account's behalf.
      expect(h.api).not.toHaveBeenCalledWith('/api/oauth/authorize', expect.anything());
      expect(assign).not.toHaveBeenCalled();
      // Approve can't be clicked while the sign-out runs.
      expect(button(wrapper, 'Approve').attributes('disabled')).toBeDefined();
    },
  );

  // A failed config fetch leaves the edition reading as standalone, and a hosted
  // sign-out that skips the control plane comes straight back as the same account.
  it('"Not you?" checks the edition again when the page-load check failed', async () => {
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
    serve({ kind: 'code' }, { code: 'the-code' }, { edition: 'node', email: 'alice@example.com' });
    const served = h.api.getMockImplementation()!;
    let configFailures = 1;
    h.api.mockImplementation(async (url, opts) => {
      if (url === '/api/config' && configFailures-- > 0) throw new Error('blip');
      return served(url, opts);
    });

    const wrapper = mount(OAuthAuthorize);
    await flushPromises();
    await button(wrapper, 'Not you?').trigger('click');
    await flushPromises();

    expect(h.api).toHaveBeenCalledWith('/_cp/auth/logout', { method: 'POST' });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // The browser signed in as someone else after the page loaded.
  it('shows a refused approval on the page', async () => {
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    serve({ kind: 'code' }, { code: 'the-code' });
    const served = h.api.getMockImplementation()!;
    h.api.mockImplementation(async (url, opts) => {
      if (url === '/api/oauth/authorize' && opts?.method === 'POST') {
        throw Object.assign(new Error('invalid_request'), {
          status: 409,
          data: { error: 'invalid_request', error_description: 'a different account' },
        });
      }
      return served(url, opts);
    });

    const wrapper = mount(OAuthAuthorize);
    await flushPromises();
    await button(wrapper, 'Approve').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('a different account');
    expect(wrapper.findAll('button')).toHaveLength(0);
    expect(assign).not.toHaveBeenCalled();
  });

  it('navigates to the redirect only after a click', async () => {
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    const redirect = 'https://app.example/cb?code=c1&state=s1';
    serve({ kind: 'web', host: 'app.example' }, { redirect });

    const wrapper = mount(OAuthAuthorize);
    await flushPromises();
    expect(wrapper.text()).toContain('Returns to app.example');
    expect(assign).not.toHaveBeenCalled();

    await button(wrapper, 'Approve').trigger('click');
    await flushPromises();
    expect(assign).toHaveBeenCalledWith(redirect);
    // This tab is the one navigating; closing it now would cancel the redirect.
    expect(wrapper.text()).not.toContain('You can close this page');
    expect(button(wrapper, 'Approve').attributes('disabled')).toBeDefined();
  });

  it.each([
    ['approve', 'Approved. You can close this page.'],
    ['deny', 'Denied. You can close this page.'],
  ])(
    'says the page can be closed once an app-scheme redirect hands off (%s)',
    async (decision, message) => {
      const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
      const redirect = 'com.example.ivory:/oauth?state=s1';
      serve({ kind: 'app', scheme: 'com.example.ivory' }, { redirect });

      const wrapper = mount(OAuthAuthorize);
      await flushPromises();
      await button(wrapper, decision === 'approve' ? 'Approve' : 'Deny').trigger('click');
      await flushPromises();

      // Another app takes the redirect and this tab stays put, so it says it's done.
      expect(assign).toHaveBeenCalledWith(redirect);
      expect(wrapper.text()).toContain(message);
      expect(wrapper.findAll('button')).toHaveLength(0);
    },
  );

  // Registration is open, so a rejected request's redirect could be anyone's.
  it('shows a rejected request on the page and never navigates', async () => {
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    h.api.mockRejectedValue(
      Object.assign(new Error('invalid_redirect_uri'), {
        status: 400,
        data: {
          error: 'invalid_redirect_uri',
          error_description: 'redirect_uri is not registered for this app',
        },
      }),
    );

    const wrapper = mount(OAuthAuthorize);
    await flushPromises();

    expect(wrapper.text()).toContain('redirect_uri is not registered for this app');
    expect(wrapper.findAll('button')).toHaveLength(0);
    expect(assign).not.toHaveBeenCalled();
  });
});
