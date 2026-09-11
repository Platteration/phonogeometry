// A document small enough to hold in your head, for testing src/app.js in node.
//
// app.js is where the screens, the cameras and the store meet, and the bugs that live there
// are decisions — what to say, when to stop, what to close — not rendering. Those decisions
// need a document to run at all, but they do not need a real one: this stands in for the few
// dozen DOM operations app.js actually performs, so the browser suite can stay for the things
// that genuinely need a browser (real getUserMedia, WebGL, a service worker).
//
// It is deliberately literal: a node is its tag, its classes, its children and its listeners.
// Anything app.js does not use is not here.

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];              // FakeElement | string
    this.listeners = new Map();
    this.classes = new Set();
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.title = '';
    this.html = '';                    // whatever was set as markup, kept verbatim
  }

  get className() { return [...this.classes].join(' '); }
  set className(v) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); }

  get classList() {
    const c = this.classes;
    return {
      add: (...n) => n.forEach((x) => c.add(x)),
      remove: (...n) => n.forEach((x) => c.delete(x)),
      contains: (n) => c.has(n),
      toggle: (n, on) => { const want = on === undefined ? !c.has(n) : !!on; if (want) c.add(n); else c.delete(n); return want; },
    };
  }

  get textContent() { return this.childNodes.map((n) => (typeof n === 'string' ? n : n.textContent)).join(''); }
  set textContent(v) { this.childNodes = v === '' || v === undefined ? [] : [String(v)]; }

  get innerHTML() { return this.html; }
  set innerHTML(v) { this.childNodes = []; this.html = String(v); }
  insertAdjacentHTML(_where, markup) { this.html += String(markup); }

  append(...nodes) { for (const n of nodes) this.childNodes.push(n); }
  appendChild(node) { this.childNodes.push(node); return node; }
  remove() {}

  matches(selector) {
    if (selector.startsWith('.')) return this.classes.has(selector.slice(1));
    if (selector.startsWith('#')) return this.attributes.id === selector.slice(1);
    return this.tagName === selector.toUpperCase();
  }

  querySelectorAll(selector) {
    const found = [];
    for (const child of this.childNodes) {
      if (typeof child === 'string') continue;
      if (child.matches(selector)) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest() { return null; }

  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  /** Fire a listener the way a user would. */
  dispatch(type, event = {}) {
    for (const fn of this.listeners.get(type) || []) fn({ type, target: this, preventDefault() {}, ...event });
  }

  click() { this.dispatch('click'); }
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  toDataURL() { return 'data:,'; }
}

/**
 * Install a document, a window and the handful of globals app.js reaches for. Selectors are
 * answered by the same node every time, created on first ask, so a test can read what the app
 * wrote to `#camera-status` without having to build a page first.
 */
export function installFakeDom() {
  const bySelector = new Map();
  const documentListeners = new Map();

  const document = {
    visibilityState: 'visible',
    querySelector(selector) {
      if (!bySelector.has(selector)) {
        const node = new FakeElement(selector.startsWith('#') ? 'div' : selector);
        if (selector.startsWith('#')) node.attributes.id = selector.slice(1);
        bySelector.set(selector, node);
      }
      return bySelector.get(selector);
    },
    createElement(tag) { return new FakeElement(tag); },
    addEventListener(type, fn) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(fn);
    },
    dispatch(type, event = {}) { for (const fn of documentListeners.get(type) || []) fn({ type, preventDefault() {}, ...event }); },
    body: new FakeElement('body'),
    activeElement: null,
  };

  const windowListeners = new Map();
  const window = {
    isSecureContext: false,
    addEventListener(type, fn) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(fn);
    },
    dispatch(type, event = {}) { for (const fn of windowListeners.get(type) || []) fn({ type, ...event }); },
  };

  globalThis.document = document;
  globalThis.window = window;
  globalThis.Option = class Option {
    constructor(label, value) { this.label = label; this.value = value; this.selected = false; this.textContent = label; }
  };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 2);

  return { document, window, $: (selector) => document.querySelector(selector), FakeElement };
}

export function uninstallFakeDom() {
  delete globalThis.document;
  delete globalThis.window;
  delete globalThis.Option;
  delete globalThis.requestAnimationFrame;
}

export { FakeElement };
