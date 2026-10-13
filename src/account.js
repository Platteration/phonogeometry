// Sign in with Google and "Support this app", on a site that runs the optional API (server/kit,
// on the site's own origin under api/: Cloudflare Pages' function, or server/start.mjs behind
// nginx). Everywhere else, GitHub Pages included, there is no such API and nothing here draws a
// thing: the page asks api/config once, and an answer of "nothing on" (the site's own static
// api/config), a 404, a network error or a body that is not the kit's shape leaves Settings as it
// always was. Nothing is stored and nothing is asked again. A browser that says it is offline is
// not asked at all.
//
// Where it is on, Settings gains an Account section (Sign in with Google; then "Signed in as …",
// Sign out and Delete account) holding the one thing the site sells, "Support this app", and
// About's privacy sentence is swapped for the one that also says what an account sends where. A
// purchase is granted by Stripe's signed webhook alone and read back from api/me; what it changes
// is one line of thanks in About and nothing in the app. A visitor who edits the page can show
// themselves that line without paying: it gates no feature, so there is nothing to protect, and
// the server's record of the payment is what a purchase is.
//
// Where sign-in is on but nothing is for sale (Google's variables set, Stripe's not), signing in
// would change nothing in this app, so it is not offered: the section is drawn only for a visitor
// already signed in (from when the site sold support), so they can sign out or delete the account.
//
// A purchase is granted when Stripe's webhook lands, which can be after the visitor is back (and
// on Cloudflare KV, up to a minute after that before every location reads it). Until api/me
// reports it, the product reads "Payment received — processing" where Buy was, for the life of
// the page and, through one sessionStorage marker (src/prefs.js SESSION_KEYS), across a reload
// within PENDING_MS: a second Buy there opened a second Checkout and charged the visitor twice.
// Only a signed-in visitor can have paid, so to anyone else a `?purchase=success` link says
// nothing and asks nothing.
//
// Everything the server says is read field by field and drawn as text (createElement and
// textContent), never as markup: the site's Trusted Types policy would refuse markup anyway.
// Sign-in and Checkout are top-level navigations to Google and Stripe, which the page's policy
// does not govern; the only requests are to the site's own api/ (connect-src 'self'), and the
// service worker answers none of them (sw.js). Kept apart from app.js so that a fake document
// and a fake fetch can drive it in node (test/account.test.js).

import { SESSION_KEYS, fields, readRecord, writeRecord } from './prefs.js';

/** The product server/catalogue.js sells, and the entitlement a paid one grants. */
export const SUPPORTER = 'supporter';
/** An id as the kit writes one: a product, an entitlement. */
const ID = /^[a-z][a-z0-9-]{0,31}$/;
/** The only place Buy navigates to. */
const CHECKOUT_ORIGIN = 'https://checkout.stripe.com';
/** After Checkout sends the visitor back: api/me up to five times over fifteen seconds. */
export const POLL = Object.freeze({ tries: 5, everyMs: 3000 });
/** How long a note from the account stays up: longer than a control's toast. */
export const NOTE_MS = 8000;
/** How long after Checkout sent this tab back a reload still says "processing" rather than
 *  offer Buy, while api/me has not reported the purchase: the webhook's own delay, and the
 *  minute Cloudflare KV can take to reach every location, with room to spare. */
export const PENDING_MS = 10 * 60 * 1000;

/** The words the account and the shop say, the same in every app that carries the kit
 *  (`processing` is this app's own so far: the others have no such state yet). */
export const WORDS = Object.freeze({
  signIn: 'Sign in with Google',
  signedInAs: (email) => `Signed in as ${email}`,
  signedIn: 'Signed in with Google',
  signOut: 'Sign out',
  deleteAccount: 'Delete account',
  signInFailed: "Sign-in didn't complete.",
  buy: 'Buy',
  signInToBuy: 'Sign in to buy',
  owned: 'Owned',
  thanks: (name) => `Thank you — ${name} is unlocked.`,
  paymentPending: 'Payment received. It can take a minute to appear — reload to check.',
  processing: 'Payment received — processing',
});

/** What the page asks before it deletes an account, and what it says when something fails. */
export const NOTES = Object.freeze({
  confirmDelete: 'Delete your account? This deletes your account on this site, and your support with it: the thank-you in About goes too. The payment itself stays with Stripe, with the account id it was made under. Your shots and meshes on this device are not touched. This cannot be undone.',
  deleteFailed: 'The account could not be deleted. Try again.',
  signOutFailed: 'Could not sign out. Try again.',
  unavailable: 'Support is not on sale right now.',
  busy: 'Too many tries for now. Try again in a while.',
  failed: 'The shop could not be reached. Try again.',
});

const SIGNED_OUT = Object.freeze({ user: null, entitlements: Object.freeze([]) });

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Text of at most `max` characters with no control character, or null. */
function text(value, max) {
  return typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

/** A price as Stripe states it, in the currency's smallest unit; null when it is not one. */
function readPrice(raw) {
  if (!isRecord(raw)) return null;
  const amount = raw.unit_amount;
  const currency = raw.currency;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) return null;
  if (typeof currency !== 'string' || !/^[a-z]{3}$/.test(currency)) return null;
  return { unitAmount: amount, currency };
}

/**
 * `GET api/config`'s body, or null when the feature does not exist: anything that is not the
 * kit's shape, and a body with sign-in off (the kit sells nothing without it). "Support this
 * app" is read from the product list when it is there as this app sells it (once, `payment`);
 * any other product is not this page's to draw.
 */
export function readConfig(raw) {
  if (!isRecord(raw) || !isRecord(raw.auth) || raw.auth.google !== true) return null;
  const listed = isRecord(raw.shop) && Array.isArray(raw.shop.products) ? raw.shop.products : [];
  for (const item of listed) {
    if (!isRecord(item) || item.id !== SUPPORTER || item.mode !== 'payment') continue;
    const name = text(item.name, 100);
    const description = text(item.description, 500);
    if (!name || description === null) continue;
    return { supporter: { id: SUPPORTER, name, description, price: readPrice(item.price) } };
  }
  return { supporter: null };
}

/** `GET api/me`'s body, or null when it is not the kit's shape. */
export function readMe(raw) {
  if (!isRecord(raw) || !Array.isArray(raw.entitlements)) return null;
  let user = null;
  if (raw.user !== null) {
    if (!isRecord(raw.user)) return null;
    user = { email: text(raw.user.email, 320) };
  }
  const entitlements = [...new Set(raw.entitlements.filter((e) => typeof e === 'string' && ID.test(e)))].slice(0, 50);
  return { user, entitlements };
}

/** Stripe's zero-decimal currencies (499 JPY is ¥499) and three-decimal ones (1500 KWD is
 *  1.500 KWD); every other currency is in hundredths. */
const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);
const THREE_DECIMAL = new Set(['bhd', 'jod', 'kwd', 'omr', 'tnd']);

/** A price for people to read, in `locale` (undefined: the browser's own). The currency is three
 *  letters (readPrice holds it to that), which Intl formats whether it knows the code or not. */
export function formatPrice(price, locale) {
  const divisor = ZERO_DECIMAL.has(price.currency) ? 1 : THREE_DECIMAL.has(price.currency) ? 1000 : 100;
  return new Intl.NumberFormat(locale, { style: 'currency', currency: price.currency.toUpperCase() }).format(price.unitAmount / divisor);
}

/**
 * What the address said on arrival (the kit's `?signin=failed`, Checkout's `?purchase=`), and
 * the same address without it, or null when there was nothing of ours to take out. Only the
 * values the kit writes are read and removed; any other `?purchase=` is not ours and stays.
 */
export function landingOf(href) {
  let url;
  try { url = new URL(href); } catch { return { landing: { signIn: null, purchase: null }, without: null }; }
  const signin = url.searchParams.get('signin');
  const purchase = url.searchParams.get('purchase');
  const landing = {
    signIn: signin === 'failed' ? 'failed' : null,
    purchase: purchase === 'success' || purchase === 'cancelled' ? purchase : null,
  };
  if (landing.signIn) url.searchParams.delete('signin');
  if (landing.purchase) url.searchParams.delete('purchase');
  if (!landing.signIn && !landing.purchase) return { landing, without: null };
  return { landing, without: `${url.pathname}${url.search}${url.hash}` };
}

/** The Checkout address `POST api/checkout` answered with, only when it is Stripe's hosted
 *  page over https; anything else is not followed. */
export function checkoutAddress(raw) {
  if (!isRecord(raw) || typeof raw.url !== 'string') return null;
  let url;
  try { url = new URL(raw.url); } catch { return null; }
  return url.origin === CHECKOUT_ORIGIN && !url.username && !url.password ? url.href : null;
}

/** Asks `me` up to POLL.tries times, POLL.everyMs apart, until it reports `entitlement`: a
 *  purchase is granted by Stripe's webhook, which may land after the visitor is back. */
export async function pollFor(entitlement, me, wait) {
  let last = null;
  for (let i = 0; i < POLL.tries; i += 1) {
    await wait(POLL.everyMs);
    last = await me();
    if (last && last.entitlements.includes(entitlement)) return { held: true, me: last };
  }
  return { held: false, me: last };
}

/**
 * The site's api/, under `base` (the site's root), through `fetch`. Every answer that is not
 * what the kit sends reads as "not available"; nothing throws.
 */
export function apiClient({ fetch, base }) {
  const api = (route) => new URL(`api/${route}`, base).href;
  const body = async (response) => {
    try { return JSON.parse(await response.text()); } catch { return undefined; }
  };
  const call = async (route, init) => {
    try { return await fetch(api(route), { credentials: 'same-origin', ...init }); } catch { return null; }
  };
  return {
    startUrl: (returnPath) => `${api('auth/google/start')}?return=${encodeURIComponent(returnPath)}`,
    async config() {
      const r = await call('config', {});
      return r && r.ok ? readConfig(await body(r)) : null;
    },
    async me() {
      const r = await call('me', { cache: 'no-store' });
      return r && r.ok ? readMe(await body(r)) : null;
    },
    async signOut() {
      const r = await call('auth/logout', { method: 'POST' });
      return !!r && r.status === 204;
    },
    async deleteAccount() {
      const r = await call('me', { method: 'DELETE' });
      return !!r && r.status === 204;
    },
    /** 'signin' (401), 'owned' (409), 'unavailable' (404), 'busy' (429), 'failed' (anything
     *  else, an address that is not Stripe's included), or { url } to go to. */
    async checkout(product) {
      const r = await call('checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ product }) });
      if (!r) return 'failed';
      if (r.status === 200) {
        const url = checkoutAddress(await body(r));
        return url ? { url } : 'failed';
      }
      return { 401: 'signin', 404: 'unavailable', 409: 'owned', 429: 'busy' }[r.status] || 'failed';
    },
  };
}

/**
 * The Account section of Settings. `o` carries what the page provides:
 *   doc       the document, to build elements with
 *   fetch     the browser's fetch (absent, as in app.js's tests, every call fails and the
 *             feature is off)
 *   base      the site's root, which api/ is under (defaults to this module's folder's parent)
 *   location  the window's location (href, pathname, search, assign)
 *   history   for taking the kit's flags out of the address
 *   online    whether the browser says it is online; false, api/config is not asked
 *   confirm   the page's confirm (window.confirm)
 *   note      shows a short message (the page's toast), with how long to show it
 *   wait      a timer, for the poll after a purchase
 *   session   the tab's sessionStorage (absent, or refusing, a reload forgets a payment in
 *             flight; the page itself does not)
 *   now       the clock (Date.now)
 *   els       { section, body, thanks, privacyLocal, privacy }: the hidden Account section, the
 *             element its controls are drawn in, About's thank-you line, and About's privacy
 *             sentence as it reads without an account and as it reads with one
 * Returns `ready`, which resolves to whether the feature is on, and the state, for the tests.
 */
export function startAccount(o) {
  const state = { config: null, me: SIGNED_OUT, busy: false, pending: false };
  const now = o.now ?? Date.now;
  const api = apiClient({ fetch: o.fetch, base: o.base ?? new URL('../', import.meta.url).href });
  const { landing, without } = landingOf(o.location?.href);
  if (without !== null) o.history.replaceState(null, '', without);
  const els = o.els;

  const el = (tag, className, ...children) => {
    const node = o.doc.createElement(tag);
    if (className) node.className = className;
    node.append(...children);
    return node;
  };
  const button = (label, className, onClick) => {
    const b = el('button', className, label);
    b.setAttribute('type', 'button');      // inside the dialog's <form>: a click submits nothing
    b.disabled = state.busy;
    b.addEventListener('click', onClick);
    return b;
  };
  /** Runs one action at a time: every button of the section is drawn disabled while it is out. */
  const act = async (task) => {
    state.busy = true;
    render();
    try { await task(); } finally { state.busy = false; render(); }
  };
  const owns = () => state.me.entitlements.includes(SUPPORTER);

  /** Whether this tab came back from a paid Checkout less than PENDING_MS ago. */
  const marked = () => {
    const { at } = fields(readRecord(o.session, SESSION_KEYS.purchasePending));
    return typeof at === 'number' && now() - at >= 0 && now() - at < PENDING_MS;
  };
  /** The payment is on its way: no Buy until api/me reports it, on this page or a reload. */
  const holdPending = () => {
    state.pending = true;
    writeRecord(o.session, SESSION_KEYS.purchasePending, { at: now() });
  };
  /** It arrived, or the account that paid has left the page. */
  const dropPending = () => {
    state.pending = false;
    try { o.session?.removeItem(SESSION_KEYS.purchasePending); } catch { /* it expires */ }
  };

  function render() {
    const { config, me } = state;
    els.section.hidden = false;
    els.privacyLocal.hidden = true;
    els.privacy.hidden = false;
    els.thanks.hidden = !owns();
    const parts = [];
    if (me.user) {
      parts.push(el('p', 'tip', me.user.email ? WORDS.signedInAs(me.user.email) : WORDS.signedIn));
      parts.push(el('div', 'row gap wrap', button(WORDS.signOut, 'ghost small', signOut), button(WORDS.deleteAccount, 'ghost small danger', deleteAccount)));
    } else {
      parts.push(el('div', 'row gap wrap', button(WORDS.signIn, 'ghost small', signIn)));
    }
    const product = config.supporter;
    if (product) {
      const heading = el('p', '', el('strong', '', product.name));
      if (product.price) heading.append(` · ${formatPrice(product.price)}`);
      const action = owns() ? el('p', 'tip', WORDS.owned)
        : !me.user ? button(WORDS.signInToBuy, 'primary small', signIn)
          : state.pending ? el('p', 'tip', WORDS.processing)
            : button(WORDS.buy, 'primary small', buy);
      parts.push(el('div', 'account-product', heading, el('p', 'tip', product.description), action));
    }
    els.body.replaceChildren(...parts);
  }

  /** Keyboard focus back on the section's first control, after a re-render took the one it was on. */
  const refocus = () => {
    const first = els.body.querySelector('button');
    if (first) first.focus();
  };

  function signIn() {
    o.location.assign(api.startUrl(`${o.location.pathname}${o.location.search}`));
  }

  function buy() {
    return act(async () => {
      const result = await api.checkout(SUPPORTER);
      if (typeof result === 'object') { o.location.assign(result.url); return; }
      if (result === 'signin') state.me = SIGNED_OUT;
      if (result === 'owned') state.me = (await api.me()) || state.me;
      if (result === 'unavailable') o.note(NOTES.unavailable, NOTE_MS);
      if (result === 'busy') o.note(NOTES.busy, NOTE_MS);
      if (result === 'failed') o.note(NOTES.failed, NOTE_MS);
    });
  }

  function signOut() {
    return act(async () => {
      if (await api.signOut()) { state.me = SIGNED_OUT; dropPending(); } else o.note(NOTES.signOutFailed, NOTE_MS);
    }).then(refocus);
  }

  function deleteAccount() {
    if (!o.confirm(NOTES.confirmDelete)) return Promise.resolve();
    return act(async () => {
      if (await api.deleteAccount()) { state.me = SIGNED_OUT; dropPending(); } else o.note(NOTES.deleteFailed, NOTE_MS);
    }).then(refocus);
  }

  async function afterPurchase(product) {
    if (owns()) { o.note(WORDS.thanks(product.name), NOTE_MS); return; }
    holdPending();
    render();
    const { held, me } = await pollFor(SUPPORTER, api.me, o.wait);
    if (me) state.me = me;
    if (held) dropPending();
    render();
    o.note(held ? WORDS.thanks(product.name) : WORDS.paymentPending, NOTE_MS);
  }

  const ready = (async () => {
    if (o.online && !o.online()) return false;
    const config = await api.config();
    if (!config) return false;
    const me = (await api.me()) || SIGNED_OUT;
    if (!config.supporter && !me.user) return false;   // nothing to buy, and no account to manage
    state.config = config;
    state.me = me;
    if (!owns() && marked()) state.pending = true;   // a reload while the payment is on its way
    else dropPending();
    render();
    if (landing.signIn === 'failed') o.note(WORDS.signInFailed, NOTE_MS);
    if (landing.purchase === 'success' && config.supporter && me.user) await afterPurchase(config.supporter);
    return true;
  })();
  return { ready, state };
}
