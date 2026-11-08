import { test, expect } from '@playwright/test';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';

// The demo server's own input handling. These tests need no browser, so they run once, in the "server" project.
// eslint-disable-next-line @typescript-eslint/no-var-requires
// SERVE_DEMO: scripts/mutants.js points this (and the web server) at a mutated copy of the server.
const { resolveRequest, insideRoot, ROOT } = require(process.env.SERVE_DEMO ? path.resolve(process.env.SERVE_DEMO) : '../scripts/serve-demo.js');

// Sends a request target exactly as written. A browser or an HTTP client would re-encode or normalise it first,
// which is the point of the attack inputs below, so these go over a raw socket.
function rawGet(baseURL: string, target: string, method = 'GET'): Promise<{ status: number; body: string; head: string }> {
  const { hostname, port } = new URL(baseURL);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), hostname, () => {
      socket.write(`${method} ${target} HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\n\r\n`);
    });
    let raw = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => (raw += chunk));
    socket.on('end', () => resolve({ status: Number(raw.split(' ')[1]), head: raw.split('\r\n\r\n')[0].toLowerCase(), body: raw.split('\r\n\r\n').slice(1).join('\r\n\r\n') }));
    socket.on('error', reject);
  });
}

test.describe('symlink containment', () => {
  test('a real path outside the demo folder is refused, one inside is allowed', () => {
    const real = fs.realpathSync(ROOT);
    expect(insideRoot(path.join(real, 'trip.json'))).toBe(true);
    expect(insideRoot(path.join(real, '..', 'package.json'))).toBe(false);
    expect(insideRoot(real + '-private' + path.sep + 'x.json')).toBe(false);
    expect(insideRoot(real)).toBe(false);
  });
});

test.describe('request path handling', () => {
  test('"/" serves the app\'s index.html', () => {
    expect(resolveRequest('/')).toEqual({ status: 200, file: path.join(ROOT, 'index.html') });
  });

  test('malformed percent-encoding is a 400, not an exception', () => {
    expect(resolveRequest('/%E0%A4%A')).toEqual({ status: 400 });
  });

  test('a null byte is a 400, not an exception', () => {
    expect(resolveRequest('/a%00b')).toEqual({ status: 400 });
  });

  test('an encoded "../" is refused with 403', () => {
    expect(resolveRequest('/..%2fpackage.json')).toEqual({ status: 403 });
    expect(resolveRequest('/demo/..%2f..%2fpackage.json')).toEqual({ status: 403 });
  });

  // A sibling folder whose name starts with the demo folder's name (demo-private next to demo). A check written as
  // file.startsWith(ROOT) without the separator would serve it; the expected 403 is stated here, not computed.
  test("a sibling folder that shares the demo folder's name prefix is refused with 403", () => {
    const sibling = path.basename(ROOT) + '-private';
    expect(resolveRequest('/..%2f' + sibling + '%2fsecret.txt')).toEqual({ status: 403 });
  });

  test('no hostile path resolves to a file outside the demo folder', () => {
    const hostile = ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/..%5cpackage.json',
      '/%2e%2e%2f%2e%2e%2fetc/passwd', '/....//package.json', '/%252e%252e%252fpackage.json', '//etc/passwd'];
    for (const target of hostile) {
      const r = resolveRequest(target);
      if (r.status === 200) expect(r.file.startsWith(ROOT + path.sep), target).toBe(true);
    }
  });
});

test.describe('the running server', () => {
  // A symlink inside the demo folder that points outside it. The link is made for this test and removed after it.
  test('a symlink that leads outside the demo folder gets 403 and no file contents', async ({ baseURL }) => {
    const link = path.join(ROOT, '__link-test.json');
    fs.rmSync(link, { force: true });
    try {
      fs.symlinkSync(path.join(ROOT, '..', 'package.json'), link, 'file');
    } catch (e: any) {
      test.skip(e.code === 'EPERM', 'this machine does not allow symlinks for this user');
      throw e;
    }
    try {
      const r = await rawGet(baseURL!, '/__link-test.json');
      expect(r.status).toBe(403);
      expect(r.body).not.toContain('planner-e2e-showcase');
    } finally {
      fs.rmSync(link, { force: true });
    }
  });
  // A hard link inside the demo folder to a file outside it: its real path is inside, so only the link count shows it.
  test('a hard link to a file outside the demo folder gets 403 and no file contents', async ({ baseURL }) => {
    const link = path.join(ROOT, '__hard-test.json');
    fs.rmSync(link, { force: true });
    try { fs.linkSync(path.join(ROOT, '..', 'package.json'), link); } catch (e: any) { test.skip(e.code === 'EXDEV' || e.code === 'EPERM', 'cannot hard-link here'); throw e; }
    try {
      const r = await rawGet(baseURL!, '/__hard-test.json');
      expect(r.status).toBe(403);
      expect(r.body).not.toContain('planner-e2e-showcase');
    } finally { fs.rmSync(link, { force: true }); }
  });
  // A FIFO: a blocking open waits for a writer and holds a threadpool thread; four of them stopped the server.
  test('a FIFO gets 404 and four of them do not stop the server', async ({ baseURL }) => {
    test.skip(process.platform === 'win32', 'no FIFOs in the Windows file system');
    const fifo = path.join(ROOT, '__fifo-test.json');
    fs.rmSync(fifo, { force: true });
    require('child_process').execFileSync('mkfifo', [fifo]);
    try {
      for (let i = 0; i < 4; i++) expect((await rawGet(baseURL!, '/__fifo-test.json')).status).toBe(404);
      expect((await rawGet(baseURL!, '/')).status).toBe(200);
    } finally { fs.rmSync(fifo, { force: true }); }
  });
  // Each crash input is followed by a normal request: a server that died would refuse that connection.
  for (const [target, status] of [['/%E0%A4%A', 400], ['/a%00b', 400]] as const) {
    test(`${target} gets ${status} and the server keeps serving`, async ({ baseURL }) => {
      expect((await rawGet(baseURL!, target)).status).toBe(status);
      expect((await rawGet(baseURL!, '/')).status).toBe(200);
    });
  }

  // A symlinked DIRECTORY inside the demo folder: the last path component is a real file, so only the real-path check
  // (not O_NOFOLLOW, which looks at the last component) can refuse it.
  test('a file reached through a symlinked directory outside the demo folder gets 403', async ({ baseURL }) => {
    const link = path.join(ROOT, '__link-dir');
    // Remove only the link itself, never what it points to (rmdir on a junction, unlink on a symlink).
    const removeLink = () => { try { fs.lstatSync(link); } catch { return; } if (process.platform === 'win32') fs.rmdirSync(link); else fs.unlinkSync(link); };
    removeLink();
    try {
      fs.symlinkSync(path.join(ROOT, '..'), link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (e: any) {
      test.skip(e.code === 'EPERM', 'this machine does not allow symlinks for this user');
      throw e;
    }
    try {
      const r = await rawGet(baseURL!, '/__link-dir/package.json');
      expect(r.status).toBe(403);
      expect(r.body).not.toContain('planner-e2e-showcase');
    } finally {
      removeLink();
    }
  });

  test('methods other than GET and HEAD get 405 with an Allow header', async ({ baseURL }) => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const r = await rawGet(baseURL!, '/', method);
      expect(r.status, method).toBe(405);
      expect(r.head, method).toContain('allow: get, head');
    }
  });

  test('HEAD gives the size and no body', async ({ baseURL }) => {
    const r = await rawGet(baseURL!, '/trip.json', 'HEAD');
    expect(r.status).toBe(200);
    expect(r.head).toContain('content-length: ' + fs.statSync(path.join(ROOT, 'trip.json')).size);
    expect(r.body).toBe('');
  });

  test('served files carry X-Content-Type-Options: nosniff', async ({ baseURL }) => {
    for (const target of ['/', '/trip.json']) {
      const r = await rawGet(baseURL!, target);
      expect(r.status, target).toBe(200);
      expect(r.head, target).toContain('x-content-type-options: nosniff');
    }
  });

  test('a sibling-prefix path gets 403', async ({ baseURL }) => {
    expect((await rawGet(baseURL!, '/..%2f' + path.basename(ROOT) + '-private%2fsecret.txt')).status).toBe(403);
  });

  test('an encoded "../" gets 403 and no file contents', async ({ baseURL }) => {
    const r = await rawGet(baseURL!, '/..%2fpackage.json');
    expect(r.status).toBe(403);
    expect(r.body).not.toContain('planner-e2e-showcase');
  });
});