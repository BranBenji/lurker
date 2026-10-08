# Notifications

::: info This chapter is in progress
An outline is below. Help finish it via **Edit this page on GitHub**.
:::

How Lurker keeps you informed across all your devices.

## How notifications work

- One **enabled** toggle per signal — Lurker decides whether to show an in-app
  toast or send a web-push notification based on where your attention is.
- Highlights and direct messages as notification triggers.

## Web push

- Enabling push so you're notified even when no tab is open.
- Per-device behavior and presence.

## The iOS and Android apps

- The apps use native push. On lurker.chat it's built in. On a self-hosted server the
  admin turns it on under **Admin → Notifications** with
  [push.lurker.chat](https://push.lurker.chat); see
  [the self-hosting guide](/SELF_HOSTING#push-and-the-mobile-apps).
- Until it's on, the apps don't ask for notification permission and contact nothing.

## Auto-away

- Auto-away when no client is in front of you and no IRC client is attached through
  the bouncer, and automatic return. A client's background connection that sends
  `AWAY *` doesn't count. A network you set away yourself keeps that away: auto-away
  skips it, and returning doesn't clear it.

## See also

- [The Interface](/guide/interface)
