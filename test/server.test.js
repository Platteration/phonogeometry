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
import { resolveRequest, startServer, hostName, allowedHosts, hostGate, MAX_LOGGED, MAX_NAME, RESCAN_MS } from '../server.js';

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

// Binding to loopback stops a network peer, not a browser that has been told an attacker's
// name resolves to 127.0.0.1. The rebound request carries that name in Host.
test('a Host that is not this server is refused, and no Host is not a rebound browser', () => {
  assert.equal(resolveRequest('/index.html', 'evil.example').status, 403);
  assert.equal(resolveRequest('/index.html', 'evil.example:8080').status, 403);
  assert.equal(resolveRequest('/', '127.0.0.1.evil.example').status, 403);
  // The refusal comes first: a rebound page gets nothing, not even a 400 to probe with.
  assert.equal(resolveRequest('/%', 'evil.example').status, 403);
  for (const host of ['localhost', 'localhost:8080', '127.0.0.1', '127.0.0.1:8080', 'LOCALHOST:8080', '[::1]', '[::1]:8080', '::1']) {
    assert.equal(resolveRequest('/index.html', host).status, 200, host);
  }
  // A browser always sends Host and a page cannot set it, so a request with none cannot be a
  // rebound one: curl --http1.0 and the tests above still work.
  assert.equal(resolveRequest('/index.html').status, 200);
  assert.equal(resolveRequest('/index.html', undefined).status, 200);
  assert.equal(resolveRequest('/index.html', '').status, 200);
});

test('hostName drops the port and keeps a bare IPv6 literal whole', () => {
  assert.equal(hostName('localhost:8080'), 'localhost');
  assert.equal(hostName('Dev.Example.com:8080 '), 'dev.example.com');
  assert.equal(hostName('[::1]:8080'), '[::1]');
  assert.equal(hostName('::1'), '::1', 'a bare IPv6 literal carries no port, so nothing is stripped');
  assert.equal(hostName(undefined), '');
});

test('bound off loopback, the server answers to this machine\'s addresses, with or without the port', () => {
  // The LAN modes (`--host=`, `--https`) exist so a phone can reach the app, and the phone
  // types an interface address. simplacad's loopback-only set would refuse every phone.
  const machine = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }, { address: '::1', family: 'IPv6', internal: true }],
    wlan0: [{ address: '192.168.1.23', family: 'IPv4', internal: false }, { address: 'fe80::1a2b', family: 'IPv6', internal: false }],
  };
  const loop = allowedHosts('127.0.0.1', machine);
  assert.equal(loop.has('192.168.1.23'), false, 'a loopback bind answers loopback names only');
  for (const bind of ['0.0.0.0', '::', '192.168.1.23']) {
    const lan = allowedHosts(bind, machine);
    for (const host of ['192.168.1.23', '192.168.1.23:8443', '[fe80::1a2b]:8443', 'localhost:8443']) {
      assert.equal(resolveRequest('/index.html', host, lan).status, 200, `${bind} <- ${host}`);
    }
    assert.equal(resolveRequest('/index.html', 'evil.example', lan).status, 403, `${bind} still refuses a foreign name`);
    assert.equal(resolveRequest('/index.html', '192.168.1.99', lan).status, 403, `${bind} answers this machine, not the subnet`);
  }
  // The bound address is a name of this server, whatever it is. `0.0.0.0` used to be struck
  // out here as "not a name"; it is answered now because abientnoiser's gate answers it and
  // the two servers are one rule, and because it is not a way in: a rebound page carries the
  // attacker's *name* in Host, which is still refused, and a browser will not navigate to
  // 0.0.0.0 at all. This assertion is the rule, in place of the exception.
  assert.equal(allowedHosts('0.0.0.0', machine).has('0.0.0.0'), true, 'the bound address is a name');
  assert.equal(allowedHosts('192.168.1.23', machine).has('192.168.1.23'), true);
  // Both spellings of every address, and this machine's names, which is what a phone types:
  // none of `laptop.local`, `laptop` or a port-forwarder's address is in os.networkInterfaces().
  const named = allowedHosts('0.0.0.0', machine, 'Laptop');
  for (const host of ['[192.168.1.23]:8443', 'fe80::1a2b', 'laptop', 'Laptop:8443', 'laptop.local', 'LAPTOP.local:8443', 'anything.local']) {
    assert.equal(resolveRequest('/index.html', host, named).status, 200, host);
  }
  for (const host of ['local', 'laptop.lan', 'evil.local.example', 'laptop.localdomain']) {
    assert.equal(resolveRequest('/index.html', host, named).status, 403, host);
  }
  assert.equal(resolveRequest('/index.html', 'laptop.local', allowedHosts('127.0.0.1', machine, 'Laptop')).status, 403, 'and none of that on a loopback bind');
  // The real machine: whatever it has, the running server would answer to it.
  const real = allowedHosts('0.0.0.0');
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) {
    assert.equal(real.has(hostName(i.family === 'IPv6' || i.family === 6 ? `[${i.address}]:8443` : `${i.address}:8443`)), true, i.address);
  }
});

/** `hostGate` with the operating system stood in for: the interface list can change between
 *  reads, the clock is ours, and the log is collected. */
function gate({ host = '0.0.0.0', interfaces = [['10.0.0.5']], hostname = 'Laptop' } = {}) {
  let reads = 0, t = 0;
  const logged = [];
  const allowed = hostGate({
    host,
    interfaces: () => {
      const list = interfaces[Math.min(reads, interfaces.length - 1)];
      reads++;
      return { eth0: list.map((address) => ({ address, family: address.includes(':') ? 'IPv6' : 'IPv4', internal: false })) };
    },
    hostname: () => hostname,
    log: (line) => logged.push(line),
    now: () => t,
  });
  return { allowed, logged, reads: () => reads, tick: (ms) => { t += ms; } };
}

/** Run `fn` with ALLOWED_HOST set, and put the environment back whatever it does. */
function withAllowedHost(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'ALLOWED_HOST');
  const before = process.env.ALLOWED_HOST;
  process.env.ALLOWED_HOST = value;
  try { return fn(); } finally { if (had) process.env.ALLOWED_HOST = before; else delete process.env.ALLOWED_HOST; }
}

// ALLOWED_HOST is the documented way to reach this server through something it cannot see —
// a port forwarded by Docker, WSL2, a VM or a tunnel, none of which is an address in
// os.networkInterfaces(). Untested, the one documented way round a 403 can silently stop
// working: deleting the line that reads it left the suite green.
test('ALLOWED_HOST adds names, as a comma-separated list, on any bind', () => {
  withAllowedHost('dev.example.com:8080, tunnel.example , ', () => {
    for (const bind of ['127.0.0.1', '0.0.0.0']) {
      const hosts = allowedHosts(bind, {}, 'laptop');
      for (const host of ['dev.example.com', 'dev.example.com:8443', 'TUNNEL.example:1234']) {
        assert.equal(resolveRequest('/index.html', host, hosts).status, 200, `${bind} <- ${host}`);
      }
      assert.equal(resolveRequest('/index.html', 'other.example', hosts).status, 403, 'and nothing else');
      assert.equal(hosts.has(''), false, 'an empty entry is not a name that matches a missing Host');
    }
  });
  assert.equal(allowedHosts('127.0.0.1', {}, 'laptop').has('dev.example.com'), false, 'gone with the variable');
});

// The Wi-Fi a phone is on may come up after the server did — a hotspot switched on so the
// phone can reach the laptop, a network joined later — and its address is one the phone will
// type. A set snapshotted at start-up refuses it until the server is restarted.
test('a miss re-reads the interfaces, at most once a second', () => {
  const { allowed, reads, tick } = gate({ interfaces: [['10.0.0.5'], ['10.0.0.5', '10.0.0.9'], ['10.0.0.5', '10.0.0.9', '10.0.0.13']] });
  assert.equal(reads(), 1, 'read once at the start');
  assert.equal(allowed('10.0.0.5:8443'), true);
  assert.equal(reads(), 1, 'a hit reads nothing');
  tick(RESCAN_MS);
  assert.equal(allowed('10.0.0.9:8443'), true, 'an address that came up since the start is answered');
  assert.equal(reads(), 2);
  assert.equal(allowed('10.0.0.13:8443'), false, 'but the next miss within the throttle does not read again');
  assert.equal(reads(), 2);
  tick(RESCAN_MS);
  assert.equal(allowed('10.0.0.13:8443'), true);
  assert.equal(reads(), 3);
  assert.equal(allowed('evil.example'), false, 'and a name no interface has stays refused');
});

test('on loopback a miss never reads the interfaces: their addresses are not answered there', () => {
  const { allowed, reads, tick } = gate({ host: '127.0.0.1', interfaces: [['10.0.0.5'], ['10.0.0.5', '10.0.0.9']] });
  assert.equal(reads(), 0);
  tick(RESCAN_MS);
  assert.equal(allowed('10.0.0.9:8443'), false);
  assert.equal(allowed('laptop.local'), false, 'nor is an mDNS name');
  assert.equal(reads(), 0);
});

// A bare `Forbidden` on the phone, with nothing on the console, is how the developer who has
// been typing `laptop.local:8443` finds out nothing at all.
test('a refused name is logged once, with the way to allow it, and no more than a bounded number', () => {
  const { allowed, logged } = gate({ host: '127.0.0.1' });
  allowed('evil.example'); allowed('evil.example:8443'); allowed('EVIL.example');
  assert.equal(logged.length, 1, 'one line for one name, whatever its port or case');
  assert.match(logged[0], /refused Host "evil\.example"/);
  assert.match(logged[0], /ALLOWED_HOST=evil\.example/, 'the refusal says how to allow the name');
  assert.match(logged[0], /--host=0\.0\.0\.0/, 'and, on loopback, how to answer to this machine\'s own names');
  allowed('other.example');
  assert.equal(logged.length, 2);
  // A name is whatever the client typed, so it is printed cut and without the hint, which
  // would otherwise be a cut name that does not work when it is pasted.
  allowed(`${'x'.repeat(5000)}.example`);
  assert.equal(logged.length, 3);
  assert.ok(logged[2].length < MAX_NAME + 200, `a long name is cut, not printed whole: ${logged[2].length} chars`);
  assert.doesNotMatch(logged[2], /ALLOWED_HOST=/, 'and a name too long to be one is not offered as one');
  for (let i = 0; i < MAX_LOGGED + 50; i++) allowed(`n${i}.example`);
  assert.equal(logged.length, MAX_LOGGED, 'a client minting names cannot fill the terminal');
  assert.equal(allowed('localhost:8443'), true, 'and the server is still serving its own names');
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

/**
 * A request with a deadline of its own. The failure this guards against is not a refusal but
 * a silence: a crash inside the request listener leaves the connection accepted and never
 * answered, and this promise then never settles. A pending promise inside a test stalls the
 * whole file — the runner's own `{ timeout }` does not rescue it, measured: with the control
 * character check deleted, `node --test` printed no result for this test, no summary, and
 * never exited. A client-side deadline turns that silence into a failed assertion, which is
 * what a test is for.
 */
function request(port, urlPath, method = 'GET', deadlineMs = 5000, headers = {}, address = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: address, port, path: urlPath, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.setTimeout(deadlineMs, () => req.destroy(new Error(`no response to ${method} ${urlPath} within ${deadlineMs} ms`)));
    req.on('error', reject);
    req.end();
  });
}

// The live tests carry a runner timeout as well, as a backstop for a stall that happens
// somewhere other than in a request.
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
  // The Host header is what a rebound browser carries; node's own client sets it freely.
  assert.equal((await request(port, '/index.html', 'GET', 5000, { Host: 'evil.example' })).status, 403);
  assert.equal((await request(port, '/index.html', 'GET', 5000, { Host: `localhost:${port}` })).status, 200);
  assert.equal((await request(port, '/index.html', 'GET', 5000, { Host: `127.0.0.1:${port}` })).status, 200);

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

// Asking for a file and walking away costs a client nothing. It must not cost the server a
// file descriptor: `pipe` handles a failure of the *source* only, so when the destination
// goes away it unpipes and leaves the fs.ReadStream open and paused, descriptor held,
// autoClose never fired. Measured at 60 leaked for 60 abandoned downloads, still held
// afterwards, unauthenticated on the LAN bind `npm run start:https` documents.
test('a client that abandons a download does not leak the open file', { timeout: 20000 }, async (t) => {
  const server = await startServer({ port: 0, host: '127.0.0.1' });
  t.after(() => new Promise((r) => server.close(r)));
  const port = server.address().port;

  // The premise is the file's own size, measured here rather than assumed: it has to be
  // bigger than the socket buffers, or the whole response is written before anyone can walk
  // away and nothing is left holding a descriptor either way.
  const big = path.join(root, 'vendor', 'three', 'three.module.min.js');
  assert.ok(fs.statSync(big).size > 256 * 1024, 'this test needs a file larger than the socket buffer');

  const opened = [];
  const realCreateReadStream = fs.createReadStream;
  t.mock.method(fs, 'createReadStream', (...args) => {
    const stream = realCreateReadStream(...args);
    opened.push(stream);
    return stream;
  });

  const n = 20;
  await Promise.all(Array.from({ length: n }, () => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/vendor/three/three.module.min.js' }, (res) => {
      res.once('data', () => { req.destroy(); resolve(); });   // first chunk, then gone
    });
    req.on('error', () => resolve());
    req.end();
  })));
  await new Promise((r) => setTimeout(r, 300));
  t.mock.restoreAll();

  assert.equal(opened.length, n, `${opened.length} reads for ${n} requests`);
  const stillOpen = opened.filter((s) => !s.destroyed).length;
  assert.equal(stillOpen, 0, `${stillOpen} of ${n} reads left open by clients that went away`);
  // And the descriptors themselves are back, where the platform will say so.
  if (fs.existsSync('/proc/self/fd')) {
    const held = fs.readdirSync('/proc/self/fd').filter((fd) => {
      try { return fs.readlinkSync(`/proc/self/fd/${fd}`) === big; } catch { return false; }
    }).length;
    assert.equal(held, 0, `${held} descriptors still open on the file`);
  }
});

test('the server binds loopback only unless told otherwise', async (t) => {
  const server = await startServer({ port: 0 });
  t.after(() => new Promise((r) => server.close(r)));
  assert.equal(server.address().address, '127.0.0.1');
});

// The bind and the set it derives are wired together in startServer, and only a listening
// server proves it: replacing `hostGate({ host })` there with the loopback default leaves every
// unit test above green (they call allowedHosts with a machine of their own) while every phone
// gets 403 in the LAN modes. 127.0.0.2 is off loopback as far as the rule is concerned — it is
// none of the four loopback names — while staying on this machine; a real interface address is
// the fallback where it cannot be bound.
test('bound off loopback, the running server answers to this machine and refuses a foreign name', { timeout: 15000 }, async (t) => {
  const own = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) own.push(i.address);
  let server, bound;
  for (const address of ['127.0.0.2', ...own]) {
    try { server = await startServer({ port: 0, host: address }); bound = address; break; } catch { /* not an address this machine can bind */ }
  }
  if (!server) return t.skip('no address to bind off loopback on this machine');
  t.after(() => new Promise((r) => server.close(r)));
  const port = server.address().port;
  const ask = (host) => request(port, '/index.html', 'GET', 5000, { Host: host }, bound);

  assert.equal((await ask(`${bound}:${port}`)).status, 200, 'the address it is bound to');
  assert.equal((await ask(`${os.hostname()}:${port}`)).status, 200, 'this machine\'s hostname');
  assert.equal((await ask(`${os.hostname()}.local:${port}`)).status, 200, 'and that name under mDNS, which is what a phone offers');
  assert.equal((await ask(`phone-typed-this.local:${port}`)).status, 200, 'as is any other .local name: no internet DNS can point one at 127.0.0.1');
  assert.equal((await ask(`localhost:${port}`)).status, 200, 'loopback names are answered on any bind');
  for (const address of own) assert.equal((await ask(`${address}:${port}`)).status, 200, `the interface address ${address}`);
  assert.equal((await ask('evil.example')).status, 403, 'and a foreign name is still refused');
  assert.equal((await ask('evil.example.com:8443')).status, 403);
  // The refusal is first, and the server is still serving afterwards.
  assert.equal((await request(port, '/%', 'GET', 5000, { Host: 'evil.example' }, bound)).status, 403);
  assert.equal((await request(port, '/index.html', 'GET', 5000, {}, bound)).status, 200);
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
