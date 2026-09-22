// The browser's own "install this app" prompt, offered from the settings dialog.
//
// Chromium fires `beforeinstallprompt` when the manifest and service worker qualify the page;
// the event is held back with preventDefault so the browser's mini-infobar does not show, and
// an Install button appears instead. Safari never fires the event, and neither does a browser
// that has the app installed already, so the button starts hidden and stays hidden there:
// nothing dead is shown on the platforms that have no such prompt.
//
// Kept apart from app.js so a fake event can drive it in node (test/install.test.js): no
// browser suite can stage the event itself.

/**
 * Wire `button` to the install prompt `target` (the window) may offer. Returns a handle the
 * tests read: whether a prompt is being held, and how many times it was shown.
 */
export function wireInstallPrompt(target, button) {
  let deferred = null;
  const state = { get pending() { return deferred !== null; }, prompted: 0 };
  target.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    button.hidden = false;
  });
  button.addEventListener('click', async () => {
    if (!deferred) return;
    // One event answers one prompt() — a second call rejects — so the button goes away with
    // it. If the person dismisses the prompt, the browser offers a fresh event later and the
    // button returns with it.
    const event = deferred;
    deferred = null;
    button.hidden = true;
    state.prompted++;
    try { await event.prompt(); } catch { /* dismissed, or the browser withdrew the offer */ }
  });
  target.addEventListener('appinstalled', () => {
    deferred = null;
    button.hidden = true;
  });
  return state;
}
