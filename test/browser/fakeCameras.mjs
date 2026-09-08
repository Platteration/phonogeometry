// Simulates a phone with several cameras, so the multi-camera capture path can be exercised
// in a browser. Chromium's own fake device only ever provides one camera, and the interesting
// behaviour is what happens with three of them, one of which the hardware refuses to run at
// the same time as the others.
export function fakePhoneCameras({ concurrencyLimit = 3 } = {}) {
  return ({ limit }) => {
    const DEVICES = [
      { deviceId: 'back-wide', label: 'camera2 0, facing back', tint: '#6a8fbf' },
      { deviceId: 'back-ultra', label: 'camera2 2, facing back ultra wide', tint: '#bf8f6a' },
      { deviceId: 'front-main', label: 'camera2 1, facing front', tint: '#8fbf6a' },
    ];
    const open = new Map();
    const streams = new Map();

    function makeStream(dev, width, height) {
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      let t = 0;
      const draw = () => {
        t += 1;
        ctx.fillStyle = dev.tint;
        ctx.fillRect(0, 0, width, height);
        // Something with texture, so a captured frame is not a flat colour
        for (let i = 0; i < 60; i++) {
          const x = (i * 97 + t * 3) % width, y = (i * 53 + t) % height;
          ctx.fillStyle = i % 2 ? '#ffffff' : '#101010';
          ctx.fillRect(x, y, 14, 14);
        }
        ctx.fillStyle = '#000';
        ctx.font = '20px sans-serif';
        ctx.fillText(dev.deviceId, 8, 28);
        if (streams.has(dev.deviceId)) requestAnimationFrame(draw);
      };
      streams.set(dev.deviceId, true);
      draw();
      const stream = canvas.captureStream(30);
      const track = stream.getVideoTracks()[0];
      const facing = dev.deviceId.startsWith('front') ? 'user' : 'environment';
      track.getSettings = () => ({ width, height, deviceId: dev.deviceId, facingMode: facing });
      track.getCapabilities = () => ({ facingMode: [facing], width: { max: width }, height: { max: height } });
      const originalStop = track.stop.bind(track);
      track.stop = () => { streams.delete(dev.deviceId); open.delete(dev.deviceId); originalStop(); };
      return stream;
    }

    navigator.mediaDevices.enumerateDevices = async () =>
      DEVICES.map((d) => ({ kind: 'videoinput', deviceId: d.deviceId, groupId: 'g', label: d.label, toJSON() { return this; } }));

    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const wanted = constraints?.video?.deviceId?.exact;
      const dev = wanted ? DEVICES.find((d) => d.deviceId === wanted) : DEVICES[0];
      if (!dev) throw new DOMException('Requested device not found', 'NotFoundError');
      if (!open.has(dev.deviceId) && open.size >= limit) {
        throw new DOMException('Could not start video source', 'NotReadableError');
      }
      const w = constraints?.video?.width?.ideal || 640;
      const h = constraints?.video?.height?.ideal || 480;
      const stream = makeStream(dev, w, Math.round(h));
      open.set(dev.deviceId, stream);
      window.__cameraOpens = (window.__cameraOpens || 0) + 1;
      return stream;
    };
    window.__openCameras = () => Array.from(open.keys());
  };
}
