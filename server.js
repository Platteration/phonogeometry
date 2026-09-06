#!/usr/bin/env node
// Tiny static server for development. Cameras need a secure context, so use
// `node server.js --https` to serve over TLS with a self-signed certificate for your LAN.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const useHttps = args.includes('--https');
const port = parseInt((args.find((a) => a.startsWith('--port=')) || '').split('=')[1] || (useHttps ? '8443' : '8080'), 10);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

function handler(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const file = path.normalize(path.join(root, urlPath));
  if (!file.startsWith(root) || file.includes(`${path.sep}.git${path.sep}`) || file.includes(`${path.sep}.certs${path.sep}`)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Cross-Origin-Opener-Policy': 'same-origin',
    });
    fs.createReadStream(file).pipe(res);
  });
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  return out;
}

function ensureCert() {
  const dir = path.join(root, '.certs');
  const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
  if (!fs.existsSync(key) || !fs.existsSync(cert)) {
    fs.mkdirSync(dir, { recursive: true });
    const ips = lanAddresses();
    const san = ['DNS:localhost', 'IP:127.0.0.1', ...ips.map((ip) => `IP:${ip}`)].join(',');
    console.log('Generating a self-signed certificate in .certs/ …');
    execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout "${key}" -out "${cert}" -days 365 -subj "/CN=phonogeometry.local" -addext "subjectAltName=${san}"`, { stdio: 'inherit' });
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

const server = useHttps ? https.createServer(ensureCert(), handler) : http.createServer(handler);
server.listen(port, '0.0.0.0', () => {
  const proto = useHttps ? 'https' : 'http';
  console.log(`Phonogeometry dev server`);
  console.log(`  ${proto}://localhost:${port}/`);
  for (const ip of lanAddresses()) console.log(`  ${proto}://${ip}:${port}/   <- open this on your phone (same Wi-Fi)`);
  if (!useHttps) console.log('\nNote: phones only allow camera access over HTTPS. Run `npm run start:https` for LAN testing.');
  else console.log('\nThe certificate is self-signed: accept the browser warning once on the phone.');
});
