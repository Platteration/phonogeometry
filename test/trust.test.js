// src/trust.js is the one Trusted Types policy the site names. Under the site's
// `require-trusted-types-for 'script'`, `new Worker()` and `navigator.serviceWorker.register()`
// refuse a plain string, and this policy is the only way a URL becomes one they accept, so what
// it vouches for is exactly what the app may start as a script. The browser suite shows the
// policy working under the real header; this pins what it refuses, which no page stages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scriptURLs, POLICY_NAME, SCRIPTS } from '../src/trust.js';

const SITE = 'https://example.test/phonogeometry/';

/** A browser's trustedTypes, enough of it: the policy objects it hands out, by name. */
function fakeTrustedTypes() {
  const created = [];
  return {
    created,
    createPolicy(name, rules) {
      created.push(name);
      return { createScriptURL: (input) => ({ trusted: rules.createScriptURL(input) }) };
    },
  };
}

test('the policy is the one the site names, and vouches for the worker and the service worker', () => {
  const trustedTypes = fakeTrustedTypes();
  const url = scriptURLs({ trustedTypes, document: { baseURI: SITE } }, SITE);
  assert.deepEqual(trustedTypes.created, [POLICY_NAME]);
  assert.equal(POLICY_NAME, 'phonogeometry');
  assert.deepEqual(SCRIPTS, ['src/pipeline/worker.js', 'sw.js']);
  // As app.js passes them: the worker as an absolute URL, the service worker relative to the page.
  assert.deepEqual(url(`${SITE}src/pipeline/worker.js`), { trusted: `${SITE}src/pipeline/worker.js` });
  assert.deepEqual(url('sw.js'), { trusted: 'sw.js' });
  assert.deepEqual(url('./sw.js'), { trusted: './sw.js' });
});

test('anything else is refused, even through the policy', () => {
  const url = scriptURLs({ trustedTypes: fakeTrustedTypes(), document: { baseURI: SITE } }, SITE);
  for (const other of [
    'src/app.js',                                   // a real module, but not one started as a script
    `${SITE}src/pipeline/worker.js?x=1`,            // the same file under another name
    'sw.js#x',
    'https://evil.example/sw.js',                   // another origin
    'https://example.test/sw.js',                   // this origin, outside the site
    '../sw.js',
    'data:text/javascript,postMessage(1)',
    'blob:https://example.test/0d5c3c4e',
    'javascript:alert(1)',
  ]) {
    assert.throws(() => url(other), TypeError, other);
  }
});

test('where the browser has no Trusted Types, or will not create the policy, the string is used as it is', () => {
  assert.equal(scriptURLs({}, SITE)('sw.js'), 'sw.js');
  const refusing = { trustedTypes: { createPolicy() { throw new TypeError('Policy "phonogeometry" disallowed.'); } } };
  assert.equal(scriptURLs(refusing, SITE)('sw.js'), 'sw.js');
});

test('without a document, URLs resolve against the site', () => {
  const url = scriptURLs({ trustedTypes: fakeTrustedTypes() }, SITE);
  assert.deepEqual(url('sw.js'), { trusted: 'sw.js' });
  assert.throws(() => url('index.html'), TypeError);
});
