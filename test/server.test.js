// The development server is reachable by anything that can reach the port, so its request
// handling is checked here: a malformed escape must not end the process, and nothing outside
// the project directory (or hidden inside it) may be served.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { resolveRequest, startServer } from '../server.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('a malformed percent-escape is a bad request, not a crash', () => {
  assert.equal(resolveRequest('/%').status, 400);
  assert.equal(resolveRequest('/%zz').status, 400);
  assert.equal(resolveRequest('/ok/%E0%A4%A').status, 400);
});

test('a NUL byte in the path is refused before it reaches fs', () => {
  // %00 is the escape decodeURIComponent does not throw on: it hands back a real NUL, and
  // this is what fs then does with one, inside the request listener and before any callback.
  assert.throws(() => fs.stat(path.join(root, 'a\u0000b'), () => {}), { code: 'ERR_INVALID_ARG_VALUE' });
  for (const url of ['/a%00b', '/%00', '/index.html%00.png', '/src/%00app.js', 'http://evil/%00']) {
    assert.equal(resolveRequest(url).status, 400, url);
  }
  // Every other control character goes the same way, so a raw CR or LF cannot reach a header.
  assert.equal(resolveRequest('/a%0d%0aX-Evil:%201').status, 400);
});

test('an escaped slash cannot walk out of the project directory', () => {
  // The URL parser leaves %2f alone, so this reaches the handler as one segment and only
  // becomes `..` after decoding: a prefix test on the resolved path would let it through.
  const sibling = `${path.basename(root)}-old`;
  for (const url of [`/..%2f${sibling}/.env`, '/..%2f..%2fetc/passwd', '/src/..%2f..%2fpasswd', '/..%2f.env']) {
    const r = resolveRequest(url);
    assert.equal(r.status, 403, `${url} -> ${JSON.stringify(r)}`);
  }
  // Plain and %2e-encoded dot segments are resolved by the URL parser itself, so those
  // never leave the root and are ordinary (missing) files inside it.
  assert.deepEqual(resolveRequest('/../../etc/passwd'), { status: 200, file: path.join(root, 'etc', 'passwd') });
  assert.deepEqual(resolveRequest('/%2e%2e/secrets.txt'), { status: 200, file: path.join(root, 'secrets.txt') });
});

test('hidden files and directories are never served', () => {
  for (const url of ['/.gitignore', '/.env', '/.git/config', '/.certs/key.pem', '/src/../.git/HEAD', '/.config/tokens.json']) {
    assert.equal(resolveRequest(url).status, 403, url);
  }
});

test('ordinary files inside the project resolve to themselves', () => {
  assert.deepEqual(resolveRequest('/index.html'), { status: 200, file: path.join(root, 'index.html') });
  assert.deepEqual(resolveRequest('/'), { status: 200, file: path.join(root, 'index.html') });
  assert.deepEqual(resolveRequest('/src/app.js?v=2'), { status: 200, file: path.join(root, 'src', 'app.js') });
  assert.deepEqual(resolveRequest('/src/vision/'), { status: 200, file: path.join(root, 'src', 'vision', 'index.html') });
});

function request(port, urlPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

// Both live tests carry a timeout: a crash in the request listener leaves the socket hanging
// rather than answering, and a stalled `npm test` reports nothing at all.
test('the running server survives the requests it refuses', { timeout: 15000 }, async (t) => {
  const server = await startServer({ port: 0, host: '127.0.0.1' });
  t.after(() => new Promise((r) => server.close(r)));
  const port = server.address().port;

  assert.equal((await request(port, '/%')).status, 400);
  assert.equal((await request(port, '/a%00b')).status, 400);
  assert.equal((await request(port, '/index.html%00.png')).status, 400);
  assert.equal((await request(port, '/.gitignore')).status, 403);
  assert.equal((await request(port, '/index.html', 'POST')).status, 405);
  assert.equal((await request(port, '/does-not-exist.js')).status, 404);

  // Still alive and serving after all of that
  const ok = await request(port, '/index.html');
  assert.equal(ok.status, 200);
  assert.match(ok.headers['content-type'], /text\/html/);
  assert.match(ok.body, /Phonogeometry/);

  const head = await request(port, '/index.html', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
});

test('a read that fails after stat costs one response, not the server', { timeout: 15000 }, async (t) => {
  const server = await startServer({ port: 0, host: '127.0.0.1' });
  t.after(() => new Promise((r) => server.close(r)));
  const port = server.address().port;

  // stat and open are two calls, so a file can go away between them. Without an 'error'
  // listener on the stream that is an unhandled event, which ends the process.
  t.mock.method(fs, 'createReadStream', () => {
    const stream = new Readable({ read() {} });
    queueMicrotask(() => stream.emit('error', Object.assign(new Error('gone'), { code: 'ENOENT' })));
    return stream;
  });
  const doomed = http.request({ host: '127.0.0.1', port, path: '/index.html' });
  doomed.on('error', () => {});   // that response is dropped mid-flight, which is the point
  doomed.end();
  await new Promise((r) => setTimeout(r, 100));
  doomed.destroy();
  t.mock.restoreAll();

  const ok = await request(port, '/index.html');
  assert.equal(ok.status, 200);
});

test('the server binds loopback only unless told otherwise', async (t) => {
  const server = await startServer({ port: 0 });
  t.after(() => new Promise((r) => server.close(r)));
  assert.equal(server.address().address, '127.0.0.1');
});

test('a sibling directory sharing this one\'s name prefix stays out of reach', async (t) => {
  // Prove the escape the prefix test allowed: create the sibling the URL points at.
  const sibling = `${root}-old`;
  if (fs.existsSync(sibling)) return; // do not disturb a real directory
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(sibling, 'secret.txt'), 'not yours');
  t.after(() => fs.rmSync(sibling, { recursive: true, force: true }));

  const server = await startServer({ port: 0, host: '127.0.0.1' });
  t.after(() => new Promise((r) => server.close(r)));
  const res = await request(server.address().port, `/..%2f${path.basename(sibling)}/secret.txt`);
  assert.equal(res.status, 403);
  assert.doesNotMatch(res.body, /not yours/);
});

test('os.tmpdir is not reachable through an absolute-looking path', () => {
  const outside = path.join(os.tmpdir(), 'phonogeometry-not-served.txt');
  assert.equal(resolveRequest(`/${outside}`).status, 200); // joined under root, so it is simply a 404 there
  assert.equal(resolveRequest(`/..%2f..%2f..${outside}`).status, 403);
});
