// Trusted Types. The site's policy says `require-trusted-types-for 'script'`, under which a
// browser refuses a plain string wherever a URL becomes script: `new Worker()` and
// `navigator.serviceWorker.register()` among them, both of which the app calls. A string
// reaches them only through the one policy the site names (`trusted-types phonogeometry`),
// and that policy vouches for exactly two scripts, the reconstruction worker and the service
// worker, so a URL that came from anywhere else — a file name, a stored record, a later
// regression — is refused even through it.
//
// Where the browser has no Trusted Types, or will not create the policy, the string is used
// as it is, which is what the app did before; the policy is the extra line, not the only one.

export const POLICY_NAME = 'phonogeometry';

/** The scripts the app starts, relative to the site's root (this file lives in src/). */
export const SCRIPTS = ['src/pipeline/worker.js', 'sw.js'];

/**
 * A function that hands back `url` in the form `new Worker()` and `register()` accept under
 * the site's policy. `win` is the global object; `base` the URL the site's root resolves
 * against. Both are parameters so a test can supply them.
 */
export function scriptURLs(win = globalThis, base = new URL('../', import.meta.url).href) {
  const allowed = new Set(SCRIPTS.map((p) => new URL(p, base).href));
  let policy = null;
  try {
    policy = win.trustedTypes?.createPolicy?.(POLICY_NAME, {
      createScriptURL(input) {
        const href = new URL(String(input), win.document?.baseURI || base).href;
        if (!allowed.has(href)) throw new TypeError(`Phonogeometry does not start ${href} as a script`);
        return String(input);
      },
    }) || null;
  } catch {
    // A host that sends a different policy, or a second policy of this name: use strings, and
    // let the browser refuse them if its policy says so.
  }
  return (url) => (policy ? policy.createScriptURL(url) : url);
}
