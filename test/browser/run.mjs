#!/usr/bin/env node
// Browser tests for the whole application: capture with a fake camera, a scan that works,
// a scan that cannot work, and offline operation. These need a real browser, so they are
// not part of `npm test`; run them with `npm run test:browser`.
//
// Playwright and a Chromium build must be available. Point at them with PLAYWRIGHT_MODULE
// and CHROMIUM_PATH if they are not where this script looks by default.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeObjectScan, writeStandingStillScan } from './fixtures.mjs';
import { fakePhoneCameras } from './fakeCameras.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const PORT = Number(process.env.PORT || 8099);
const BASE = `http://localhost:${PORT}/`;

const CHROMIUM_CANDIDATES = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
].filter(Boolean);
const PLAYWRIGHT_CANDIDATES = [
  process.env.PLAYWRIGHT_MODULE,
  'playwright',
  '/opt/node22/lib/node_modules/playwright/index.mjs',
  '/usr/local/lib/node_modules/playwright/index.mjs',
].filter(Boolean);

async function loadPlaywright() {
  for (const spec of PLAYWRIGHT_CANDIDATES) {
    try { return (await import(spec)).chromium; } catch { /* try the next */ }
  }
  return null;
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
  const chromium = await loadPlaywright();
  if (!chromium) {
    console.log('Playwright is not installed, so the browser tests were skipped.');
    console.log('Install it with `npm i -D playwright && npx playwright install chromium`, or set PLAYWRIGHT_MODULE.');
    return 0;
  }
  const executablePath = CHROMIUM_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });

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

  try {
    // ---- 1. Cameras and capture, with the browser's fake camera device ----
    {
      const page = await browser.newPage({ viewport: { width: 420, height: 860 }, permissions: ['camera'] });
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
      const page = await browser.newPage({ viewport: { width: 420, height: 860 }, permissions: ['camera'] });
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
      check(`${label}: no page errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
      await page.close();
    }

    // ---- 2. A scan that works, from import to export ----
    {
      const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('dialog', (d) => d.accept());
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

      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => document.querySelectorAll('#thumbs .shot').length >= 8, null, { timeout: 20000 }).catch(() => {});
      const restored = Number(await page.textContent('#shot-count'));
      check('shots survive a reload', restored === 8, `${restored} restored`);
      check('no page errors during a good scan', errors.length === 0, errors.slice(0, 2).join(' | '));
      await page.close();
    }

    // ---- 2b. Names that come from outside are shown, not executed ----
    {
      const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
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

    // ---- 3. A scan that cannot work says so, where the user is looking ----
    {
      const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
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

    // ---- 4. Offline ----
    {
      const ctx = await browser.newContext({ viewport: { width: 420, height: 860 } });
      const page = await ctx.newPage();
      await page.goto(BASE, { waitUntil: 'load' });
      await page.waitForTimeout(4000);              // let the service worker cache the shell
      await page.reload({ waitUntil: 'load' });     // and take control
      await page.waitForTimeout(1500);
      const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
      await ctx.setOffline(true);
      const reloaded = await page.reload({ waitUntil: 'load', timeout: 25000 }).then(() => true).catch(() => false);
      await page.waitForTimeout(1500);
      const ui = await page.$('#btn-start-cameras') !== null;
      const dir = path.join(fixtures, 'object');
      let built = 'not attempted';
      if (reloaded && ui) {
        await page.setInputFiles('#file-import', fs.readdirSync(dir).sort().map((f) => path.join(dir, f)));
        await page.waitForFunction(() => document.querySelectorAll('#thumbs .shot').length >= 8, null, { timeout: 30000 });
        await page.selectOption('#quality', 'fast');
        await page.click('#btn-reconstruct');
        built = await waitForResult(page);
      }
      check('the app works with the network cut', controlled && reloaded && ui && built === 'finished',
        `service worker in control: ${controlled}, reload: ${reloaded}, interface: ${ui}, scan: ${built}`);
      await ctx.close();
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
