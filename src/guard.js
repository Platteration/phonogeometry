/* The safety net. Loaded first, from <head>, as a plain script that depends on nothing, so that
   when a file the page needs does not load, or the app throws before it has started, the
   visitor reads a short note where the controls were instead of a page of buttons that do
   nothing. The page starts with class="no-js" on <html>, which shows the same note in place of
   the controls; scripts are running, so that comes off at once. src/app.js adds "started" to
   <html> as the last step of init(): after that the app reports its own failures and this file
   stays out of the way. The app does not start inside another page's frame either, and this
   says so (see the end of this file). */
(function () {
  'use strict';
  var root = document.documentElement;
  root.classList.remove('no-js');

  var MESSAGES = {
    load: 'Part of Phonogeometry did not load, so it cannot start. Check your connection and reload the page.',
    start: 'Phonogeometry could not start in this browser. Reload the page; if it happens again, try a current Chrome, Edge, Firefox or Safari.',
    framed: 'Phonogeometry does not run inside another site\'s page. Open it in a tab of its own: ',
  };

  /** Only this site's own files count: an extension that injects a script of its own, and
      fails, is not a reason to take the app away. */
  function ours(url) {
    try { return new URL(url, location.href).origin === location.origin; } catch (e) { return false; }
  }

  var shown = null;
  function show() {
    var note = document.getElementById('start-note');
    if (!note || !shown) return;
    // The address without its query or fragment: the framing page writes the frame's URL, and
    // whatever it put there is not this page's to repeat.
    note.textContent = MESSAGES[shown] + (shown === 'framed' ? location.origin + location.pathname : '');
  }

  function fail(kind) {
    if (root.classList.contains('started')) return;
    // The first cause stands: a frame, or a missing file; the throws that follow are symptoms.
    if (shown !== 'framed' && shown !== 'load') shown = kind;
    root.classList.add('start-failed');
    show();
  }

  // Capture phase: a script or stylesheet that fails to load fires on its element and does not
  // bubble. A module that is missing, or one of the modules it imports, fires on the page's
  // <script type="module">. An exception thrown while a script runs reaches here as an
  // ErrorEvent on window.
  window.addEventListener('error', function (e) {
    var el = e.target;
    if (el && el !== window && el.tagName) {
      var tag = el.tagName.toLowerCase();
      if ((tag === 'script' && ours(el.src)) || (tag === 'link' && el.rel === 'stylesheet' && ours(el.href))) fail('load');
      return;
    }
    if (e.filename && ours(e.filename)) fail('start');
  }, true);

  // A failure before the body was parsed has no note to write into yet.
  document.addEventListener('DOMContentLoaded', show);

  // The app is a module, and modules run before the load event. A page that reaches it without
  // having started is one whose browser did not run the app at all (no modules, no import
  // maps) or one that failed in a way nothing above saw.
  window.addEventListener('load', function () {
    if (!root.classList.contains('started')) fail('start');
  });

  // Inside another page's frame the app does not start (src/app.js asks the same question). A
  // host that sends the site's headers refuses the frame outright (frame-ancestors 'none'), but
  // GitHub Pages sends none and a <meta> cannot carry that rule, so there any site can frame the
  // page. A frame's storage is partitioned by the top-level site, not by origin: a page on the
  // same site (on a custom domain, any other subdomain of it) gets the visitor's own shots in
  // every browser, and any page does in a browser that does not partition (Chrome before 115,
  // for one). A click steered onto a shot's x then deletes it with nothing asked. Here the
  // controls stay hidden and the note gives the address to open.
  var framed;
  try { framed = window.top !== window.self; } catch (e) { framed = true; }
  if (framed) fail('framed');
})();
