import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHandler } from '../server.js';

test('static server rejects malformed paths and paths outside its real root', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'phonogeometry-server-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'public');
  const sibling = path.join(parent, 'public-backup');
  await fs.mkdir(root);
  await fs.mkdir(sibling);
  await fs.writeFile(path.join(root, 'index.html'), 'app');
  await fs.writeFile(path.join(root, '.env'), 'private');
  await fs.writeFile(path.join(sibling, 'credentials.txt'), 'outside');
  await fs.symlink(sibling, path.join(root, 'escape'));
  await fs.symlink(path.join(root, '.env'), path.join(root, 'alias.txt'));
  const server = http.createServer(createHandler(root));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const request = (urlPath) => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
  });
  assert.equal((await request('/%')).status, 400);
  assert.equal((await request('/%00')).status, 400);
  assert.equal((await request('/%2e%2e%2fpublic-backup%2fcredentials.txt')).status, 403);
  assert.equal((await request('/escape/credentials.txt')).status, 403);
  assert.equal((await request('/.env')).status, 403);
  assert.equal((await request('/alias.txt')).status, 403);
  assert.equal((await request('/missing')).status, 404);
  assert.deepEqual(await request('/'), { status: 200, body: 'app' });
});
