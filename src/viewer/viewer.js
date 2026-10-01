// three.js viewer for the reconstructed mesh, sparse cloud and camera frusta.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export class Viewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setClearColor(0x0f1115, 1);
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);
    this.camera.position.set(0, 0.5, 3);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(2, 3, 2);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xaaccff, 0.5);
    fill.position.set(-3, -1, -2);
    this.scene.add(fill);
    this.grid = new THREE.GridHelper(4, 16, 0x334, 0x223);
    this.grid.material.transparent = true; this.grid.material.opacity = 0.35;
    this.scene.add(this.grid);
    this.measureGroup = new THREE.Group();
    this.meshGroup = new THREE.Group();
    this.pointsGroup = new THREE.Group();
    this.camerasGroup = new THREE.Group();
    this.scene.add(this.meshGroup, this.pointsGroup, this.camerasGroup, this.measureGroup);
    this.pointsGroup.visible = false;
    this.mode = 'solid';
    this._materials = {
      solid: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, side: THREE.DoubleSide }),
      wire: new THREE.MeshBasicMaterial({ color: 0x9ecbff, wireframe: true }),
      shaded: new THREE.MeshStandardMaterial({ color: 0xbfc7d5, roughness: 0.6, metalness: 0.05, side: THREE.DoubleSide, flatShading: false }),
      normals: new THREE.MeshNormalMaterial({ side: THREE.DoubleSide }),
      marker: new THREE.MeshBasicMaterial({ color: 0xff5c8a, depthTest: false }),
      markerLine: new THREE.LineBasicMaterial({ color: 0xff5c8a, depthTest: false }),
      // One cloud and one set of frusta are on screen at a time, so these are reused rather
      // than allocated per result and left for the garbage collector to find.
      points: new THREE.PointsMaterial({ size: 0.01, vertexColors: true, sizeAttenuation: true }),
      cameraLines: new THREE.LineBasicMaterial({ color: 0xffb454 }),
    };
    // Measuring: tap two points on the surface. A tap is a press and release without a drag,
    // so turning the model does not drop a marker.
    this.measuring = false;
    this.onMeasure = null;
    this._picked = [];
    this._raycaster = new THREE.Raycaster();
    this._pressedAt = null;
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => { this._pressedAt = { x: e.clientX, y: e.clientY }; });
    el.addEventListener('pointerup', (e) => {
      const start = this._pressedAt;
      this._pressedAt = null;
      if (!this.measuring || !start) return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 6) return; // a drag, not a tap
      this._pick(e);
    });

    this._resize = () => this.resize();
    window.addEventListener('resize', this._resize);
    this.resize();
    this._running = false;
    this._loop = () => {
      if (!this._running) return;
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(this._loop);
    };
    this.setActive(true);
  }

  /**
   * Draw only while the viewer is the screen the user is on. Otherwise a finished scan
   * leaves a full-rate WebGL loop running behind a hidden screen, next to several live
   * camera streams and, during the next build, the plane sweep's own use of the GPU.
   */
  setActive(on) {
    const want = !!on;
    if (want === this._running) return;
    this._running = want;
    if (want) requestAnimationFrame(this._loop);
  }

  _pick(event) {
    if (!this.mesh) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this._raycaster.setFromCamera(ndc, this.camera);
    const hit = this._raycaster.intersectObject(this.mesh, false)[0];
    if (!hit) return;
    if (this._picked.length >= 2) this.clearMeasurement();
    this._picked.push(hit.point.clone());
    this._drawMeasurement();
    if (this.onMeasure) {
      this.onMeasure(this._picked.length === 2
        ? this._picked[0].distanceTo(this._picked[1])
        : null, this._picked.length);
    }
  }

  _drawMeasurement() {
    while (this.measureGroup.children.length) {
      const c = this.measureGroup.children.pop();
      c.geometry?.dispose();
    }
    const radius = (this.mesh?.geometry.boundingSphere?.radius || 1) * 0.012;
    for (const p of this._picked) {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 8), this._materials.marker);
      dot.position.copy(p);
      this.measureGroup.add(dot);
    }
    if (this._picked.length === 2) {
      const g = new THREE.BufferGeometry().setFromPoints(this._picked);
      this.measureGroup.add(new THREE.Line(g, this._materials.markerLine));
    }
  }

  setMeasuring(on) {
    this.measuring = on;
    if (!on) this.clearMeasurement();
  }

  clearMeasurement() {
    this._picked = [];
    while (this.measureGroup.children.length) {
      const c = this.measureGroup.children.pop();
      c.geometry?.dispose();
    }
    if (this.onMeasure) this.onMeasure(null, 0);
  }

  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  clear() {
    this._picked = [];
    for (const g of [this.meshGroup, this.pointsGroup, this.camerasGroup, this.measureGroup]) {
      while (g.children.length) {
        const c = g.children.pop();
        if (c.geometry) c.geometry.dispose();
      }
    }
  }

  /** Show only the camera path and sparse points, before a surface exists. */
  setPreview({ sparse, cameras }) {
    this.clear();
    this.mesh = null;
    const box = new THREE.Box3();
    if (sparse && sparse.positions.length) {
      const pg = new THREE.BufferGeometry();
      pg.setAttribute('position', new THREE.BufferAttribute(sparse.positions, 3));
      pg.setAttribute('color', new THREE.BufferAttribute(sparse.colors, 3));
      pg.computeBoundingBox();
      box.union(pg.boundingBox);
      const r = Math.max(1e-3, pg.boundingBox.getSize(new THREE.Vector3()).length() / 2);
      this._materials.points.size = r * 0.01;
      this.pointsGroup.add(new THREE.Points(pg, this._materials.points));
      this.pointsGroup.visible = true;
    }
    this._addCameras(cameras, Math.max(1e-3, box.getSize(new THREE.Vector3()).length() / 2));
    const centre = box.getCenter(new THREE.Vector3());
    const radius = Math.max(1e-3, box.getSize(new THREE.Vector3()).length() / 2);
    this.grid.position.set(centre.x, centre.y - radius, centre.z);
    this.grid.scale.setScalar(radius);
    this._framing = { centre, radius };
    this._frame(centre, radius);
  }

  _addCameras(cameras, size0) {
    if (!cameras) return;
    const size = size0 * 0.08;
    const verts = [];
    for (const c of cameras) {
      if (!c) continue;
      const C = new THREE.Vector3(...c.center);
      const right = new THREE.Vector3(...c.right), down = new THREE.Vector3(...c.down), fwd = new THREE.Vector3(...c.forward);
      const hw = c.fovTan * size, hh = hw / c.aspect;
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) =>
        C.clone().add(fwd.clone().multiplyScalar(size)).add(right.clone().multiplyScalar(sx * hw)).add(down.clone().multiplyScalar(sy * hh)));
      for (let i = 0; i < 4; i++) {
        verts.push(C.x, C.y, C.z, corners[i].x, corners[i].y, corners[i].z);
        const n = corners[(i + 1) % 4];
        verts.push(corners[i].x, corners[i].y, corners[i].z, n.x, n.y, n.z);
      }
    }
    if (!verts.length) return;
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    this.camerasGroup.add(new THREE.LineSegments(cg, this._materials.cameraLines));
  }

  _frame(centre, radius) {
    const dist = radius / Math.sin((this.camera.fov * Math.PI) / 360) * 1.1;
    this.controls.target.copy(centre);
    this.camera.position.copy(centre).add(new THREE.Vector3(0.4, 0.5, 1).normalize().multiplyScalar(dist));
    this.camera.near = Math.max(0.001, dist / 1000); this.camera.far = dist * 50;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  setResult(result) {
    this.clear();
    const { mesh, sparse, cameras } = result;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(mesh.colors, 3));
    geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    geo.computeBoundingSphere();
    this.mesh = new THREE.Mesh(geo, this._materials[this.mode]);
    this.meshGroup.add(this.mesh);

    if (sparse && sparse.positions.length) {
      const pg = new THREE.BufferGeometry();
      pg.setAttribute('position', new THREE.BufferAttribute(sparse.positions, 3));
      pg.setAttribute('color', new THREE.BufferAttribute(sparse.colors, 3));
      const r = geo.boundingSphere.radius;
      this._materials.points.size = r * 0.012;
      this.pointsGroup.add(new THREE.Points(pg, this._materials.points));
    }

    this._addCameras(cameras, geo.boundingSphere.radius);
    // Grid under the model
    const bs = geo.boundingSphere;
    this.grid.position.set(bs.center.x, bs.center.y - bs.radius, bs.center.z);
    this.grid.scale.setScalar(bs.radius);
    this._framing = { centre: bs.center.clone(), radius: bs.radius };
    this.fit();
  }

  /** Return the camera to the framing chosen when the current content was loaded. */
  fit() {
    if (this.mesh) {
      const bs = this.mesh.geometry.boundingSphere;
      this._frame(bs.center, bs.radius);
    } else if (this._framing) {
      this._frame(this._framing.centre, this._framing.radius);
    }
  }

  setMode(mode) {
    this.mode = mode;
    if (this.mesh) this.mesh.material = this._materials[mode] || this._materials.solid;
  }

  setLayer(layer, visible) {
    const g = { mesh: this.meshGroup, points: this.pointsGroup, cameras: this.camerasGroup, grid: this.grid }[layer];
    if (g) g.visible = visible;
  }

  dispose() {
    this.setActive(false);
    window.removeEventListener('resize', this._resize);
    this.clear();
    for (const m of Object.values(this._materials)) m.dispose();
    this.renderer.dispose();
  }
}
