// The Account section of Settings and "Support this app" (src/account.js), on a fake document and
// a fake api/: what the page draws for each answer the site's API can give, what it sends, and
// where it lets a click take the visitor. The browser suite (test/browser/run.mjs) runs the same
// flow for real, under the site's policy, against the kit itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeElement } from './fakeDom.js';
import {
  SUPPORTER, POLL, NOTE_MS, WORDS, NOTES,
  readConfig, readMe, formatPrice, landingOf, checkoutAddress, pollFor, apiClient, startAccount,
} from '../src/account.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://example.test/phonogeometry/';
const SUPPORT = { id: 'supporter', name: 'Support this app', description: 'A one-time payment.', mode: 'payment', price: { unit_amount: 400, currency: 'eur' } };
const ON = { auth: { google: true }, shop: { products: [SUPPORT] } };

/** Every string drawn under `node`, in order: what a reader of the page sees. */
const words = (node) => (typeof node === 'string' ? [node] : node.childNodes.flatMap(words));
const buttons = (node) => (typeof node === 'string' ? [] : [...(node.tagName === 'BUTTON' ? [node] : []), ...node.childNodes.flatMap(buttons)]);
const button = (els, label) => {
  const found = buttons(els.body).find((b) => b.textContent === label);
  if (!found) throw new Error(`no "${label}" button among ${buttons(els.body).map((b) => b.textContent).join(', ') || 'none'}`);
  return found;
};

/**
 * A fake api/: `answers` maps "METHOD route" to a status and a body (or a function returning
 * one, or 'network' for a fetch that rejects). Every request is recorded.
 */
function fakeApi(answers) {
  const requests = [];
  const fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const route = url.startsWith(`${BASE}api/`) ? url.slice(`${BASE}api/`.length) : `outside ${url}`;
    requests.push({ method, route, init });
    let answer = answers[`${method} ${route}`];
    if (typeof answer === 'function') answer = answer();
    if (answer === 'network') throw new TypeError('Failed to fetch');
    if (!answer) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    const [status, body] = answer;
    return new Response(status === 204 ? null : typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return { fetch, requests };
}

/** startAccount on a fake page: the four elements app.js hands it, and a window's parts. */
function page({ answers, href = BASE, online = true, confirmAnswer = true, withFetch = true } = {}) {
  const els = { section: new FakeElement('div'), body: new FakeElement('div'), thanks: new FakeElement('p'), privacyLocal: new FakeElement('p'), privacy: new FakeElement('p') };
  els.section.hidden = true;
  els.thanks.hidden = true;
  els.privacy.hidden = true;
  const api = fakeApi(answers ?? {});
  const url = new URL(href);
  const log = { assigned: [], replaced: [], notes: [], confirms: [], waits: [] };
  const handle = startAccount({
    doc: { createElement: (tag) => new FakeElement(tag) },
    fetch: withFetch ? api.fetch : undefined,
    base: BASE,
    location: { href: url.href, pathname: url.pathname, search: url.search, assign: (to) => log.assigned.push(to) },
    history: { replaceState: (_state, _title, to) => log.replaced.push(to) },
    online: () => online,
    confirm: (message) => { log.confirms.push(message); return confirmAnswer; },
    note: (message, ms) => log.notes.push([message, ms]),
    wait: async (ms) => { log.waits.push(ms); },
    els,
  });
  return { ...handle, els, api, log };
}
/** Until a click's handler has had its answers from the fake api/ (each body is read on a later
 *  task than the one it was asked on). */
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

// ---- What the server says, read field by field

test('api/config: only the kit\'s shape with sign-in on turns the feature on', () => {
  for (const off of [null, 'x', [], {}, { auth: {} }, { auth: { google: false }, shop: { products: [SUPPORT] } }, { auth: { google: 'true' } }, { auth: { google: 1 } }]) {
    assert.equal(readConfig(off), null, JSON.stringify(off));
  }
  assert.deepEqual(readConfig({ auth: { google: true } }), { supporter: null }, 'sign-in alone: the account, no product');
  assert.deepEqual(readConfig(ON), { supporter: { id: 'supporter', name: 'Support this app', description: 'A one-time payment.', price: { unitAmount: 400, currency: 'eur' } } });
  assert.deepEqual(readConfig({ auth: { google: true }, shop: { products: [{ ...SUPPORT, price: undefined }] } }).supporter.price, null, 'listed without a price when Stripe did not answer');
});

test('api/config: a product that is not this app\'s "Support this app", as the kit sends it, is not drawn', () => {
  const only = (product) => readConfig({ auth: { google: true }, shop: { products: [product] } }).supporter;
  assert.equal(only({ ...SUPPORT, id: 'pro' }), null);
  assert.equal(only({ ...SUPPORT, mode: 'subscription' }), null);
  assert.equal(only({ ...SUPPORT, name: 'Support\nthis app' }), null, 'no control character');
  assert.equal(only({ ...SUPPORT, name: 'x'.repeat(101) }), null);
  assert.equal(only({ ...SUPPORT, name: '' }), null);
  assert.equal(only({ ...SUPPORT, description: 7 }), null);
  for (const price of [{ unit_amount: -1, currency: 'eur' }, { unit_amount: 1.5, currency: 'eur' }, { unit_amount: '400', currency: 'eur' }, { unit_amount: 400, currency: 'EUR' }, { unit_amount: 400, currency: 'eu' }, { unit_amount: 400 }, 'four euros']) {
    assert.equal(only({ ...SUPPORT, price }).price, null, JSON.stringify(price));
  }
});

test('api/me: a user, their verified email and the entitlements, or nothing', () => {
  for (const bad of [null, {}, { user: null }, { user: 'ada', entitlements: [] }, { user: [], entitlements: [] }, { entitlements: 'supporter' }]) {
    assert.equal(readMe(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(readMe({ user: null, entitlements: [] }), { user: null, entitlements: [] });
  assert.deepEqual(readMe({ user: {}, entitlements: ['supporter'] }), { user: { email: null }, entitlements: ['supporter'] });
  assert.deepEqual(readMe({ user: { email: 'ada@example.com' }, entitlements: ['supporter', 'supporter', 'Pro', 'a b', 7, 'x'.repeat(33)] }),
    { user: { email: 'ada@example.com' }, entitlements: ['supporter'] });
  assert.equal(readMe({ user: { email: 'ada@example.com\u0000' }, entitlements: [] }).user.email, null);
  assert.equal(readMe({ user: {}, entitlements: Array.from({ length: 80 }, (_, i) => `e${i}`) }).entitlements.length, 50);
});

test('prices are in the currency\'s smallest unit, as Stripe counts it', () => {
  assert.equal(formatPrice({ unitAmount: 400, currency: 'eur' }, 'en-GB'), '€4.00');
  assert.equal(formatPrice({ unitAmount: 499, currency: 'jpy' }, 'en-US'), '¥499');
  assert.match(formatPrice({ unitAmount: 1500, currency: 'kwd' }, 'en-US'), /^KWD\s1\.500$/);
});

test('the kit\'s flags are read once and taken out of the address, and nothing else is', () => {
  assert.deepEqual(landingOf(`${BASE}?signin=failed`), { landing: { signIn: 'failed', purchase: null }, without: '/phonogeometry/' });
  assert.deepEqual(landingOf(`${BASE}?purchase=success&fbclid=x#top`), { landing: { signIn: null, purchase: 'success' }, without: '/phonogeometry/?fbclid=x#top' });
  assert.deepEqual(landingOf(`${BASE}?purchase=cancelled`).landing, { signIn: null, purchase: 'cancelled' });
  assert.deepEqual(landingOf(`${BASE}?purchase=maybe&signin=ok`), { landing: { signIn: null, purchase: null }, without: null }, 'values the kit never writes are not ours');
  assert.deepEqual(landingOf(BASE), { landing: { signIn: null, purchase: null }, without: null });
  assert.equal(landingOf('not a url').without, null);
});

test('Buy follows Stripe\'s hosted Checkout and nothing else', () => {
  assert.equal(checkoutAddress({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' }), 'https://checkout.stripe.com/c/pay/cs_test_1');
  for (const url of ['http://checkout.stripe.com/c/pay/cs_1', 'https://checkout.stripe.com.evil.example/c', 'https://evil.example/?https://checkout.stripe.com/',
    'https://user:pw@checkout.stripe.com/c', 'https://user@checkout.stripe.com/c', 'javascript:alert(1)', '/api/checkout', 'https://checkout.stripe.com:8443/c', 'https://pay.stripe.com/c']) {
    assert.equal(checkoutAddress({ url }), null, url);
  }
  for (const raw of [null, {}, { url: 7 }, 'https://checkout.stripe.com/']) assert.equal(checkoutAddress(raw), null, JSON.stringify(raw));
});

test('after a purchase, api/me is asked up to five times over fifteen seconds', async () => {
  const waits = [];
  let asked = 0;
  const never = await pollFor(SUPPORTER, async () => { asked++; return { user: {}, entitlements: [] }; }, async (ms) => waits.push(ms));
  assert.equal(never.held, false);
  assert.equal(asked, POLL.tries);
  assert.deepEqual(waits, [3000, 3000, 3000, 3000, 3000]);
  asked = 0;
  const third = await pollFor(SUPPORTER, async () => (++asked === 3 ? { user: {}, entitlements: ['supporter'] } : null), async () => {});
  assert.equal(third.held, true);
  assert.equal(asked, 3, 'and stops once it is there');
});

test('the client asks the site\'s own api/, under the site\'s path, and maps each answer', async () => {
  const api = fakeApi({ 'POST checkout': [200, { url: 'https://checkout.stripe.com/c/pay/cs_1' }], 'POST auth/logout': [204], 'DELETE me': [204] });
  const client = apiClient({ fetch: api.fetch, base: BASE });
  assert.equal(client.startUrl('/phonogeometry/?x=1'), `${BASE}api/auth/google/start?return=%2Fphonogeometry%2F%3Fx%3D1`);
  assert.deepEqual(await client.checkout('supporter'), { url: 'https://checkout.stripe.com/c/pay/cs_1' });
  const sent = api.requests.at(-1);
  assert.equal(sent.init.headers['Content-Type'], 'application/json', 'JSON, which an HTML form cannot send');
  assert.equal(sent.init.body, '{"product":"supporter"}');
  assert.equal(sent.init.credentials, 'same-origin');
  assert.equal(await client.signOut(), true);
  assert.equal(await client.deleteAccount(), true);
  assert.deepEqual(api.requests.map((r) => `${r.method} ${r.route}`), ['POST checkout', 'POST auth/logout', 'DELETE me']);
  for (const [status, result] of [[401, 'signin'], [404, 'unavailable'], [409, 'owned'], [429, 'busy'], [500, 'failed'], [502, 'failed']]) {
    assert.equal(await apiClient({ fetch: fakeApi({ 'POST checkout': [status, {}] }).fetch, base: BASE }).checkout('supporter'), result, String(status));
  }
  assert.equal(await apiClient({ fetch: fakeApi({ 'POST checkout': [200, { url: 'https://evil.example/' }] }).fetch, base: BASE }).checkout('supporter'), 'failed');
  assert.equal(await apiClient({ fetch: fakeApi({ 'POST checkout': 'network' }).fetch, base: BASE }).checkout('supporter'), 'failed');
  assert.equal(await apiClient({ fetch: fakeApi({ 'POST auth/logout': [403, {}] }).fetch, base: BASE }).signOut(), false);
});

// ---- What the page draws

test('nothing is drawn, stored or asked again where the site has no API to offer', async () => {
  const offs = {
    'a 404': {},
    'a network error': { 'GET config': 'network' },
    'a body that is not JSON': { 'GET config': [200, '<!doctype html><title>Page not found</title>'] },
    'the site\'s own static api/config': { 'GET config': [200, fs.readFileSync(path.join(root, 'api', 'config'), 'utf8')] },
    'sign-in off': { 'GET config': [200, { auth: { google: false }, shop: { products: [] } }] },
    'a server error': { 'GET config': [500, ON] },
  };
  for (const [label, answers] of Object.entries(offs)) {
    const p = page({ answers });
    assert.equal(await p.ready, false, label);
    await settle();
    assert.equal(p.els.section.hidden, true, `${label}: no Account section`);
    assert.equal(p.els.privacy.hidden, true, `${label}: About keeps its sentence`);
    assert.equal(p.els.privacyLocal.hidden, false, label);
    assert.equal(p.els.thanks.hidden, true, label);
    assert.deepEqual(p.els.body.childNodes, [], label);
    assert.deepEqual(p.api.requests.map((r) => `${r.method} ${r.route}`), ['GET config'], `${label}: one question, and nothing after it`);
  }
});

test('offline, or with no fetch at all, the API is not asked', async () => {
  const offline = page({ answers: { 'GET config': [200, ON] }, online: false });
  assert.equal(await offline.ready, false);
  assert.deepEqual(offline.api.requests, []);
  assert.equal(offline.els.section.hidden, true);
  const bare = page({ answers: { 'GET config': [200, ON] }, withFetch: false });
  assert.equal(await bare.ready, false);
  assert.deepEqual(bare.api.requests, []);
});

test('signed out: Sign in with Google, the product with its price, and Sign in to buy', async () => {
  const p = page({ answers: { 'GET config': [200, ON], 'GET me': [200, { user: null, entitlements: [] }] }, href: `${BASE}?fbclid=x` });
  assert.equal(await p.ready, true);
  assert.equal(p.els.section.hidden, false);
  assert.equal(p.els.privacy.hidden, false, 'About says what an account sends where');
  assert.equal(p.els.privacyLocal.hidden, true);
  assert.equal(p.els.thanks.hidden, true);
  const text = words(p.els.body).join('|');
  assert.match(text, /Sign in with Google/);
  assert.match(text, /Support this app\| · €4\.00\|A one-time payment\./);
  assert.deepEqual(buttons(p.els.body).map((b) => [b.textContent, b.attributes.type]), [[WORDS.signIn, 'button'], [WORDS.signInToBuy, 'button']], 'buttons that submit nothing in the dialog\'s form');
  button(p.els, WORDS.signInToBuy).click();
  button(p.els, WORDS.signIn).click();
  assert.deepEqual(p.log.assigned, [`${BASE}api/auth/google/start?return=%2Fphonogeometry%2F%3Ffbclid%3Dx`, `${BASE}api/auth/google/start?return=%2Fphonogeometry%2F%3Ffbclid%3Dx`],
    'a top-level navigation to the sign-in start, coming back to this page');
  assert.deepEqual(p.api.requests.map((r) => `${r.method} ${r.route}`), ['GET config', 'GET me']);
});

test('signed in: who, Sign out, Delete account and Buy, and Buy goes to Stripe\'s Checkout', async () => {
  const p = page({ answers: {
    'GET config': [200, ON],
    'GET me': [200, { user: { email: 'ada@example.com' }, entitlements: [] }],
    'POST checkout': [200, { url: 'https://checkout.stripe.com/c/pay/cs_test_9' }],
  } });
  assert.equal(await p.ready, true);
  assert.match(words(p.els.body).join('|'), /Signed in as ada@example\.com/);
  assert.deepEqual(buttons(p.els.body).map((b) => b.textContent), [WORDS.signOut, WORDS.deleteAccount, WORDS.buy]);
  await button(p.els, WORDS.buy).dispatch('click');
  await settle();
  assert.deepEqual(p.log.assigned, ['https://checkout.stripe.com/c/pay/cs_test_9']);
  assert.deepEqual(p.api.requests.at(-1).route, 'checkout');
});

test('a signed-in account Google gave no verified email is "Signed in with Google"', async () => {
  const p = page({ answers: { 'GET config': [200, ON], 'GET me': [200, { user: {}, entitlements: [] }] } });
  await p.ready;
  assert.equal(words(p.els.body)[0], WORDS.signedIn);
});

test('what the server says is drawn as text, never as markup', async () => {
  const email = '<img src=x onerror=alert(1)>@example.com';
  const p = page({ answers: { 'GET config': [200, { auth: { google: true }, shop: { products: [{ ...SUPPORT, name: '<b>Support</b>' }] } }], 'GET me': [200, { user: { email }, entitlements: [] }] } });
  await p.ready;
  const strings = words(p.els.body);
  assert.ok(strings.includes(`Signed in as ${email}`) && strings.includes('<b>Support</b>'), strings.join('|'));
  const tags = (node) => (typeof node === 'string' ? [] : [node.tagName, ...node.childNodes.flatMap(tags)]);
  assert.deepEqual([...new Set(tags(p.els.body))].sort(), ['BUTTON', 'DIV', 'P', 'STRONG'], 'only the elements the page builds itself');
});

test('a Checkout address that is not Stripe\'s is not followed, and each refusal is said', async () => {
  for (const [answer, note] of [
    [[200, { url: 'https://evil.example/pay' }], NOTES.failed], [[404, {}], NOTES.unavailable], [[429, {}], NOTES.busy], [[502, {}], NOTES.failed], ['network', NOTES.failed],
  ]) {
    const p = page({ answers: { 'GET config': [200, ON], 'GET me': [200, { user: { email: 'a@b.c' }, entitlements: [] }], 'POST checkout': answer } });
    await p.ready;
    await button(p.els, WORDS.buy).dispatch('click');
    await settle();
    assert.deepEqual(p.log.assigned, [], JSON.stringify(answer));
    assert.deepEqual(p.log.notes, [[note, NOTE_MS]], JSON.stringify(answer));
    assert.equal(buttons(p.els.body).every((b) => !b.disabled), true, 'the controls come back');
  }
});

test('Buy answered 401 shows the visitor signed out; 409 reads the account again and shows Owned', async () => {
  const signedOut = page({ answers: { 'GET config': [200, ON], 'GET me': [200, { user: { email: 'a@b.c' }, entitlements: [] }], 'POST checkout': [401, {}] } });
  await signedOut.ready;
  await button(signedOut.els, WORDS.buy).dispatch('click');
  await settle();
  assert.deepEqual(buttons(signedOut.els.body).map((b) => b.textContent), [WORDS.signIn, WORDS.signInToBuy]);

  let owned = false;
  const already = page({ answers: {
    'GET config': [200, ON],
    'GET me': () => [200, { user: { email: 'a@b.c' }, entitlements: owned ? ['supporter'] : [] }],
    'POST checkout': () => { owned = true; return [409, { error: 'conflict' }]; },
  } });
  await already.ready;
  await button(already.els, WORDS.buy).dispatch('click');
  await settle();
  assert.ok(words(already.els.body).includes(WORDS.owned));
  assert.equal(already.els.thanks.hidden, false);
  assert.deepEqual(already.log.assigned, []);
});

test('a supporter reads Owned in Settings and the thank-you in About, and nothing else changes', async () => {
  const p = page({ answers: { 'GET config': [200, ON], 'GET me': [200, { user: { email: 'a@b.c' }, entitlements: ['supporter'] }] } });
  await p.ready;
  assert.ok(words(p.els.body).includes(WORDS.owned));
  assert.deepEqual(buttons(p.els.body).map((b) => b.textContent), [WORDS.signOut, WORDS.deleteAccount], 'no Buy');
  assert.equal(p.els.thanks.hidden, false);
});

test('Sign out ends the session and draws the signed-out section; a refusal is said', async () => {
  const p = page({ answers: { 'GET config': [200, ON], 'GET me': [200, { user: { email: 'a@b.c' }, entitlements: ['supporter'] }], 'POST auth/logout': [204] } });
  await p.ready;
  await button(p.els, WORDS.signOut).dispatch('click');
  await settle();
  assert.deepEqual(buttons(p.els.body).map((b) => b.textContent), [WORDS.signIn, WORDS.signInToBuy], 'signed out, the page knows of no purchase');
  assert.equal(p.els.thanks.hidden, true, 'the thank-you is the account\'s');
  assert.deepEqual(p.api.requests.at(-1), { method: 'POST', route: 'auth/logout', init: { credentials: 'same-origin', method: 'POST' } });

  const refused = page({ answers: { 'GET config': [200, ON], 'GET me': [200, { user: { email: 'a@b.c' }, entitlements: [] }], 'POST auth/logout': [403, {}] } });
  await refused.ready;
  await button(refused.els, WORDS.signOut).dispatch('click');
  await settle();
  assert.deepEqual(refused.log.notes, [[NOTES.signOutFailed, NOTE_MS]]);
  assert.match(words(refused.els.body).join('|'), /Signed in as a@b\.c/);
});

test('Delete account asks first, says the support goes with it, and deletes only when confirmed', async () => {
  const answers = { 'GET config': [200, ON], 'GET me': [200, { user: { email: 'a@b.c' }, entitlements: ['supporter'] }], 'DELETE me': [204] };
  const kept = page({ answers, confirmAnswer: false });
  await kept.ready;
  await button(kept.els, WORDS.deleteAccount).dispatch('click');
  await settle();
  assert.deepEqual(kept.log.confirms, [NOTES.confirmDelete]);
  assert.match(NOTES.confirmDelete, /support with it/);
  assert.match(NOTES.confirmDelete, /The payment itself stays with Stripe/);
  assert.ok(!kept.api.requests.some((r) => r.method === 'DELETE'), 'cancelled: nothing is deleted');

  const gone = page({ answers });
  await gone.ready;
  await button(gone.els, WORDS.deleteAccount).dispatch('click');
  await settle();
  assert.equal(gone.api.requests.at(-1).method, 'DELETE');
  assert.deepEqual(buttons(gone.els.body).map((b) => b.textContent), [WORDS.signIn, WORDS.signInToBuy]);
  assert.equal(gone.els.thanks.hidden, true);

  const failed = page({ answers: { ...answers, 'DELETE me': [409, { error: 'subscription_active' }] } });
  await failed.ready;
  await button(failed.els, WORDS.deleteAccount).dispatch('click');
  await settle();
  assert.deepEqual(failed.log.notes, [[NOTES.deleteFailed, NOTE_MS]]);
});

test('back from Google with ?signin=failed: said once, and taken out of the address', async () => {
  const p = page({ answers: { 'GET config': [200, ON], 'GET me': [200, { user: null, entitlements: [] }] }, href: `${BASE}?signin=failed` });
  assert.deepEqual(p.log.replaced, ['/phonogeometry/'], 'the address is cleaned before anything is asked');
  await p.ready;
  assert.deepEqual(p.log.notes, [[WORDS.signInFailed, NOTE_MS]]);
});

test('back from Checkout: thanked once the webhook has landed, told to reload when it has not', async () => {
  let asks = 0;
  const landed = page({ answers: {
    'GET config': [200, ON],
    'GET me': () => [200, { user: { email: 'a@b.c' }, entitlements: ++asks >= 3 ? ['supporter'] : [] }],
  }, href: `${BASE}?purchase=success` });
  assert.deepEqual(landed.log.replaced, ['/phonogeometry/']);
  await landed.ready;
  assert.deepEqual(landed.log.notes, [[WORDS.thanks('Support this app'), NOTE_MS]]);
  assert.equal(landed.log.notes[0][0], 'Thank you — Support this app is unlocked.');
  assert.deepEqual(landed.log.waits, [3000, 3000], 'asked again until it was there');
  assert.equal(landed.els.thanks.hidden, false);

  const late = page({ answers: { 'GET config': [200, ON], 'GET me': [200, { user: { email: 'a@b.c' }, entitlements: [] }] }, href: `${BASE}?purchase=success` });
  await late.ready;
  assert.deepEqual(late.log.notes, [[WORDS.paymentPending, NOTE_MS]]);
  assert.equal(late.log.waits.length, POLL.tries);
  assert.equal(late.api.requests.filter((r) => r.route === 'me').length, 1 + POLL.tries);

  const cancelled = page({ answers: { 'GET config': [200, ON], 'GET me': [200, { user: { email: 'a@b.c' }, entitlements: [] }] }, href: `${BASE}?purchase=cancelled` });
  await cancelled.ready;
  assert.deepEqual(cancelled.log.replaced, ['/phonogeometry/']);
  assert.deepEqual(cancelled.log.notes, [], 'a cancelled Checkout says nothing');
  assert.equal(cancelled.api.requests.filter((r) => r.route === 'me').length, 1);
});

test('the page holds the Account section and About\'s account lines hidden until the API says otherwise', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  for (const [id, hidden] of [['account', true], ['account-body', false], ['about-privacy', false], ['about-privacy-account', true], ['about-thanks', true]]) {
    const tag = html.match(new RegExp(`<[a-z]+ id="${id}"[^>]*>`))?.[0];
    assert.ok(tag, `index.html has #${id}`);
    assert.equal(/\shidden(\s|>)/.test(tag), hidden, `#${id} is ${hidden ? '' : 'not '}hidden in the markup`);
  }
  const app = fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8');
  assert.match(app, /els: \{ section: \$\('#account'\), body: \$\('#account-body'\), thanks: \$\('#about-thanks'\), privacyLocal: \$\('#about-privacy'\), privacy: \$\('#about-privacy-account'\) \}/);
  assert.match(html, /<p id="about-thanks" class="tip" hidden>Thank you for supporting Phonogeometry\.<\/p>/);
  const account = html.match(/<p id="about-privacy-account"[^>]*>([^<]*)<\/p>/)[1];
  assert.match(account, /nothing else leaves it unless you sign in or buy/);
  assert.match(account, /Google tells this site an account id and your email, Stripe handles the payment, and the site keeps the account id, what was bought and Stripe's customer id/);
});
