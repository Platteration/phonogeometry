// Web Worker entry: runs the reconstruction off the main thread.
import { reconstruct } from './reconstruct.js';

self.onmessage = async (ev) => {
  const { type, images, options } = ev.data;
  if (type !== 'run') return;
  try {
    // The pixel buffers were transferred to this worker, so they can be freed as they are used
    const result = await reconstruct(images, { ...options, releaseInputs: true }, (stage, fraction, message, data) => {
      if (stage === 'preview' && data) {
        // Copies, because the reconstruction goes on using these arrays
        const sparse = { positions: Float32Array.from(data.sparse.positions), colors: Float32Array.from(data.sparse.colors) };
        self.postMessage({ type: 'preview', message, sparse, cameras: data.cameras }, [sparse.positions.buffer, sparse.colors.buffer]);
        return;
      }
      self.postMessage({ type: 'progress', stage, fraction, message });
    });
    const transfer = [
      result.mesh.positions.buffer, result.mesh.normals.buffer, result.mesh.colors.buffer, result.mesh.indices.buffer,
      result.sparse.positions.buffer, result.sparse.colors.buffer,
      result.dense.positions.buffer, result.dense.colors.buffer,
    ];
    self.postMessage({ type: 'done', result: { mesh: result.mesh, sparse: result.sparse, dense: result.dense, cameras: result.cameras, stats: result.stats } }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err), stack: err && err.stack });
  }
};
