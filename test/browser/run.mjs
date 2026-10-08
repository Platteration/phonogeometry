#!/usr/bin/env node
// Browser tests for the whole application: capture with a fake camera, a scan that works,
// a scan that cannot work, and offline operation. These need a real browser, so they are
// not part of `npm test`; run them with `npm run test:e2e`.
//
// Playwright and a Chromium build must be available. Point at them with PLAYWRIGHT_MODULE
// and CHROMIUM_PATH if they are not where this script looks by default. Without them the
// suite skips itself, which is what makes it safe to run anywhere — set REQUIRE_BROWSER=1
// (as CI does) to make a missing browser a failure instead of a silent pass.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeObjectScan, writeStandingStillScan } from './fixtures.mjs';
import { fakePhoneCameras } from './fakeCameras.mjs';
import { build as buildSite, siteFiles } from '../../tools/site.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const PORT = Number(process.env.PORT || 8099);
const pkgVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const BASE = `http://localhost:${PORT}/`;

// Where a globally installed Playwright lives for the node running this script, rather than
// a path from one particular machine: `<prefix>/lib/node_modules/...` next to the binary.
const globalModules = path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules');
const PLAYWRIGHT_CANDIDATES = [
  process.env.PLAYWRIGHT_MODULE,
  'playwright',
  path.join(globalModules, 'playwright', 'index.mjs'),
  '/usr/local/lib/node_modules/playwright/index.mjs',
].filter(Boolean);

async function loadPlaywright() {
  for (const spec of PLAYWRIGHT_CANDIDATES) {
    try { return (await import(spec)).chromium; } catch { /* try the next */ }
  }
  return null;
}

/** Playwright's own browser first, then whatever the system has; null means "let it decide". */
function findChromium(chromium) {
  const own = (() => { try { return chromium.executablePath(); } catch { return null; } })();
  const candidates = [process.env.CHROMIUM_PATH, own, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].filter(Boolean);
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

// GitHub Pages serves the app from <user>.github.io/<repository>/, not from the root.
const SUB_PATH = '/phonogeometry/';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8',
};

/** _headers as [{ pattern, headers }], in file order: what Netlify and Cloudflare Pages send. */
function headerRules() {
  const rules = [];
  for (const line of fs.readFileSync(path.join(root, '_headers'), 'utf8').split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) { rules.push({ pattern: line.trim(), headers: {} }); continue; }
    const m = line.match(/^\s+([A-Za-z-]+):\s*(.+)$/);
    rules[rules.length - 1].headers[m[1]] = m[2].trim();
  }
  return rules;
}
/** The headers such a host sends for a path of the site ('/x', from the site's root). */
function headersFor(rules, sitePath) {
  const out = {};
  for (const { pattern, headers } of rules) {
    if (pattern.endsWith('/*') ? sitePath.startsWith(pattern.slice(0, -1)) : sitePath === pattern) Object.assign(out, headers);
  }
  return out;
}

/**
 * Serves `dir` under SUB_PATH the way a static host does, and nothing outside it: every
 * response carries the headers _headers writes for its path, and an address the site does not
 * have is answered 404 with the site's own 404.html, as Netlify, Cloudflare Pages and GitHub
 * Pages answer it. Every request is recorded, the service worker's own included, so a URL that
 * escapes the sub-path or names a missing file is seen. `stop` closes it for real: Playwright's
 * offline mode does not reach a service worker's own fetches (measured: a reload after
 * setOffline(true) still sent 26 requests to the host), so a worker that answered from the
 * network rather than its cache would pass with the host still up. The files carry no
 * validators, so the no-cache _headers sends makes the browser fetch each one afresh: what the
 * host serves is what the worker is shown.
 */
async function serveSite(dir) {
  const requests = [];
  const rules = headerRules();
  let movedTo = null;
  const server = http.createServer((req, res) => {
    const { pathname, search } = new URL(req.url, 'http://localhost');
    // A site that has moved answers every address with a redirect to the same path there.
    if (movedTo) {
      requests.push({ path: pathname, status: 301 });
      res.writeHead(301, { Location: `${movedTo}${pathname.startsWith(SUB_PATH) ? pathname.slice(SUB_PATH.length) : ''}${search}` });
      return res.end();
    }
    let file = null;
    let rel = null;
    if (pathname.startsWith(SUB_PATH)) {
      try { rel = decodeURIComponent(pathname.slice(SUB_PATH.length)); } catch { /* a malformed escape is a 404 */ }
      const candidate = rel === null ? null : path.join(dir, rel === '' || rel.endsWith('/') ? `${rel}index.html` : rel);
      if (candidate?.startsWith(dir + path.sep) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) file = candidate;
    }
    requests.push({ path: pathname, status: file ? 200 : 404 });
    const shown = file || path.join(dir, '404.html');
    res.writeHead(file ? 200 : 404, {
      'Content-Type': TYPES[path.extname(shown)] ?? 'application/octet-stream',
      ...headersFor(rules, `/${file ? rel : '404.html'}`),
    });
    res.end(fs.readFileSync(shown));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://localhost:${server.address().port}${SUB_PATH}`,
    requests,
    moveTo: (url) => { movedTo = url; },
    stop: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

/**
 * Records what a policy refused in `target` (a page or a context): securitypolicyviolation
 * events from every document it loads (a binding outlives a navigation, which drops a page's
 * own record), console lines about the policy, the permissions policy or Trusted Types, every
 * console error and every page error.
 */
async function watchPolicy(target, into, { consoleErrors = true } = {}) {
  await target.exposeBinding('__policyViolation', (_source, line) => { into.push(`violation: ${line}`); });
  await target.addInitScript(() => {
    addEventListener('securitypolicyviolation', (e) => {
      window.__policyViolation(`${e.effectiveDirective} refused ${e.blockedURI || '(inline)'} at ${e.sourceFile || location.href}:${e.lineNumber} ${e.sample || ''}`.trim());
    }, true);
  });
  // Without console errors and page errors this watches the policy alone, for the sections that
  // check their own errors and stage failures on purpose.
  const onPage = (page) => {
    page.on('console', (m) => {
      if ((consoleErrors && m.type() === 'error') || /Content.Security.Policy|Permissions.policy|Trusted.?Type/i.test(m.text())) into.push(`console ${m.type()}: ${m.text().slice(0, 300)} (${m.location().url})`);
    });
    if (consoleErrors) page.on('pageerror', (e) => into.push(`page error: ${e.message}`));
  };
  if (typeof target.pages === 'function') target.on('page', onPage); else onPage(target);
}

/** The text of `file` in this app's own cache (whatever its generation), or null. */
function cachedText(page, file) {
  return page.evaluate(async (f) => {
    for (const name of (await caches.keys()).filter((k) => k.startsWith('phonogeometry-'))) {
      const hit = await (await caches.open(name)).match(f);
      if (hit) return hit.text();
    }
    return null;
  }, file);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  — ' + detail : ''}`);
}

async function waitForResult(page, timeout = 300000) {
  return Promise.race([
    page.waitForFunction(() => {
      const v = document.querySelector('#screen-view'), b = document.querySelector('#building');
      return v && !v.hidden && b && b.hidden && (document.querySelector('#stats')?.textContent || '').length > 0;
    }, null, { timeout }).then(() => 'finished'),
    page.waitForFunction(() => (document.querySelector('#building-stage')?.textContent || '').includes('Could not')
      || (document.querySelector('#progress-stage')?.textContent || '').includes('failed'), null, { timeout }).then(() => 'failed'),
  ]).catch(() => 'timeout');
}

async function main() {
  const required = process.env.REQUIRE_BROWSER === '1' || process.argv.includes('--require');
  const chromium = await loadPlaywright();
  if (!chromium) {
    console.log('Playwright is not installed, so the browser tests were skipped.');
    console.log('Install it with `npm i -D playwright && npx playwright install chromium`, or set PLAYWRIGHT_MODULE.');
    return required ? 1 : 0;
  }
  const executablePath = findChromium(chromium);

  const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'phonogeometry-'));
  const shots = path.join(fixtures, 'shots');
  writeObjectScan(path.join(fixtures, 'object'));
  writeObjectScan(path.join(fixtures, 'blurred'), { blurFrame: 3 });
  writeStandingStillScan(path.join(fixtures, 'still'));
  fs.mkdirSync(shots, { recursive: true });

  const server = spawn(process.execPath, [path.join(root, 'server.js'), `--port=${PORT}`], { cwd: root, stdio: 'ignore' });
  const stop = () => { try { server.kill(); } catch { /* already gone */ } };
  process.on('exit', stop);
  await new Promise((r) => setTimeout(r, 1200));

  const args = ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'];
  if (process.env.HTTPS_PROXY) { args.push('--proxy-server=' + process.env.HTTPS_PROXY, '--proxy-bypass-list=localhost;127.0.0.1'); }
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [...args, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    ...(process.env.HTTPS_PROXY ? { ignoreDefaultArgs: ['--no-proxy-server'] } : {}),
  });

  // Every page the sections below open at the dev server runs under the policy index.html
  // carries in its <meta>, which is what GitHub Pages serves: anything it refuses there is
  // recorded and checked at the end. (The headers are section 4's.)
  const metaFindings = [];
  const newPage = async (options) => {
    const page = await browser.newPage(options);
    await watchPolicy(page, metaFindings, { consoleErrors: false });
    return page;
  };

  try {
    // ---- 1. Cameras and capture, with the browser's fake camera device ----
    {
      const page = await newPage({ viewport: { width: 420, height: 860 }, permissions: ['camera'] });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(BASE, { waitUntil: 'load' });
      await page.click('#btn-start-cameras');
      await page.waitForFunction(() => document.querySelectorAll('#camera-grid .cam-tile').length > 0, null, { timeout: 20000 });
      for (let i = 0; i < 2; i++) {
        await page.click('#btn-capture');
        await page.waitForFunction((n) => document.querySelectorAll('#thumbs .shot').length >= n, i + 1, { timeout: 20000 });
      }
      const shotCount = Number(await page.textContent('#shot-count'));
      check('capture from the phone cameras', shotCount === 2 && errors.length === 0, `${shotCount} shots, ${errors.length} page errors`);
      await page.close();
    }

    // ---- 1b. A phone with three cameras, one of which cannot stream alongside the others ----
    for (const limit of [3, 1]) {
      const page = await newPage({ viewport: { width: 420, height: 860 }, permissions: ['camera'] });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.addInitScript(fakePhoneCameras(), { limit });
      await page.goto(BASE, { waitUntil: 'load' });
      await page.click('#btn-start-cameras');
      await page.waitForFunction(() => document.querySelectorAll('#camera-grid .cam-tile').length === 3, null, { timeout: 20000 });
      const label = limit === 3 ? 'three cameras at once' : 'three cameras, only one at a time';

      const tiles = await page.$$eval('#camera-grid .cam-tile', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
      check(`${label}: every lens is listed and named`,
        tiles.length === 3 && tiles.some((t) => /Back 1/.test(t)) && tiles.some((t) => /Back 2/.test(t)) && tiles.some((t) => /Front/.test(t)),
        tiles.join(' / '));
      check(`${label}: lens types are guessed from the labels`,
        tiles.some((t) => /Ultra-wide/.test(t)) && tiles.some((t) => /Front \(selfie\)/.test(t)),
        tiles.join(' / '));

      await page.click('#btn-capture');
      await page.waitForFunction(() => document.querySelectorAll('#thumbs .shot').length >= 1, null, { timeout: 30000 });
      await page.waitForTimeout(500);
      const framesInShot = await page.$$eval('#thumbs .shot:first-child .thumb', (els) => els.map((e) => e.textContent.trim()));
      check(`${label}: one press captures from all of them`, framesInShot.length === 3, `${framesInShot.length} frames: ${framesInShot.join(', ')}`);

      // A second press must work as well as the first: the tiles have to survive the first one
      await page.click('#btn-capture');
      await page.waitForFunction(() => document.querySelectorAll('#thumbs .shot').length >= 2, null, { timeout: 30000 });
      await page.waitForTimeout(500);
      const secondShot = await page.$$eval('#thumbs .shot:nth-child(2) .thumb', (els) => els.length);
      check(`${label}: a second press captures from all of them too`, secondShot === 3, `${secondShot} frames`);

      // The movement guide should be measuring against the shot just taken
      if (limit === 3) {
        await page.waitForTimeout(1200);
        // Ask what is on the screen, not what a property says. `hidden` is an HTMLElement
        // property and the ring is an <svg>, so reading it reported a ring that was never
        // drawn: the check passed for months of nothing being visible.
        const ringBox = await page.$eval('#guide-ring', (e) => {
          const r = e.getBoundingClientRect();
          return { w: Math.round(r.width), h: Math.round(r.height) };
        });
        const level = await page.$eval('#guide-ring', (e) => e.dataset.level || '');
        const status = (await page.textContent('#guide-status')).trim();
        check(`${label}: the movement guide reports something after a shot`,
          ringBox.w > 80 && level.length > 0 && status.length > 0,
          `ring ${ringBox.w}x${ringBox.h}, level "${level}", status "${status}"`);

        // and the ring has to stand clear of the shutter, or it cannot be read at all
        const clearance = await page.evaluate(() => {
          const r = document.querySelector('#guide-ring').getBoundingClientRect();
          const s = document.querySelector('#btn-capture').getBoundingClientRect();
          return Math.round((s.left - r.left) * 10) / 10;
        });
        check(`${label}: the ring stands outside the shutter`, clearance >= 10, `${clearance}px of ring outside the button`);

        // Turning the guide off must stop it and hide the ring. The switch lives in the
        // settings dialog, so open it the way a user would.
        await page.click('#btn-settings');
        await page.waitForTimeout(200);
        await page.uncheck('#chk-guide');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(700);
        check(`${label}: the guide can be turned off`,
          await page.$eval('#guide-ring', (e) => e.getBoundingClientRect().width === 0));
        await page.click('#btn-settings');
        await page.waitForTimeout(200);
        await page.check('#chk-guide');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
      }

      const liveTiles = await page.$$eval('#camera-grid .cam-tile video', (els) => els.filter((v) => v.videoWidth > 0 && !v.paused).length);
      check(`${label}: the previews are still live afterwards`, liveTiles === Math.min(3, limit), `${liveTiles} live of ${Math.min(3, limit)} expected`);

      if (limit === 3) {
        // The cameras belong to the capture screen. A build runs for minutes on a phone that
        // is already hot, and the OS indicator stays lit through all of it while nothing is
        // being captured. Held track objects are what says so: closing a stream also clears
        // the <video>'s srcObject, so counting live previews would pass on a detached but
        // still-running track.
        await page.evaluate(() => {
          window.__tracks = [];
          for (const v of document.querySelectorAll('video')) for (const t of v.srcObject?.getVideoTracks() || []) window.__tracks.push(t);
        });
        const states = () => page.evaluate(() => window.__tracks.map((t) => t.readyState));
        const before = await states();
        await page.click('#btn-reconstruct');
        await page.waitForFunction(() => document.querySelector('#screen-capture').hidden, null, { timeout: 20000 });
        await page.waitForTimeout(400);
        const during = await states();
        // A build that fails fast can put the preview on screen instead, which carries the
        // other stop button.
        await page.click(await page.$eval('#screen-process', (e) => e.hidden) ? '#btn-cancel-build' : '#btn-cancel');
        await page.waitForFunction(() => !document.querySelector('#screen-capture').hidden, null, { timeout: 20000 });
        const liveNow = () => page.$$eval('#camera-grid .cam-tile video', (els) => els.filter((v) => v.srcObject?.getVideoTracks().some((t) => t.readyState === 'live')).length);
        // Reopening is one getUserMedia per lens, so give them all a moment to come back.
        for (let i = 0; i < 40 && (await liveNow()) < 3; i++) await page.waitForTimeout(250);
        const live = await liveNow();
        check(`${label}: the cameras stop while a build runs, and come back with the screen`,
          before.length === 3 && before.every((r) => r === 'live') && during.every((r) => r === 'ended') && live === 3,
          `before ${before.join(',')} · during ${during.join(',')} · after ${live} live`);
      }

      if (limit === 1) {
        // Changing the capture resolution reopens the streams. Only the cameras that were
        // open can be reopened, so the ones this phone will not run alongside the others are
        // not part of that — and their tiles must keep saying why they are dark and that they
        // will still be captured, rather than falling back to a bare "Not open".
        await page.click('#btn-settings');
        await page.selectOption('#capture-res', '960');
        await page.waitForFunction(() => /streaming live at up to 960 px/.test(document.querySelector('#camera-status').textContent), null, { timeout: 30000 });
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        const explained = await page.$$eval('#camera-grid .cam-tile', (els) => els.filter((e) => /Will capture sequentially/.test(e.textContent)).length);
        const flagged = await page.$$eval('#camera-grid .cam-tile.failed', (els) => els.length);
        const status = (await page.textContent('#camera-status')).replace(/\s+/g, ' ').trim();
        check(`${label}: changing the capture resolution keeps them explained`,
          explained === 2 && flagged === 2 && /2 will be captured sequentially/.test(status),
          `${explained} tiles explained, ${flagged} flagged; status: ${status}`);
      }

      check(`${label}: no page errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
      await page.close();
    }

    // ---- 2. A scan that works, from import to export ----
    {
      const page = await newPage({ viewport: { width: 420, height: 860 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('dialog', (d) => d.accept());
      // Count the draw calls the page issues, so the viewer's loop can be watched from
      // outside it: whether it is still drawing is the behaviour, not what it says about
      // itself. Counting animation frames instead would count this script's own rAF polling.
      await page.addInitScript(() => {
        window.__draws = 0;
        for (const proto of [window.WebGLRenderingContext?.prototype, window.WebGL2RenderingContext?.prototype]) {
          if (!proto) continue;
          for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
            const real = proto[name];
            if (!real) continue;
            proto[name] = function (...args) { window.__draws++; return real.apply(this, args); };
          }
        }
      });
      await page.goto(BASE, { waitUntil: 'load' });
      const blurredDir = path.join(fixtures, 'blurred');
      await page.setInputFiles('#file-import', fs.readdirSync(blurredDir).sort().map((f) => path.join(blurredDir, f)));
      await page.waitForFunction(() => document.querySelectorAll('#thumbs .shot').length >= 8, null, { timeout: 30000 });
      const blurry = await page.$$eval('.thumb-flag.warn', (els) => els.length);
      check('a blurred photo is flagged on import', blurry === 1, `${blurry} flagged`);
      await page.click('#btn-clear');
      await page.waitForFunction(() => document.querySelectorAll('#thumbs .shot').length === 0, null, { timeout: 10000 });

      const dir = path.join(fixtures, 'object');
      await page.setInputFiles('#file-import', fs.readdirSync(dir).sort().map((f) => path.join(dir, f)));
      await page.waitForFunction(() => document.querySelectorAll('#thumbs .shot').length >= 8, null, { timeout: 30000 });
      const sharpFlags = await page.$$eval('.thumb-flag.warn', (els) => els.length);
      check('sharp photos are not flagged', sharpFlags === 0, `${sharpFlags} flagged`);

      await page.selectOption('#quality', 'fast');
      const started = Date.now();
      let previewAt = 0;
      const previewSeen = page.waitForSelector('#building:not([hidden])', { timeout: 200000 })
        .then(() => { previewAt = Date.now() - started; }).catch(() => {});
      await page.click('#btn-reconstruct');
      const outcome = await waitForResult(page);
      await previewSeen;
      const stats = (await page.textContent('#stats')).replace(/\s+/g, ' ');
      const unused = await page.$$eval('.thumb-flag.bad', (els) => els.length);
      check('a good scan reconstructs, using every photo', outcome === 'finished' && /^8\/8/.test(stats.trim()) && unused === 0,
        `${outcome}: ${stats}, ${unused} unused`);
      check('the camera path is previewed before the surface', previewAt > 0 && previewAt < Date.now() - started,
        previewAt ? `preview at ${(previewAt / 1000).toFixed(1)}s of ${((Date.now() - started) / 1000).toFixed(1)}s` : 'never shown');

      for (const [button, ext] of [['#btn-export-glb', '.glb'], ['#btn-export-ply', '.ply'], ['#btn-export-points', '.ply']]) {
        const [dl] = await Promise.all([page.waitForEvent('download'), page.click(button)]);
        const file = path.join(shots, dl.suggestedFilename());
        await dl.saveAs(file);
        check(`export ${button.replace('#btn-export-', '')}`, fs.statSync(file).size > 1000 && dl.suggestedFilename().endsWith(ext), `${fs.statSync(file).size} bytes`);
      }

      // ---- Setting a real-world scale ----
      const glbBefore = fs.statSync(path.join(shots, fs.readdirSync(shots).find((f) => f.endsWith('.glb')))).size;
      await page.click('#btn-measure');
      const box = await page.$eval('#viewer canvas', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
      // Tap two points on the model, well above the toolbar that overlays the lower part
      const toolbarTop = await page.$eval('.viewer-toolbar', (el) => el.getBoundingClientRect().top);
      const usable = Math.max(box.y + 80, toolbarTop - 40);
      const midY = (box.y + 60 + usable) / 2;
      await page.mouse.click(box.x + box.w * 0.42, midY);
      await page.waitForTimeout(300);
      await page.mouse.click(box.x + box.w * 0.58, midY);
      await page.waitForTimeout(400);
      const entryShown = !(await page.$eval('#measure-entry', (e) => e.hidden));
      check('two taps on the model give a measurement', entryShown, (await page.textContent('#measure-hint')).trim().slice(0, 70));
      if (entryShown) {
        await page.fill('#measure-value', '0.5');
        await page.selectOption('#measure-unit', '1');
        await page.click('#btn-measure-apply');
        await page.waitForTimeout(400);
        const statsText = (await page.textContent('#stats')).replace(/\s+/g, ' ');
        const reported = (statsText.match(/([\d.]+) m × ([\d.]+) m × ([\d.]+) m/) || []).slice(1).map(Number);
        check('the model size is reported once the scale is known', reported.length === 3, statsText.slice(-60));
        const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export-glb')]);
        const file = path.join(shots, 'scaled-' + dl.suggestedFilename());
        await dl.saveAs(file);
        const scaled = fs.readFileSync(file);
        const json = JSON.parse(scaled.subarray(20, 20 + scaled.readUInt32LE(12)).toString());
        const extent = json.accessors[0].max.map((v, i) => v - json.accessors[0].min[i]);
        // glTF is defined in metres, so the exported bounds must be the size shown on screen
        const matches = reported.length === 3 && extent.every((v, i) => Math.abs(v - reported[i]) < 0.02 * reported[i]);
        check('the export carries the scale that was set',
          matches && Math.abs(fs.statSync(file).size - glbBefore) < 4096,
          `bounding box ${extent.map((v) => v.toFixed(2)).join(' × ')} m against ${reported.join(' × ')} m shown`);
      }
      if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, 'measure.png') });
      await page.click('#btn-measure');

      // The three.js loop must draw while the viewer is the screen you are on and stop when
      // it is not: otherwise it runs behind a hidden screen, next to the live camera
      // previews and the next build's use of the GPU. Counted from the frames the loop
      // actually draws, not from anything the viewer says about itself: a loop that kept
      // running while claiming to have stopped is exactly the regression this is for.
      const drawsAtStart = await page.evaluate(() => window.__draws);
      await page.waitForTimeout(600);
      const drawsOnView = await page.evaluate(() => window.__draws);
      await page.click('#btn-back-capture');
      await page.waitForTimeout(400);           // let a frame already scheduled land
      const drawsAfterLeaving = await page.evaluate(() => window.__draws);
      await page.waitForTimeout(600);
      const drawsLater = await page.evaluate(() => window.__draws);
      const drewOnView = drawsOnView - drawsAtStart;
      const drewAway = drawsLater - drawsAfterLeaving;
      check('the viewer stops drawing once you leave it',
        drewOnView > 0 && drewAway === 0,
        `${drewOnView} draw calls in 0.6s on the viewer, ${drewAway} in 0.6s after leaving`);

      // A preference is written when its control changes and read back on the next load.
      await page.click('#btn-settings');
      await page.selectOption('#capture-res', '1920');
      await page.keyboard.press('Escape');
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => document.querySelectorAll('#thumbs .shot').length >= 8, null, { timeout: 20000 }).catch(() => {});
      const restored = Number(await page.textContent('#shot-count'));
      check('shots survive a reload', restored === 8, `${restored} restored`);
      const kept = await page.$eval('#capture-res', (s) => s.value);
      check('a changed preference survives a reload', kept === '1920', `capture resolution came back as ${kept}`);
      // The About block is filled from the version module, not typed into the markup.
      await page.click('#btn-settings');
      // The whole line, not just the span: "Version <n>" is the form the sibling apps show.
      const about = (await page.$eval('#about-version', (el) => el.parentElement.textContent.replace(/\s+/g, ' ').trim()));
      check('the About block shows the package version', about === `Version ${pkgVersion}`, `shows "${about}", package.json says ${pkgVersion}`);
      await page.selectOption('#capture-res', '1280');   // back to the default for the sections after this one
      await page.keyboard.press('Escape');
      check('no page errors during a good scan', errors.length === 0, errors.slice(0, 2).join(' | '));
      await page.close();
    }

    // ---- 2b. Names that come from outside are shown, not executed ----
    {
      const page = await newPage({ viewport: { width: 420, height: 860 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(BASE, { waitUntil: 'load' });
      // A photo whose file name is markup. It reaches the interface as a label.
      const nasty = path.join(fixtures, 'x"><img src=x onerror="window.__injected=1">.png');
      fs.copyFileSync(path.join(fixtures, 'object', 'photo-0.png'), nasty);
      await page.setInputFiles('#file-import', [nasty]);
      await page.waitForFunction(() => document.querySelectorAll('#thumbs .shot').length >= 1, null, { timeout: 20000 });
      await page.waitForTimeout(600);
      const injected = await page.evaluate(() => window.__injected === 1);
      const shown = await page.$eval('#thumbs .thumb-label', (e) => e.textContent);
      const strayImages = await page.$$eval('#thumbs img', (els) => els.filter((i) => i.getAttribute('src') === 'x').length);
      check('a file name that looks like markup is shown as text',
        !injected && strayImages === 0 && shown.includes('<img'),
        `injected: ${injected}, stray elements: ${strayImages}, label: ${JSON.stringify(shown)}`);
      check('no page errors from an awkward file name', errors.length === 0, errors.slice(0, 2).join(' | '));
      await page.close();
    }

    // ---- 2c. Cancel during the decode, and a photo that cannot be decoded at all ----
    {
      const page = await newPage({ viewport: { width: 420, height: 860 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      // Decoding thirty frames on a phone takes seconds. Here it is slowed on purpose so the
      // Cancel press lands inside that window, which is where there is no worker to terminate.
      await page.addInitScript(() => {
        const real = window.createImageBitmap.bind(window);
        window.createImageBitmap = async (...args) => { await new Promise((r) => setTimeout(r, 400)); return real(...args); };
      });
      await page.goto(BASE, { waitUntil: 'load' });
      const dir = path.join(fixtures, 'object');
      await page.setInputFiles('#file-import', fs.readdirSync(dir).sort().map((f) => path.join(dir, f)));
      await page.waitForFunction(() => document.querySelectorAll('#thumbs .shot').length >= 8, null, { timeout: 60000 });
      await page.selectOption('#quality', 'fast');
      await page.click('#btn-reconstruct');
      await page.waitForTimeout(500);   // still decoding
      await page.click('#btn-cancel');
      // A build that ignored the cancel would move past the first stage and then pull the
      // user onto the viewer when its preview arrives.
      const carriedOn = await page.waitForFunction(() => !document.querySelector('#screen-view').hidden
        || /Matching|Solving|Computing|Fusing|Extracting|Done/.test(document.querySelector('#progress-stage').textContent),
      null, { timeout: 12000 }).then(() => true).catch(() => false);
      const onCapture = await page.$eval('#screen-capture', (e) => !e.hidden);
      check('cancelling while the photos are decoding stops the build', !carriedOn && onCapture,
        `carried on: ${carriedOn}, on the capture screen: ${onCapture}`);

      // A stored photo whose blob cannot be decoded (a canvas that returned null under
      // memory pressure, a record that no longer reads) must cost that frame, not the scan.
      await page.evaluate(async () => {
        const db = await new Promise((res, rej) => {
          const r = indexedDB.open('phonogeometry', 1);
          r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
        });
        await new Promise((res, rej) => {
          const t = db.transaction('shots', 'readwrite');
          t.objectStore('shots').put({
            id: 'shot-unreadable',
            createdAt: Date.now() + 60000,
            frames: [{
              blob: new Blob(['this is not a photograph'], { type: 'image/jpeg' }),
              thumbUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
              width: 320, height: 240, f: 300, cx: 159.5, cy: 119.5,
              label: 'unreadable', lens: 'unknown', key: 'import', sharpness: 5,
            }],
          });
          t.oncomplete = res; t.onerror = () => rej(t.error);
        });
      });
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => document.querySelectorAll('#thumbs .shot').length >= 9, null, { timeout: 30000 });
      await page.selectOption('#quality', 'fast');
      await page.click('#btn-reconstruct');
      const outcome = await waitForResult(page, 200000);
      const log = await page.textContent('#progress-log');
      check('a photo that cannot be decoded is left out, not left hanging',
        outcome === 'finished' && /could not be read/.test(log),
        `${outcome}; log ${/could not be read/.test(log) ? 'says so' : 'is silent'}`);
      check('no page errors around a cancelled or undecodable build', errors.length === 0, errors.slice(0, 2).join(' | '));
      await page.close();
    }

    // ---- 2d. A build that has been superseded must not drive the screen ----
    {
      const page = await newPage({ viewport: { width: 420, height: 860 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      // Keep every worker the page creates. A worker whose build has been cancelled or
      // replaced is not stopped the instant that happens — the replacement only terminates it
      // after decoding the photos, which takes seconds — so its queued messages arrive while
      // the newer build owns the screen. Holding a reference lets one speak on cue.
      await page.addInitScript(() => {
        const Real = window.Worker;
        window.__workers = [];
        window.Worker = class extends Real {
          constructor(...args) { super(...args); window.__workers.push(this); }
        };
      });
      await page.goto(BASE, { waitUntil: 'load' });
      const dir = path.join(fixtures, 'object');
      await page.setInputFiles('#file-import', fs.readdirSync(dir).sort().map((f) => path.join(dir, f)));
      await page.waitForFunction(() => document.querySelectorAll('#thumbs .shot').length >= 8, null, { timeout: 30000 });
      await page.selectOption('#quality', 'fast');

      await page.click('#btn-reconstruct');
      const buildOfferedAgain = await page.$eval('#btn-reconstruct', (e) => !e.disabled);
      check('the Build button does not offer a second build while one is running', !buildOfferedAgain,
        buildOfferedAgain ? 'still enabled during a build' : 'disabled during a build');
      await page.waitForFunction(() => window.__workers.length === 1, null, { timeout: 90000 });
      await page.click('#btn-cancel');

      // A second build, with the first build's worker still holding the handlers it was given.
      await page.click('#btn-reconstruct');
      await page.waitForFunction(() => window.__workers.length === 2, null, { timeout: 90000 });
      await page.evaluate(() => {
        const stale = window.__workers[0];
        stale.onmessage({ data: { type: 'progress', stage: 'log', message: 'STALE-WORKER-SPOKE' } });
        stale.onmessage({ data: { type: 'progress', stage: 'mesh', fraction: 1, message: 'STALE-WORKER-SPOKE' } });
        stale.onerror({ message: 'the build that was cancelled fell over' });
      });
      const outcome = await waitForResult(page, 200000);
      await page.waitForTimeout(300);
      const log = await page.textContent('#progress-log');
      const stats = (await page.textContent('#stats') || '').replace(/\s+/g, ' ').trim();
      const failureShown = await page.evaluate(() => /failed/i.test(document.querySelector('#progress-stage').textContent)
        || /Could not/.test(document.querySelector('#building-stage').textContent));
      const building = await page.evaluate(() => !document.querySelector('#building').hidden);
      check('a superseded build cannot report, fail or finish over the one that replaced it',
        outcome === 'finished' && !/STALE-WORKER-SPOKE/.test(log) && !failureShown && !building && /^8\/8/.test(stats),
        `${outcome}; the stale worker ${/STALE-WORKER-SPOKE/.test(log) ? 'reached the log' : 'was ignored'}, failure shown: ${failureShown}, stats: ${stats.slice(0, 40)}`);
      check('no page errors around a superseded build', errors.length === 0, errors.slice(0, 2).join(' | '));
      await page.close();
    }

    // ---- 2e. A browser that stores nothing is told what is actually wrong ----
    {
      const page = await newPage({ viewport: { width: 420, height: 860 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      // Private browsing, or site data blocked by policy: there is no database to write to.
      // That is not a full disk, and telling someone to free up space sends them nowhere.
      await page.addInitScript(() => {
        Object.defineProperty(window, 'indexedDB', { configurable: true, get: () => undefined });
      });
      await page.goto(BASE, { waitUntil: 'load' });
      await page.setInputFiles('#file-import', [path.join(fixtures, 'object', 'photo-0.png')]);
      const warned = await page.waitForFunction(() => {
        const t = document.querySelector('#toast');
        return t && !t.hidden && /reload would lose/.test(t.textContent) ? t.textContent : null;
      }, null, { timeout: 20000 }).then((h) => h.jsonValue()).catch(() => '');
      const message = String(warned).replace(/\s+/g, ' ').trim();
      check('a browser that stores nothing is not told its storage is full',
        /not storing data/.test(message) && !/storage is full/.test(message), message || 'nothing was said');
      check('no page errors when nothing can be stored', errors.length === 0, errors.slice(0, 2).join(' | '));
      await page.close();
    }

    // ---- 3. A scan that cannot work says so, where the user is looking ----
    {
      const page = await newPage({ viewport: { width: 420, height: 860 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(BASE, { waitUntil: 'load' });
      const dir = path.join(fixtures, 'still');
      await page.setInputFiles('#file-import', fs.readdirSync(dir).sort().map((f) => path.join(dir, f)));
      await page.waitForFunction(() => document.querySelectorAll('#thumbs .shot').length >= 5, null, { timeout: 20000 });
      await page.selectOption('#quality', 'fast');
      await page.click('#btn-reconstruct');
      const outcome = await waitForResult(page, 120000);
      await page.waitForTimeout(500);
      // The reason must appear wherever the user is looking. Which screen that is depends on
      // whether the camera path was previewed before the failure, so accept either.
      const onViewer = !(await page.$eval('#screen-view', (e) => e.hidden));
      const banner = (await page.textContent('#building')).replace(/\s+/g, ' ').trim();
      const processText = (await page.textContent('#screen-process')).replace(/\s+/g, ' ');
      const shown = onViewer ? /Could not build/.test(banner) : /failed/i.test(processText);
      const reason = onViewer ? banner : processText;
      check('a hopeless scan reports the reason', outcome === 'failed' && shown && /overlap|depth maps|matches|surface/i.test(reason),
        `${outcome} on the ${onViewer ? 'viewer' : 'processing'} screen: ${reason.slice(0, 90)}`);
      const exportsOff = await page.$$eval('#btn-export-glb, #btn-export-ply', (els) => els.every((e) => e.disabled));
      check('exports stay disabled when there is no surface', exportsOff);
      check('no page errors during a failure', errors.length === 0, errors.slice(0, 2).join(' | '));
      await page.close();
    }

    // The meta policy, at the dev server, across every section above.
    check('the <meta> policy refused nothing the app does at the dev server', metaFindings.length === 0,
      metaFindings.slice(0, 3).join(' | '));

    // ---- 4. The website: the built site, under its own headers, at the sub-path ----
    // What tools/site.js copies (the files pages.yml publishes) served from SUB_PATH by a server
    // of this step's own, which sends every response the headers _headers writes for it, as
    // Netlify and Cloudflare Pages do, and answers a missing address with 404.html. Every other
    // step uses the dev server at the root, where a root-relative URL (`/sw.js`, `/styles.css`)
    // works and the published site would break, and where only the <meta> policy applies. The
    // main flow runs here under the header policy, so a source the app needs and the policy
    // leaves out fails here rather than on a visitor's phone: a refusal, a console error or a
    // page error anywhere in it fails the step.
    {
      const siteDir = path.join(fixtures, 'site');
      buildSite(siteDir);
      const site = await serveSite(siteDir);
      const findings = [];
      const offSite = [];
      const ctx = await browser.newContext({ viewport: { width: 420, height: 860 }, permissions: ['camera'], acceptDownloads: true });
      await watchPolicy(ctx, findings);
      ctx.on('request', (r) => {
        const u = r.url();
        if (!u.startsWith(new URL(site.url).origin + SUB_PATH) && !/^(data|blob):/.test(u)) offSite.push(u);
      });
      const page = await ctx.newPage();
      page.on('dialog', (d) => d.accept());
      const response = await page.goto(site.url, { waitUntil: 'load' });
      const sent = response.headers()['content-security-policy'];
      const rootClass = await page.evaluate(() => document.documentElement.className);
      const noteShown = await page.$eval('#start-note', (e) => getComputedStyle(e).display !== 'none');
      check('the site is served under the policy _headers writes, and the app starts under it',
        sent === headersFor(headerRules(), '/index.html')['Content-Security-Policy'] && /\bstarted\b/.test(rootClass) && !/no-js|start-failed/.test(rootClass) && !noteShown,
        `policy sent: ${sent ? 'yes' : 'no'}, <html class="${rootClass}">, start note shown: ${noteShown}`);

      // The phone's own camera path (Chromium's fake device behind a real getUserMedia), which
      // is what the Permissions-Policy decides: with camera=() it is refused.
      await page.click('#btn-start-cameras');
      const tiles = await page.waitForFunction(() => document.querySelectorAll('#camera-grid .cam-tile video').length > 0, null, { timeout: 20000 })
        .then(() => page.$$eval('#camera-grid .cam-tile', (els) => els.length)).catch(() => 0);
      for (let i = 0; i < 2 && tiles; i++) {
        await page.click('#btn-capture');
        await page.waitForFunction((n) => document.querySelectorAll('#thumbs .shot').length >= n, i + 1, { timeout: 20000 }).catch(() => {});
      }
      // The thumbnails are data: URLs: img-src has to allow them, or every shot is a blank tile.
      const drawn = () => page.$$eval('#thumbs img', (els) => els.map((i) => i.complete && i.naturalWidth > 0));
      await page.waitForFunction(() => [...document.querySelectorAll('#thumbs img')].every((i) => i.complete), null, { timeout: 5000 }).catch(() => {});
      const camThumbs = await drawn();
      check('the site: the camera opens, shoots, and its thumbnails are drawn', tiles > 0 && camThumbs.length === 2 && camThumbs.every(Boolean),
        `${tiles} camera tiles, thumbnails ${camThumbs.map((d) => (d ? 'drawn' : 'blank')).join(', ') || 'none'}`);

      // The dialogs are <form method="dialog">, which form-action 'none' must leave working.
      await page.click('#btn-settings');
      await page.click('#settings button[value=close]');
      await page.click('#btn-help');
      await page.click('#help button[value=close]');
      const dialogsShut = await page.evaluate(() => !document.querySelector('#settings').open && !document.querySelector('#help').open);
      check('the site: Settings and Help open and close', dialogsShut);

      await page.click('#btn-clear');
      await page.waitForFunction(() => document.querySelectorAll('#thumbs .shot').length === 0, null, { timeout: 10000 }).catch(() => {});
      const objectDir = path.join(fixtures, 'object');
      await page.setInputFiles('#file-import', fs.readdirSync(objectDir).sort().map((f) => path.join(objectDir, f)));
      await page.waitForFunction(() => document.querySelectorAll('#thumbs .shot').length >= 8, null, { timeout: 30000 }).catch(() => {});
      await page.waitForFunction(() => [...document.querySelectorAll('#thumbs img')].every((i) => i.complete), null, { timeout: 5000 }).catch(() => {});
      const importThumbs = await drawn();
      // The worker is started through the Trusted Types policy, the viewer is three.js through
      // the import map the policy allows by its hash, and the wake lock the build takes is the
      // other feature the Permissions-Policy grants.
      await page.selectOption('#quality', 'fast');
      await page.click('#btn-reconstruct');
      const outcome = await waitForResult(page);
      const stats = (await page.textContent('#stats')).replace(/\s+/g, ' ').trim();
      const gpu = /Depth maps on the GPU/.test(await page.textContent('#progress-log'));
      const viewer = await page.$$eval('#viewer canvas', (els) => els.length);
      check('the site: photos import, a scan builds in the worker and the viewer shows it',
        importThumbs.length === 8 && importThumbs.every(Boolean) && outcome === 'finished' && /^8\/8/.test(stats) && viewer === 1,
        `${importThumbs.filter(Boolean).length}/${importThumbs.length} thumbnails drawn, ${outcome}: ${stats.slice(0, 40)}, depth on the ${gpu ? 'GPU' : 'CPU'}, ${viewer} viewer canvas`);
      const downloads = [];
      for (const button of ['#btn-export-glb', '#btn-export-ply', '#btn-export-obj', '#btn-export-points']) {
        const size = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.click(button)])
          .then(async ([dl]) => { const f = path.join(shots, `site-${dl.suggestedFilename()}`); await dl.saveAs(f); return fs.statSync(f).size; })
          .catch(() => 0);
        downloads.push(size);
      }
      check('the site: all four exports download', downloads.every((n) => n > 1000), downloads.map((n) => `${n} bytes`).join(', '));

      // The service worker's install is its own fetches, which connect-src governs: with 'none'
      // it registers and caches nothing, and nothing on the page says so.
      const scope = await page.evaluate(() => Promise.race([
        navigator.serviceWorker.ready.then((r) => r.scope),       // active: the shell is cached
        new Promise((resolve) => setTimeout(() => resolve(null), 15000)),
      ]));
      const uncached = await page.evaluate(async (files) => {
        const names = (await caches.keys()).filter((k) => k.startsWith('phonogeometry-'));
        const out = [];
        for (const f of files) {
          let hit = false;
          for (const name of names) hit = hit || !!(await (await caches.open(name)).match(f));
          if (!hit) out.push(f);
        }
        return out;
      }, ['./', ...siteFiles().filter((f) => !['sw.js', '404.html', 'robots.txt', '.well-known/security.txt', 'vendor/three/LICENSE'].includes(f))]);
      check('the service worker takes the sub-path as its scope and caches the whole shell under the policy',
        scope === site.url && uncached.length === 0, `scope ${scope}, site ${site.url}, not cached: ${uncached.join(' ') || 'none'}`);
      const cdp = await ctx.newCDPSession(page);
      const manifest = await cdp.send('Page.getAppManifest');
      await cdp.detach();
      check('the site: the manifest loads under manifest-src', manifest.errors.length === 0 && (manifest.data || '').includes('Phonogeometry'),
        `${manifest.url}: ${manifest.errors.length} errors`);

      await page.reload({ waitUntil: 'load' });     // and take control
      await page.waitForTimeout(1500);
      const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);

      // A deploy changes a file on the host. Loaded online, it has to reach the worker's
      // cache as well as the page: a clone taken after the page had read the body threw
      // here, and the cache kept the old file while the unit test's stub said otherwise.
      const marker = '/* published after the install */';
      fs.appendFileSync(path.join(siteDir, 'styles.css'), `\n${marker}\n`);
      await page.reload({ waitUntil: 'load' });
      let refreshed = false;
      for (let i = 0; i < 40 && !refreshed; i++) {
        refreshed = ((await cachedText(page, 'styles.css')) ?? '').includes(marker);
        if (!refreshed) await page.waitForTimeout(250);
      }
      check('a shell file fetched online is written back into the worker\'s cache', refreshed);

      // The server saw every request, the service worker's own included.
      const outside = site.requests.filter((r) => !r.path.startsWith(SUB_PATH));
      const missing = site.requests.filter((r) => r.status !== 200);
      check('nothing the app loads leaves its sub-path or is missing there', outside.length === 0 && missing.length === 0 && offSite.length === 0,
        `${site.requests.length} requests, ${outside.length} outside ${SUB_PATH}, ${missing.length} not found, ${offSite.length} to other hosts: ${[...outside, ...missing].map((r) => r.path).concat(offSite).slice(0, 4).join(' ')}`);
      check('the site: the policy refused nothing, and nothing threw or logged an error', findings.length === 0, findings.slice(0, 3).join(' | '));

      // The policy is in force, not merely sent: under require-trusted-types-for an HTML
      // string sink throws. The probe is itself a violation, so it runs in a context of its own.
      {
        const probe = await browser.newContext();
        const p = await probe.newPage();
        await p.goto(site.url, { waitUntil: 'load' });
        const refused = await p.evaluate(() => { try { document.createElement('div').innerHTML = '<b>probe</b>'; return 'assigned'; } catch (e) { return e.name; } });
        check('Trusted Types are enforced on the site: an HTML string is refused', refused === 'TypeError', `innerHTML assignment: ${refused}`);
        await probe.close();
      }

      // The page every host answers a missing address with: its look is its own <style>,
      // which the policy allows by its hash, and its link leads back to the app.
      {
        const nfFindings = [];
        const nf = await browser.newContext({ viewport: { width: 420, height: 860 } });
        await watchPolicy(nf, nfFindings);
        const p = await nf.newPage();
        const missing = `${site.url}no-such-page`;
        const res = await p.goto(missing, { waitUntil: 'load' });
        const look = await p.evaluate(() => ({ title: document.title, bg: getComputedStyle(document.body).backgroundColor, link: document.querySelector('a.open')?.href }));
        await p.click('a.open');
        await p.waitForFunction(() => document.documentElement.classList.contains('started'), null, { timeout: 15000 }).catch(() => {});
        const back = p.url();
        // Chromium logs the 404 of the address itself as a console error; that one is the point.
        const own404 = (f) => f.startsWith('console error: Failed to load resource: the server responded with a status of 404') && f.endsWith(`(${missing})`);
        const refused = nfFindings.filter((f) => !own404(f));
        check('a missing address gets the site\'s 404 page, styled under the policy, with a way back',
          res.status() === 404 && /Page not found/.test(look.title) && look.bg === 'rgb(15, 17, 21)' && look.link === site.url && back === site.url && refused.length === 0,
          `${res.status()} "${look.title}", background ${look.bg}, link ${look.link}, then ${back}; ${refused.slice(0, 2).join(' | ') || 'nothing refused'}`);
        await nf.close();
      }

      // What is not the site is not published: the folder holds the site and nothing else.
      const statuses = [];
      for (const f of ['README.md', 'tools/site.js', '_headers', 'deploy/nginx.conf', '.git/config', 'server.js', 'test/website.test.js']) {
        statuses.push(`${f} ${(await fetch(site.url + f)).status}`);
      }
      check('the repository\'s own files are not part of the site', statuses.every((x) => x.endsWith(' 404')), statuses.join(', '));

      // frame-ancestors 'none': another site cannot put the app in a frame and dress it up.
      {
        const framer = http.createServer((req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<!doctype html><title>framer</title><iframe src="${site.url}" width="400" height="600"></iframe>`);
        });
        await new Promise((resolve) => framer.listen(0, '127.0.0.1', resolve));
        const fc = await browser.newContext();
        const p = await fc.newPage();
        const refusals = [];
        // The policy's refusal, not X-Frame-Options' (which old browsers fall back on): it is
        // frame-ancestors that this proves is in force.
        p.on('console', (m) => { if (/frame-ancestors 'none'/.test(m.text())) refusals.push(m.text()); });
        await p.goto(`http://127.0.0.1:${framer.address().port}/`, { waitUntil: 'load' });
        await p.waitForTimeout(1000);
        const framed = await (p.frames()[1]?.$('#btn-start-cameras').catch(() => null)) ?? null;
        check('another site cannot frame the app', framed === null && refusals.length > 0, `${refusals.length} refusal(s) logged, app in frame: ${framed !== null}`);
        await fc.close();
        await new Promise((resolve) => framer.close(resolve));
      }

      // The safety net: no JavaScript, a module that does not load, one that throws while the
      // app starts, and an app that never runs at all each leave a short note where the
      // controls were, not dead buttons. A failure the guard sees is shown as it happens, before
      // the page has finished loading (which a slow image or font can hold back); the load event
      // is the backstop for one nothing reports.
      for (const [label, setup, expect, early] of [
        ['with JavaScript off', { javaScriptEnabled: false }, /has not started/, null],
        ['when one of its modules does not load', { route: ['**/src/storage.js', { status: 404, contentType: 'text/plain', body: 'gone' }] }, /did not load/, true],
        ['when it throws while starting', { route: ['**/src/version.js', { status: 200, contentType: 'text/javascript', body: 'throw new Error("broken at start");' }] }, /could not start/, true],
        ['when the app never runs', { route: ['**/src/app.js', { status: 200, contentType: 'text/javascript', body: '// nothing runs' }] }, /could not start/, false],
      ]) {
        const gc = await browser.newContext({ viewport: { width: 420, height: 860 }, javaScriptEnabled: setup.javaScriptEnabled !== false, serviceWorkers: 'block' });
        if (setup.route) await gc.route(setup.route[0], (route) => route.fulfill(setup.route[1]));
        if (early !== null) {
          await gc.addInitScript(() => {
            document.addEventListener('DOMContentLoaded', () => { window.__failedEarly = document.documentElement.classList.contains('start-failed'); });
          });
        }
        const p = await gc.newPage();
        await p.goto(site.url, { waitUntil: 'load' });
        await p.waitForTimeout(300);
        const failedEarly = early === null ? null : await p.evaluate(() => window.__failedEarly);
        // Locators, not evaluate: they work in a page whose own scripts are off.
        const state = {
          note: (await p.locator('#start-note').isVisible()) ? (await p.locator('#start-note').textContent()).trim() : '',
          controls: (await p.locator('#screen-capture').isVisible()) || (await p.locator('#capture-bar').isVisible()) || (await p.locator('#btn-settings').isVisible()),
        };
        check(`the safety net speaks ${label}`, expect.test(state.note) && !state.controls && failedEarly === early,
          `note: "${state.note.slice(0, 80)}", controls shown: ${state.controls}${early === null ? '' : `, shown before the load event: ${failedEarly}`}`);
        await gc.close();
      }

      await site.stop();
      await ctx.setOffline(true);
      const reloaded = await page.reload({ waitUntil: 'load', timeout: 25000 }).then(() => true).catch(() => false);
      await page.waitForTimeout(1500);
      const ui = await page.$('#btn-start-cameras') !== null;
      let built = 'not attempted';
      if (reloaded && ui) {
        await page.click('#btn-clear');
        await page.setInputFiles('#file-import', fs.readdirSync(objectDir).sort().map((f) => path.join(objectDir, f)));
        await page.waitForFunction(() => document.querySelectorAll('#thumbs .shot').length >= 8, null, { timeout: 30000 });
        await page.selectOption('#quality', 'fast');
        await page.click('#btn-reconstruct');
        built = await waitForResult(page);
      }
      check('the app works with the network cut', controlled && reloaded && ui && built === 'finished',
        `service worker in control: ${controlled}, reload: ${reloaded}, interface: ${ui}, scan: ${built}`);
      check('offline, the policy refused nothing either', findings.length === 0, findings.slice(0, 3).join(' | '));
      await ctx.close();

      // The addresses the service worker is shown that are not the app's own: a link with a
      // query string, which every social site and campaign link appends, and a site that has
      // moved to an origin of its own, as the README advises, and redirects the old address.
      {
        const moved = await serveSite(siteDir);
        const home = http.createServer((req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><title>The new home</title><p>Moved here.</p>');
        });
        await new Promise((resolve) => home.listen(0, '127.0.0.1', resolve));
        const homeUrl = `http://127.0.0.1:${home.address().port}/`;
        const mc = await browser.newContext({ viewport: { width: 420, height: 860 } });
        const p = await mc.newPage();
        await p.goto(moved.url, { waitUntil: 'load' });
        await p.evaluate(() => Promise.race([navigator.serviceWorker.ready, new Promise((resolve) => setTimeout(resolve, 15000))]));
        await p.reload({ waitUntil: 'load' });
        await p.waitForTimeout(500);
        const inControl = await p.evaluate(() => !!navigator.serviceWorker.controller);
        for (const q of ['?fbclid=IwAR0a', '?fbclid=IwAR0b', 'index.html?utm_source=readme']) await p.goto(`${moved.url}${q}`, { waitUntil: 'load' });
        await p.waitForTimeout(500);
        const withQuery = await p.evaluate(async () => {
          const out = [];
          for (const name of (await caches.keys()).filter((k) => k.startsWith('phonogeometry-'))) {
            for (const req of await (await caches.open(name)).keys()) if (new URL(req.url).search) out.push(req.url);
          }
          return out;
        });
        check('a link with a query string adds nothing to the worker\'s cache', inControl && withQuery.length === 0,
          `service worker in control: ${inControl}, entries with a query: ${withQuery.length ? withQuery.join(' ') : 'none'}`);

        moved.moveTo(homeUrl);
        const landed = [];
        for (let i = 0; i < 2; i++) {
          await p.goto(moved.url, { waitUntil: 'load' }).catch(() => {});
          landed.push(p.url());
        }
        check('a site that moved takes its installed copy with it', landed.every((u) => u === homeUrl),
          `opened the old address twice, landed on ${landed.join(', ')}`);

        await moved.stop();
        const offline = await p.goto(`${moved.url}?fbclid=IwAR0offline`, { waitUntil: 'load', timeout: 15000 }).then(() => true).catch(() => false);
        const app = offline && (await p.$('#btn-start-cameras')) !== null;
        check('offline, a link with a query string opens the app', app, `loaded: ${offline}, interface: ${app}`);
        await mc.close();
        await new Promise((resolve) => home.close(resolve));
      }
    }
  } finally {
    await browser.close();
    stop();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
  return failed.length ? 1 : 0;
}

process.exit(await main());
