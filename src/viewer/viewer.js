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
    this.meshGroup = new THREE.Group();
    this.pointsGroup = new THREE.Group();
    this.camerasGroup = new THREE.Group();
    this.scene.add(this.meshGroup, this.pointsGroup, this.camerasGroup);
    this.pointsGroup.visible = false;
    this.mode = 'solid';
    this._materials = {
      solid: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, side: THREE.DoubleSide }),
      wire: new THREE.MeshBasicMaterial({ color: 0x9ecbff, wireframe: true }),
      shaded: new THREE.MeshStandardMaterial({ color: 0xbfc7d5, roughness: 0.6, metalness: 0.05, side: THREE.DoubleSide, flatShading: false }),
      normals: new THREE.MeshNormalMaterial({ side: THREE.DoubleSide }),
    };
    this._resize = () => this.resize();
    window.addEventListener('resize', this._resize);
    this.resize();
    this._running = true;
    const loop = () => {
      if (!this._running) return;
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  clear() {
    for (const g of [this.meshGroup, this.pointsGroup, this.camerasGroup]) {
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
      this.pointsGroup.add(new THREE.Points(pg, new THREE.PointsMaterial({ size: r * 0.01, vertexColors: true, sizeAttenuation: true })));
      this.pointsGroup.visible = true;
    }
    this._addCameras(cameras, Math.max(1e-3, box.getSize(new THREE.Vector3()).length() / 2));
    const centre = box.getCenter(new THREE.Vector3());
    const radius = Math.max(1e-3, box.getSize(new THREE.Vector3()).length() / 2);
    this.grid.position.set(centre.x, centre.y - radius, centre.z);
    this.grid.scale.setScalar(radius);
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
    this.camerasGroup.add(new THREE.LineSegments(cg, new THREE.LineBasicMaterial({ color: 0xffb454 })));
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
      this.pointsGroup.add(new THREE.Points(pg, new THREE.PointsMaterial({ size: r * 0.012, vertexColors: true, sizeAttenuation: true })));
    }

    this._addCameras(cameras, geo.boundingSphere.radius);
    // Grid under the model
    const bs = geo.boundingSphere;
    this.grid.position.set(bs.center.x, bs.center.y - bs.radius, bs.center.z);
    this.grid.scale.setScalar(bs.radius);
    this.fit();
  }

  fit() {
    if (!this.mesh) return;
    const bs = this.mesh.geometry.boundingSphere;
    this._frame(bs.center, bs.radius);
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
    this._running = false;
    window.removeEventListener('resize', this._resize);
    this.clear();
    this.renderer.dispose();
  }
}
