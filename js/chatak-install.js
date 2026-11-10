// Chatak progressive web app install helper.
// Captures Chromium's install event before the UI runtime mounts.
// iOS uses the browser's Add to Home Screen flow instead of a JS prompt.
(function (root) {
  'use strict';
  if (!root || root.ChatakInstall) return;

  let pendingPrompt = null;
  let installedByBrowser = false;
  const subscribers = new Set();
  const nav = root.navigator || {};
  const ua = String(nav.userAgent || '');
  const ios = /iPhone|iPad|iPod/i.test(ua) ||
    (nav.platform === 'MacIntel' && Number(nav.maxTouchPoints) > 1);
  const android = /Android/i.test(ua);

  function standalone() {
    return installedByBrowser || nav.standalone === true ||
      (typeof root.matchMedia === 'function' &&
        (root.matchMedia('(display-mode: standalone)').matches ||
         root.matchMedia('(display-mode: fullscreen)').matches));
  }

  function status() {
    const installed = standalone();
    const insecure = root.isSecureContext === false &&
      !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(root.location ? root.location.href : '');
    const mode = installed ? 'installed' : insecure ? 'insecure' :
      pendingPrompt ? 'prompt' : ios ? 'ios' : 'manual';
    return {
      mode,
      installed,
      canPrompt: mode === 'prompt',
      platform: ios ? 'ios' : android ? 'android' : 'other'
    };
  }

  function notify() {
    const data = status();
    for (const subscriber of subscribers) {
      try { subscriber(data); } catch (error) { console.warn('[ChatakInstall] listener', error); }
    }
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return function () {};
    subscribers.add(listener);
    listener(status());
    return function () { subscribers.delete(listener); };
  }

  // The browser only allows prompt() while processing a user action.
  async function promptInstall() {
    if (standalone()) return { result: 'installed' };
    const event = pendingPrompt;
    if (!event) return { result: 'manual' };
    pendingPrompt = null;
    notify();
    try {
      await event.prompt();
      const choice = await event.userChoice;
      const result = choice && choice.outcome === 'accepted' ? 'accepted' : 'dismissed';
      notify();
      return { result };
    } catch (error) {
      console.warn('[ChatakInstall] prompt', error);
      notify();
      return { result: 'error' };
    }
  }

  root.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    pendingPrompt = event;
    notify();
  });
  root.addEventListener('appinstalled', function () {
    installedByBrowser = true;
    pendingPrompt = null;
    notify();
  });

  if (typeof root.matchMedia === 'function') {
    const query = root.matchMedia('(display-mode: standalone)');
    if (query && typeof query.addEventListener === 'function') query.addEventListener('change', notify);
    else if (query && typeof query.addListener === 'function') query.addListener(notify);
  }

  root.ChatakInstall = { status, subscribe, promptInstall };
})(typeof window !== 'undefined' ? window : null);
