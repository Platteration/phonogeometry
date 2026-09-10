# Vendored three.js

The viewer's copy of three.js lives in `vendor/three/` rather than in `node_modules`, so the
app stays a folder that can be copied to any static host and works offline. That only holds
up if it is possible to say exactly what those files are, so this is the record.

| File | Upstream path in the npm package | sha256 |
| --- | --- | --- |
| `vendor/three/three.module.min.js` | `build/three.module.min.js` | `3e690ac7d180b0aadf0891bea39eec643e29e2d3e75c99b18689518665f69ba6` |
| `vendor/three/OrbitControls.js` | `examples/jsm/controls/OrbitControls.js` | `5a44a9e86a2a0fb11933eed69bc2cd33c76a496854c1aed6ed776efa87d7b064` |
| `vendor/three/LICENSE` | `LICENSE` | `852e0e8699169bf9f6fdc6bda3e682d078dcbc738b5d33e74df594721bff271d` |

- **Version:** `three@0.160.0` (r160, December 2023), MIT licensed.
- **Local edits:** none. All three files are byte-identical to the published package, which is
  what the checksums above are for. `OrbitControls.js` imports the bare specifier `three`,
  which the import map in `index.html` resolves to the file next to it.

`test/vendor.test.js` recomputes these checksums on every `npm test`, so an edit to a vendored
file — or an update that forgets this page — fails the suite rather than passing quietly.

## Verifying or updating

```bash
npm pack three@0.160.0            # or the version you are moving to
tar xzf three-0.160.0.tgz
sha256sum package/build/three.module.min.js package/examples/jsm/controls/OrbitControls.js package/LICENSE
```

Copy those three files into `vendor/three/`, put the new version and checksums in the table
above, and check the viewer still loads (`npm run test:browser` drives it end to end). Watch
the [three.js release notes](https://github.com/mrdoob/three.js/releases) for anything that
matters to a `WebGLRenderer` plus `OrbitControls` viewer; nothing else of the library is used.
