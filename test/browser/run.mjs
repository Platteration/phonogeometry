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

      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => document.querySelectorAll('#thumbs .shot').length >= 8, null, { timeout: 20000 }).catch(() => {});
      const restored = Number(await page.textContent('#shot-count'));
      check('shots survive a reload', restored === 8, `${restored} restored`);
      check('no page errors during a good scan', errors.length === 0, errors.slice(0, 2).join(' | '));
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
