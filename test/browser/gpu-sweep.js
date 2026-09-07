// Browser-only check: GPU plane sweep against the CPU implementation and the ground truth.
// Open test/browser/index.html through the dev server; results are printed on the page and
// exposed as window.__results for automation.
import { computeDepthMap } from '../../src/vision/planeSweep.js';
import { createGpuSweeper } from '../../src/vision/planeSweepGPU.js';
import { renderRoom } from '../synthScene.js';
import { lookAt } from '../helpers.js';

const out = document.getElementById('out');
const lines = [];
const log = (s) => { lines.push(s); out.textContent = lines.join('\n'); };

function accuracy(depth, truth, n) {
  let valid = 0, good = 0, total = 0;
  for (let i = 0; i < n; i++) {
    if (!(truth[i] > 0)) continue;
    total++;
    if (!(depth[i] > 0)) continue;
    valid++;
    if (Math.abs(depth[i] - truth[i]) / truth[i] < 0.05) good++;
  }
  return { coverage: valid / total, accuracy: good / Math.max(1, valid) };
}

async function main() {
  const results = {};
  const w = 240, h = 180, f = 200, cx = (w - 1) / 2, cy = (h - 1) / 2;
  const centers = [[0, 0, -0.6], [0.25, 0.05, -0.6], [-0.25, -0.05, -0.55], [0.1, 0.25, -0.5]];
  const cams = centers.map((c) => lookAt(c, [0, 0, 5]));
  const views = cams.map((cam) => { const r = renderRoom(cam, w, h, f, cx, cy, 2); return { gray: r.gray, truth: r.depth, w, h, f, cx, cy, R: cam.R, t: cam.t }; });
  const opts = { dmin: 1.0, dmax: 4.0, numPlanes: 64, radius: 3, minZncc: 0.6 };

  const t0 = performance.now();
  const cpu = computeDepthMap(views[0], views.slice(1), opts);
  const cpuMs = performance.now() - t0;
  results.cpu = { ...accuracy(cpu.depth, views[0].truth, w * h), ms: cpuMs };
  log(`CPU: coverage ${results.cpu.coverage.toFixed(3)} accuracy ${results.cpu.accuracy.toFixed(3)} in ${cpuMs.toFixed(0)} ms`);

  const gpu = createGpuSweeper();
  if (!gpu) { results.gpu = null; log('GPU: WebGL2 with float render targets unavailable'); }
  else {
    log(`GPU renderer: ${gpu.info}`);
    gpu.computeDepthMap(views[0], views.slice(1), opts); // warm-up (shader compilation)
    const t1 = performance.now();
    const g = gpu.computeDepthMap(views[0], views.slice(1), opts);
    const gpuMs = performance.now() - t1;
    results.gpu = { ...accuracy(g.depth, views[0].truth, w * h), ms: gpuMs };
    let both = 0, agree = 0;
    for (let i = 0; i < w * h; i++) {
      if (cpu.depth[i] > 0 && g.depth[i] > 0) { both++; if (Math.abs(cpu.depth[i] - g.depth[i]) / cpu.depth[i] < 0.02) agree++; }
    }
    results.gpu.agreementWithCpu = agree / Math.max(1, both);
    results.gpu.overlap = both / (w * h);
    log(`GPU: coverage ${results.gpu.coverage.toFixed(3)} accuracy ${results.gpu.accuracy.toFixed(3)} in ${gpuMs.toFixed(0)} ms; agrees with CPU on ${(100 * results.gpu.agreementWithCpu).toFixed(1)}% of shared pixels`);
    gpu.dispose();
  }
  window.__results = results;
  log('done');
}
main().catch((e) => { log('ERROR: ' + e.message + '\n' + e.stack); window.__results = { error: e.message }; });
