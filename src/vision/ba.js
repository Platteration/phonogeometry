// Sparse bundle adjustment (Levenberg-Marquardt with the Schur complement trick).
// Cameras are parameterised by an SE(3) left perturbation; points by 3D offsets.
import { rotvecToMat, matMul, matVec, solveSPD, inv3 } from './linalg.js';

/**
 * @param cameras [{R: Float64Array(9), t: Float64Array(3), f: number, fixed?: boolean, focalGroup?: number}]
 *   Cameras sharing a focalGroup index share one focal-length scale parameter when
 *   opts.refineFocal is set; the scale is written back as cameras[c].focalScale.
 * @param points Float64Array(3 * np) world points (modified in place)
 * @param obs {cam: Int32Array, pt: Int32Array, x: Float64Array(2*nobs)} observations normalised
 *   with the cameras' initial focal lengths
 * @param opts {iterations, huber (pixels), refineFocal}
 * @returns {{initialRms:number, finalRms:number, iterations:number, focalScales: Float64Array}}
 */
export function bundleAdjust(cameras, points, obs, opts = {}) {
  const iterations = opts.iterations ?? 10;
  const huber = opts.huber ?? 3.0; // pixels
  const nc = cameras.length;
  const np = points.length / 3;
  const nobs = obs.cam.length;

  // Camera parameter indexing (fixed cameras have no parameters), then focal group scales
  const camIndex = new Int32Array(nc);
  let nfree = 0;
  for (let c = 0; c < nc; c++) camIndex[c] = cameras[c].fixed ? -1 : nfree++;
  let nGroups = 0;
  const groupIndex = new Int32Array(nc).fill(-1);
  if (opts.refineFocal) {
    const map = new Map();
    for (let c = 0; c < nc; c++) {
      const g = cameras[c].focalGroup ?? c;
      if (!map.has(g)) map.set(g, nGroups++);
      groupIndex[c] = nfree * 6 + map.get(g);
    }
  }
  const NC = nfree * 6 + nGroups;
  const scale = new Float64Array(nGroups).fill(1); // focal multipliers

  const R = cameras.map((c) => Float64Array.from(c.R));
  const t = cameras.map((c) => Float64Array.from(c.t));
  const F = cameras.map((c) => c.f || 1);
  const NP = 7; // camera-block parameters touched by one observation: 6 pose + 1 focal

  // Observations grouped by point (for the Schur complement)
  const ptObsStart = new Int32Array(np + 1);
  for (let o = 0; o < nobs; o++) ptObsStart[obs.pt[o] + 1]++;
  for (let p = 0; p < np; p++) ptObsStart[p + 1] += ptObsStart[p];
  const ptObs = new Int32Array(nobs);
  {
    const fill = Int32Array.from(ptObsStart.subarray(0, np));
    for (let o = 0; o < nobs; o++) ptObs[fill[obs.pt[o]]++] = o;
  }

  const residuals = new Float64Array(nobs * 2);
  const weights = new Float64Array(nobs);

  function computeResiduals(Rs, ts, pts, sc) {
    let total = 0, count = 0;
    for (let o = 0; o < nobs; o++) {
      const c = obs.cam[o], p = obs.pt[o];
      const Rc = Rs[c], tc = ts[c];
      const gi = groupIndex[c], sgc = gi >= 0 ? sc[gi - nfree * 6] : 1;
      const X0 = pts[p * 3], X1 = pts[p * 3 + 1], X2 = pts[p * 3 + 2];
      const z = Rc[6] * X0 + Rc[7] * X1 + Rc[8] * X2 + tc[2];
      if (z <= 1e-9) {
        residuals[o * 2] = residuals[o * 2 + 1] = huber * 3; weights[o] = 0;
        total += 2 * (huber * 3) ** 2; count++;
        continue;
      }
      const x = (Rc[0] * X0 + Rc[1] * X1 + Rc[2] * X2 + tc[0]) / z;
      const y = (Rc[3] * X0 + Rc[4] * X1 + Rc[5] * X2 + tc[1]) / z;
      // pixel residual with the current focal scale: f*s*proj - f*obs
      const ru = (sgc * x - obs.x[o * 2]) * F[c], rv = (sgc * y - obs.x[o * 2 + 1]) * F[c];
      residuals[o * 2] = ru; residuals[o * 2 + 1] = rv;
      const e = Math.hypot(ru, rv);
      const w = e <= huber ? 1 : huber / e;
      weights[o] = w;
      total += w * (ru * ru + rv * rv);
      count++;
    }
    return { cost: total, rms: Math.sqrt(total / Math.max(1, count)) };
  }

  let { cost, rms: initialRms } = computeResiduals(R, t, points, scale);
  let lambda = 1e-4;
  let iterDone = 0;

  const Hcc = new Float64Array(NC * NC);
  const gc = new Float64Array(NC);
  const Hpp = new Float64Array(np * 9);
  const gp = new Float64Array(np * 3);
  const Hcp = new Float64Array(nobs * NP * 3); // per observation NP x 3 block
  const obsParams = new Int32Array(nobs * NP).fill(-1); // global camera-block parameter indices
  const Jc = new Float64Array(2 * NP), Jp = new Float64Array(6);

  for (let it = 0; it < iterations; it++) {
    iterDone = it + 1;
    Hcc.fill(0); gc.fill(0); Hpp.fill(0); gp.fill(0); Hcp.fill(0);
    // Build normal equations
    for (let o = 0; o < nobs; o++) {
      const w = weights[o];
      if (w === 0) continue;
      const c = obs.cam[o], p = obs.pt[o];
      const Rc = R[c], tc = t[c];
      const gi = groupIndex[c], sgc = gi >= 0 ? scale[gi - nfree * 6] : 1;
      const f = F[c] * sgc;
      const X0 = points[p * 3], X1 = points[p * 3 + 1], X2 = points[p * 3 + 2];
      const xc = Rc[0] * X0 + Rc[1] * X1 + Rc[2] * X2 + tc[0];
      const yc = Rc[3] * X0 + Rc[4] * X1 + Rc[5] * X2 + tc[1];
      const zc = Rc[6] * X0 + Rc[7] * X1 + Rc[8] * X2 + tc[2];
      const iz = 1 / zc, u = xc * iz, v = yc * iz;
      // d(f*s*u, f*s*v)/dXc
      const Ju0 = f * iz, Ju2 = -f * u * iz;
      const Jv1 = f * iz, Jv2 = -f * v * iz;
      // dXc/dθ = -[Xc]x ; dXc/dt = I
      // -[Xc]x = [[0, zc, -yc], [-zc, 0, xc], [yc, -xc, 0]]
      // Jc rows: u then v; columns θ(3), t(3)
      Jc[0] = Ju2 * yc;            Jc[1] = Ju0 * zc - Ju2 * xc;   Jc[2] = -Ju0 * yc;
      Jc[3] = Ju0; Jc[4] = 0; Jc[5] = Ju2;
      Jc[6] = 0; // focal scale: d(f*s*u)/ds = f*u
      Jc[NP + 0] = -Jv1 * zc + Jv2 * yc; Jc[NP + 1] = -Jv2 * xc;    Jc[NP + 2] = Jv1 * xc;
      Jc[NP + 3] = 0; Jc[NP + 4] = Jv1; Jc[NP + 5] = Jv2;
      Jc[NP + 6] = 0;
      if (gi >= 0) { Jc[6] = F[c] * u; Jc[NP + 6] = F[c] * v; }
      // dXc/dX = R  => Jp = J_proj * R
      Jp[0] = Ju0 * Rc[0] + Ju2 * Rc[6]; Jp[1] = Ju0 * Rc[1] + Ju2 * Rc[7]; Jp[2] = Ju0 * Rc[2] + Ju2 * Rc[8];
      Jp[3] = Jv1 * Rc[3] + Jv2 * Rc[6]; Jp[4] = Jv1 * Rc[4] + Jv2 * Rc[7]; Jp[5] = Jv1 * Rc[5] + Jv2 * Rc[8];
      const ru = residuals[o * 2], rv = residuals[o * 2 + 1];
      const ci = camIndex[c];
      // Point block
      for (let a = 0; a < 3; a++) {
        gp[p * 3 + a] += w * (Jp[a] * ru + Jp[3 + a] * rv);
        for (let b = 0; b < 3; b++) Hpp[p * 9 + a * 3 + b] += w * (Jp[a] * Jp[b] + Jp[3 + a] * Jp[3 + b]);
      }
      // Camera-block parameters touched by this observation
      const op = o * NP;
      for (let a = 0; a < NP; a++) obsParams[op + a] = -1;
      if (ci >= 0) for (let a = 0; a < 6; a++) obsParams[op + a] = ci * 6 + a;
      if (gi >= 0) obsParams[op + 6] = gi;
      for (let a = 0; a < NP; a++) {
        const ia = obsParams[op + a];
        if (ia < 0) continue;
        gc[ia] += w * (Jc[a] * ru + Jc[NP + a] * rv);
        for (let b = 0; b < NP; b++) {
          const ib = obsParams[op + b];
          if (ib >= 0) Hcc[ia * NC + ib] += w * (Jc[a] * Jc[b] + Jc[NP + a] * Jc[NP + b]);
        }
        for (let b = 0; b < 3; b++) Hcp[(o * NP + a) * 3 + b] = w * (Jc[a] * Jp[b] + Jc[NP + a] * Jp[3 + b]);
      }
    }

    let accepted = false;
    for (let attempt = 0; attempt < 8 && !accepted; attempt++) {
      // Damped point blocks and their inverses
      const HppInv = new Float64Array(np * 9);
      const blk = new Float64Array(9);
      for (let p = 0; p < np; p++) {
        for (let k = 0; k < 9; k++) blk[k] = Hpp[p * 9 + k];
        for (let a = 0; a < 3; a++) blk[a * 3 + a] += lambda * (1 + blk[a * 3 + a]);
        const inv = inv3(blk);
        if (inv) HppInv.set(inv, p * 9);
      }
      // Schur complement S = Hcc - sum Hcp Hpp^-1 Hpc, gs = gc - sum Hcp Hpp^-1 gp
      const S = Float64Array.from(Hcc);
      for (let a = 0; a < NC; a++) S[a * NC + a] += lambda * (1 + S[a * NC + a]);
      const gs = Float64Array.from(gc);
      const tmp = new Float64Array(NP * 3); // Hcp * HppInv (NP x 3)
      for (let p = 0; p < np; p++) {
        const o0 = ptObsStart[p], o1 = ptObsStart[p + 1];
        const Hi = HppInv.subarray(p * 9, p * 9 + 9);
        const gpp = gp.subarray(p * 3, p * 3 + 3);
        for (let oa = o0; oa < o1; oa++) {
          const o = ptObs[oa];
          if (weights[o] === 0) continue;
          const A = Hcp.subarray(o * NP * 3, (o + 1) * NP * 3);
          for (let r = 0; r < NP; r++) for (let k = 0; k < 3; k++) {
            tmp[r * 3 + k] = A[r * 3] * Hi[k] + A[r * 3 + 1] * Hi[3 + k] + A[r * 3 + 2] * Hi[6 + k];
          }
          for (let r = 0; r < NP; r++) {
            const ia = obsParams[o * NP + r];
            if (ia < 0) continue;
            gs[ia] -= tmp[r * 3] * gpp[0] + tmp[r * 3 + 1] * gpp[1] + tmp[r * 3 + 2] * gpp[2];
          }
          for (let ob = o0; ob < o1; ob++) {
            const o2 = ptObs[ob];
            if (weights[o2] === 0) continue;
            const B = Hcp.subarray(o2 * NP * 3, (o2 + 1) * NP * 3);
            for (let r = 0; r < NP; r++) {
              const ia = obsParams[o * NP + r];
              if (ia < 0) continue;
              const rowS = ia * NC;
              const t0 = tmp[r * 3], t1 = tmp[r * 3 + 1], t2 = tmp[r * 3 + 2];
              for (let q = 0; q < NP; q++) {
                const ib = obsParams[o2 * NP + q];
                if (ib >= 0) S[rowS + ib] -= t0 * B[q * 3] + t1 * B[q * 3 + 1] + t2 * B[q * 3 + 2];
              }
            }
          }
        }
      }
      let dc;
      if (NC > 0) {
        const ngs = gs.map((v) => -v);
        dc = solveSPD(S, ngs, NC);
        if (!dc) { lambda *= 10; continue; }
      } else {
        dc = new Float64Array(0);
      }
      // Back-substitute points: dp = HppInv (-gp - Hpc dc)
      const newPts = Float64Array.from(points);
      const rhs = new Float64Array(3);
      for (let p = 0; p < np; p++) {
        rhs[0] = -gp[p * 3]; rhs[1] = -gp[p * 3 + 1]; rhs[2] = -gp[p * 3 + 2];
        for (let oa = ptObsStart[p]; oa < ptObsStart[p + 1]; oa++) {
          const o = ptObs[oa];
          if (weights[o] === 0) continue;
          const A = Hcp.subarray(o * NP * 3, (o + 1) * NP * 3);
          for (let k = 0; k < 3; k++) {
            let s = 0;
            for (let r = 0; r < NP; r++) { const ia = obsParams[o * NP + r]; if (ia >= 0) s += A[r * 3 + k] * dc[ia]; }
            rhs[k] -= s;
          }
        }
        const Hi = HppInv.subarray(p * 9, p * 9 + 9);
        for (let k = 0; k < 3; k++) newPts[p * 3 + k] += Hi[k * 3] * rhs[0] + Hi[k * 3 + 1] * rhs[1] + Hi[k * 3 + 2] * rhs[2];
      }
      // Update cameras
      const newR = R.map((m) => m), newT = t.map((m) => m);
      for (let c = 0; c < nc; c++) {
        const ci = camIndex[c];
        if (ci < 0) continue;
        const d = dc.subarray(ci * 6, ci * 6 + 6);
        const dR = rotvecToMat([d[0], d[1], d[2]]);
        newR[c] = matMul(dR, R[c], 3, 3, 3);
        const Rt = matVec(dR, t[c], 3, 3);
        newT[c] = new Float64Array([Rt[0] + d[3], Rt[1] + d[4], Rt[2] + d[5]]);
      }
      const newScale = Float64Array.from(scale);
      for (let g = 0; g < nGroups; g++) newScale[g] = Math.min(2.5, Math.max(0.4, scale[g] + dc[nfree * 6 + g]));
      const savedRes = Float64Array.from(residuals), savedW = Float64Array.from(weights);
      const trial = computeResiduals(newR, newT, newPts, newScale);
      if (trial.cost < cost) {
        const rel = (cost - trial.cost) / cost;
        cost = trial.cost;
        for (let c = 0; c < nc; c++) { R[c] = newR[c]; t[c] = newT[c]; }
        scale.set(newScale);
        points.set(newPts);
        lambda = Math.max(1e-9, lambda / 3);
        accepted = true;
        if (rel < 1e-6) it = iterations; // converged
      } else {
        residuals.set(savedRes); weights.set(savedW);
        lambda *= 10;
      }
    }
    if (!accepted) break;
  }
  for (let c = 0; c < nc; c++) {
    cameras[c].R = R[c]; cameras[c].t = t[c];
    cameras[c].focalScale = groupIndex[c] >= 0 ? scale[groupIndex[c] - nfree * 6] : 1;
  }
  const final = computeResiduals(R, t, points, scale);
  return { initialRms, finalRms: final.rms, iterations: iterDone, focalScales: scale };
}
