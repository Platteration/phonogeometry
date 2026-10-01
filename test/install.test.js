// The install prompt cannot be staged by a browser suite: Chromium decides for itself when to
// fire `beforeinstallprompt`, and Safari never does. So the handler is driven here with a fake
// event, on the fake document app.js is tested against.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeElement } from './fakeDom.js';
import { wireInstallPrompt } from '../src/install.js';

/** A window that only dispatches: the two events the handler listens for are all it needs. */
function fakeWindow() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); },
    dispatch(type, event = {}) { for (const fn of listeners.get(type) || []) fn({ type, ...event }); },
  };
}

/**
 * What Chromium hands the listener: preventDefault, and a prompt() that resolves. Counted in
 * closures, not on `this`: the fake window spreads the event into a fresh object the way
 * test/fakeDom.js does, so a method that counted on itself would count on a copy.
 */
function installEvent() {
  const counts = { prevented: 0, prompts: 0 };
  return { counts, preventDefault() { counts.prevented++; }, prompt() { counts.prompts++; return Promise.resolve(); } };
}

test('the button is hidden until the browser offers a prompt, and the offer is held back', () => {
  const win = fakeWindow();
  const button = new FakeElement('button');
  button.hidden = true;
  const handle = wireInstallPrompt(win, button);
  assert.equal(handle.pending, false);
  button.click();                         // nothing offered yet: nothing to prompt
  assert.equal(handle.prompted, 0);
  assert.equal(button.hidden, true);

  const ev = installEvent();
  win.dispatch('beforeinstallprompt', ev);
  assert.equal(ev.counts.prevented, 1, 'preventDefault, or the browser shows its own bar as well');
  assert.equal(button.hidden, false);
  assert.equal(handle.pending, true);
});

test('a click shows the prompt once and spends the event', async () => {
  const win = fakeWindow();
  const button = new FakeElement('button');
  button.hidden = true;
  const handle = wireInstallPrompt(win, button);
  const ev = installEvent();
  win.dispatch('beforeinstallprompt', ev);
  button.click();
  await Promise.resolve();
  assert.equal(ev.counts.prompts, 1);
  assert.equal(handle.prompted, 1);
  assert.equal(handle.pending, false, 'one event answers one prompt()');
  assert.equal(button.hidden, true);
  button.click();                         // a second click has nothing to show
  await Promise.resolve();
  assert.equal(ev.counts.prompts, 1);
  // A prompt that rejects (the browser withdrew the offer) is not an unhandled rejection.
  const bad = { preventDefault() {}, prompt: () => Promise.reject(new Error('withdrawn')) };
  win.dispatch('beforeinstallprompt', bad);
  assert.equal(button.hidden, false, 'a fresh offer brings the button back');
  button.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(button.hidden, true);
});

test('installing the app hides the button, whether or not a prompt was pending', () => {
  const win = fakeWindow();
  const button = new FakeElement('button');
  button.hidden = true;
  const handle = wireInstallPrompt(win, button);
  win.dispatch('beforeinstallprompt', installEvent());
  assert.equal(button.hidden, false);
  win.dispatch('appinstalled');
  assert.equal(button.hidden, true);
  assert.equal(handle.pending, false, 'the held event is dropped: an installed app is not offered again');
  win.dispatch('appinstalled');           // installed from the browser's own menu, no event held
  assert.equal(button.hidden, true);
});
